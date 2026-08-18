import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useUndoStore } from './undoStore';

// A saved snapshot of a finished match, captured from a scoreboard widget's
// current state at the moment "Save Result" is pressed — powers the
// "recent-matches" widget's results list.
export interface SavedMatchResult {
  id: string;
  /** Which tournament/competition this result belongs to (teamDbStore-scoped). */
  tournamentId?: string;
  date: string; // e.g. "2026-07-09"
  /** Scheduled kickoff time, carried over from the fixture this result came
   *  from (e.g. "20:30") — distinct from savedAt, which is when the result
   *  was actually recorded/the match ended. */
  time?: string;
  competition?: string;
  round?: string;
  /** Pool/group name, or a knockout-stage marker ('Final', 'Semifinal',
   *  'Quarterfinal', 'Round of N', a ranked-placement label, or the literal
   *  '3rd Place' sentinel) — carried over from the originating fixture's
   *  ScheduledMatch.group so standings can tell a group-stage result apart
   *  from a bracket-stage one after it's saved (see isPoolStageResult in
   *  TournamentManager.tsx). Absent for results saved before this field
   *  existed or with no linked fixture. */
  group?: string;
  /** Bracket tier ('Cup', 'Plate', a combined pair like 'Cup/Plate', etc.),
   *  carried over from ScheduledMatch.tier — same purpose as `group` above. */
  tier?: string;
  /** Tournament category (e.g. "Men", "U21") this result belongs to — carried
   *  over from the originating fixture so a same-named team entered in
   *  multiple categories doesn't get its stats/history mixed together. */
  category?: string;
  /** The SavedTeam id behind teamAName/teamBName, when known — same purpose
   *  as ScheduledMatch.teamAId/teamBId: lets matching use an unambiguous id
   *  instead of name+category string matching (still the fallback when
   *  either side lacks one). */
  teamAId?: string;
  teamBId?: string;
  teamAName: string;
  teamAShortName?: string;
  teamALogo?: string;
  teamAColor: string;
  scoreA: number;
  teamBName: string;
  teamBShortName?: string;
  teamBLogo?: string;
  teamBColor: string;
  scoreB: number;
  /** 'bye' = no opponent that round; 'walkover' = one side forfeited a
   *  fixtured match — neither was actually played, carried over from the
   *  originating Schedule fixture so Results/standings can badge it. */
  matchType?: 'bye' | 'walkover';
  walkoverLoser?: 'A' | 'B';
  /** The ScheduledMatch this result came from, when there was one (bye/walkover
   *  auto-generated results, or a normal result saved from a scoreboard that
   *  had a fixture loaded onto it via Load Match/Send to Scoreboard) — lets a
   *  future save for the same fixture find-and-update this result instead of
   *  creating a duplicate. Unset for results entered with no linked fixture. */
  sourceScheduleId?: string;
  /** Trimmed snapshot of the scoreboard's live scoreLog at save time — every
   *  score event that made up the final score (e.g. Try/Conversion/Penalty),
   *  not just the total. Powers head-to-head breakdowns. Absent for
   *  bye/walkover results (no live match ever ran) and any result saved
   *  before this field existed. */
  scoreLog?: { team: 'A' | 'B'; action: string; points: number; scorer?: string; jerseyNo?: string; timeStr?: string; period?: number }[];
  /** Kick-by-kick decider recorded when a match stayed level and a shootout
   *  was used to decide it — soccer penalty shootout, rugby place-kick
   *  competition, or any sport's equivalent. Does NOT change scoreA/scoreB
   *  (which stay as the tied regulation score); only decides the winner for
   *  bracket advancement/standings. Absent for any match not decided by one. */
  shootout?: {
    kicks: { a?: boolean; b?: boolean }[]; // chronological rounds, regulation + sudden death
    scoreA: number; // total makes by A across all rounds
    scoreB: number;
    winner: 'A' | 'B';
  };
  /** Cards given during the match, captured from the linked Player Picker
   *  lists at save time (mirrors the scoreLog capture above). `playerId`/
   *  `jerseyNo`/`playerName` are only resolvable when that Player List's
   *  team was known at save time — older results (and any card given to a
   *  slot with no team resolved) may have just `team`+`type`. Absent when
   *  no Player Picker was linked or no cards were given. */
  cards?: { team: 'A' | 'B'; type: 'yellow' | 'orange' | 'red'; playerId?: string; jerseyNo?: string; playerName?: string }[];
  /** Full squad snapshot from the linked Player List widget(s) at save time —
   *  every player who was ever placed in a starter or sub slot (not just
   *  those still on the pitch at the final whistle), so the scoring page can
   *  show who actually played. Absent for a side with no Player List linked
   *  (or no team resolved on it) — a manually-entered result with only a
   *  scoreline has no lineup data to capture. */
  lineup?: { team: 'A' | 'B'; playerId: string; jerseyNo: string; name: string; section: 'starter' | 'sub'; subbedOn: boolean }[];
  /** Which physical venue pushed this result, for multi-venue cloud sync
   *  (see src/lib/cloudSync.ts) — same convention as ScheduledMatch.venueLabel. */
  venueLabel?: string;
  /** Best-effort snapshot of the linked Timer widget's clock at save time —
   *  absent if no Timer was linked to the scoreboard. `elapsedMs` is total
   *  game time actually played (regular + extra time + after-ET combined,
   *  countdown periods converted to time-played rather than time-remaining)
   *  — a simplified summary, not a frame-perfect replay of every timer
   *  edge case (see computeTimerSummary in src/utils/scoreboardSnapshot.ts). */
  timerSummary?: {
    elapsedMs: number;
    /** Which regular period the match had reached, capped at that sport's
     *  period count. */
    periodsPlayed: number;
    wentToExtraTime: boolean;
    wentToAfterEt: boolean;
  };
  savedAt: number;
}

interface MatchResultsStore {
  results: SavedMatchResult[];
  /** Result ids deleted locally since the last successful cloud push — read
   *  and cleared by cloudSync.ts so a deletion actually removes the record
   *  from the cloud too, instead of leaving a stale copy behind that a push
   *  only ever upserts and never removes on its own. */
  pendingDeletedIds: string[];
  addResult: (result: Omit<SavedMatchResult, 'id' | 'savedAt'>) => string;
  updateResult: (id: string, patch: Partial<Omit<SavedMatchResult, 'id' | 'savedAt'>>) => void;
  deleteResult: (id: string) => void;
  clearResults: () => void;
  restoreResults: (results: unknown[]) => void;
  /** Consumes (removes) the given ids from pendingDeletedIds — called by
   *  cloudSync.ts once they've actually been pushed to the cloud. */
  clearPendingDeletedIds: (ids: string[]) => void;
  /** Collapses any results that share a `sourceScheduleId` (the same fixture)
   *  down to one row each — cleans up duplicates already sitting in saved
   *  data from before results got deterministic ids (see addResult), and
   *  from any older-build venue on a multi-venue sync that still creates
   *  random ids. Keeps the most recently saved row per fixture, marks the
   *  rest pendingDeletedIds so the next push removes them from the cloud
   *  too. Returns how many duplicate rows were removed. Safe/cheap to call
   *  on every launch — a no-op when there's nothing to collapse. */
  dedupeBySourceSchedule: () => number;
}

export const useMatchResultsStore = create<MatchResultsStore>()(
  persist(
    (set, get) => ({
      results: [],
      pendingDeletedIds: [],

      addResult: (result) => {
        // A fixture-linked result gets a DETERMINISTIC id derived from its
        // sourceScheduleId instead of a random one — two independent saves
        // of the same fixture (a local double-save, or two venues on a
        // multi-venue sync each completing it before the other's push/pull
        // caught up) then converge on the same id instead of becoming two
        // separate rows. Cloud sync's upsertById (and the id-keyed upsert
        // below) collapse them naturally instead of accumulating duplicates
        // that double-count in standings. Manually-entered results with no
        // linked fixture keep a random id — there's no reliable natural key
        // to dedupe those against.
        const id = result.sourceScheduleId ? `fixture-${result.sourceScheduleId}` : crypto.randomUUID();
        set(s => {
          const idx = s.results.findIndex(r => r.id === id);
          if (idx !== -1) {
            const next = s.results.slice();
            next[idx] = { ...next[idx], ...result, id, savedAt: Date.now() };
            return { results: next };
          }
          return { results: [{ ...result, id, savedAt: Date.now() }, ...s.results] };
        });
        return id;
      },

      updateResult: (id, patch) => set(s => ({
        results: s.results.map(r => r.id === id ? { ...r, ...patch } : r),
      })),

      deleteResult: (id) => {
        const result = get().results.find(r => r.id === id);
        set(s => ({ results: s.results.filter(r => r.id !== id), pendingDeletedIds: [...s.pendingDeletedIds, id] }));
        if (result) useUndoStore.getState().pushUndo(`Deleted result "${result.teamAName} vs ${result.teamBName}"`, () =>
          useMatchResultsStore.setState(s => ({
            results: [result, ...s.results],
            pendingDeletedIds: s.pendingDeletedIds.filter(x => x !== id),
          })));
      },

      clearResults: () => {
        const removed = get().results.slice();
        const removedIds = removed.map(r => r.id);
        set(s => ({ results: [], pendingDeletedIds: [...s.pendingDeletedIds, ...removedIds] }));
        if (removed.length > 0) useUndoStore.getState().pushUndo(`Cleared ${removed.length} result${removed.length === 1 ? '' : 's'}`, () =>
          useMatchResultsStore.setState(s => ({
            results: [...removed, ...s.results],
            pendingDeletedIds: s.pendingDeletedIds.filter(x => !removedIds.includes(x)),
          })));
      },

      restoreResults: (results) => set({ results: results as SavedMatchResult[] }),

      clearPendingDeletedIds: (ids) => set(s => ({ pendingDeletedIds: s.pendingDeletedIds.filter(id => !ids.includes(id)) })),

      dedupeBySourceSchedule: () => {
        const results = get().results;
        const bySchedule = new Map<string, SavedMatchResult[]>();
        const passthrough: SavedMatchResult[] = [];
        for (const r of results) {
          if (!r.sourceScheduleId) { passthrough.push(r); continue; }
          const arr = bySchedule.get(r.sourceScheduleId) ?? [];
          arr.push(r);
          bySchedule.set(r.sourceScheduleId, arr);
        }
        const rebuilt: SavedMatchResult[] = [...passthrough];
        const removedIds: string[] = [];
        for (const [scheduleId, group] of bySchedule) {
          const canonicalId = `fixture-${scheduleId}`;
          const survivor = group.reduce((a, b) => (b.savedAt > a.savedAt ? b : a));
          rebuilt.push({ ...survivor, id: canonicalId });
          for (const r of group) if (r.id !== canonicalId) removedIds.push(r.id);
        }
        if (removedIds.length === 0) return 0;
        set(s => ({ results: rebuilt, pendingDeletedIds: [...s.pendingDeletedIds, ...removedIds] }));
        return removedIds.length;
      },
    }),
    {
      name: 'gomolab-match-results-v1',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
          ? localStorage
          : sessionStorage
      ),
      // Remote/browser clients always load the host's live data via
      // FULL_STATE — never persist locally, or a reload could show stale
      // data before (or instead of) the synced copy.
      partialize: (s) => (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) ? {} : { results: s.results, pendingDeletedIds: s.pendingDeletedIds },
    }
  )
);
