import { useMemo } from 'react';
import { useMatchResultsStore, type SavedMatchResult } from '../../stores/matchResultsStore';
import { resolveImageUrl } from '../../lib/imageUrl';

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

interface Group {
  key: string;
  competition: string;
  items: SavedMatchResult[];
}

export function RecentMatchesWidget({ config }: Props) {
  const { results, deleteResult } = useMatchResultsStore();
  const maxResults: number = config.maxResults ?? 8;
  const groupByCompetition: boolean = config.groupByCompetition ?? true;
  const showDate: boolean = config.showDate ?? true;
  const title: string = config.title ?? 'Latest Results';

  const shown = useMemo(() => results.slice(0, maxResults), [results, maxResults]);

  const groups: Group[] = useMemo(() => {
    if (!groupByCompetition) return [{ key: '__all__', competition: '', items: shown }];
    const out: Group[] = [];
    for (const r of shown) {
      const comp = r.competition || 'Results';
      const last = out[out.length - 1];
      if (last && last.competition === comp) last.items.push(r);
      else out.push({ key: `${comp}-${out.length}`, competition: comp, items: [r] });
    }
    return out;
  }, [shown, groupByCompetition]);

  return (
    <div className="wgt-rm">
      <div className="wgt-rm-header">{title}</div>
      {shown.length === 0 ? (
        <div className="wgt-rm-empty">No saved results yet — use "💾 Save Result" on a scoreboard widget</div>
      ) : (
        <div className="wgt-rm-list">
          {groups.map(g => (
            <div key={g.key} className="wgt-rm-group">
              {groupByCompetition && (
                <div className="wgt-rm-group-header">
                  <span className="wgt-rm-group-comp">{g.competition}</span>
                  {showDate && g.items[0]?.date && <span className="wgt-rm-group-date">{g.items[0].date}</span>}
                </div>
              )}
              {g.items.map(r => (
                <div key={r.id} className="wgt-rm-row">
                  <div className="wgt-rm-team wgt-rm-team--a">
                    {r.teamALogo
                      ? <img className="wgt-rm-logo" src={resolveImageUrl(r.teamALogo)} alt="" />
                      : <div className="wgt-rm-logo-ph" style={{ background: r.teamAColor }} />
                    }
                    <span className="wgt-rm-team-name" title={r.teamAName}>{r.teamAShortName || r.teamAName}</span>
                  </div>
                  <div className="wgt-rm-score">
                    <span className={r.scoreA > r.scoreB ? 'wgt-rm-score-win' : r.scoreA < r.scoreB ? 'wgt-rm-score-lose' : ''}>{r.scoreA}</span>
                    <span className="wgt-rm-score-sep">–</span>
                    <span className={r.scoreB > r.scoreA ? 'wgt-rm-score-win' : r.scoreB < r.scoreA ? 'wgt-rm-score-lose' : ''}>{r.scoreB}</span>
                  </div>
                  <div className="wgt-rm-team wgt-rm-team--b">
                    <span className="wgt-rm-team-name" title={r.teamBName}>{r.teamBShortName || r.teamBName}</span>
                    {r.teamBLogo
                      ? <img className="wgt-rm-logo" src={resolveImageUrl(r.teamBLogo)} alt="" />
                      : <div className="wgt-rm-logo-ph" style={{ background: r.teamBColor }} />
                    }
                  </div>
                  {!groupByCompetition && showDate && <span className="wgt-rm-date">{r.date}</span>}
                  <button
                    className="wgt-rm-del"
                    title="Delete this result"
                    onClick={e => { e.stopPropagation(); deleteResult(r.id); }}
                  >×</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
