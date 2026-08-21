import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Send } from 'lucide-react';
import { useMatchScheduleStore, type ScheduledMatch } from '../../stores/matchScheduleStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { extractKnockoutStage, knockoutStageSize, findMatchScore, findMatchWinner } from '../TournamentManager';
import { BracketView } from '../BracketView';
import { transparentLogoUrl, clearStaleLogoSlots } from '../../lib/imageUrl';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

// One match's worth of vMix fields, index-suffixed in bracket order (Stage1.Text,
// Stage2.Text, ... — earliest round first, same left-to-right order the bracket
// itself reads in) — same indexed-list convention as Match Schedule/Group
// Standings, so the same MergeFieldComposer/prefix-field pattern applies here too.
type BracketMergePart = 'stage' | 'teamA' | 'teamB' | 'fullTeamA' | 'fullTeamB' | 'scoreA' | 'scoreB' | 'winner';
function resolveBracketPart(
  m: ScheduledMatch, score: { a: number; b: number } | null, winnerSide: 'A' | 'B' | '', key: BracketMergePart,
): string {
  switch (key) {
    case 'stage':     return m.tier ? `${m.tier} ${extractKnockoutStage(m)}` : (extractKnockoutStage(m) ?? '');
    case 'teamA':     return m.teamAShortName || m.teamAName;
    case 'teamB':     return m.teamBName ? (m.teamBShortName || m.teamBName) : 'BYE';
    case 'fullTeamA': return m.teamAName;
    case 'fullTeamB': return m.teamBName || 'BYE';
    case 'scoreA':    return score ? String(score.a) : '';
    case 'scoreB':    return score ? String(score.b) : '';
    case 'winner':    return winnerSide;
  }
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

  // Same stage grouping + size-descending sort BracketView uses to lay the
  // columns out left to right (earliest round first) — flattened into one
  // ordered list for the indexed vMix push below, with the 3rd Place
  // Playoff (not really "next round", fed by the Semifinal losers) tacked
  // on as the final slot rather than woven into stage order.
  const orderedMatches: ScheduledMatch[] = useMemo(() => {
    const byStage = new Map<string, ScheduledMatch[]>();
    for (const m of matches) {
      const key = extractKnockoutStage(m)!;
      if (!byStage.has(key)) byStage.set(key, []);
      byStage.get(key)!.push(m);
    }
    const stages = Array.from(byStage.entries()).sort((a, b) => knockoutStageSize(b[0]) - knockoutStageSize(a[0]));
    const flat = stages.flatMap(([, ms]) => ms);
    return thirdPlaceMatch ? [...flat, thirdPlaceMatch] : flat;
  }, [matches, thirdPlaceMatch]);

  const { getClient, vmixState, vmixSyncVersion } = useVmixStore();
  const vmixInputKey: string = config.vmixInputKey ?? '';
  const PREFIX_FIELDS: { key: string; part: BracketMergePart }[] = [
    { key: 'stagePrefix', part: 'stage' }, { key: 'teamAPrefix', part: 'teamA' }, { key: 'teamBPrefix', part: 'teamB' },
    { key: 'fullTeamAPrefix', part: 'fullTeamA' }, { key: 'fullTeamBPrefix', part: 'fullTeamB' },
    { key: 'scoreAPrefix', part: 'scoreA' }, { key: 'scoreBPrefix', part: 'scoreB' }, { key: 'winnerPrefix', part: 'winner' },
  ];

  const sendToVmix = useCallback(() => {
    const c = getClient();
    if (!c || !vmixInputKey || !tournament || orderedMatches.length === 0) return;
    const prefixes = PREFIX_FIELDS.map(f => config[f.key] as string | undefined).concat(config.mergedPrefix);
    orderedMatches.forEach((m, i) => {
      const idx = i + 1;
      const score = findMatchScore(m, allResults, tournament.id);
      const winnerSide = findMatchWinner(m, allResults, tournament.id)?.side ?? '';
      for (const f of PREFIX_FIELDS) {
        const prefix = config[f.key];
        if (prefix) c.setTextField(vmixInputKey, `${prefix}${idx}.Text`, resolveBracketPart(m, score, winnerSide, f.part));
      }
      if (config.logoAPrefix) c.setImageField(vmixInputKey, `${config.logoAPrefix}${idx}.Source`, m.teamALogo || transparentLogoUrl());
      if (config.logoBPrefix) c.setImageField(vmixInputKey, `${config.logoBPrefix}${idx}.Source`, m.teamBLogo || transparentLogoUrl());
      if (config.mergedPrefix && config.mergedParts?.length) {
        const merged = config.mergedParts.map((p: BracketMergePart) => resolveBracketPart(m, score, winnerSide, p)).join(config.mergedSeparator ?? ' ');
        c.setTextField(vmixInputKey, `${config.mergedPrefix}${idx}.Text`, merged);
      }
    });
    // Clear any extra same-prefix fields beyond the current match count, e.g.
    // leftover text from a previous, bigger bracket (a Round of 16 shrinking
    // to a Quarterfinal-only tier filter).
    const vmixInput = vmixState?.inputs?.find(inp => inp.key === vmixInputKey);
    if (vmixInput) {
      for (const prefix of prefixes) {
        if (!prefix) continue;
        const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${esc}(\\d+)\\.Text$`, 'i');
        for (const field of vmixInput.textFields) {
          const fm = field.name.match(re);
          if (fm && parseInt(fm[1]) > orderedMatches.length) c.setTextField(vmixInputKey, field.name, '');
        }
      }
      clearStaleLogoSlots(c, vmixInputKey, vmixInput.textFields, config.logoAPrefix, orderedMatches.length);
      clearStaleLogoSlots(c, vmixInputKey, vmixInput.textFields, config.logoBPrefix, orderedMatches.length);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getClient, vmixState, vmixInputKey, orderedMatches, tournament, allResults, config]);

  const dataKey = tournament ? orderedMatches.map(m => {
    const score = findMatchScore(m, allResults, tournament.id);
    const winnerSide = findMatchWinner(m, allResults, tournament.id)?.side ?? '';
    return `${m.id}:${m.teamAName}:${m.teamBName}:${score?.a}:${score?.b}:${winnerSide}`;
  }).join('|') : '';
  const prevKeyRef = useRef('');
  useEffect(() => {
    if (!vmixInputKey || !config.vmixAutoSync) return;
    if (dataKey === prevKeyRef.current && vmixSyncVersion === 0) return;
    prevKeyRef.current = dataKey;
    sendToVmix();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, vmixSyncVersion, config.vmixAutoSync]);

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
      {vmixInputKey && (
        <div className="wgt-standings-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
          <button className="wgt-p-stats-send-btn" onClick={sendToVmix} disabled={!getClient()} title="Send this bracket to vMix now">
            <Send size={12} strokeWidth={2} /> Send
          </button>
        </div>
      )}
      <BracketView
        matches={matches}
        thirdPlaceMatch={thirdPlaceMatch}
        results={allResults}
        tournamentId={tournament.id}
      />
    </div>
  );
}
