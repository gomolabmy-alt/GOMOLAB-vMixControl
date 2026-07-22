import { useMemo } from 'react';
import { useMatchScheduleStore, type ScheduledMatch } from '../../stores/matchScheduleStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useCanvasStore } from '../../stores/canvasStore';
import { extractKnockoutStage } from '../TournamentManager';
import { BracketView } from '../BracketView';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

// Read-only broadcast display of a tournament's knockout bracket — mirrors
// the Tournament Database's Bracket tab (BracketPanel) geometry/rendering
// exactly (both are thin wrappers around the shared BracketView), but drops
// everything that only makes sense as an editing tool there: "✏️ Edit
// Arrangement", "Add 3rd Place Playoff", and the click-to-TeamInfoModal team
// names.
export function BracketWidget({ widgetId, config }: Props) {
  const { matches: allMatches } = useMatchScheduleStore();
  const { results: allResults } = useMatchResultsStore();
  const { tournaments } = useTournamentStore();
  const { pages } = useCanvasStore();

  const pageTournamentId = pages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const tournamentId: string | undefined = config.filterTournamentId || pageTournamentId;
  const tournament = tournaments.find(t => t.id === tournamentId);
  const category: string = config.filterCategory ?? '';
  const categories = tournament?.categories ?? [];
  const tier: string = config.filterTier ?? '';

  const effectiveCategory = (m: ScheduledMatch): string | undefined =>
    m.category ?? (m.round?.includes(' · ') ? m.round.split(' · ')[0] : undefined);

  const categoryMatches = useMemo(
    () => !tournament ? [] : allMatches.filter(m =>
      m.tournamentId === tournament.id &&
      (categories.length === 0 || effectiveCategory(m) === category) &&
      !!extractKnockoutStage(m)
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament, category, categories.length]
  );

  // A shared Quarterfinal's combined label ("Cup/Plate") is excluded from
  // the selectable tier list itself, but its matches are still picked up
  // below whenever either paired tier is selected — same convention as
  // BracketPanel.
  const tiers = useMemo(() => {
    const set = new Set(categoryMatches.map(m => m.tier).filter((t): t is string => !!t && !t.includes('/')));
    return Array.from(set);
  }, [categoryMatches]);

  const matches = useMemo(
    () => tiers.length > 0
      ? categoryMatches.filter(m => m.tier === tier || (!!m.tier?.includes('/') && m.tier.split('/').includes(tier)))
      : categoryMatches,
    [categoryMatches, tiers.length, tier]
  );

  const thirdPlaceMatch = useMemo(
    () => !tournament ? undefined : allMatches.find(m =>
      m.tournamentId === tournament.id &&
      (categories.length === 0 || effectiveCategory(m) === category) &&
      (tiers.length === 0 || m.tier === tier) &&
      m.group === '3rd Place'
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament, category, categories.length, tiers.length, tier]
  );

  if (!tournament) {
    return <div className="wgt-bracket wgt-bracket--empty">Pick a tournament in widget settings</div>;
  }
  if (categories.length > 0 && !category) {
    return <div className="wgt-bracket wgt-bracket--empty">Pick a category in widget settings</div>;
  }
  if (tiers.length > 0 && !tier) {
    return <div className="wgt-bracket wgt-bracket--empty">Pick a tier in widget settings</div>;
  }
  if (matches.length === 0) {
    return <div className="wgt-bracket wgt-bracket--empty">No knockout-stage fixtures found{categories.length > 0 ? ' for this category' : ''}</div>;
  }

  return (
    <div className="wgt-bracket">
      <BracketView
        matches={matches}
        thirdPlaceMatch={thirdPlaceMatch}
        results={allResults}
        tournamentId={tournament.id}
      />
    </div>
  );
}
