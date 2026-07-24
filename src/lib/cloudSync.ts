import { useAuthStore } from '../stores/authStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { useMatchScheduleStore, sortMatches, type ScheduledMatch } from '../stores/matchScheduleStore';
import { useMatchResultsStore, type SavedMatchResult } from '../stores/matchResultsStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useTeamDbStore, type SavedTeam } from '../stores/teamDbStore';
import { useCloudSyncStatus } from '../stores/cloudSyncStatusStore';
import { resolveImageUrl } from './imageUrl';
import { computeMatchNumbers } from '../utils/matchNumber';
import { startRosterAutoSync, stopRosterAutoSync } from './externalRoster';
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

// What the cloud is already known to hold for each record — a snapshot of
// the exact `{venueLabel, data}` this device last pushed (or last pulled,
// since a pulled record is by definition already on the cloud too), keyed by
// id. The automatic background push (pushAll) diffs against this before
// sending anything, so a debounced push triggered by editing ONE fixture
// doesn't re-upload every other unchanged fixture/result in the tournament
// too. Reset on app restart (in-memory only) — the first push of a new
// session naturally re-syncs everything once, which is the correct, safe
// baseline rather than added persistence complexity for a one-time cost.
const lastPushedTournament = new Map<string, string>();
const lastPushedMatch = new Map<string, string>();
const lastPushedResult = new Map<string, string>();
const lastPushedTeam = new Map<string, string>();

function recordKey(venueLabel: string | undefined, data: unknown): string {
  return JSON.stringify({ venueLabel, data });
}

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

// Trimmed to mirror SavedMatchResult.scoreLog's shape (see matchResultsStore)
// so the website can render a live breakdown with the same renderer it'd use
// for a finished match's saved log — drops the widget-local `id`/`timeMs`/
// `teamName`/running-score-snapshot fields, which only matter to the board
// itself (per-entry undo, etc.), not to a remote viewer.
export interface LiveScoreLogEntry {
  team: 'A' | 'B';
  action: string;
  points: number;
  scorer?: string;
  jerseyNo?: string;
  timeStr?: string;
}

// Live, in-progress score + try/conversion/etc. breakdown for a fixture
// currently loaded on a scoreboard widget — read straight off that widget's
// own config (same traversal as getLiveFixtureIds above), never persisted to
// matchScheduleStore. Folded into that fixture's pushed `data` below so the
// public scoring page can show a live breakdown while the match is still in
// progress, not just the final score once a Result is saved.
function getLiveScoreForMatch(fixtureId: string): { scoreA: number; scoreB: number; scoreLog: LiveScoreLogEntry[] } | null {
  const { pages, commentatorPages } = useCanvasStore.getState();
  const allWidgets = [...pages, ...commentatorPages].flatMap(p => p.widgets);
  for (const w of allWidgets) {
    if (w.type !== 'scoreboard') continue;
    const cfg: any = w.config;
    const dc = cfg.linkedScoreboardSourceId
      ? allWidgets.find(x => x.id === cfg.linkedScoreboardSourceId && x.type === 'scoreboard')?.config ?? cfg
      : cfg;
    if (dc.linkedScheduleMatchId !== fixtureId) continue;
    const scoreLog: LiveScoreLogEntry[] = (dc.scoreLog ?? []).map((e: any) => ({
      team: e.team, action: e.action, points: e.points, scorer: e.scorer, jerseyNo: e.jerseyNo, timeStr: e.timeStr,
    }));
    return { scoreA: dc.scoreA ?? 0, scoreB: dc.scoreB ?? 0, scoreLog };
  }
  return null;
}

function upsertById<T extends { id: string }>(current: T[], incoming: T): T[] {
  const idx = current.findIndex(x => x.id === incoming.id);
  if (idx === -1) return [...current, incoming];
  const next = current.slice();
  next[idx] = { ...next[idx], ...incoming };
  return next;
}

// Team logos are served by the embedded HTTP server on the operator's own
// machine (http://localhost:PORT/images/...) — reachable from other
// widgets/mirrors on the same LAN, but never from the public website. Pushed
// matches/results instead carry a content-addressed reference URL
// (/api/public/scoring/logo/<sha256 of the bytes>) pointing at a
// ScoringTeamLogo row, with the raw bytes sent at most ONCE per push no
// matter how many fixtures share that team's crest — sending a full base64
// copy inline on every single fixture (the previous approach) is what
// ballooned a single tournament's push payload past several megabytes and
// caused the server to silently time out partway through, dropping results
// with no error surfaced anywhere (see the push route's per-record loop).
const LOGO_URL_PREFIX = `${API_BASE}/api/public/scoring/logo/`;

interface PendingLogo { mimeType: string; base64: string }

// Resolved reference, keyed by the ORIGINAL source string (a local
// http://localhost:PORT/... URL, or an already-embedded data: URI left over
// from before this scheme existed) — so repeated fixtures sharing the same
// team's logo only ever hash/encode it once per app session, not once per
// fixture.
const logoRefCache = new Map<string, { url: string; hash: string; mimeType: string; base64: string }>();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Chunked — spreading a large Uint8Array straight into String.fromCharCode
// blows the call stack once a crest is more than a couple hundred KB.
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Resolves a team's logo into a public reference URL, registering the raw
// bytes into `pending` (deduped by hash, so a team appearing in dozens of
// fixtures in this same push only contributes its bytes once) — accepts a
// local http://localhost:PORT/... URL, an old embedded data: URI (from
// before this scheme existed, or pulled from a venue still on an older
// build), or an already-resolved reference (passed through untouched).
async function resolveLogoRef(url: string | undefined, pending: Map<string, PendingLogo>): Promise<string | undefined> {
  if (!url) return url;
  if (url.startsWith(LOGO_URL_PREFIX)) return url; // already a shared reference — nothing to do

  const cached = logoRefCache.get(url);
  if (cached) {
    pending.set(cached.hash, { mimeType: cached.mimeType, base64: cached.base64 });
    return cached.url;
  }

  let bytes: Uint8Array;
  let mimeType = 'image/png';
  try {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      mimeType = url.slice(5, comma).split(';')[0] || mimeType;
      bytes = Uint8Array.from(atob(url.slice(comma + 1)), c => c.charCodeAt(0));
    } else {
      const res = await fetch(resolveImageUrl(url));
      if (!res.ok) return undefined;
      mimeType = res.headers.get('content-type') || mimeType;
      bytes = new Uint8Array(await res.arrayBuffer());
    }
  } catch {
    return undefined; // offline/unreachable — falls back to no logo rather than a broken local URL
  }

  const hash = await sha256Hex(bytes);
  const base64 = bytesToBase64(bytes);
  const refUrl = `${LOGO_URL_PREFIX}${hash}`;
  logoRefCache.set(url, { url: refUrl, hash, mimeType, base64 });
  pending.set(hash, { mimeType, base64 });
  return refUrl;
}

async function withLogoRefs<T extends { teamALogo?: string; teamBLogo?: string }>(obj: T, pending: Map<string, PendingLogo>): Promise<T> {
  const [teamALogo, teamBLogo] = await Promise.all([resolveLogoRef(obj.teamALogo, pending), resolveLogoRef(obj.teamBLogo, pending)]);
  return { ...obj, teamALogo: teamALogo ?? obj.teamALogo, teamBLogo: teamBLogo ?? obj.teamBLogo };
}

// Same idea as withLogoRefs, for a SavedTeam's own single `logo` field
// instead of a match/result's teamA/teamB pair.
async function withTeamLogoRef<T extends { logo?: string }>(obj: T, pending: Map<string, PendingLogo>): Promise<T> {
  const logo = await resolveLogoRef(obj.logo, pending);
  return { ...obj, logo: logo ?? obj.logo };
}

// Shared by pushAll (every cloud-enabled tournament, debounced) and
// pushTournamentNow (one tournament, on demand) so both send the exact same
// payload shape and both stamp this device's venue onto un-labeled rows.
// `incremental` — true for the automatic background push, which only sends
// tournaments/matches/results that actually differ from the last confirmed-
// pushed (or pulled) snapshot; false for a manual "Push Now", which always
// sends everything for that tournament so it reliably reconciles regardless
// of what this device's cache thinks the cloud already has.
async function buildPushPayload(tournaments: Tournament[], incremental: boolean) {
  const venueLabel = useAppSettings.getState().canvasVenue || undefined;
  const tournamentIds = new Set(tournaments.map(t => t.id));
  const allMatches = useMatchScheduleStore.getState().matches.filter(m => m.tournamentId && tournamentIds.has(m.tournamentId));
  const allResults = useMatchResultsStore.getState().results.filter(r => r.tournamentId && tournamentIds.has(r.tournamentId));
  const allTeams = useTeamDbStore.getState().teams.filter(tm => tm.tournamentId && tournamentIds.has(tm.tournamentId));

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

  // Auto match number (e.g. "MB1") — computed per tournament (each has its
  // own prefix/venue letters) from that tournament's FULL local match list,
  // so the running sequence reflects the whole schedule, not just whatever
  // subset happens to be in this particular push. Carried onto a result via
  // its sourceScheduleId so a completed fixture keeps showing the same
  // number it had while still upcoming.
  const matchNumbers = new Map<string, string>();
  for (const t of tournaments) {
    const tMatches = allMatches.filter(m => m.tournamentId === t.id);
    for (const [id, code] of computeMatchNumbers(tMatches, t.matchNumberPrefix, t.venuePrefixes)) {
      matchNumbers.set(id, code);
    }
  }

  const pendingLogos = new Map<string, PendingLogo>();
  const [matchesData, resultsData, teamsData] = await Promise.all([
    Promise.all(allMatches.map(async m => {
      const base = { ...(await withLogoRefs(m, pendingLogos)), matchNumber: matchNumbers.get(m.id) };
      if (m.completedAt) return base;
      const live = getLiveScoreForMatch(m.id);
      return live ? { ...base, liveScoreA: live.scoreA, liveScoreB: live.scoreB, liveScoreLog: live.scoreLog } : base;
    })),
    Promise.all(allResults.map(async r => ({
      ...(await withLogoRefs(r, pendingLogos)),
      matchNumber: r.sourceScheduleId ? matchNumbers.get(r.sourceScheduleId) : undefined,
    }))),
    Promise.all(allTeams.map(tm => withTeamLogoRef(tm, pendingLogos))),
  ]);

  // An old embedded data: URI (from before this hash-based scheme existed,
  // or pulled from a venue still on an older build) genuinely bloats local
  // storage, so THAT case is worth resolving down to a short reference and
  // writing back locally. An already-compact local server URL
  // (http://<lan-ip>:PORT/images/...) gets no such benefit — it's already
  // short — so it's deliberately left alone here: overwriting it with the
  // cloud reference would force this device to fetch its own team's logo
  // back over the internet (e.g. every time it's sent to vMix) instead of
  // over the LAN, for zero local storage gain. The push payload above still
  // always uses the resolved cloud reference regardless, since the cloud/
  // website can only ever reach a publicly-resolvable URL, never this
  // device's own LAN address.
  allMatches.forEach((m, i) => {
    const { teamALogo, teamBLogo } = matchesData[i];
    const patch: { teamALogo?: string; teamBLogo?: string } = {};
    if (m.teamALogo?.startsWith('data:') && teamALogo !== m.teamALogo) patch.teamALogo = teamALogo;
    if (m.teamBLogo?.startsWith('data:') && teamBLogo !== m.teamBLogo) patch.teamBLogo = teamBLogo;
    if (Object.keys(patch).length > 0) useMatchScheduleStore.getState().updateMatch(m.id, patch);
  });
  allTeams.forEach((tm, i) => {
    const { logo } = teamsData[i];
    if (tm.logo?.startsWith('data:') && logo !== tm.logo) useTeamDbStore.getState().updateTeam(tm.id, { logo });
  });
  allResults.forEach((r, i) => {
    const { teamALogo, teamBLogo } = resultsData[i];
    const patch: { teamALogo?: string; teamBLogo?: string } = {};
    if (r.teamALogo?.startsWith('data:') && teamALogo !== r.teamALogo) patch.teamALogo = teamALogo;
    if (r.teamBLogo?.startsWith('data:') && teamBLogo !== r.teamBLogo) patch.teamBLogo = teamBLogo;
    if (Object.keys(patch).length > 0) useMatchResultsStore.getState().updateResult(r.id, patch);
  });

  // Fixtures/results deleted locally since the last push — sent with every
  // push (not scoped to `tournaments`, since once something's deleted there's
  // no local record left to know which tournament it belonged to) so the
  // cloud's copy actually gets removed too, instead of a push only ever
  // being able to add/update and never take anything away. This is what
  // keeps the public scoring page from showing something the controller no
  // longer has at all.
  const deletedMatchIds = [...useMatchScheduleStore.getState().pendingDeletedIds];
  const deletedResultIds = [...useMatchResultsStore.getState().pendingDeletedIds];
  const deletedTeamIds = [...useTeamDbStore.getState().pendingDeletedIds];

  // Reconcile against the cloud's current state for exactly these
  // tournaments, on every push (not just a manual one) — anything the cloud
  // has that the controller doesn't have locally at all any more gets
  // removed too, not just what was explicitly deleted since last sync. This
  // catches a tombstone lost to a crash, or data left over from before
  // deletions were ever pushed — the whole point being the cloud should
  // never show something the controller no longer has. If the cloud can't
  // be reached, the push still proceeds with just the explicit tombstones.
  const headers = authHeaders();
  if (headers) {
    const localMatchIds = new Set(allMatches.map(m => m.id));
    const localResultIds = new Set(allResults.map(r => r.id));
    const localTeamIds = new Set(allTeams.map(tm => tm.id));
    for (const t of tournaments) {
      try {
        const cloudRes = await fetch(`${API_BASE}/api/desktop/scoring/pull?tournamentId=${encodeURIComponent(t.id)}&since=`, { headers });
        if (!cloudRes.ok) continue;
        const cloudBody: { matches?: { id: string }[]; results?: { id: string }[]; teams?: { id: string }[] } = await cloudRes.json();
        for (const cm of cloudBody.matches ?? []) {
          if (!localMatchIds.has(cm.id) && !deletedMatchIds.includes(cm.id)) deletedMatchIds.push(cm.id);
        }
        for (const cr of cloudBody.results ?? []) {
          if (!localResultIds.has(cr.id) && !deletedResultIds.includes(cr.id)) deletedResultIds.push(cr.id);
        }
        for (const ct of cloudBody.teams ?? []) {
          if (!localTeamIds.has(ct.id) && !deletedTeamIds.includes(ct.id)) deletedTeamIds.push(ct.id);
        }
      } catch {
        // Offline/unreachable for this tournament — skip reconcile, the
        // explicit tombstones above still apply.
      }
    }
  }

  const tournamentRows = tournaments.map(t => {
    const { cloudSyncEnabled, ...rest } = t;
    // Team name -> position within its Draw group (see teamDbStore's
    // groupPosition), so the website's standings table can seed in Draw
    // order too, same reasoning as computeStandings here on the controller
    // — teams/groupPosition are never otherwise pushed at all (only
    // matches/results are), so without this the website has no way to know
    // draw order and just falls back to whatever order it first encounters
    // a team's name across the fixture list.
    const teamOrder: Record<string, number> = {};
    const tTeams = useTeamDbStore.getState().teams.filter(tm => tm.tournamentId === t.id);
    const byGroup = new Map<string, typeof tTeams>();
    for (const tm of tTeams) {
      const g = tm.group ?? '';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(tm);
    }
    for (const members of byGroup.values()) {
      [...members]
        .sort((a, b) => (a.groupPosition ?? Infinity) - (b.groupPosition ?? Infinity) || a.name.localeCompare(b.name))
        .forEach((tm, i) => { teamOrder[tm.name.trim().toLowerCase()] = i; });
    }
    const data = { ...rest, teamOrder };
    // eventId is also sent as its own top-level field (in addition to living
    // inside `data`) so the server can store it as a real, queryable column
    // for the website's scoring overview page to join on. eventShareKey
    // rides along the same way — only actually needed (and only ever
    // checked server-side) when eventId points to a different vendor's
    // event, see the push route's own validation.
    return { id: t.id, name: t.name, sport: t.sport, eventId: t.eventId, eventShareKey: t.eventShareKey, data };
  });
  const matchRows = allMatches.map((m, i) => ({ id: m.id, tournamentId: m.tournamentId!, venueLabel: m.venueLabel ?? venueLabel, data: matchesData[i] }));
  const resultRows = allResults.map((r, i) => ({ id: r.id, tournamentId: r.tournamentId!, venueLabel: r.venueLabel ?? venueLabel, data: resultsData[i] }));
  const teamRows = allTeams.map((tm, i) => ({ id: tm.id, tournamentId: tm.tournamentId!, venueLabel, data: teamsData[i] }));

  return {
    tournaments: incremental ? tournamentRows.filter(t => recordKey(undefined, t.data) !== lastPushedTournament.get(t.id)) : tournamentRows,
    matches: incremental ? matchRows.filter(m => recordKey(m.venueLabel, m.data) !== lastPushedMatch.get(m.id)) : matchRows,
    results: incremental ? resultRows.filter(r => recordKey(r.venueLabel, r.data) !== lastPushedResult.get(r.id)) : resultRows,
    teams: incremental ? teamRows.filter(tm => recordKey(tm.venueLabel, tm.data) !== lastPushedTeam.get(tm.id)) : teamRows,
    logos: Array.from(pendingLogos, ([hash, v]) => ({ hash, mimeType: v.mimeType, base64: v.base64 })),
    deletedMatchIds,
    deletedResultIds,
    deletedTeamIds,
  };
}

// Records what a successful push actually sent as "now confirmed on the
// cloud" — both for the automatic push's own next diff, and so a manual
// full push doesn't cause the very next automatic push to redundantly
// re-send the same records again.
function recordPushed(payload: {
  tournaments: { id: string; data: unknown }[];
  matches: { id: string; venueLabel?: string; data: unknown }[];
  results: { id: string; venueLabel?: string; data: unknown }[];
  teams: { id: string; venueLabel?: string; data: unknown }[];
}) {
  for (const t of payload.tournaments) lastPushedTournament.set(t.id, recordKey(undefined, t.data));
  for (const m of payload.matches) lastPushedMatch.set(m.id, recordKey(m.venueLabel, m.data));
  for (const r of payload.results) lastPushedResult.set(r.id, recordKey(r.venueLabel, r.data));
  for (const tm of payload.teams) lastPushedTeam.set(tm.id, recordKey(tm.venueLabel, tm.data));
}

function clearPushedDeletions(payload: { deletedMatchIds: string[]; deletedResultIds: string[]; deletedTeamIds: string[] }) {
  if (payload.deletedMatchIds.length) {
    useMatchScheduleStore.getState().clearPendingDeletedIds(payload.deletedMatchIds);
    for (const id of payload.deletedMatchIds) lastPushedMatch.delete(id);
  }
  if (payload.deletedResultIds.length) {
    useMatchResultsStore.getState().clearPendingDeletedIds(payload.deletedResultIds);
    for (const id of payload.deletedResultIds) lastPushedResult.delete(id);
  }
  if (payload.deletedTeamIds.length) {
    useTeamDbStore.getState().clearPendingDeletedIds(payload.deletedTeamIds);
    for (const id of payload.deletedTeamIds) lastPushedTeam.delete(id);
  }
}

// Automatic background push — diffs against what's already confirmed on the
// cloud (see lastPushedTournament/Match/Result) so a debounced push
// triggered by editing ONE fixture doesn't re-upload every other unchanged
// record in the tournament too. Skips the request entirely when the diff
// (plus tombstones/logos) comes back empty, e.g. a store change unrelated to
// any pushed field still triggered this cycle.
async function pushAll() {
  if (pushInFlight) return;
  const headers = authHeaders();
  if (!headers) return;

  // foreignVendor is excluded explicitly (not just implied by
  // cloudSyncEnabled being false at creation, see pullAll) — this device
  // never owns that tournament, so it must never be pushed even if
  // cloudSyncEnabled somehow ends up true on it.
  const tournaments = useTournamentStore.getState().tournaments.filter(t => t.cloudSyncEnabled && !t.foreignVendor);
  if (tournaments.length === 0) return;

  pushInFlight = true;
  useCloudSyncStatus.getState().setPushing(true);
  try {
    const payload = await buildPushPayload(tournaments, true);
    if (
      payload.tournaments.length === 0 && payload.matches.length === 0 && payload.results.length === 0 &&
      payload.teams.length === 0 && payload.logos.length === 0 && payload.deletedMatchIds.length === 0 &&
      payload.deletedResultIds.length === 0 && payload.deletedTeamIds.length === 0
    ) {
      return;
    }
    const bodyStr = JSON.stringify(payload);
    const res = await fetch(`${API_BASE}/api/desktop/scoring/push`, {
      method: 'POST',
      headers,
      body: bodyStr,
    });
    if (res.ok) {
      clearPushedDeletions(payload);
      recordPushed(payload);
      useCloudSyncStatus.getState().setLastError(null);
    } else {
      // The server's own error text (e.g. "Invalid JSON body") is far more
      // useful than the bare status code alone — pushTournamentNow already
      // surfaces it, this background path silently discarded it before.
      // Payload size is included too since a request this large failing to
      // parse server-side usually means it was truncated hitting some size
      // limit upstream (hosting platforms commonly cap serverless function
      // request bodies in the low single-digit MB), not a malformed value.
      const serverMsg = await res.json().catch(() => null);
      const sizeMb = (bodyStr.length / 1024 / 1024).toFixed(2);
      useCloudSyncStatus.getState().setLastError(
        `Push failed (${res.status})${serverMsg?.error ? `: ${serverMsg.error}` : ''} — payload ${sizeMb}MB`
      );
    }
  } catch {
    // Offline/network failure — no watermark to roll back, the next
    // debounced push or the next 30s pull tick just retries naturally.
  } finally {
    pushInFlight = false;
    useCloudSyncStatus.getState().setPushing(false);
  }
}

/** Immediately pushes ONE tournament's full current data — bypasses the
 *  normal 2.5s debounce AND the cloudSyncEnabled gate (it's an explicit
 *  one-off "push right now" action, e.g. right after a batch of edits, or
 *  to confirm data actually reached the cloud, rather than trusting the
 *  next automatic tick). Returns success/failure so the caller can show
 *  feedback — unlike pushAll, which runs silently in the background. */
export async function pushTournamentNow(tournamentId: string): Promise<{ ok: boolean; error?: string }> {
  const headers = authHeaders();
  if (!headers) return { ok: false, error: 'Not signed in' };
  const tournament = useTournamentStore.getState().tournaments.find(t => t.id === tournamentId);
  if (!tournament) return { ok: false, error: 'Tournament not found' };
  if (tournament.foreignVendor) return { ok: false, error: 'This tournament belongs to another organisation — you can\'t push changes to it.' };

  useCloudSyncStatus.getState().setPushing(true);
  try {
    // buildPushPayload already reconciles against the cloud's current state
    // for this tournament (see there) — anything the cloud has that the
    // controller doesn't have locally gets included in deletedMatchIds/
    // deletedResultIds automatically. Not incremental — a manual push always
    // sends everything for this tournament, so it reliably reconciles
    // regardless of what this device's diff cache thinks the cloud has.
    const payload = await buildPushPayload([tournament], false);

    const res = await fetch(`${API_BASE}/api/desktop/scoring/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const error = body?.error || `Push failed (${res.status})`;
      useCloudSyncStatus.getState().setLastError(error);
      return { ok: false, error };
    }
    clearPushedDeletions(payload);
    recordPushed(payload);
    useCloudSyncStatus.getState().setLastError(null);
    return { ok: true };
  } catch {
    const error = 'Network error — check your connection';
    useCloudSyncStatus.getState().setLastError(error);
    return { ok: false, error };
  } finally {
    useCloudSyncStatus.getState().setPushing(false);
  }
}

/** Manual "results only" push — sends just this tournament's saved results
 *  (with their own logo dedup/match-number labelling), leaving matches,
 *  teams and tournament settings completely untouched either locally or on
 *  the cloud. For when an operator wants results specifically confirmed in
 *  sync without waiting for (or triggering) a full tournament push. */
export async function pushResultsOnly(tournamentId: string): Promise<{ ok: boolean; error?: string; count?: number }> {
  const headers = authHeaders();
  if (!headers) return { ok: false, error: 'Not signed in' };
  const tournament = useTournamentStore.getState().tournaments.find(t => t.id === tournamentId);
  if (!tournament) return { ok: false, error: 'Tournament not found' };
  if (tournament.foreignVendor) return { ok: false, error: 'This tournament belongs to another organisation — you can\'t push changes to it.' };

  useCloudSyncStatus.getState().setPushing(true);
  try {
    const allMatches = useMatchScheduleStore.getState().matches.filter(m => m.tournamentId === tournamentId);
    const allResults = useMatchResultsStore.getState().results.filter(r => r.tournamentId === tournamentId);
    const matchNumbers = new Map(computeMatchNumbers(allMatches, tournament.matchNumberPrefix, tournament.venuePrefixes));

    const pendingLogos = new Map<string, PendingLogo>();
    const resultsData = await Promise.all(allResults.map(async r => ({
      ...(await withLogoRefs(r, pendingLogos)),
      matchNumber: r.sourceScheduleId ? matchNumbers.get(r.sourceScheduleId) : undefined,
    })));
    // See buildPushPayload's identical guard — only a genuinely bloated
    // data: URI is worth resolving down locally; an already-compact local
    // server URL is left alone so this device keeps using its own LAN path.
    allResults.forEach((r, i) => {
      const { teamALogo, teamBLogo } = resultsData[i];
      const patch: { teamALogo?: string; teamBLogo?: string } = {};
      if (r.teamALogo?.startsWith('data:') && teamALogo !== r.teamALogo) patch.teamALogo = teamALogo;
      if (r.teamBLogo?.startsWith('data:') && teamBLogo !== r.teamBLogo) patch.teamBLogo = teamBLogo;
      if (Object.keys(patch).length > 0) useMatchResultsStore.getState().updateResult(r.id, patch);
    });

    const venueLabel = useAppSettings.getState().canvasVenue || undefined;
    const resultRows = allResults.map((r, i) => ({ id: r.id, tournamentId: r.tournamentId!, venueLabel: r.venueLabel ?? venueLabel, data: resultsData[i] }));
    const logos = Array.from(pendingLogos, ([hash, v]) => ({ hash, mimeType: v.mimeType, base64: v.base64 }));

    const res = await fetch(`${API_BASE}/api/desktop/scoring/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ results: resultRows, logos }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const error = body?.error || `Push failed (${res.status})`;
      useCloudSyncStatus.getState().setLastError(error);
      return { ok: false, error };
    }
    for (const r of resultRows) lastPushedResult.set(r.id, recordKey(r.venueLabel, r.data));
    useCloudSyncStatus.getState().setLastError(null);
    return { ok: true, count: resultRows.length };
  } catch {
    const error = 'Network error — check your connection';
    useCloudSyncStatus.getState().setLastError(error);
    return { ok: false, error };
  } finally {
    useCloudSyncStatus.getState().setPushing(false);
  }
}

/** Manual "results only" pull — fetches this tournament's current results
 *  from the cloud and merges them in, leaving matches/teams/tournament
 *  settings alone (pulled but never applied, even if this device's copy of
 *  those happens to be stale — this button is scoped to results only). */
export async function pullResultsOnly(tournamentId: string): Promise<{ ok: boolean; error?: string; count?: number }> {
  const headers = authHeaders();
  if (!headers) return { ok: false, error: 'Not signed in' };
  useCloudSyncStatus.getState().setPulling(true);
  try {
    const res = await fetch(`${API_BASE}/api/desktop/scoring/pull?tournamentId=${encodeURIComponent(tournamentId)}&since=`, { headers });
    if (!res.ok) {
      const error = `Pull failed (${res.status})`;
      useCloudSyncStatus.getState().setLastError(error);
      return { ok: false, error };
    }
    const body: { results?: { id: string; tournamentId: string; venueLabel?: string; data: any }[] } = await res.json();
    for (const rr of body.results ?? []) {
      const incoming: SavedMatchResult = { ...rr.data, id: rr.id, tournamentId: rr.tournamentId, venueLabel: rr.venueLabel };
      useMatchResultsStore.setState(s => ({ results: upsertById(s.results, incoming) }));
      lastPushedResult.set(rr.id, recordKey(rr.venueLabel, rr.data));
    }
    useCloudSyncStatus.getState().setLastError(null);
    return { ok: true, count: (body.results ?? []).length };
  } catch {
    const error = 'Network error — check your connection';
    useCloudSyncStatus.getState().setLastError(error);
    return { ok: false, error };
  } finally {
    useCloudSyncStatus.getState().setPulling(false);
  }
}

const isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Downloads any cloud-hosted logo (a URL under LOGO_URL_PREFIX) still
 *  referenced by this tournament's teams/fixtures/results back down into
 *  this device's own local image server, and repoints those records at the
 *  new local copy — the actual fix for a team/fixture that was already
 *  pinned to the cloud URL before the push-side overwrite bug was fixed (see
 *  that fix's own commit): there's no way to recover the ORIGINAL local
 *  file that was pushed, but the cloud has the exact same bytes under a
 *  stable, content-addressed URL, so re-downloading and re-importing it
 *  locally reaches the same end state. A manual, explicit action (like Push
 *  Now/Pull Now) rather than something that runs silently on launch, since
 *  it downloads and writes files rather than just reconciling in-memory
 *  state. Same cloud URL is only ever downloaded once per call even if
 *  referenced by many rows (team logo + every fixture/result using it). */
export async function localizeTournamentLogos(tournamentId: string): Promise<{ ok: boolean; error?: string; count?: number }> {
  if (!isTauriApp) return { ok: false, error: 'Only available in the desktop app' };

  const resolved = new Map<string, string>();
  async function localize(url: string | undefined): Promise<string | undefined> {
    if (!url || !url.startsWith(LOGO_URL_PREFIX)) return undefined; // not a cloud ref — nothing to do
    const already = resolved.get(url);
    if (already) return already;
    try {
      const res = await fetch(url);
      if (!res.ok) return undefined;
      const mimeType = res.headers.get('content-type') || 'image/png';
      const bytes = new Uint8Array(await res.arrayBuffer());
      const base64 = bytesToBase64(bytes);
      const hash = url.slice(LOGO_URL_PREFIX.length);
      const ext = mimeType.split('/')[1]?.split('+')[0] || 'png';
      const { invoke } = await import('@tauri-apps/api/core');
      const saved = await invoke<{ name: string; url: string }>('import_image', {
        name: `logo_${hash.slice(0, 16)}.${ext}`, dataBase64: base64, tournamentId,
      });
      resolved.set(url, saved.url);
      return saved.url;
    } catch {
      return undefined; // offline/unreachable this cycle — leave the cloud ref in place, harmless
    }
  }

  try {
    let count = 0;
    for (const t of useTeamDbStore.getState().teams.filter(t => t.tournamentId === tournamentId)) {
      const logo = await localize(t.logo);
      if (logo) { useTeamDbStore.getState().updateTeam(t.id, { logo }); count++; }
    }
    for (const m of useMatchScheduleStore.getState().matches.filter(m => m.tournamentId === tournamentId)) {
      const [teamALogo, teamBLogo] = await Promise.all([localize(m.teamALogo), localize(m.teamBLogo)]);
      const patch: { teamALogo?: string; teamBLogo?: string } = {};
      if (teamALogo) patch.teamALogo = teamALogo;
      if (teamBLogo) patch.teamBLogo = teamBLogo;
      if (Object.keys(patch).length > 0) { useMatchScheduleStore.getState().updateMatch(m.id, patch); count++; }
    }
    for (const r of useMatchResultsStore.getState().results.filter(r => r.tournamentId === tournamentId)) {
      const [teamALogo, teamBLogo] = await Promise.all([localize(r.teamALogo), localize(r.teamBLogo)]);
      const patch: { teamALogo?: string; teamBLogo?: string } = {};
      if (teamALogo) patch.teamALogo = teamALogo;
      if (teamBLogo) patch.teamBLogo = teamBLogo;
      if (Object.keys(patch).length > 0) { useMatchResultsStore.getState().updateResult(r.id, patch); count++; }
    }
    return { ok: true, count };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface PushDiffItem {
  kind: 'match' | 'result';
  status: 'new' | 'updated' | 'removed';
  label: string;
  detail?: string;
}

// Only these fields matter for deciding whether a fixture/result "changed"
// from what's already on the cloud — comparing full objects would flag
// harmless noise (key ordering, undefined-vs-missing fields) as a change.
function matchFingerprint(d: any) {
  return {
    teamAName: d.teamAName ?? '', teamBName: d.teamBName ?? '',
    scoreA: d.scoreA ?? 0, scoreB: d.scoreB ?? 0,
    round: d.round ?? '', date: d.date ?? '', time: d.time ?? '',
    completedAt: !!d.completedAt, matchType: d.matchType ?? '',
  };
}
function resultFingerprint(d: any) {
  return {
    teamAName: d.teamAName ?? '', teamBName: d.teamBName ?? '',
    scoreA: d.scoreA ?? 0, scoreB: d.scoreB ?? 0,
    round: d.round ?? '', date: d.date ?? '',
  };
}
function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return Object.keys(a).every(k => a[k] === b[k]);
}

/** Compares this device's local fixtures/results for a tournament against
 *  what's currently on the cloud, so "Push Now" can show exactly what's
 *  about to be overwritten before it happens — a push always fully replaces
 *  the cloud's copy of each record with the local one, so anything genuinely
 *  different there is about to be lost. Returns an empty array if nothing
 *  meaningful differs, or null if the cloud couldn't be reached (caller
 *  should just push directly rather than block on an unreachable check). */
export async function computePushDiff(tournamentId: string): Promise<PushDiffItem[] | null> {
  const headers = authHeaders();
  if (!headers) return null;
  try {
    const res = await fetch(`${API_BASE}/api/desktop/scoring/pull?tournamentId=${encodeURIComponent(tournamentId)}&since=`, { headers });
    if (!res.ok) return null;
    const body: { matches?: { id: string; data: any }[]; results?: { id: string; data: any }[] } = await res.json();
    const cloudMatches = new Map((body.matches ?? []).map(m => [m.id, m.data]));
    const cloudResults = new Map((body.results ?? []).map(r => [r.id, r.data]));

    const localMatches = useMatchScheduleStore.getState().matches.filter(m => m.tournamentId === tournamentId);
    const localResults = useMatchResultsStore.getState().results.filter(r => r.tournamentId === tournamentId);

    const items: PushDiffItem[] = [];
    for (const m of localMatches) {
      const label = `${m.teamAName || 'TBD'} vs ${m.teamBName || 'BYE'}${m.round ? ` — ${m.round}` : ''}`;
      const cloud = cloudMatches.get(m.id);
      if (!cloud) {
        items.push({ kind: 'match', status: 'new', label });
        continue;
      }
      const localFp = matchFingerprint(m);
      const cloudFp = matchFingerprint(cloud);
      if (!shallowEqual(localFp, cloudFp)) {
        const detail = (cloudFp.scoreA !== localFp.scoreA || cloudFp.scoreB !== localFp.scoreB)
          ? `Score: ${cloudFp.scoreA}-${cloudFp.scoreB} → ${localFp.scoreA}-${localFp.scoreB}`
          : undefined;
        items.push({ kind: 'match', status: 'updated', label, detail });
      }
    }
    for (const r of localResults) {
      const label = `${r.teamAName} vs ${r.teamBName}${r.round ? ` — ${r.round}` : ''}`;
      const cloud = cloudResults.get(r.id);
      if (!cloud) {
        items.push({ kind: 'result', status: 'new', label, detail: `${r.scoreA}-${r.scoreB}` });
        continue;
      }
      const localFp = resultFingerprint(r);
      const cloudFp = resultFingerprint(cloud);
      if (!shallowEqual(localFp, cloudFp)) {
        items.push({ kind: 'result', status: 'updated', label, detail: `${cloudFp.scoreA}-${cloudFp.scoreB} → ${localFp.scoreA}-${localFp.scoreB}` });
      }
    }

    // Cloud has these but the controller doesn't have them at all any more
    // (deleted locally, or left over from before push started cleaning up
    // after itself) — a push removes them too, not just add/update.
    const localMatchIds = new Set(localMatches.map(m => m.id));
    const localResultIds = new Set(localResults.map(r => r.id));
    for (const [id, cloud] of cloudMatches) {
      if (localMatchIds.has(id)) continue;
      items.push({ kind: 'match', status: 'removed', label: `${cloud.teamAName || 'TBD'} vs ${cloud.teamBName || 'BYE'}${cloud.round ? ` — ${cloud.round}` : ''}` });
    }
    for (const [id, cloud] of cloudResults) {
      if (localResultIds.has(id)) continue;
      items.push({ kind: 'result', status: 'removed', label: `${cloud.teamAName} vs ${cloud.teamBName}${cloud.round ? ` — ${cloud.round}` : ''}`, detail: `${cloud.scoreA}-${cloud.scoreB}` });
    }
    return items;
  } catch {
    return null;
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
  useCloudSyncStatus.getState().setPulling(true);
  try {
    const res = await fetch(`${API_BASE}/api/desktop/scoring/pull?since=${encodeURIComponent(pullWatermark)}`, { headers });
    if (!res.ok) return;
    const body: {
      serverTime?: string;
      /** `foreign: true` = pulled in from a DIFFERENT vendor's tournament
       *  sharing an eventId with one of this device's own (see
       *  scoring/pull's own cross-venue merge) — read-only on this device,
       *  see Tournament.foreignVendor. */
      tournaments?: { id: string; name: string; sport: string; data: any; foreign?: boolean }[];
      matches?: { id: string; tournamentId: string; venueLabel?: string; data: any }[];
      results?: { id: string; tournamentId: string; venueLabel?: string; data: any }[];
      teams?: { id: string; tournamentId: string; venueLabel?: string; data: any }[];
    } = await res.json();

    const liveIds = getLiveFixtureIds();

    for (const rt of body.tournaments ?? []) {
      const local = useTournamentStore.getState().tournaments.find(t => t.id === rt.id);
      if (local) {
        // Partial merge via updateTournament preserves cloudSyncEnabled —
        // a device's own opt-out is never silently overwritten by a pull.
        useTournamentStore.getState().updateTournament(rt.id, rt.data);
      } else if (rt.foreign) {
        // Never opted into sync locally regardless of the server's own
        // record — this device doesn't own it, so it must never end up in
        // pushAll's scope (which gates purely on cloudSyncEnabled). The
        // server-side push route would reject the write anyway, but keeping
        // it out of scope here means it's never even attempted.
        const created: Tournament = { ...rt.data, id: rt.id, name: rt.name, sport: rt.sport, cloudSyncEnabled: false, foreignVendor: true };
        useTournamentStore.setState(s => ({ tournaments: [...s.tournaments, created] }));
      } else {
        // A tournament that only just appeared via pull was, by definition,
        // already opted into sync by whichever venue created it.
        const created: Tournament = { ...rt.data, id: rt.id, name: rt.name, sport: rt.sport, cloudSyncEnabled: true };
        useTournamentStore.setState(s => ({ tournaments: [...s.tournaments, created] }));
      }
      // A pulled record is by definition already on the cloud — recording it
      // here too means an unrelated later push doesn't redundantly re-upload
      // data this device only just received from another venue.
      lastPushedTournament.set(rt.id, recordKey(undefined, rt.data));
    }

    for (const rm of body.matches ?? []) {
      // "Live on this device" only protects an in-progress fixture from
      // being clobbered — it must never block the ONE update that actually
      // matters once another venue finishes it: completedAt. Without this
      // exception, a fixture this device also has loaded (even just
      // idly, on a mirrored/linked board) would stay stuck showing as live
      // here forever, since completedAt never had a chance to arrive.
      if (liveIds.has(rm.id) && !(rm.data as any)?.completedAt) continue;
      const incoming: ScheduledMatch = { ...rm.data, id: rm.id, tournamentId: rm.tournamentId, venueLabel: rm.venueLabel };
      useMatchScheduleStore.setState(s => ({ matches: upsertById(s.matches, incoming).sort(sortMatches) }));
      lastPushedMatch.set(rm.id, recordKey(rm.venueLabel, rm.data));
    }

    for (const rr of body.results ?? []) {
      const incoming: SavedMatchResult = { ...rr.data, id: rr.id, tournamentId: rr.tournamentId, venueLabel: rr.venueLabel };
      useMatchResultsStore.setState(s => ({ results: upsertById(s.results, incoming) }));
      lastPushedResult.set(rr.id, recordKey(rr.venueLabel, rr.data));
    }

    for (const rtm of body.teams ?? []) {
      const before = useTeamDbStore.getState().teams.find(t => t.id === rtm.id);
      const incoming: SavedTeam = { ...rtm.data, id: rtm.id, tournamentId: rtm.tournamentId };
      useTeamDbStore.setState(s => ({ teams: upsertById(s.teams, incoming) }));
      lastPushedTeam.set(rtm.id, recordKey(rtm.venueLabel, rtm.data));
      // A team edited on ANOTHER venue only carries its OWN fixtures'
      // teamALogo/etc. correctly (that venue's local cascade already fixed
      // those before pushing). This device may separately reference the
      // same team by name in fixtures of its own — never pushed/pulled
      // alongside this particular team update — so cascade here too.
      if (before && (before.name !== incoming.name || before.shortName !== incoming.shortName ||
          before.color !== incoming.color || before.logo !== incoming.logo)) {
        useMatchScheduleStore.getState().syncTeamIdentity(incoming.tournamentId, before.name, before.category, {
          name: incoming.name, shortName: incoming.shortName, color: incoming.color, logo: incoming.logo,
        });
      }
    }

    if (body.serverTime) pullWatermark = body.serverTime;
  } catch {
    // Offline/network failure — watermark unchanged, next 30s tick retries.
  } finally {
    pullInFlight = false;
    useCloudSyncStatus.getState().setPulling(false);
  }
}

/** Starts the background push/pull loop — call once, e.g. from App.tsx.
 *  No-ops if already running. Push fires shortly after any local change to
 *  a cloud-enabled tournament's schedule/results/settings; pull runs on a
 *  flat 30s interval regardless of local activity. Both are silently
 *  skipped whenever signed out (checked per-tick, not just at startup, so
 *  signing out later stops new pushes/pulls without needing to call
 *  stopCloudSync()). */
// One-time local self-heal, run at launch (see startCloudSync below): a
// fixture only ever snapshots a team's name/shortName/color/logo, and
// updateTeam/pullAll's own cascades (syncTeamIdentity) only fire on the NEXT
// change from here on — they can't retroactively fix a fixture that already
// went stale before those cascades existed, or from any other bulk path
// (e.g. an older pulled team update, from before this cascade shipped, that
// never got followed by a further edit to that same team since). Since this
// operates purely on local state (no network), it runs unconditionally —
// re-applying a team's already-current identity to its own fixtures is a
// harmless no-op wherever nothing was actually stale.
function reconcileFixtureTeamIdentities() {
  const { teams } = useTeamDbStore.getState();
  const { syncTeamIdentity } = useMatchScheduleStore.getState();
  for (const t of teams) {
    syncTeamIdentity(t.tournamentId, t.name, t.category, {
      name: t.name, shortName: t.shortName, color: t.color, logo: t.logo,
    });
  }
}

// Same self-heal reasoning, for a different staleness: resetAllSent/
// unmarkSent's own cascade (see canvasStore's resetScoreboardStateForMatches)
// only fires at the moment a fixture is actually reset — it can't
// retroactively clear a scoreboard that was already left stale before that
// cascade existed. That includes a fixture reset on a DIFFERENT venue's
// device that hasn't been updated yet: this device only ever sees whatever
// stale score/log THAT device last pushed, and has no way to reach into its
// canvasStore — but re-running the cascade here for every currently not-
// sent/not-completed match self-heals THIS device's own scoreboards
// regardless of which past build reset them, and is a no-op wherever a
// linked scoreboard is already clear (or there isn't one at all).
function reconcileScoreboardState() {
  const notPlayedIds = useMatchScheduleStore.getState().matches
    .filter(m => !m.sentAt && !m.completedAt)
    .map(m => m.id);
  useCanvasStore.getState().resetScoreboardStateForMatches(notPlayedIds);
}

export function startCloudSync() {
  if (started) return;
  started = true;

  reconcileFixtureTeamIdentities();
  reconcileScoreboardState();
  // Independent of GOMOLAB's own cloud sync (cloudSyncEnabled) entirely —
  // this refreshes rosters from a THIRD-PARTY public API per Tournament
  // .externalRoster, a separate opt-in. No-ops for any tournament that
  // hasn't linked one, and for any team within it that hasn't been through
  // "Pull from API" at least once (see externalRoster.ts).
  startRosterAutoSync();

  const triggerPush = () => schedulePush();
  unsubscribers.push(useTournamentStore.subscribe(triggerPush));
  unsubscribers.push(useMatchScheduleStore.subscribe(triggerPush));
  unsubscribers.push(useMatchResultsStore.subscribe(triggerPush));
  unsubscribers.push(useTeamDbStore.subscribe(triggerPush));
  // Also on canvasStore — a scoreboard's live score/scoreLog lives only in
  // widget config, not in matchScheduleStore, so without this a live match's
  // running score/breakdown would never actually reach buildPushPayload
  // until something else (e.g. Save Result) touched one of the stores above.
  unsubscribers.push(useCanvasStore.subscribe(triggerPush));

  pullTimer = setInterval(() => { pullAll(); }, PULL_INTERVAL_MS);
  // Kick off an initial pull immediately rather than waiting a full 30s.
  pullAll();
  // ALSO an initial push — lastPushedTournament/Match/Result/Team are
  // in-memory only and reset on every launch, so pushAll()'s own diffing
  // treats everything as "changed" the first time it runs in a session
  // (see its own doc comment) and naturally re-syncs everything once. But
  // that first run only ever happened reactively, off a store subscription
  // firing — a session where nothing gets edited (e.g. the app was just
  // restarted onto a new build that pushes a NEW category of data, like
  // team sync, with no local team edit to trigger it) would otherwise never
  // push anything at all until something incidental changed. Doing it
  // proactively here closes that gap.
  pushAll();
}

export function stopCloudSync() {
  if (pullTimer) clearInterval(pullTimer);
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pullTimer = null;
  pushDebounceTimer = null;
  for (const unsub of unsubscribers) unsub();
  unsubscribers = [];
  started = false;
  stopRosterAutoSync();
}
