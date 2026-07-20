import { useMemo, useRef, useState, useEffect } from 'react';
import { useMatchScheduleStore, type ScheduledMatch } from '../../stores/matchScheduleStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useCanvasStore } from '../../stores/canvasStore';
import {
  ScheduleBadge, extractKnockoutStage, knockoutStageSize, computeBracketCenters, findMatchScore, findMatchWinner,
  BRACKET_MATCH_H, BRACKET_BASE_GAP, BRACKET_COL_W, BRACKET_COL_GAP,
} from '../TournamentManager';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

// Read-only broadcast display of a tournament's knockout bracket — mirrors
// the Tournament Database's Bracket tab (BracketPanel) geometry/rendering
// exactly (reusing its exported helpers), but drops everything that only
// makes sense as an editing tool there: "✏️ Edit Arrangement", "Add 3rd
// Place Playoff", and the click-to-TeamInfoModal team names.
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

  const effectiveCategory = (m: ScheduledMatch): string | undefined =>
    m.category ?? (m.round?.includes(' · ') ? m.round.split(' · ')[0] : undefined);

  const matches = useMemo(
    () => !tournament ? [] : allMatches.filter(m =>
      m.tournamentId === tournament.id &&
      (categories.length === 0 || effectiveCategory(m) === category) &&
      !!extractKnockoutStage(m)
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament, category, categories.length]
  );

  const thirdPlaceMatch = useMemo(
    () => !tournament ? undefined : allMatches.find(m =>
      m.tournamentId === tournament.id &&
      (categories.length === 0 || effectiveCategory(m) === category) &&
      m.group === '3rd Place'
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament, category, categories.length]
  );

  const stages = useMemo(() => {
    const byStage = new Map<string, ScheduledMatch[]>();
    for (const m of matches) {
      const key = extractKnockoutStage(m)!;
      if (!byStage.has(key)) byStage.set(key, []);
      byStage.get(key)!.push(m);
    }
    return Array.from(byStage.entries()).sort((a, b) => knockoutStageSize(b[0]) - knockoutStageSize(a[0]));
  }, [matches]);

  const centers = useMemo(() => computeBracketCenters(stages.map(([, ms]) => ms.length)), [stages]);
  const bracketHeight = centers[0] ? centers[0].length * (BRACKET_MATCH_H + BRACKET_BASE_GAP) : 0;
  const bracketWidth = stages.length * (BRACKET_COL_W + BRACKET_COL_GAP) - BRACKET_COL_GAP;

  const semifinalStageIdx = stages.findIndex(([name]) => name === 'Semifinal');
  const finalStageIdx = stages.length - 1;
  const finalCenterY = centers[finalStageIdx]?.[0] ?? 0;
  const thirdPlaceY = finalCenterY + BRACKET_MATCH_H + BRACKET_BASE_GAP * 2.5;
  const containerHeight = thirdPlaceMatch
    ? Math.max(bracketHeight, thirdPlaceY + BRACKET_MATCH_H / 2 + 20)
    : bracketHeight;
  const naturalWidth = bracketWidth;
  const naturalHeight = containerHeight + 24;

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

  const findScore = (m: ScheduledMatch) => tournament ? findMatchScore(m, allResults, tournament.id) : null;
  const findWinner = (m: ScheduledMatch) => tournament ? findMatchWinner(m, allResults, tournament.id) : null;

  if (!tournament) {
    return <div className="wgt-bracket wgt-bracket--empty">Pick a tournament in widget settings</div>;
  }
  if (categories.length > 0 && !category) {
    return <div className="wgt-bracket wgt-bracket--empty">Pick a category in widget settings</div>;
  }
  if (stages.length === 0) {
    return <div className="wgt-bracket wgt-bracket--empty">No knockout-stage fixtures found{categories.length > 0 ? ' for this category' : ''}</div>;
  }

  return (
    <div className="wgt-bracket">
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
              {stages.slice(0, -1).map(([, stageMatches], r) => {
                const colLeft = r * (BRACKET_COL_W + BRACKET_COL_GAP);
                const xStart = colLeft + BRACKET_COL_W;
                const xMid = xStart + BRACKET_COL_GAP / 2;
                const xEnd = xStart + BRACKET_COL_GAP;
                const pairs: React.ReactNode[] = [];
                for (let i = 0; i < stageMatches.length; i += 2) {
                  const y1 = centers[r][i];
                  const y2 = centers[r][i + 1] ?? y1;
                  const yMid = centers[r + 1]?.[i / 2] ?? (y1 + y2) / 2;
                  pairs.push(
                    <path
                      key={`${r}-${i}`}
                      d={`M ${xStart} ${y1} L ${xMid} ${y1} L ${xMid} ${y2} L ${xStart} ${y2} M ${xMid} ${yMid} L ${xEnd} ${yMid}`}
                      fill="none"
                      className="tm-bracket-line"
                    />
                  );
                }
                return pairs;
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
            {stages.map(([stageName, stageMatches], r) => (
              <div
                key={stageName}
                className="tm-bracket-col"
                style={{ position: 'absolute', left: r * (BRACKET_COL_W + BRACKET_COL_GAP), top: 0, width: BRACKET_COL_W, height: containerHeight + 24 }}
              >
                <div className="tm-bracket-col-title">{stageName}</div>
                {stageMatches.map((m, i) => {
                  const score = findScore(m);
                  const win = findWinner(m);
                  const aWins = win?.side === 'A';
                  const bWins = win?.side === 'B';
                  const centerY = centers[r]?.[i] ?? 0;
                  return (
                    <div
                      key={m.id}
                      className="tm-bracket-match"
                      style={{ position: 'absolute', top: 24 + centerY - BRACKET_MATCH_H / 2, left: 0, width: BRACKET_COL_W, height: BRACKET_MATCH_H }}
                      title={win?.shootout ? `Won on penalties, ${win.shootout.scoreA}-${win.shootout.scoreB}` : undefined}
                    >
                      <div className={`tm-bracket-team${aWins ? ' tm-bracket-team--winner' : ''}`}>
                        <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={m.teamALogo} color={m.teamAColor} /></div>
                        <span className="tm-bracket-team-name">{m.teamAShortName || m.teamAName}</span>
                        {score && <span className="tm-bracket-score">{score.a}{win?.shootout && aWins ? <sup className="tm-bracket-pens">p</sup> : null}</span>}
                      </div>
                      <div className={`tm-bracket-team${bWins ? ' tm-bracket-team--winner' : ''}`}>
                        <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={m.teamBLogo} color={m.teamBColor} /></div>
                        <span className="tm-bracket-team-name">{m.teamBName ? (m.teamBShortName || m.teamBName) : 'BYE'}</span>
                        {score && <span className="tm-bracket-score">{score.b}{win?.shootout && bWins ? <sup className="tm-bracket-pens">p</sup> : null}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
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
                  >🥉 3rd Place</div>
                  <div
                    className="tm-bracket-match"
                    style={{ position: 'absolute', top: thirdPlaceY - BRACKET_MATCH_H / 2, left: 0, width: BRACKET_COL_W, height: BRACKET_MATCH_H }}
                    title={win?.shootout ? `Won on penalties, ${win.shootout.scoreA}-${win.shootout.scoreB}` : undefined}
                  >
                    <div className={`tm-bracket-team${aWins ? ' tm-bracket-team--winner' : ''}`}>
                      <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={thirdPlaceMatch.teamALogo} color={thirdPlaceMatch.teamAColor} /></div>
                      <span className="tm-bracket-team-name">{thirdPlaceMatch.teamAShortName || thirdPlaceMatch.teamAName}</span>
                      {score && <span className="tm-bracket-score">{score.a}{win?.shootout && aWins ? <sup className="tm-bracket-pens">p</sup> : null}</span>}
                    </div>
                    <div className={`tm-bracket-team${bWins ? ' tm-bracket-team--winner' : ''}`}>
                      <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={thirdPlaceMatch.teamBLogo} color={thirdPlaceMatch.teamBColor} /></div>
                      <span className="tm-bracket-team-name">{thirdPlaceMatch.teamBName ? (thirdPlaceMatch.teamBShortName || thirdPlaceMatch.teamBName) : 'BYE'}</span>
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
