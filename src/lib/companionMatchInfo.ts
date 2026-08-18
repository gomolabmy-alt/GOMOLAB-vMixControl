import { useTournamentStore } from '../stores/tournamentStore';
import { useMatchScheduleStore } from '../stores/matchScheduleStore';
import { useAppSettings } from '../stores/appSettingsStore';

export interface CompanionNextFixture {
  teamAName: string;
  teamBName: string;
  date: string;
  time: string;
  venue: string;
  round: string;
  competition: string;
}

export interface CompanionMatchInfo {
  tournamentName: string;
  venue: string;
  nextFixture?: CompanionNextFixture;
}

// General match-context data from the database — not tied to any specific
// widget on the canvas — for Companion Variables: which tournament/venue
// the app is currently scoped to (Sidebar's own "Venue Scope" picker), and
// the soonest not-yet-sent fixture within that scope (the same "next up"
// convention MatchScheduleWidget/player-list-next already use).
export function collectCompanionMatchInfo(): CompanionMatchInfo {
  const { tournaments, canvasTournamentId, canvasVenue } = {
    ...useTournamentStore.getState(),
    ...useAppSettings.getState(),
  };
  const tournament = tournaments.find(t => t.id === canvasTournamentId);

  const matches = useMatchScheduleStore.getState().matches;
  const next = matches.find(m =>
    !m.sentAt
    && (!canvasTournamentId || m.tournamentId === canvasTournamentId)
    && (!canvasVenue || m.venue === canvasVenue),
  );

  return {
    tournamentName: tournament?.name ?? '',
    venue: canvasVenue || '',
    nextFixture: next ? {
      teamAName: next.teamAName ?? '',
      teamBName: next.teamBName ?? '',
      date: next.date ?? '',
      time: next.time ?? '',
      venue: next.venue ?? '',
      round: next.round ?? '',
      competition: next.competition ?? '',
    } : undefined,
  };
}
