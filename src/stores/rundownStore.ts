import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useUndoStore } from './undoStore';
import type { ScheduledMatch } from './matchScheduleStore';

// A broadcast-style running order for the whole event day — segments like
// "Opening Ceremony", "Match 1", "Halftime Entertainment" — distinct from
// matchScheduleStore's fixtures (which only ever represent an actual match
// between two teams). A segment can optionally link to a real fixture (to
// show its live teams/score and auto-complete when its result is saved),
// or stay a plain freeform title/time/notes entry — both kinds coexist in
// one ordered list, deliberately not scoped to a single tournament (a
// rundown spans the whole day, which may cross several tournaments/venues).
export interface RundownSegment {
  id: string;
  /** Plain sequential position, renumbered 0..n-1 on every reorder — unlike
   *  ScheduledMatch's sortIndex there's no "slot identity independent of
   *  content" concept here, so a plain splice-and-renumber is enough. */
  sortIndex: number;
  /** "2026-08-17" — defaults to today when a segment is added. */
  date: string;
  /** "20:30" — optional; no late-detection at all when unset. */
  time?: string;
  /** Planned length in minutes — informational, drives an "overrun"
   *  indicator once a live segment has run longer than this. */
  durationMin?: number;
  /** For a linked segment this is auto-seeded "TeamA vs TeamB" at link
   *  time, and only ever shown again as a fallback if the linked fixture is
   *  later deleted (see linkedScheduleMatchId). */
  title: string;
  notes?: string;
  /** Optional link into matchScheduleStore — when set, this segment's
   *  status is derived entirely from that fixture's own sentAt/completedAt
   *  (see deriveRundownStatus) and sentAt/completedAt below are ignored. */
  linkedScheduleMatchId?: string;
  /** Freeform-only manual status timestamps — same names/semantics as
   *  ScheduledMatch.sentAt/completedAt on purpose, so the same late-badge
   *  formatting applies unchanged. Ignored whenever linkedScheduleMatchId
   *  is set. */
  sentAt?: number;
  completedAt?: number;
}

export type RundownStatus = 'upcoming' | 'live' | 'done';

export function sortRundownSegments(a: RundownSegment, b: RundownSegment): number {
  return ((a.sortIndex ?? 0) - (b.sortIndex ?? 0)) || a.date.localeCompare(b.date);
}

/**
 * For a linked segment, status is derived directly from the linked fixture's
 * own sentAt/completedAt — NOT from matchResultsStore. completedAt is
 * already stamped the instant a result is saved (guardScoreboardOverwrite ->
 * markCompleted, see utils/scoreboardSnapshot.ts), so "auto-complete on
 * save" falls out for free with zero new state. Cross-referencing
 * matchResultsStore instead would drift: deleting a saved result from the
 * Results tab does NOT clear the fixture's completedAt, so a
 * matchResultsStore-based check would wrongly flip a linked segment back to
 * "not done" the moment its result row is deleted, even though the fixture
 * itself is still marked complete. Keying off sentAt/completedAt matches
 * how every other consumer (MatchScheduleWidget, useLiveFixtureIds) already
 * treats those two fields as the sole ground truth.
 */
export function deriveRundownStatus(segment: RundownSegment, linkedMatch: ScheduledMatch | undefined): RundownStatus {
  if (segment.linkedScheduleMatchId) {
    if (!linkedMatch) return 'upcoming'; // orphaned link — fixture was deleted, degrade gracefully
    if (linkedMatch.completedAt) return 'done';
    if (linkedMatch.sentAt) return 'live';
    return 'upcoming';
  }
  if (segment.completedAt) return 'done';
  if (segment.sentAt) return 'live';
  return 'upcoming';
}

interface RundownStore {
  segments: RundownSegment[];
  addSegment: (segment: Omit<RundownSegment, 'id' | 'sortIndex'> & { sortIndex?: number }) => string;
  updateSegment: (id: string, patch: Partial<Omit<RundownSegment, 'id'>>) => void;
  deleteSegment: (id: string) => void;
  markSent: (id: string) => void;
  unmarkSent: (id: string) => void;
  markCompleted: (id: string) => void;
  /** Resets sentAt/completedAt on every segment, or only those in `ids` when
   *  given. Only affects freeform segments — a linked segment's status
   *  comes from its fixture, not from these fields, so this is a no-op for
   *  those (matching how "Reset" only ever meant something for the manually
   *  tracked ones). */
  resetAllSent: (ids?: string[]) => void;
  clearSegments: (ids?: string[]) => void;
  restoreSegments: (segments: unknown[]) => void;
}

export const useRundownStore = create<RundownStore>()(
  persist(
    (set, get) => ({
      segments: [],

      addSegment: (segment) => {
        const id = crypto.randomUUID();
        set(s => {
          const nextSortIndex = s.segments.reduce((max, seg) => Math.max(max, seg.sortIndex ?? 0), 0) + 1;
          return { segments: [...s.segments, { ...segment, id, sortIndex: segment.sortIndex ?? nextSortIndex }].sort(sortRundownSegments) };
        });
        return id;
      },

      updateSegment: (id, patch) => set(s => ({
        segments: s.segments.map(seg => seg.id === id ? { ...seg, ...patch } : seg).sort(sortRundownSegments),
      })),

      deleteSegment: (id) => {
        const segment = get().segments.find(seg => seg.id === id);
        set(s => ({ segments: s.segments.filter(seg => seg.id !== id) }));
        if (segment) useUndoStore.getState().pushUndo(`Deleted segment "${segment.title}"`, () =>
          useRundownStore.setState(s => ({ segments: [...s.segments, segment].sort(sortRundownSegments) })));
      },

      markSent: (id) => set(s => ({
        segments: s.segments.map(seg => seg.id === id ? { ...seg, sentAt: Date.now() } : seg),
      })),

      unmarkSent: (id) => set(s => ({
        segments: s.segments.map(seg => seg.id === id ? { ...seg, sentAt: undefined, completedAt: undefined } : seg),
      })),

      markCompleted: (id) => set(s => ({
        segments: s.segments.map(seg => seg.id === id ? { ...seg, completedAt: Date.now() } : seg),
      })),

      resetAllSent: (ids) => {
        const affected = ids ?? get().segments.map(seg => seg.id);
        set(s => ({
          segments: s.segments.map(seg => affected.includes(seg.id) ? { ...seg, sentAt: undefined, completedAt: undefined } : seg),
        }));
      },

      clearSegments: (ids) => {
        const removed = ids ? get().segments.filter(seg => ids.includes(seg.id)) : get().segments.slice();
        set(s => ({ segments: ids ? s.segments.filter(seg => !ids.includes(seg.id)) : [] }));
        if (removed.length > 0) useUndoStore.getState().pushUndo(`Cleared ${removed.length} segment${removed.length === 1 ? '' : 's'}`, () =>
          useRundownStore.setState(s => ({ segments: [...s.segments, ...removed].sort(sortRundownSegments) })));
      },

      restoreSegments: (segments) => set({ segments: segments as RundownSegment[] }),
    }),
    {
      name: 'gomolab-rundown-v1',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
          ? localStorage
          : sessionStorage
      ),
      // Remote/browser clients always load the host's live data via
      // FULL_STATE — never persist locally, or a reload could show stale
      // data before (or instead of) the synced copy.
      partialize: (s) => (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) ? {} : { segments: s.segments },
    }
  )
);
