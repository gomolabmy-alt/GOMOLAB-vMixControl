import { useMemo, useRef, useState, useEffect } from 'react';
import { Medal, Check, Pencil } from 'lucide-react';
import { useMatchScheduleStore, type ScheduledMatch } from '../stores/matchScheduleStore';
import type { SavedMatchResult } from '../stores/matchResultsStore';
import {
  ScheduleBadge, extractKnockoutStage, knockoutStageSize, computeBracketCenters, findMatchScore, findMatchWinner,
  BRACKET_MATCH_H, BRACKET_BASE_GAP, BRACKET_COL_W, BRACKET_COL_GAP,
} from './TournamentManager';

export interface BracketViewProps {
  /** Already scoped to one tournament/category/tier — every match here is
   *  drawn in one bracket tree. Caller decides what "one bracket" means
   *  (e.g. filters by tier for a Cup/Plate/Bowl/Shield split) and whether
   *  there's anything to show at all; this component assumes a non-empty list. */
  matches: ScheduledMatch[];
  thirdPlaceMatch?: ScheduledMatch;
  results: SavedMatchResult[];
  tournamentId: string;
  /** Offers the "✏️ Edit Arrangement" Round-1 slot swap and, when a
   *  Semifinal stage exists with no 3rd place match yet, the "Add 3rd Place
   *  Playoff" retrofit button. Off for read-only contexts like the OBS
   *  bracket widget. */
  editable?: boolean;
  onSelectTeam?: (name: string) => void;
  /** Constructs and dispatches the actual 3rd-place fixture — left to the
   *  caller since it needs tournament/category/tier context this component
   *  doesn't otherwise carry (and, for a tiered tournament, must be scoped
   *  to the SAME tier these `matches` belong to). */
  onAddThirdPlace?: () => void;
}

// Shared bracket-tree renderer — the geometry/rendering half of what used to
// be inlined separately in both TournamentManager.tsx's BracketPanel (the
// editable in-app Bracket tab) and widgets/BracketWidget.tsx (the read-only
// OBS overlay), which had drifted into two near-identical copies of the same
// stage-bucketing + SVG-connector + 3rd-place-column code. Extracted so a
// Cup/Plate/Bowl/Shield tournament's per-tier brackets don't need a third copy.
export function BracketView({ matches, thirdPlaceMatch, results, tournamentId, editable, onSelectTeam, onAddThirdPlace }: BracketViewProps) {
  const { updateMatch } = useMatchScheduleStore();
  const [editMode, setEditMode] = useState(false);

  const stages = useMemo(() => {
    const byStage = new Map<string, ScheduledMatch[]>();
    for (const m of matches) {
      const key = extractKnockoutStage(m)!;
      if (!byStage.has(key)) byStage.set(key, []);
      byStage.get(key)!.push(m);
    }
    return Array.from(byStage.entries()).sort((a, b) => knockoutStageSize(b[0]) - knockoutStageSize(a[0]));
  }, [matches]);

  // A stage is normally fed by the immediately preceding one (today's only
  // shape: Quarterfinal -> Semifinal -> Final). A placement ladder (see
  // scheduleGen.ts's buildPlacementLadder) can instead produce two SAME-SIZE
  // sibling finals fed by the SAME earlier round (e.g. "9th-10th Placing"
  // and "11th-12th Placing" both fed by "9th-12th Placing") — detect the
  // real feeder via "Winner of X"/"Loser of X" placeholder-text reference
  // rather than assuming strict adjacency, and render any sibling beyond
  // the first STACKED in its primary's column instead of claiming its own
  // — the same treatment already used for the 3rd Place Playoff below,
  // generalized from that one hardcoded case to however many are detected.
  // For every existing (non-tied) bracket shape this reproduces today's
  // r -> r+1 behavior exactly, since a plain sequential bracket already
  // trivially satisfies the placeholder-reference check at each step.
  const { stackedOf, stackedGroups, colOfStage, feederIdx, primaryStageIndices } = useMemo(() => {
    const feederIdx: (number | null)[] = stages.map((_, s) => {
      if (s === 0) return null;
      const myMatches = stages[s][1];
      for (let f = s - 1; f >= 0; f--) {
        const feederMatches = stages[f][1];
        const feeds = myMatches.some(m =>
          feederMatches.some(fm =>
            m.teamAName === `Winner of ${fm.round}` || m.teamAName === `Loser of ${fm.round}` ||
            m.teamBName === `Winner of ${fm.round}` || m.teamBName === `Loser of ${fm.round}`
          )
        );
        if (feeds) return f;
      }
      return s - 1;
    });
    const primaryForFeeder = new Map<number, number>();
    const stackedOf = new Map<number, number>();
    const stackedGroups = new Map<number, number[]>();
    stages.forEach((_, s) => {
      const f = feederIdx[s];
      if (f === null) return;
      if (!primaryForFeeder.has(f)) primaryForFeeder.set(f, s);
      else {
        const primary = primaryForFeeder.get(f)!;
        stackedOf.set(s, primary);
        if (!stackedGroups.has(primary)) stackedGroups.set(primary, []);
        stackedGroups.get(primary)!.push(s);
      }
    });
    const primaryStageIndices = stages.map((_, s) => s).filter(s => !stackedOf.has(s));
    const primaryPosOf = new Map<number, number>();
    primaryStageIndices.forEach((s, pos) => primaryPosOf.set(s, pos));
    const colOfStage = (s: number) => primaryPosOf.get(stackedOf.get(s) ?? s) ?? 0;
    return { stackedOf, stackedGroups, colOfStage, feederIdx, primaryStageIndices };
  }, [stages]);
  const primaryStages = useMemo(() => stages.filter((_, s) => !stackedOf.has(s)), [stages, stackedOf]);

  const centers = useMemo(() => computeBracketCenters(primaryStages.map(([, ms]) => ms.length)), [primaryStages]);
  const bracketHeight = centers[0] ? centers[0].length * (BRACKET_MATCH_H + BRACKET_BASE_GAP) : 0;
  const bracketWidth = primaryStages.length * (BRACKET_COL_W + BRACKET_COL_GAP) - BRACKET_COL_GAP;
  // Vertical offset for the k-th stacked sibling under its primary's own
  // single match (k=0 is the first/closest) — same spacing the 3rd Place
  // Playoff already uses below the Final.
  const stackedOffset = (k: number) => (k + 1) * (BRACKET_MATCH_H + BRACKET_BASE_GAP * 2.5);
  let maxStackedBottom = 0;
  for (const [primary, stackedList] of stackedGroups.entries()) {
    const baseY = centers[colOfStage(primary)]?.[0] ?? 0;
    stackedList.forEach((_, k) => { maxStackedBottom = Math.max(maxStackedBottom, baseY + stackedOffset(k)); });
  }

  // The 3rd Place Playoff isn't a normal bracket round (it's fed by the two
  // Semifinal LOSERS, not winners) — position it in the Final's column, below
  // the Final match, and draw its own connector from the Semifinal matches.
  const semifinalRawIdx = stages.findIndex(([name]) => name === 'Semifinal');
  const semifinalStageIdx = semifinalRawIdx >= 0 ? colOfStage(semifinalRawIdx) : -1;
  const finalStageIdx = primaryStages.length - 1;
  const finalCenterY = centers[finalStageIdx]?.[0] ?? 0;
  const thirdPlaceY = finalCenterY + BRACKET_MATCH_H + BRACKET_BASE_GAP * 2.5;
  const containerHeight = Math.max(
    bracketHeight,
    thirdPlaceMatch ? thirdPlaceY + BRACKET_MATCH_H / 2 + 20 : 0,
    maxStackedBottom ? maxStackedBottom + BRACKET_MATCH_H / 2 + 20 : 0,
  );
  const naturalWidth = bracketWidth;
  const naturalHeight = containerHeight + 24;

  // Scales the whole bracket to fill whatever space is available — a small
  // 2-round bracket wouldn't otherwise sit tiny in a sea of whitespace; a
  // big one shrinks to fit instead of forcing a scrollbar.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || stages.length === 0 || naturalWidth === 0 || naturalHeight === 0) return;
    const update = () => {
      const s = Math.min(el.clientWidth / naturalWidth, el.clientHeight / naturalHeight, 1.6);
      setScale(Math.max(0.35, s));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [naturalWidth, naturalHeight, stages.length]);

  const findScore = (m: ScheduledMatch) => findMatchScore(m, results, tournamentId);
  const findWinner = (m: ScheduledMatch) => findMatchWinner(m, results, tournamentId);

  // Round-1 slot arrangement — lets an operator change which entrant (e.g.
  // "1st Group A") lands in which bracket position, without regenerating the
  // whole schedule. Only Round 1 is editable this way: later rounds are
  // winner placeholders that already get filled in automatically as results
  // come in (see the bracket auto-advance effect in TournamentManager.tsx).
  interface BracketSlot { matchId: string; side: 'A' | 'B'; name: string; shortName?: string; color: string; logo?: string; }
  const round1Slots: BracketSlot[] = useMemo(() => {
    const round1 = stages[0]?.[1] ?? [];
    const slots: BracketSlot[] = [];
    for (const m of round1) {
      slots.push({ matchId: m.id, side: 'A', name: m.teamAName, shortName: m.teamAShortName, color: m.teamAColor, logo: m.teamALogo });
      if (m.teamBName) slots.push({ matchId: m.id, side: 'B', name: m.teamBName, shortName: m.teamBShortName, color: m.teamBColor, logo: m.teamBLogo });
    }
    return slots;
  }, [stages]);

  const swapSlot = (matchId: string, side: 'A' | 'B', newName: string) => {
    const from = round1Slots.find(s => s.matchId === matchId && s.side === side);
    const to = round1Slots.find(s => s.name === newName);
    if (!from || !to || from.name === to.name) return;
    const patchFor = (slot: BracketSlot, team: BracketSlot) => slot.side === 'A'
      ? { teamAName: team.name, teamAShortName: team.shortName, teamAColor: team.color, teamALogo: team.logo }
      : { teamBName: team.name, teamBShortName: team.shortName, teamBColor: team.color, teamBLogo: team.logo };
    if (from.matchId === to.matchId) {
      updateMatch(from.matchId, { ...patchFor(from, to), ...patchFor(to, from) });
    } else {
      updateMatch(from.matchId, patchFor(from, to));
      updateMatch(to.matchId, patchFor(to, from));
    }
  };

  const semifinalStage = stages.find(([name]) => name === 'Semifinal');
  const canAddThirdPlace = editable && !!onAddThirdPlace && !!semifinalStage && !thirdPlaceMatch;

  // Shared match-card renderer — used for every primary-column match, every
  // stacked-sibling match (see stackedGroups above), and the 3rd Place
  // Playoff below, so all three stay visually identical.
  const renderMatch = (m: ScheduledMatch, centerY: number, slotEditable: boolean) => {
    const score = findScore(m);
    const win = findWinner(m);
    const aWins = win?.side === 'A';
    const bWins = win?.side === 'B';
    return (
      <div
        key={m.id}
        className={`tm-bracket-match${slotEditable ? ' tm-bracket-match--editing' : ''}`}
        style={{ position: 'absolute', top: 24 + centerY - BRACKET_MATCH_H / 2, left: 0, width: BRACKET_COL_W, height: BRACKET_MATCH_H }}
        title={win?.shootout ? `Won on penalties, ${win.shootout.scoreA}-${win.shootout.scoreB}` : undefined}
      >
        <div className={`tm-bracket-team${aWins ? ' tm-bracket-team--winner' : ''}`}>
          <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={m.teamALogo} color={m.teamAColor} /></div>
          {slotEditable ? (
            <select className="tm-bracket-slot-select" value={m.teamAName} onChange={e => swapSlot(m.id, 'A', e.target.value)}>
              {round1Slots.map(s => <option key={`${s.matchId}-${s.side}`} value={s.name}>{s.name}</option>)}
            </select>
          ) : onSelectTeam ? (
            <span className="tm-bracket-team-name tm-bracket-team-name--clickable" onClick={() => onSelectTeam(m.teamAName)}>{m.teamAShortName || m.teamAName}</span>
          ) : (
            <span className="tm-bracket-team-name">{m.teamAShortName || m.teamAName}</span>
          )}
          {score && <span className="tm-bracket-score">{score.a}{win?.shootout && aWins ? <sup className="tm-bracket-pens">p</sup> : null}</span>}
        </div>
        <div className={`tm-bracket-team${bWins ? ' tm-bracket-team--winner' : ''}`}>
          <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={m.teamBLogo} color={m.teamBColor} /></div>
          {slotEditable && m.teamBName ? (
            <select className="tm-bracket-slot-select" value={m.teamBName} onChange={e => swapSlot(m.id, 'B', e.target.value)}>
              {round1Slots.map(s => <option key={`${s.matchId}-${s.side}`} value={s.name}>{s.name}</option>)}
            </select>
          ) : (
            <span
              className={m.teamBName && onSelectTeam ? 'tm-bracket-team-name tm-bracket-team-name--clickable' : 'tm-bracket-team-name'}
              onClick={m.teamBName && onSelectTeam ? () => onSelectTeam(m.teamBName) : undefined}
            >{m.teamBName ? (m.teamBShortName || m.teamBName) : 'BYE'}</span>
          )}
          {score && <span className="tm-bracket-score">{score.b}{win?.shootout && bWins ? <sup className="tm-bracket-pens">p</sup> : null}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="tm-bracket-panel">
      {editable && (round1Slots.length > 0 || canAddThirdPlace) && (
        <div className="tm-bracket-modal-header">
          {canAddThirdPlace && (
            <button className="tm-io-btn" onClick={onAddThirdPlace} title="Add a 3rd/4th place playoff between the Semifinal losers">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Medal size={14} /> Add 3rd Place Playoff</span>
            </button>
          )}
          {round1Slots.length > 0 && (
            <button
              className={`tm-io-btn${editMode ? ' tm-io-btn--ok' : ''}`}
              onClick={() => setEditMode(v => !v)}
              title="Swap which entrant lands in which Round 1 bracket slot"
            >
              {editMode
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={14} /> Done Editing</span>
                : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Pencil size={14} /> Edit Arrangement</span>}
            </button>
          )}
        </div>
      )}
      {editMode && (
        <div className="tm-gen-warn" style={{ marginTop: 0 }}>
          Edit mode: pick a different entrant in any Round 1 slot to swap it with whoever currently holds that spot.
        </div>
      )}

      <div ref={viewportRef} className="tm-bracket-viewport">
        <div style={{ width: naturalWidth * scale, height: naturalHeight * scale, position: 'relative' }}>
          <div
            className="tm-bracket"
            style={{ width: naturalWidth, height: naturalHeight, transform: `scale(${scale})`, transformOrigin: 'top left', position: 'absolute', top: 0, left: 0 }}
          >
            <svg
              className="tm-bracket-lines"
              width={bracketWidth} height={containerHeight + 24}
              style={{ position: 'absolute', left: 0, top: 24, pointerEvents: 'none' }}
            >
              {primaryStageIndices.slice(1).map((rawIdx, i0) => {
                const col = i0 + 1;
                const feederRaw = feederIdx[rawIdx];
                if (feederRaw === null) return null;
                const feederCol = colOfStage(feederRaw);
                const feederMatches = stages[feederRaw][1];
                const colLeft = feederCol * (BRACKET_COL_W + BRACKET_COL_GAP);
                const xStart = colLeft + BRACKET_COL_W;
                const xMid = xStart + BRACKET_COL_GAP / 2;
                const xEnd = xStart + BRACKET_COL_GAP;
                const pairs: React.ReactNode[] = [];
                for (let i = 0; i < feederMatches.length; i += 2) {
                  const y1 = centers[feederCol][i];
                  const y2 = centers[feederCol][i + 1] ?? y1;
                  const yMid = centers[col]?.[i / 2] ?? (y1 + y2) / 2;
                  pairs.push(
                    <path
                      key={`${col}-${i}`}
                      d={`M ${xStart} ${y1} L ${xMid} ${y1} L ${xMid} ${y2} L ${xStart} ${y2} M ${xMid} ${yMid} L ${xEnd} ${yMid}`}
                      fill="none"
                      className="tm-bracket-line"
                    />
                  );
                }
                return pairs;
              })}
              {/* Stacked siblings (e.g. "11th-12th Placing" stacked under
                  "9th-10th Placing" — both fed by "9th-12th Placing") each
                  draw their own connector from the shared feeder into their
                  stacked Y position, same geometry as the 3rd Place Playoff
                  connector below, generalized to however many are detected. */}
              {Array.from(stackedGroups.entries()).flatMap(([primary, stackedList]) => {
                const primaryCol = colOfStage(primary);
                const feederRaw = feederIdx[primary];
                if (feederRaw === null) return [];
                const feederCol = colOfStage(feederRaw);
                const colLeft = feederCol * (BRACKET_COL_W + BRACKET_COL_GAP);
                const xStart = colLeft + BRACKET_COL_W;
                const xMid = xStart + BRACKET_COL_GAP / 2;
                const xEnd = xStart + BRACKET_COL_GAP;
                // Each stacked sibling draws from the SAME shared feeder
                // round as its primary (a match's winner and loser are the
                // two halves of one binary outcome, not disjoint slices of
                // a bigger feeder) — same geometry as the 3rd Place Playoff
                // connector below, one point per feeder match.
                const y1 = centers[feederCol]?.[0] ?? 0;
                const y2 = centers[feederCol]?.[1] ?? y1;
                return stackedList.map((_, k) => {
                  const y = (centers[primaryCol]?.[0] ?? 0) + stackedOffset(k);
                  return (
                    <path
                      key={`stacked-${primary}-${k}`}
                      d={`M ${xStart} ${y1} L ${xMid} ${y1} L ${xMid} ${y} L ${xEnd} ${y} M ${xMid} ${y2} L ${xStart} ${y2}`}
                      fill="none"
                      className="tm-bracket-line tm-bracket-line--third"
                    />
                  );
                });
              })}
              {thirdPlaceMatch && semifinalStageIdx >= 0 && (() => {
                const colLeft = semifinalStageIdx * (BRACKET_COL_W + BRACKET_COL_GAP);
                const xStart = colLeft + BRACKET_COL_W;
                const xMid = xStart + BRACKET_COL_GAP / 2;
                const xEnd = xStart + BRACKET_COL_GAP;
                const y1 = centers[semifinalStageIdx][0];
                const y2 = centers[semifinalStageIdx][1] ?? y1;
                return (
                  <path
                    d={`M ${xStart} ${y1} L ${xMid} ${y1} L ${xMid} ${thirdPlaceY} L ${xEnd} ${thirdPlaceY} M ${xMid} ${y2} L ${xStart} ${y2}`}
                    fill="none"
                    className="tm-bracket-line tm-bracket-line--third"
                  />
                );
              })()}
            </svg>
            {primaryStages.map(([stageName, stageMatches], r) => (
              <div
                key={stageName}
                className="tm-bracket-col"
                style={{ position: 'absolute', left: r * (BRACKET_COL_W + BRACKET_COL_GAP), top: 0, width: BRACKET_COL_W, height: containerHeight + 24 }}
              >
                {/* Tier-prefixed (e.g. "Cup Semifinal") whenever this column's
                    fixtures carry a tier — reads off the matches themselves
                    rather than a single "active tier" passed in, since a
                    shared Cup/Plate-style Quarterfinal column carries its own
                    combined tier label ("Cup/Plate") distinct from the pure
                    tier of the Semifinal/Final columns after it. Without this
                    the OBS bracket widget (no tier chip row visible there,
                    unlike the in-app Bracket tab) shows a bare "Semifinal"
                    with no way to tell which tier's bracket is on screen. */}
                <div className="tm-bracket-col-title">{stageMatches[0]?.tier ? `${stageMatches[0].tier} ${stageName}` : stageName}</div>
                {stageMatches.map((m, i) => renderMatch(m, centers[r]?.[i] ?? 0, !!editable && editMode && r === 0))}
              </div>
            ))}
            {/* Stacked siblings (e.g. "11th-12th Placing") render in their
                primary's column, offset below it — same treatment as the
                3rd Place Playoff block further down, generalized. */}
            {Array.from(stackedGroups.entries()).flatMap(([primary, stackedList]) =>
              stackedList.map((stackedRawIdx, k) => {
                const [stageName, stageMatches] = stages[stackedRawIdx];
                const col = colOfStage(primary);
                const y = (centers[col]?.[0] ?? 0) + stackedOffset(k);
                return (
                  <div
                    key={`stacked-col-${stackedRawIdx}`}
                    className="tm-bracket-col"
                    style={{ position: 'absolute', left: col * (BRACKET_COL_W + BRACKET_COL_GAP), top: 0, width: BRACKET_COL_W, height: containerHeight + 24 }}
                  >
                    <div className="tm-bracket-col-title tm-bracket-col-title--third" style={{ position: 'absolute', top: y - BRACKET_MATCH_H / 2 - 16 }}>
                      {stageMatches[0]?.tier ? `${stageMatches[0].tier} ${stageName}` : stageName}
                    </div>
                    {stageMatches.map(m => renderMatch(m, y, false))}
                  </div>
                );
              })
            )}
            {thirdPlaceMatch && (() => {
              const score = findScore(thirdPlaceMatch);
              const win = findWinner(thirdPlaceMatch);
              const aWins = win?.side === 'A';
              const bWins = win?.side === 'B';
              return (
                <div
                  className="tm-bracket-col"
                  style={{ position: 'absolute', left: finalStageIdx * (BRACKET_COL_W + BRACKET_COL_GAP), top: 0, width: BRACKET_COL_W, height: containerHeight + 24 }}
                >
                  <div
                    className="tm-bracket-col-title tm-bracket-col-title--third"
                    style={{ position: 'absolute', top: thirdPlaceY - BRACKET_MATCH_H / 2 - 16 }}
                  ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Medal size={12} /> {thirdPlaceMatch.tier ? `${thirdPlaceMatch.tier} ` : ''}3rd Place</span></div>
                  <div
                    className="tm-bracket-match"
                    style={{ position: 'absolute', top: thirdPlaceY - BRACKET_MATCH_H / 2, left: 0, width: BRACKET_COL_W, height: BRACKET_MATCH_H }}
                    title={win?.shootout ? `Won on penalties, ${win.shootout.scoreA}-${win.shootout.scoreB}` : undefined}
                  >
                    <div className={`tm-bracket-team${aWins ? ' tm-bracket-team--winner' : ''}`}>
                      <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={thirdPlaceMatch.teamALogo} color={thirdPlaceMatch.teamAColor} /></div>
                      {onSelectTeam ? (
                        <span className="tm-bracket-team-name tm-bracket-team-name--clickable" onClick={() => onSelectTeam(thirdPlaceMatch.teamAName)}>{thirdPlaceMatch.teamAShortName || thirdPlaceMatch.teamAName}</span>
                      ) : (
                        <span className="tm-bracket-team-name">{thirdPlaceMatch.teamAShortName || thirdPlaceMatch.teamAName}</span>
                      )}
                      {score && <span className="tm-bracket-score">{score.a}{win?.shootout && aWins ? <sup className="tm-bracket-pens">p</sup> : null}</span>}
                    </div>
                    <div className={`tm-bracket-team${bWins ? ' tm-bracket-team--winner' : ''}`}>
                      <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={thirdPlaceMatch.teamBLogo} color={thirdPlaceMatch.teamBColor} /></div>
                      <span
                        className={thirdPlaceMatch.teamBName && onSelectTeam ? 'tm-bracket-team-name tm-bracket-team-name--clickable' : 'tm-bracket-team-name'}
                        onClick={thirdPlaceMatch.teamBName && onSelectTeam ? () => onSelectTeam(thirdPlaceMatch.teamBName) : undefined}
                      >{thirdPlaceMatch.teamBName ? (thirdPlaceMatch.teamBShortName || thirdPlaceMatch.teamBName) : 'BYE'}</span>
                      {score && <span className="tm-bracket-score">{score.b}{win?.shootout && bWins ? <sup className="tm-bracket-pens">p</sup> : null}</span>}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
