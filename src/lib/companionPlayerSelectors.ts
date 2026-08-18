import type { CanvasPage } from '../types/canvas';
import { findTeamRecord } from './teamForm';
import { autoLinkedWidget } from './autoLink';
import { useTeamDbStore } from '../stores/teamDbStore';

export interface CompanionPlayerChoice {
  /** The SavedTeam player id — what actually gets written into the
   *  widget's own `playerId`/`playerAId`/`playerBId` config field. */
  playerId: string;
  jerseyNo: string;
  name: string;
  /** Which team this player belongs to — only meaningful when the target's
   *  `needsTeamPick` is true (see below). */
  side?: 'A' | 'B';
}

export interface CompanionPlayerSelectorTarget {
  /** `${widgetId}:player` (single-slot widgets like Player Stats) or
   *  `${widgetId}:playerA` / `${widgetId}:playerB` (fixed-team slots like
   *  Head to Head's two sides). */
  id: string;
  widgetId: string;
  /** Which config field on the widget holds the chosen player's id. */
  configKey: string;
  /** Which config field holds the chosen team side ('A'/'B') — only present
   *  when needsTeamPick, since a fixed-team slot has nothing to set here. */
  teamSideConfigKey?: string;
  label: string;
  /** True when the widget's slot can show either team's player (Player
   *  Stats' single slot, switched by its own Home/Away toggle) — Companion
   *  then also needs to pick a team, so choices span both rosters. False
   *  when the slot's team is already fixed (Head to Head's Player A/Player
   *  B, each always tied to that specific side) — team pick is skipped,
   *  choices are just that one team's roster. */
  needsTeamPick: boolean;
  choices: CompanionPlayerChoice[];
}

// Every widget that has its own "pick a player to show" UI (a team-side
// toggle + player dropdown, or a fixed-team player dropdown) — mirrors that
// same two-step flow (team, then jersey number) for Companion, skipping the
// team step where the widget's slot already has a fixed team. More widget
// types with this pattern (Player Lower Third, ...) can be added the same
// way as follow-ups.
export function collectCompanionPlayerSelectors(pages: CanvasPage[]): CompanionPlayerSelectorTarget[] {
  const out: CompanionPlayerSelectorTarget[] = [];
  const teams = useTeamDbStore.getState().teams;

  for (const page of pages) {
    for (const w of page.widgets) {
      const cfg: any = w.config ?? {};
      const linkedScoreboard = autoLinkedWidget(pages, w.id, cfg.linkedScoreboardId, 'scoreboard');
      const dc = linkedScoreboard?.config ?? {};
      const teamAName: string = dc.teamAName || 'Team A';
      const teamBName: string = dc.teamBName || 'Team B';
      const category: string | undefined = dc.category;
      const tournamentId: string | undefined = dc.linkedTournamentId || page.tournamentId;

      if (w.type === 'player-stats') {
        const teamARecord = findTeamRecord(teams, teamAName, category, tournamentId);
        const teamBRecord = findTeamRecord(teams, teamBName, category, tournamentId);
        const choices: CompanionPlayerChoice[] = [
          ...(teamARecord?.players ?? []).map(p => ({ playerId: p.id, jerseyNo: p.jerseyNo || '', name: p.name, side: 'A' as const })),
          ...(teamBRecord?.players ?? []).map(p => ({ playerId: p.id, jerseyNo: p.jerseyNo || '', name: p.name, side: 'B' as const })),
        ];
        out.push({
          id: `${w.id}:player`,
          widgetId: w.id,
          configKey: 'playerId',
          teamSideConfigKey: 'teamSide',
          label: w.label || 'Player Stats',
          needsTeamPick: true,
          choices,
        });
        continue;
      }

      if (w.type === 'player-h2h') {
        const teamARecord = findTeamRecord(teams, teamAName, category, tournamentId);
        const teamBRecord = findTeamRecord(teams, teamBName, category, tournamentId);
        const label = w.label || 'Head to Head';
        out.push({
          id: `${w.id}:playerA`,
          widgetId: w.id,
          configKey: 'playerAId',
          label: `${label} — Player A (${teamAName})`,
          needsTeamPick: false,
          choices: (teamARecord?.players ?? []).map(p => ({ playerId: p.id, jerseyNo: p.jerseyNo || '', name: p.name })),
        });
        out.push({
          id: `${w.id}:playerB`,
          widgetId: w.id,
          configKey: 'playerBId',
          label: `${label} — Player B (${teamBName})`,
          needsTeamPick: false,
          choices: (teamBRecord?.players ?? []).map(p => ({ playerId: p.id, jerseyNo: p.jerseyNo || '', name: p.name })),
        });
        continue;
      }
    }
  }
  return out;
}
