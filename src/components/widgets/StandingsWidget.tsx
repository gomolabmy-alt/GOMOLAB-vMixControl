import { useMemo } from 'react';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useCanvasStore } from '../../stores/canvasStore';
import { SPORT_DEFAULTS } from '../../types/tournament';
import type { TournamentGroup } from '../../types/tournament';
import { computeStandings, normalizeGroups, StandingsTable } from '../TournamentManager';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

// Read-only broadcast display of a tournament's standings table(s) — the
// interactive version lives in the Tournament Database's Standings tab
// (StandingsPanel); this reuses its exported computeStandings/StandingsTable
// but drops the click-to-TeamInfoModal affordance, which only makes sense
// inside the DB window.
export function StandingsWidget({ widgetId, config }: Props) {
  const { teams: allTeams } = useTeamDbStore();
  const { results: allResults } = useMatchResultsStore();
  const { tournaments } = useTournamentStore();
  const { pages } = useCanvasStore();
  const title: string = config.title ?? 'Standings';

  const pageTournamentId = pages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const tournamentId: string | undefined = config.filterTournamentId || pageTournamentId;
  const tournament = tournaments.find(t => t.id === tournamentId);
  const category: string = config.filterCategory ?? '';

  const teams = useMemo(
    () => tournament ? allTeams.filter(t => t.tournamentId === tournament.id && (!category || t.category === category)) : [],
    [allTeams, tournament, category]
  );
  const results = useMemo(
    () => tournament ? allResults.filter(r => r.tournamentId === tournament.id) : [],
    [allResults, tournament]
  );

  if (!tournament) {
    return <div className="wgt-standings wgt-standings--empty">Pick a tournament in widget settings</div>;
  }

  const settings = tournament.settings ?? SPORT_DEFAULTS[tournament.sport];
  const allGroups = normalizeGroups(tournament.groups);
  const groups: TournamentGroup[] = allGroups.filter(g => !category || !g.category || g.category === category);

  if (teams.length === 0) {
    return <div className="wgt-standings wgt-standings--empty">No teams yet</div>;
  }

  return (
    <div className="wgt-standings">
      <div className="wgt-standings-header">{title}</div>
      <div className="wgt-standings-body">
        {groups.length === 0 ? (
          <StandingsTable title={tournament.name} rows={computeStandings(teams, results, settings)} />
        ) : (
          <>
            {groups.map(g => (
              <StandingsTable key={g.name} title={g.name} rows={computeStandings(teams.filter(t => t.group === g.name), results, settings)} />
            ))}
            {teams.some(t => !t.group) && (
              <StandingsTable title="Unassigned" rows={computeStandings(teams.filter(t => !t.group), results, settings)} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
