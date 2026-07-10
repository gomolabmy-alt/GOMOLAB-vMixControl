import { useMemo, useState, useRef, useEffect } from 'react';
import { useMatchResultsStore, type SavedMatchResult } from '../../stores/matchResultsStore';
import { resolveImageUrl } from '../../lib/imageUrl';
import { ConfirmButton } from '../ConfirmButton';

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

// Double-click a team name or score directly on the widget to correct it in
// place — no need to reopen the Tournament DB window for a quick fix.
function EditableSpan({ value, onChange, className, type = 'text', title, placeholder }: {
  value: string; onChange: (v: string) => void; className?: string; type?: 'text' | 'number'; title?: string; placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select(); });
  }, [editing]);

  const commit = () => { setEditing(false); if (draft !== value) onChange(draft); };

  if (editing) {
    return (
      <input
        ref={ref}
        type={type}
        className={`wgt-rm-edit-input ${className ?? ''}`}
        value={draft}
        onClick={e => e.stopPropagation()}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
      />
    );
  }

  return (
    <span
      className={className}
      title={title}
      onDoubleClick={e => { e.stopPropagation(); setDraft(value); setEditing(true); }}
    >
      {value || (placeholder ? <span className="wgt-rm-placeholder">{placeholder}</span> : '')}
    </span>
  );
}

export function RecentMatchesWidget({ config }: Props) {
  const { results, updateResult, deleteResult, clearResults } = useMatchResultsStore();
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
      <div className="wgt-rm-header">
        <span>{title}</span>
        {results.length > 0 && (
          <ConfirmButton
            className="wgt-rm-tool-btn"
            label="🗑 Clear"
            confirmLabel="Delete all"
            message="Delete all saved results? This can't be undone."
            onConfirm={clearResults}
          />
        )}
      </div>
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
                <div key={r.id} className="wgt-rm-row-wrap">
                  <div className="wgt-rm-row">
                    <div className="wgt-rm-team wgt-rm-team--a">
                      {r.teamALogo
                        ? <img className="wgt-rm-logo" src={resolveImageUrl(r.teamALogo)} alt="" />
                        : <div className="wgt-rm-logo-ph" style={{ background: r.teamAColor }} />
                      }
                      <EditableSpan
                        className="wgt-rm-team-name"
                        title={r.teamAName}
                        value={r.teamAShortName || r.teamAName}
                        onChange={v => updateResult(r.id, r.teamAShortName ? { teamAShortName: v } : { teamAName: v })}
                      />
                    </div>
                    <div className="wgt-rm-score">
                      <EditableSpan
                        type="number"
                        className={r.scoreA > r.scoreB ? 'wgt-rm-score-win' : r.scoreA < r.scoreB ? 'wgt-rm-score-lose' : ''}
                        value={String(r.scoreA)}
                        onChange={v => updateResult(r.id, { scoreA: Number(v) || 0 })}
                      />
                      <span className="wgt-rm-score-sep">–</span>
                      <EditableSpan
                        type="number"
                        className={r.scoreB > r.scoreA ? 'wgt-rm-score-win' : r.scoreB < r.scoreA ? 'wgt-rm-score-lose' : ''}
                        value={String(r.scoreB)}
                        onChange={v => updateResult(r.id, { scoreB: Number(v) || 0 })}
                      />
                    </div>
                    <div className="wgt-rm-team wgt-rm-team--b">
                      <EditableSpan
                        className="wgt-rm-team-name"
                        title={r.teamBName}
                        value={r.teamBShortName || r.teamBName}
                        onChange={v => updateResult(r.id, r.teamBShortName ? { teamBShortName: v } : { teamBName: v })}
                      />
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
                  <EditableSpan
                    className="wgt-rm-round"
                    placeholder="Round/Group"
                    value={r.round ?? ''}
                    onChange={v => updateResult(r.id, { round: v })}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
