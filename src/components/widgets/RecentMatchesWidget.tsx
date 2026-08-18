import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { AlertTriangle, Check, Download, Upload, X } from 'lucide-react';
import { useMatchResultsStore, type SavedMatchResult } from '../../stores/matchResultsStore';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { resolveImageUrl } from '../../lib/imageUrl';
import { pushResultsOnly, pullResultsOnly } from '../../lib/cloudSync';
import { useMatchNumbers } from '../../utils/matchNumber';
import { sortResults, RESULT_SORT_LABELS, type ResultSortMode } from '../../utils/resultSort';

// vMix push — same "one input, several 1-based indexed fixture slots"
// pattern MatchScheduleWidget uses (see its FixtureVmixTarget/
// pushFixturesToTargets), plus Score A/B (results have a final score,
// unlike a still-upcoming fixture) and an optional "finished" status field
// that can be either a text label (e.g. "FT") or an image (e.g. a
// checkmark badge) on the same field slot, whichever the operator points
// it at. A target can either configure its OWN vMix input+fields
// (standalone), or reuse an existing Match Schedule widget's own vMix
// input+team/date/time/round field mapping (linked) — so the exact same
// on-screen graphic slot a fixture was shown in can be re-pushed with its
// final result instead, without duplicating that field mapping by hand.
type ResultMergePart = 'teamA' | 'teamB' | 'shortTeamA' | 'shortTeamB' | 'scoreA' | 'scoreB' | 'date' | 'time' | 'round' | 'competition';

interface ResultVmixTarget {
  id: string;
  mode?: 'standalone' | 'linked';
  inputKey?: string;
  inputTitle?: string;
  teamAPrefix?: string;
  teamBPrefix?: string;
  /** Short name ONLY (blank if the team has none) — separate from
   *  teamAPrefix/teamBPrefix above, which already fall back to the short
   *  name when set. */
  shortTeamAPrefix?: string;
  shortTeamBPrefix?: string;
  datePrefix?: string;
  timePrefix?: string;
  roundPrefix?: string;
  linkedWidgetId?: string;
  linkedListKey?: 'scheduleVmixInputs' | 'nextVmixInputs';
  scoreAPrefix?: string;
  scoreBPrefix?: string;
  statusFieldPrefix?: string;
  statusFieldType?: 'text' | 'image';
  statusText?: string;
  statusImage?: string;
  mergedPrefix?: string;
  mergedParts?: ResultMergePart[];
  mergedSeparator?: string;
  autoSync?: boolean;
}

function resolveResultTargetInput(t: ResultVmixTarget, pages: any[]) {
  if (t.mode === 'linked') {
    const w = pages.flatMap((p: any) => p.widgets).find((w: any) => w.id === t.linkedWidgetId);
    const list = w?.config?.[t.linkedListKey ?? 'scheduleVmixInputs'] ?? [];
    const first = list[0];
    if (!first?.inputKey) return null;
    return { inputKey: first.inputKey as string, teamAPrefix: first.teamAPrefix, teamBPrefix: first.teamBPrefix, shortTeamAPrefix: first.shortTeamAPrefix, shortTeamBPrefix: first.shortTeamBPrefix, datePrefix: first.datePrefix, timePrefix: first.timePrefix, roundPrefix: first.roundPrefix };
  }
  if (!t.inputKey) return null;
  return { inputKey: t.inputKey, teamAPrefix: t.teamAPrefix, teamBPrefix: t.teamBPrefix, shortTeamAPrefix: t.shortTeamAPrefix, shortTeamBPrefix: t.shortTeamBPrefix, datePrefix: t.datePrefix, timePrefix: t.timePrefix, roundPrefix: t.roundPrefix };
}

function resolveResultMergePart(r: SavedMatchResult, key: ResultMergePart): string {
  switch (key) {
    case 'teamA': return r.teamAShortName || r.teamAName;
    case 'teamB': return r.teamBShortName || r.teamBName;
    case 'shortTeamA': return r.teamAShortName ?? '';
    case 'shortTeamB': return r.teamBShortName ?? '';
    case 'scoreA': return String(r.scoreA ?? 0);
    case 'scoreB': return String(r.scoreB ?? 0);
    case 'date': return r.date ?? '';
    case 'time': return r.time ?? '';
    case 'round': return r.round ?? '';
    case 'competition': return r.competition ?? '';
  }
}

interface Props {
  widgetId: string;
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

export function RecentMatchesWidget({ widgetId, config }: Props) {
  const { results: allResults, updateResult, deleteResult } = useMatchResultsStore();
  const { pages, updateWidgetConfig } = useCanvasStore();
  const maxResults: number = config.maxResults ?? 8;
  const groupByCompetition: boolean = config.groupByCompetition ?? true;
  const showDate: boolean = config.showDate ?? true;
  const title: string = config.title ?? 'Latest Results';
  const useFullName: boolean = config.nameDisplay === 'full';
  const compact: boolean = config.compactSize ?? false;
  const sortMode: ResultSortMode = config.sortMode ?? 'matchId';

  // A canvas is normally dedicated to one tournament — falls back to that
  // instead of requiring "which tournament" to be picked on every widget.
  const pageTournamentId = pages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const effectiveTournamentId: string | undefined = config.filterTournamentId || pageTournamentId;
  const results = useMemo(
    () => effectiveTournamentId ? allResults.filter(r => r.tournamentId === effectiveTournamentId) : allResults,
    [allResults, effectiveTournamentId]
  );

  const matchNumbers = useMatchNumbers();
  // matchId/kickoff sort ascending (real match running order) — "latest N"
  // for this widget's maxResults cap is the tail of that order, reversed
  // back to newest-on-top for display. 'updated' already sorts newest-first
  // (savedAt descending), so its own first N is already the right slice.
  const sortedAll = useMemo(() => sortResults(results, sortMode, matchNumbers), [results, sortMode, matchNumbers]);
  const shown = useMemo(
    () => sortMode === 'updated' ? sortedAll.slice(0, maxResults) : sortedAll.slice(-maxResults).reverse(),
    [sortedAll, maxResults, sortMode]
  );

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

  // ── vMix push — same shape/indexing as MatchScheduleWidget's own
  // pushFixturesToTargets, plus score + a "finished" status field/image.
  const { getClient, vmixState, vmixSyncVersion } = useVmixStore();
  const resultVmixTargets: ResultVmixTarget[] = config.resultVmixInputs ?? [];
  const pushResultsToVmix = useCallback(() => {
    const c = getClient();
    if (!c) return;
    for (const t of resultVmixTargets) {
      const resolved = resolveResultTargetInput(t, pages);
      if (!resolved) continue;
      const prefixes = [resolved.teamAPrefix, resolved.teamBPrefix, resolved.shortTeamAPrefix, resolved.shortTeamBPrefix, resolved.datePrefix, resolved.timePrefix, resolved.roundPrefix, t.scoreAPrefix, t.scoreBPrefix, t.statusFieldPrefix, t.mergedPrefix];
      shown.forEach((r, i) => {
        const idx = i + 1;
        if (resolved.teamAPrefix) c.setTextField(resolved.inputKey, `${resolved.teamAPrefix}${idx}.Text`, r.teamAShortName || r.teamAName);
        if (resolved.teamBPrefix) c.setTextField(resolved.inputKey, `${resolved.teamBPrefix}${idx}.Text`, r.teamBShortName || r.teamBName);
        if (resolved.shortTeamAPrefix) c.setTextField(resolved.inputKey, `${resolved.shortTeamAPrefix}${idx}.Text`, r.teamAShortName ?? '');
        if (resolved.shortTeamBPrefix) c.setTextField(resolved.inputKey, `${resolved.shortTeamBPrefix}${idx}.Text`, r.teamBShortName ?? '');
        if (resolved.datePrefix)  c.setTextField(resolved.inputKey, `${resolved.datePrefix}${idx}.Text`, r.date ?? '');
        if (resolved.timePrefix)  c.setTextField(resolved.inputKey, `${resolved.timePrefix}${idx}.Text`, r.time ?? '');
        if (resolved.roundPrefix) c.setTextField(resolved.inputKey, `${resolved.roundPrefix}${idx}.Text`, r.round ?? '');
        if (t.scoreAPrefix) c.setTextField(resolved.inputKey, `${t.scoreAPrefix}${idx}.Text`, String(r.scoreA ?? 0));
        if (t.scoreBPrefix) c.setTextField(resolved.inputKey, `${t.scoreBPrefix}${idx}.Text`, String(r.scoreB ?? 0));
        if (t.statusFieldPrefix) {
          if (t.statusFieldType === 'image') {
            if (t.statusImage) c.setImageField(resolved.inputKey, `${t.statusFieldPrefix}${idx}.Source`, t.statusImage);
          } else {
            c.setTextField(resolved.inputKey, `${t.statusFieldPrefix}${idx}.Text`, t.statusText ?? 'FT');
          }
        }
        if (t.mergedPrefix && t.mergedParts?.length) {
          c.setTextField(resolved.inputKey, `${t.mergedPrefix}${idx}.Text`, t.mergedParts.map(k => resolveResultMergePart(r, k)).join(t.mergedSeparator ?? ' '));
        }
      });
      // Clear any extra same-prefix fields beyond the reserved slot count,
      // e.g. leftover text from a previously longer results list — same
      // cleanup MatchScheduleWidget's own push does.
      const vmixInput = vmixState?.inputs?.find(inp => inp.key === resolved.inputKey);
      if (vmixInput) {
        for (const prefix of prefixes) {
          if (!prefix) continue;
          const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`^${esc}(\\d+)\\.(Text|Source)$`, 'i');
          for (const field of vmixInput.textFields) {
            const fm = field.name.match(re);
            if (fm && parseInt(fm[1]) > shown.length) c.setTextField(resolved.inputKey, field.name, '');
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultVmixTargets, shown, pages, getClient, vmixState]);

  useEffect(() => {
    if (resultVmixTargets.some(t => t.autoSync)) pushResultsToVmix();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, vmixSyncVersion]);

  // Manual "results only" sync — same scoped push/pull as the Tournament
  // Database's Results tab, exposed here too so an operator watching this
  // widget doesn't need to open that window just to confirm results are
  // in sync. Needs a tournament scope to know what to sync.
  const [resultsSyncState, setResultsSyncState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const runResultsSync = async (kind: 'pull' | 'push') => {
    if (!effectiveTournamentId || resultsSyncState === 'busy') return;
    setResultsSyncState('busy');
    const result = kind === 'pull' ? await pullResultsOnly(effectiveTournamentId) : await pushResultsOnly(effectiveTournamentId);
    setResultsSyncState(result.ok ? 'done' : 'error');
    setTimeout(() => setResultsSyncState('idle'), 2000);
  };

  return (
    <div className={`wgt-rm${compact ? ' wgt-rm--compact' : ''}`}>
      <div className="wgt-rm-header">
        <span>{title}</span>
        <div className="wgt-rm-sync-btns" onClick={e => e.stopPropagation()}>
          <select
            className="wgt-rm-sort-select"
            value={sortMode}
            title="Sort order"
            onPointerDown={e => e.stopPropagation()}
            onChange={e => updateWidgetConfig(widgetId, { sortMode: e.target.value as ResultSortMode })}
          >
            {(Object.keys(RESULT_SORT_LABELS) as ResultSortMode[]).map(m => (
              <option key={m} value={m}>{RESULT_SORT_LABELS[m]}</option>
            ))}
          </select>
          {resultsSyncState === 'error' && <span className="wgt-rm-sync-status wgt-rm-sync-status--error"><AlertTriangle size={12} /></span>}
          {resultsSyncState === 'done' && <span className="wgt-rm-sync-status"><Check size={12} /></span>}
          <button
            className="wgt-rm-tool-btn"
            disabled={!effectiveTournamentId || resultsSyncState === 'busy'}
            title={effectiveTournamentId ? "Pull just this tournament's results from the cloud" : 'No tournament scoped to this widget/canvas'}
            onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); runResultsSync('pull'); }}
          >{resultsSyncState === 'busy' ? '…' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Download size={13} /> Pull</span>}</button>
          <button
            className="wgt-rm-tool-btn"
            disabled={!effectiveTournamentId || resultsSyncState === 'busy'}
            title={effectiveTournamentId ? "Push just this tournament's results to the cloud" : 'No tournament scoped to this widget/canvas'}
            onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); runResultsSync('push'); }}
          >{resultsSyncState === 'busy' ? '…' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Upload size={13} /> Push</span>}</button>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="wgt-rm-empty">No saved results yet — use "Save Result" on a scoreboard widget</div>
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
                        value={useFullName ? r.teamAName : (r.teamAShortName || r.teamAName)}
                        onChange={v => updateResult(r.id, useFullName || !r.teamAShortName ? { teamAName: v } : { teamAShortName: v })}
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
                        value={useFullName ? r.teamBName : (r.teamBShortName || r.teamBName)}
                        onChange={v => updateResult(r.id, useFullName || !r.teamBShortName ? { teamBName: v } : { teamBShortName: v })}
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
                    ><X size={12} /></button>
                  </div>
                  <div className="wgt-rm-round-row">
                    {r.sourceScheduleId && matchNumbers.get(r.sourceScheduleId) && (
                      <span className="wgt-match-id" title="Match ID — same as shown on the public scoring page">{matchNumbers.get(r.sourceScheduleId)}</span>
                    )}
                    {r.matchType && <span className="wgt-rm-type-badge">{r.matchType === 'bye' ? 'BYE' : 'W/O'}</span>}
                    {r.shootout && <span className="wgt-rm-type-badge">{r.shootout.scoreA}-{r.shootout.scoreB} PENS</span>}
                    <EditableSpan
                      className="wgt-rm-round"
                      placeholder="Round/Group"
                      value={r.round ?? ''}
                      onChange={v => updateResult(r.id, { round: v })}
                    />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
