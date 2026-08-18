import { useTournamentStore } from '../stores/tournamentStore';
import { useMatchScheduleStore, type ScheduledMatch } from '../stores/matchScheduleStore';
import { useMatchResultsStore } from '../stores/matchResultsStore';
import { useTeamDbStore } from '../stores/teamDbStore';
import { useCanvasStore } from '../stores/canvasStore';
import { SPORT_DEFAULTS } from '../types/tournament';
import { tierRank, isPlacementRoundLabel } from './scheduleGen';
import { computeLocalStatsForTeam } from './localPlayerStats';
import {
  computeStandings, findMatchWinner, isPlaceholderTeamName, extractKnockoutStage,
  knockoutStageSize, normalizeGroups, bareStageLabel, isPoolStageResult,
} from '../components/TournamentManager';

const _isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Runs the same four auto-advance steps that used to live as useEffects
// inside TournamentManager (only while the 🏆 Tournament Database window was
// open) — now for EVERY tournament, independent of any window being open, so
// a match completed purely from a canvas Scoreboard widget still resolves
// the next round/pool standings immediately.
export function runTournamentAutoAdvance() {
  const tournaments = useTournamentStore.getState().tournaments;
  const allMatches = useMatchScheduleStore.getState().matches;
  const allResults = useMatchResultsStore.getState().results;
  const allTeams = useTeamDbStore.getState().teams;
  const { updateMatch } = useMatchScheduleStore.getState();
  const { updateResult, deleteResult } = useMatchResultsStore.getState();

  for (const t of tournaments) {
    const scopedMatches = allMatches.filter(m => m.tournamentId === t.id);
    const scopedResults = allResults.filter(r => r.tournamentId === t.id);
    const scopedTeams = allTeams.filter(x => x.tournamentId === t.id);

    // ── 1. Bye/Walkover flag sync ──────────────────────────────────────
    // Fully automatic, no manual per-fixture picker: a fixture with no Team
    // B name is a bye; a fixture where either team currently has 'walkover'
    // status set in the Team Database is a walkover for that side. Keeps
    // every not-yet-completed fixture in sync as fixtures/team statuses change.
    {
      const statusOf = (name: string, shortName?: string) => {
        const key = name.trim().toLowerCase();
        const shortKey = (shortName ?? '').trim().toLowerCase();
        return scopedTeams.find(x =>
          x.name.trim().toLowerCase() === key || (!!shortKey && (x.shortName ?? '').trim().toLowerCase() === shortKey)
        )?.status;
      };
      for (const m of scopedMatches) {
        if (m.completedAt) continue;
        const isByeAuto = !m.teamBName || !m.teamBName.trim();
        let nextType: ScheduledMatch['matchType'];
        let nextLoser: 'A' | 'B' | undefined;
        if (isByeAuto) {
          nextType = 'bye';
        } else if (statusOf(m.teamAName, m.teamAShortName) === 'walkover') {
          nextType = 'walkover'; nextLoser = 'A';
        } else if (statusOf(m.teamBName, m.teamBShortName) === 'walkover') {
          nextType = 'walkover'; nextLoser = 'B';
        }
        if (nextType === m.matchType && nextLoser === m.walkoverLoser) continue;
        // Only ever flags the fixture (badge) and clears any leftover score
        // from before it became a bye/walkover — the actual score is never
        // auto-filled here. It's only ever set once the operator confirms it
        // via the scoreboard's Walkover Confirm popup.
        updateMatch(m.id, { matchType: nextType, walkoverLoser: nextLoser, scoreA: undefined, scoreB: undefined });
      }
    }

    // ── 2. Bye/Walkover result sync ────────────────────────────────────
    // A bye/walkover's Result is only ever created via the scoreboard's
    // Walkover Confirm popup, same as a real live match only becomes a
    // Result once someone acts on it. This just keeps an ALREADY-confirmed
    // auto-result's metadata in sync as the fixture is edited afterwards
    // (round renamed, score corrected, etc.), and removes it if the
    // fixture's walkover/bye status is later reverted — it never creates one.
    {
      for (const m of scopedMatches) {
        const existing = scopedResults.find(r => r.sourceScheduleId === m.id);
        if (!existing || !existing.matchType) continue; // nothing auto-generated to sync/remove
        if (!m.matchType) {
          // Only ever remove a result THIS step (or the scoreboard confirm
          // popup) generated (existing.matchType set means it came from a
          // bye/walkover) — a normal result saved from a live-played match
          // has no matchType and must never be touched here.
          deleteResult(existing.id);
          continue;
        }
        const data = {
          tournamentId: t.id,
          date: m.date, time: m.time,
          competition: m.competition ?? t.name, round: m.round, category: m.category,
          teamAName: m.teamAName, teamAShortName: m.teamAShortName, teamALogo: m.teamALogo, teamAColor: m.teamAColor,
          scoreA: m.scoreA ?? 0,
          teamBName: m.teamBName, teamBShortName: m.teamBShortName, teamBLogo: m.teamBLogo, teamBColor: m.teamBColor,
          scoreB: m.scoreB ?? 0,
          matchType: m.matchType, walkoverLoser: m.walkoverLoser,
          sourceScheduleId: m.id,
        };
        if (
          existing.scoreA !== data.scoreA || existing.scoreB !== data.scoreB ||
          existing.walkoverLoser !== data.walkoverLoser || existing.round !== data.round ||
          existing.category !== data.category ||
          existing.date !== data.date || existing.time !== data.time ||
          existing.teamAName !== data.teamAName || existing.teamBName !== data.teamBName ||
          existing.teamAShortName !== data.teamAShortName || existing.teamBShortName !== data.teamBShortName
        ) {
          updateResult(existing.id, data);
        }
      }
    }

    // ── 3. Knockout bracket auto-advance ───────────────────────────────
    // Once a stage's match has a decided winner (bye/walkover, or a
    // completed regular match with a saved result), that winner is written
    // into its slot in the next stage's match — but only while that slot
    // still holds a placeholder ("Winner of …", "1st Group A"); a
    // manually-picked real team is never overwritten. Scoped per category,
    // since each category's bracket advances independently.
    {
      const categories = t.categories ?? [];
      const buckets: (string | undefined)[] = categories.length > 0 ? categories : [undefined];
      const matchIndexOf = (m: ScheduledMatch) => {
        const mm = bareStageLabel(m).match(/(\d+)\s*$/);
        return mm ? parseInt(mm[1], 10) - 1 : 0;
      };
      for (const cat of buckets) {
        const catMatches = scopedMatches.filter(m => cat === undefined || m.category === cat);
        const catBracketMatches = catMatches.filter(m => !!extractKnockoutStage(m));

        // Two adjacent tiers can share a Quarterfinal (tagged e.g.
        // "Cup/Plate"): the WINNER continues in the upper tier's own
        // bracket, the LOSER drops into the lower tier's, via "Winner of
        // X"/"Loser of X" placeholder text rather than the index-based
        // advance below. Matched by exact placeholder text, scoped to this
        // category so two categories both using this format never resolve
        // each other's slots.
        const pairedQfMatches = catBracketMatches.filter(m => m.tier?.includes('/') && extractKnockoutStage(m) === 'Quarterfinal');
        for (const qf of pairedQfMatches) {
          const win = findMatchWinner(qf, scopedResults, t.id);
          if (!win) continue;
          const winner = win.side === 'A'
            ? { id: qf.teamAId, name: qf.teamAName, shortName: qf.teamAShortName, color: qf.teamAColor, logo: qf.teamALogo }
            : { id: qf.teamBId, name: qf.teamBName, shortName: qf.teamBShortName, color: qf.teamBColor, logo: qf.teamBLogo };
          const loser = win.side === 'A'
            ? { id: qf.teamBId, name: qf.teamBName, shortName: qf.teamBShortName, color: qf.teamBColor, logo: qf.teamBLogo }
            : { id: qf.teamAId, name: qf.teamAName, shortName: qf.teamAShortName, color: qf.teamAColor, logo: qf.teamALogo };
          const matchLabel = bareStageLabel(qf);
          const winnerPh = `Winner of ${qf.tier} ${matchLabel}`;
          const loserPh = `Loser of ${qf.tier} ${matchLabel}`;
          for (const target of catMatches) {
            if (winner.name) {
              if (target.teamAName === winnerPh && isPlaceholderTeamName(target.teamAName)) {
                updateMatch(target.id, { teamAId: winner.id, teamAName: winner.name, teamAShortName: winner.shortName, teamAColor: winner.color, teamALogo: winner.logo });
                useCanvasStore.getState().syncScoreboardTeamForFixture(target.id, 'A', winnerPh, winner);
              }
              if (target.teamBName === winnerPh && isPlaceholderTeamName(target.teamBName)) {
                updateMatch(target.id, { teamBId: winner.id, teamBName: winner.name, teamBShortName: winner.shortName, teamBColor: winner.color, teamBLogo: winner.logo });
                useCanvasStore.getState().syncScoreboardTeamForFixture(target.id, 'B', winnerPh, winner);
              }
            }
            if (loser.name) {
              if (target.teamAName === loserPh && isPlaceholderTeamName(target.teamAName)) {
                updateMatch(target.id, { teamAId: loser.id, teamAName: loser.name, teamAShortName: loser.shortName, teamAColor: loser.color, teamALogo: loser.logo });
                useCanvasStore.getState().syncScoreboardTeamForFixture(target.id, 'A', loserPh, loser);
              }
              if (target.teamBName === loserPh && isPlaceholderTeamName(target.teamBName)) {
                updateMatch(target.id, { teamBId: loser.id, teamBName: loser.name, teamBShortName: loser.shortName, teamBColor: loser.color, teamBLogo: loser.logo });
                useCanvasStore.getState().syncScoreboardTeamForFixture(target.id, 'B', loserPh, loser);
              }
            }
          }
        }

        // Placement-ladder rounds (see buildPlacementLadder / groups-tiered's
        // "ranked placement" mode) — every completed match whose bare stage
        // is an "Nth-Mth Placing" label writes its winner/loser into any
        // placeholder matching that exact text, category-scoped. No tier/'/'
        // gate needed (unlike pairedQfMatches above): these labels are
        // structurally unique to this generator and never reused by the old
        // tiered format, so there's no cross-format text-collision risk, and
        // it's idempotent (a slot already resolved no longer matches
        // isPlaceholderTeamName).
        const placementMatches = catBracketMatches.filter(m => isPlacementRoundLabel(extractKnockoutStage(m) ?? ''));
        for (const pm of placementMatches) {
          const win = findMatchWinner(pm, scopedResults, t.id);
          if (!win) continue;
          const winner = win.side === 'A'
            ? { id: pm.teamAId, name: pm.teamAName, shortName: pm.teamAShortName, color: pm.teamAColor, logo: pm.teamALogo }
            : { id: pm.teamBId, name: pm.teamBName, shortName: pm.teamBShortName, color: pm.teamBColor, logo: pm.teamBLogo };
          const loser = win.side === 'A'
            ? { id: pm.teamBId, name: pm.teamBName, shortName: pm.teamBShortName, color: pm.teamBColor, logo: pm.teamBLogo }
            : { id: pm.teamAId, name: pm.teamAName, shortName: pm.teamAShortName, color: pm.teamAColor, logo: pm.teamALogo };
          const matchLabel = bareStageLabel(pm);
          const winnerPh = `Winner of ${matchLabel}`;
          const loserPh = `Loser of ${matchLabel}`;
          for (const target of catMatches) {
            if (winner.name) {
              if (target.teamAName === winnerPh && isPlaceholderTeamName(target.teamAName)) {
                updateMatch(target.id, { teamAId: winner.id, teamAName: winner.name, teamAShortName: winner.shortName, teamAColor: winner.color, teamALogo: winner.logo });
                useCanvasStore.getState().syncScoreboardTeamForFixture(target.id, 'A', winnerPh, winner);
              }
              if (target.teamBName === winnerPh && isPlaceholderTeamName(target.teamBName)) {
                updateMatch(target.id, { teamBId: winner.id, teamBName: winner.name, teamBShortName: winner.shortName, teamBColor: winner.color, teamBLogo: winner.logo });
                useCanvasStore.getState().syncScoreboardTeamForFixture(target.id, 'B', winnerPh, winner);
              }
            }
            if (loser.name) {
              if (target.teamAName === loserPh && isPlaceholderTeamName(target.teamAName)) {
                updateMatch(target.id, { teamAId: loser.id, teamAName: loser.name, teamAShortName: loser.shortName, teamAColor: loser.color, teamALogo: loser.logo });
                useCanvasStore.getState().syncScoreboardTeamForFixture(target.id, 'A', loserPh, loser);
              }
              if (target.teamBName === loserPh && isPlaceholderTeamName(target.teamBName)) {
                updateMatch(target.id, { teamBId: loser.id, teamBName: loser.name, teamBShortName: loser.shortName, teamBColor: loser.color, teamBLogo: loser.logo });
                useCanvasStore.getState().syncScoreboardTeamForFixture(target.id, 'B', loserPh, loser);
              }
            }
          }
        }

        // A Cup/Plate/Bowl/Shield tournament has several parallel brackets
        // reusing the exact same stage names ("Quarterfinal 1"..."Quarterfinal
        // N" in every tier) — advancing by stage alone would cross-advance a
        // Cup winner into a Plate slot. Scoping by tier too (in fixed
        // Cup→Plate→Bowl→Shield order) keeps each tier's bracket
        // independent. Combined pair labels ("Cup/Plate") are excluded here
        // — handled by the shared-QF resolution above. A non-tiered
        // tournament has `tier` undefined on every match, so this collapses
        // to a single [undefined] bucket.
        const tiersPresent = Array.from(new Set(catBracketMatches.map(m => m.tier))).filter(x => !x?.includes('/'));
        const tierBuckets = tiersPresent.length > 0 ? tiersPresent.sort((a, b) => tierRank(a ?? '') - tierRank(b ?? '')) : [undefined];
        for (const tier of tierBuckets) {
          const bracketMatches = catBracketMatches.filter(m => m.tier === tier);
          const thirdPlaceMatch = scopedMatches.find(m => (cat === undefined || m.category === cat) && m.tier === tier && m.group === '3rd Place');
          const byStage = new Map<string, ScheduledMatch[]>();
          for (const m of bracketMatches) {
            const key = extractKnockoutStage(m)!;
            if (!byStage.has(key)) byStage.set(key, []);
            byStage.get(key)!.push(m);
          }
          const stages = Array.from(byStage.entries()).sort((a, b) => knockoutStageSize(b[0]) - knockoutStageSize(a[0]));
          for (let r = 0; r < stages.length - 1; r++) {
            const stageName = stages[r][0];
            // Placement-ladder stages ("9th-12th Placing"...) are fully
            // resolved by the dedicated pass above — this generic
            // winner-only/position-based routing has no concept of a loser
            // ALSO continuing to a different next stage, so it would
            // misroute a placement bracket's sibling finals if left to run.
            if (isPlacementRoundLabel(stageName)) continue;
            const curMatches = stages[r][1];
            const nextMatches = stages[r + 1][1];
            const nextByIndex = new Map(nextMatches.map(m => [matchIndexOf(m), m]));
            for (const cur of curMatches) {
              const win = findMatchWinner(cur, scopedResults, t.id);
              if (!win) continue;
              const k = matchIndexOf(cur);
              const slot: 'A' | 'B' = k % 2 === 0 ? 'A' : 'B';
              const winner = win.side === 'A'
                ? { id: cur.teamAId, name: cur.teamAName, shortName: cur.teamAShortName, color: cur.teamAColor, logo: cur.teamALogo }
                : { id: cur.teamBId, name: cur.teamBName, shortName: cur.teamBShortName, color: cur.teamBColor, logo: cur.teamBLogo };
              const next = nextByIndex.get(Math.floor(k / 2));
              if (next && winner.name) {
                const curName = slot === 'A' ? next.teamAName : next.teamBName;
                if (curName !== winner.name && isPlaceholderTeamName(curName)) {
                  updateMatch(next.id, slot === 'A'
                    ? { teamAId: winner.id, teamAName: winner.name, teamAShortName: winner.shortName, teamAColor: winner.color, teamALogo: winner.logo }
                    : { teamBId: winner.id, teamBName: winner.name, teamBShortName: winner.shortName, teamBColor: winner.color, teamBLogo: winner.logo });
                  useCanvasStore.getState().syncScoreboardTeamForFixture(next.id, slot, curName, winner);
                }
              }
              // 3rd/4th place playoff: the Semifinal LOSER fills the corresponding slot.
              if (thirdPlaceMatch && stageName === 'Semifinal') {
                const loser = win.side === 'A'
                  ? { id: cur.teamBId, name: cur.teamBName, shortName: cur.teamBShortName, color: cur.teamBColor, logo: cur.teamBLogo }
                  : { id: cur.teamAId, name: cur.teamAName, shortName: cur.teamAShortName, color: cur.teamAColor, logo: cur.teamALogo };
                if (loser.name) {
                  const curName = slot === 'A' ? thirdPlaceMatch.teamAName : thirdPlaceMatch.teamBName;
                  if (curName !== loser.name && isPlaceholderTeamName(curName)) {
                    updateMatch(thirdPlaceMatch.id, slot === 'A'
                      ? { teamAId: loser.id, teamAName: loser.name, teamAShortName: loser.shortName, teamAColor: loser.color, teamALogo: loser.logo }
                      : { teamBId: loser.id, teamBName: loser.name, teamBShortName: loser.shortName, teamBColor: loser.color, teamBLogo: loser.logo });
                    useCanvasStore.getState().syncScoreboardTeamForFixture(thirdPlaceMatch.id, slot, curName, loser);
                  }
                }
              }
            }
          }
        }
      }
    }

    // ── 4. Groups → Knockout auto-fill ─────────────────────────────────
    // Once every fixture in a Draw group's round-robin stage is decided
    // (completed or bye/walkover), that group's final standings are
    // computed and used to fill any "1st Group A"/"2nd Group A" placeholder
    // still sitting in the knockout stage — same placeholder-only rule as
    // the bracket auto-advance above, so a manual pick is never overwritten.
    {
      const allGroups = normalizeGroups(t.groups);
      const categories = t.categories ?? [];
      const buckets: (string | undefined)[] = categories.length > 0 ? categories : [undefined];
      const settings = t.settings ?? SPORT_DEFAULTS[t.sport];
      const placeholderRe = /^(\d+)(?:st|nd|rd|th) (.+)$/;
      // A "Best Nth-place" wildcard (see buildBestNthWildcardSlots) — e.g.
      // "Best 3rd", "2nd Best 3rd" — cross-ranks every pool's Nth-place
      // finisher instead of naming one specific pool. Checked BEFORE
      // placeholderRe below: a leading-ordinal wildcard like "2nd Best 3rd"
      // would otherwise partially match placeholderRe (group captured as
      // the literal text "Best 3rd", which is never a real group name) and
      // silently dead-end forever instead of falling into this branch.
      const wildcardRe = /^(?:(\d+)(?:st|nd|rd|th) )?Best (\d+)(?:st|nd|rd|th)$/;

      for (const cat of buckets) {
        const catGroups = allGroups.filter(g => cat === undefined || !g.category || g.category === cat);
        if (catGroups.length === 0) continue;
        const bracketMatches = scopedMatches.filter(m => (cat === undefined || m.category === cat) && !!extractKnockoutStage(m));
        if (bracketMatches.length === 0) continue;

        const standingsByGroup = new Map<string, ReturnType<typeof computeStandings>>();
        for (const g of catGroups) {
          const groupMatches = scopedMatches.filter(m => m.group === g.name);
          if (groupMatches.length === 0) continue;
          // A bye/walkover only counts once confirmed via the scoreboard
          // popup (completedAt) — an unconfirmed one must not make the
          // group look "fully decided" and trigger advancing teams into
          // the knockout stage.
          if (!groupMatches.every(m => !!m.completedAt)) continue;
          const groupTeams = scopedTeams.filter(x => x.group === g.name && (cat === undefined || x.category === cat));
          // Only pool-stage results decide who advances — a same-group
          // rematch inside the bracket/wildcard stage must not count twice.
          standingsByGroup.set(g.name, computeStandings(groupTeams, scopedResults.filter(isPoolStageResult), settings));
        }
        if (standingsByGroup.size === 0) continue;

        for (const m of bracketMatches) {
          for (const side of ['A', 'B'] as const) {
            const curName = side === 'A' ? m.teamAName : m.teamBName;
            if (!curName) continue;

            const wildcardMatch = curName.match(wildcardRe);
            if (wildcardMatch) {
              const wildcardRank = wildcardMatch[1] ? parseInt(wildcardMatch[1], 10) : 1;
              const sourceRank = parseInt(wildcardMatch[2], 10);
              // Only the pools that actually have an Nth-place team are
              // candidates — and every one of THOSE must be fully decided
              // (present in standingsByGroup) before ranking them, so a
              // still-in-progress pool can't lock in a wrong wildcard.
              const eligibleGroups = catGroups.filter(g =>
                scopedTeams.filter(x => x.group === g.name && (cat === undefined || x.category === cat)).length >= sourceRank
              );
              if (eligibleGroups.length === 0 || !eligibleGroups.every(g => standingsByGroup.has(g.name))) continue;
              const candidates = eligibleGroups
                .map(g => standingsByGroup.get(g.name)![sourceRank - 1])
                .filter((s): s is NonNullable<typeof s> => !!s)
                .sort((a, b) => b.pts - a.pts || (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf);
              const standing = candidates[wildcardRank - 1];
              if (!standing) continue;
              updateMatch(m.id, side === 'A'
                ? { teamAId: standing.teamId, teamAName: standing.name, teamAShortName: standing.shortName, teamAColor: standing.color, teamALogo: standing.logo }
                : { teamBId: standing.teamId, teamBName: standing.name, teamBShortName: standing.shortName, teamBColor: standing.color, teamBLogo: standing.logo });
              useCanvasStore.getState().syncScoreboardTeamForFixture(m.id, side, curName, { id: standing.teamId, name: standing.name, shortName: standing.shortName, color: standing.color, logo: standing.logo });
              continue;
            }

            const placeholderMatch = curName.match(placeholderRe);
            if (!placeholderMatch) continue;
            const rank = parseInt(placeholderMatch[1], 10);
            const groupName = placeholderMatch[2];
            const standing = standingsByGroup.get(groupName)?.[rank - 1];
            if (!standing) continue;
            updateMatch(m.id, side === 'A'
              ? { teamAId: standing.teamId, teamAName: standing.name, teamAShortName: standing.shortName, teamAColor: standing.color, teamALogo: standing.logo }
              : { teamBId: standing.teamId, teamBName: standing.name, teamBShortName: standing.shortName, teamBColor: standing.color, teamBLogo: standing.logo });
            useCanvasStore.getState().syncScoreboardTeamForFixture(m.id, side, curName, { id: standing.teamId, name: standing.name, shortName: standing.shortName, color: standing.color, logo: standing.logo });
          }
        }
      }
    }

    // ── 5. Local player stats recompute ────────────────────────────────
    // Only for teams explicitly switched to statsSource:'local' (a toggle in
    // the Team Database's Players tab) — every other team keeps whatever
    // the external roster API last set, or a manual edit, exactly as
    // before this existed. A full recompute from this team's own saved
    // match history each time (see localPlayerStats.ts), so it's always
    // safe to re-run — dirty-checked below so it doesn't just keep
    // rewriting identical numbers (and re-triggering this very loop) every
    // cycle once the numbers are already correct.
    {
      for (const team of scopedTeams) {
        if (team.statsSource !== 'local') continue;
        const totals = computeLocalStatsForTeam(team, scopedResults);
        for (const player of team.players) {
          const stat = totals.get(player.id)!;
          if (
            (player.tries ?? 0) !== stat.tries || (player.conversions ?? 0) !== stat.conversions ||
            (player.penalties ?? 0) !== stat.penalties || (player.dropGoals ?? 0) !== stat.dropGoals
          ) {
            useTeamDbStore.getState().updatePlayer(team.id, player.id, stat);
          }
        }
      }
    }
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRun() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    try { runTournamentAutoAdvance(); } catch (err) { console.warn('[auto-advance] run failed:', err); }
  }, 250);
}

let started = false;

/** Starts the always-on auto-advance loop — runs once immediately, then
 *  re-runs (debounced) whenever schedule/result/team/tournament data
 *  changes, regardless of whether the Tournament Database window is open.
 *  Desktop-host only, same as every other write-owning background process
 *  in this app (cloud sync, hotkeys, team-id backfill) — remote/browser
 *  clients only ever mirror the host's state. */
export function startTournamentAutoAdvance() {
  if (!_isTauriApp || started) return;
  started = true;
  runTournamentAutoAdvance();
  useMatchScheduleStore.subscribe(scheduleRun);
  useMatchResultsStore.subscribe(scheduleRun);
  useTeamDbStore.subscribe(scheduleRun);
  useTournamentStore.subscribe(scheduleRun);
}
