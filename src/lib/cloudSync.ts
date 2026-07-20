import { useAuthStore } from '../stores/authStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { useMatchScheduleStore, sortMatches, type ScheduledMatch } from '../stores/matchScheduleStore';
import { useMatchResultsStore, type SavedMatchResult } from '../stores/matchResultsStore';
import { useCanvasStore } from '../stores/canvasStore';
import type { Tournament } from '../types/tournament';

// Multi-venue live scoring sync — each venue's desktop app pushes its
// cloud-enabled tournaments' fixtures/results to event.gomonetwork.com and
// pulls other venues' changes back, so every venue sees the combined
// picture. Reuses the same auth token already used for sign-in (authStore) —
// no separate credential. See the "Multi-venue cloud sync" plan for the
// full design.
const API_BASE = 'https://event.gomonetwork.com';
const PULL_INTERVAL_MS = 30000;
const PUSH_DEBOUNCE_MS = 2500;

let pullTimer: ReturnType<typeof setInterval> | null = null;
let pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribers: (() => void)[] = [];
let started = false;
let pushInFlight = false;
let pullInFlight = false;

// ISO timestamp of the last successful pull — vendor-wide, not per
// tournament, matching the /pull route's single `since` cursor.
let pullWatermark = '';

function authHeaders(): Record<string, string> | null {
  const token = useAuthStore.getState().token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Plain (non-hook) equivalent of scoreboardSnapshot.ts's useLiveFixtureIds —
// this module runs outside React, so it reads the same stores imperatively
// instead. Used to make sure an incoming pull never clobbers a fixture
// that's actively live on THIS device right now.
function getLiveFixtureIds(): Set<string> {
  const { pages, commentatorPages } = useCanvasStore.getState();
  const matches = useMatchScheduleStore.getState().matches;
  const allWidgets = [...pages, ...commentatorPages].flatMap(p => p.widgets);
  const completedIds = new Set(matches.filter(m => m.completedAt).map(m => m.id));
  const ids = new Set<string>();
  for (const w of allWidgets) {
    if (w.type !== 'scoreboard') continue;
    const cfg: any = w.config;
    const dc = cfg.linkedScoreboardSourceId
      ? allWidgets.find(x => x.id === cfg.linkedScoreboardSourceId && x.type === 'scoreboard')?.config ?? cfg
      : cfg;
    const fixtureId = dc.linkedScheduleMatchId;
    if (fixtureId && !completedIds.has(fixtureId)) ids.add(fixtureId);
  }
  return ids;
}

function upsertById<T extends { id: string }>(current: T[], incoming: T): T[] {
  const idx = current.findIndex(x => x.id === incoming.id);
  if (idx === -1) return [...current, incoming];
  const next = current.slice();
  next[idx] = { ...next[idx], ...incoming };
  return next;
}

// Pushes every cloud-enabled tournament's full current fixture/result set —
// not a computed delta. The data is small enough (tens of KB per
// tournament) that this is trivially cheap, and it sidesteps needing
// per-record change-tracking across every store mutation site; the server
// upserts by id either way, so re-sending unchanged records is harmless.
async function pushAll() {
  if (pushInFlight) return;
  const headers = authHeaders();
  if (!headers) return;

  const tournaments = useTournamentStore.getState().tournaments.filter(t => t.cloudSyncEnabled);
  if (tournaments.length === 0) return;

  const venueLabel = useAppSettings.getState().canvasVenue || undefined;
  const tournamentIds = new Set(tournaments.map(t => t.id));
  const allMatches = useMatchScheduleStore.getState().matches.filter(m => m.tournamentId && tournamentIds.has(m.tournamentId));
  const allResults = useMatchResultsStore.getState().results.filter(r => r.tournamentId && tournamentIds.has(r.tournamentId));

  // Stamp this device's venue onto anything that doesn't have one yet, so
  // the origin device's own rows show a badge too once other venues pull
  // them (not just remote-originated rows).
  if (venueLabel) {
    for (const m of allMatches) {
      if (!m.venueLabel) useMatchScheduleStore.getState().updateMatch(m.id, { venueLabel });
    }
    for (const r of allResults) {
      if (!r.venueLabel) useMatchResultsStore.getState().updateResult(r.id, { venueLabel });
    }
  }

  const payload = {
    tournaments: tournaments.map(t => {
      const { cloudSyncEnabled, ...data } = t;
      // eventId is also sent as its own top-level field (in addition to
      // living inside `data`) so the server can store it as a real,
      // queryable column for the website's scoring overview page to join on.
      return { id: t.id, name: t.name, sport: t.sport, eventId: t.eventId, data };
    }),
    matches: allMatches.map(m => ({ id: m.id, tournamentId: m.tournamentId!, venueLabel: m.venueLabel ?? venueLabel, data: m })),
    results: allResults.map(r => ({ id: r.id, tournamentId: r.tournamentId!, venueLabel: r.venueLabel ?? venueLabel, data: r })),
  };

  pushInFlight = true;
  try {
    await fetch(`${API_BASE}/api/desktop/scoring/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch {
    // Offline/network failure — no watermark to roll back, the next
    // debounced push or the next 30s pull tick just retries naturally.
  } finally {
    pushInFlight = false;
  }
}

function schedulePush() {
  // A pull applying incoming changes triggers these same store subscriptions
  // — skip scheduling a push for those, or every pull would immediately
  // echo the same data straight back to the server.
  if (pullInFlight) return;
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(() => { pushAll(); }, PUSH_DEBOUNCE_MS);
}

async function pullAll() {
  if (pullInFlight) return;
  const headers = authHeaders();
  if (!headers) return;

  pullInFlight = true;
  try {
    const res = await fetch(`${API_BASE}/api/desktop/scoring/pull?since=${encodeURIComponent(pullWatermark)}`, { headers });
    if (!res.ok) return;
    const body: {
      serverTime?: string;
      tournaments?: { id: string; name: string; sport: string; data: any }[];
      matches?: { id: string; tournamentId: string; venueLabel?: string; data: any }[];
      results?: { id: string; tournamentId: string; venueLabel?: string; data: any }[];
    } = await res.json();

    const liveIds = getLiveFixtureIds();

    for (const rt of body.tournaments ?? []) {
      const local = useTournamentStore.getState().tournaments.find(t => t.id === rt.id);
      if (local) {
        // Partial merge via updateTournament preserves cloudSyncEnabled —
        // a device's own opt-out is never silently overwritten by a pull.
        useTournamentStore.getState().updateTournament(rt.id, rt.data);
      } else {
        // A tournament that only just appeared via pull was, by definition,
        // already opted into sync by whichever venue created it.
        const created: Tournament = { ...rt.data, id: rt.id, name: rt.name, sport: rt.sport, cloudSyncEnabled: true };
        useTournamentStore.setState(s => ({ tournaments: [...s.tournaments, created] }));
      }
    }

    for (const rm of body.matches ?? []) {
      if (liveIds.has(rm.id)) continue; // actively live on this device — don't clobber
      const incoming: ScheduledMatch = { ...rm.data, id: rm.id, tournamentId: rm.tournamentId, venueLabel: rm.venueLabel };
      useMatchScheduleStore.setState(s => ({ matches: upsertById(s.matches, incoming).sort(sortMatches) }));
    }

    for (const rr of body.results ?? []) {
      const incoming: SavedMatchResult = { ...rr.data, id: rr.id, tournamentId: rr.tournamentId, venueLabel: rr.venueLabel };
      useMatchResultsStore.setState(s => ({ results: upsertById(s.results, incoming) }));
    }

    if (body.serverTime) pullWatermark = body.serverTime;
  } catch {
    // Offline/network failure — watermark unchanged, next 30s tick retries.
  } finally {
    pullInFlight = false;
  }
}

/** Starts the background push/pull loop — call once, e.g. from App.tsx.
 *  No-ops if already running. Push fires shortly after any local change to
 *  a cloud-enabled tournament's schedule/results/settings; pull runs on a
 *  flat 30s interval regardless of local activity. Both are silently
 *  skipped whenever signed out (checked per-tick, not just at startup, so
 *  signing out later stops new pushes/pulls without needing to call
 *  stopCloudSync()). */
export function startCloudSync() {
  if (started) return;
  started = true;

  const triggerPush = () => schedulePush();
  unsubscribers.push(useTournamentStore.subscribe(triggerPush));
  unsubscribers.push(useMatchScheduleStore.subscribe(triggerPush));
  unsubscribers.push(useMatchResultsStore.subscribe(triggerPush));

  pullTimer = setInterval(() => { pullAll(); }, PULL_INTERVAL_MS);
  // Kick off an initial pull immediately rather than waiting a full 30s.
  pullAll();
}

export function stopCloudSync() {
  if (pullTimer) clearInterval(pullTimer);
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pullTimer = null;
  pushDebounceTimer = null;
  for (const unsub of unsubscribers) unsub();
  unsubscribers = [];
  started = false;
}
