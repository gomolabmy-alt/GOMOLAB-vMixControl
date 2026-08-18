import React, { useState, useMemo, useContext } from 'react';
import {
  CircleDot, Asterisk, ArrowDown, ArrowUp, ChevronDown, Pencil, Check,
  X, StickyNote, ArrowLeftRight, ArrowUpDown, Pause, RotateCcw,
} from 'lucide-react';
import { useCanvasStore, formatTime } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { useUndoStore } from '../../stores/undoStore';
import { autoLinkedWidget, autoLinkedWidgetPair } from '../../lib/autoLink';
import { resolvePlayerListRoster } from '../../lib/playerListSquad';
import { simplifyPlayerName } from '../../lib/simpleName';
import type { TimelineEvent, TimelineEventType } from '../../types/canvas';

interface Props { widgetId: string; config: Record<string, any>; }

function getCurrentTimeStr(timerCfg: Record<string, any> | null) {
  if (timerCfg) return formatTime(timerCfg.currentMs ?? 0, timerCfg.format ?? 'mm:ss');
  const now = new Date();
  return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}

function renderEventIcon(ev: TimelineEvent) {
  if (ev.type === 'score') {
    return ev.jerseyNo
      ? <span className="wgt-tl2-ico wgt-tl2-ico--jersey">{ev.jerseyNo}</span>
      : <span className="wgt-tl2-ico wgt-tl2-ico--score"><CircleDot size={13} strokeWidth={2} /></span>;
  }
  if (ev.type === 'yellow-card') return <span className="wgt-tl2-ico wgt-tl2-ico--ycard" />;
  if (ev.type === 'orange-card') return <span className="wgt-tl2-ico wgt-tl2-ico--ocard" />;
  if (ev.type === 'red-card')    return <span className="wgt-tl2-ico wgt-tl2-ico--rcard" />;
  if (ev.type === 'custom')      return <span className="wgt-tl2-ico wgt-tl2-ico--custom"><Asterisk size={12} strokeWidth={2} /></span>;
  return null;
}

function JerseyTag({ no }: { no: string }) {
  return <span className="wgt-tl2-jersey">{no}</span>;
}

function PlayerName({ name, jersey }: { name?: string; jersey?: string }) {
  if (!name) return null;
  return (
    <span className="wgt-tl2-player">
      {jersey && <JerseyTag no={jersey} />}
      {name}
    </span>
  );
}

function renderEventContent(ev: TimelineEvent, side: 'left' | 'right') {
  if (ev.type === 'score') {
    const scoreLabel = ev.scoreA !== undefined ? ` [${ev.scoreA} - ${ev.scoreB}]` : '';
    return (
      <div className="wgt-tl2-content">
        <span className="wgt-tl2-label">{ev.detail || 'Score'}{scoreLabel}</span>
        {ev.player && <span className="wgt-tl2-player">{ev.player}</span>}
      </div>
    );
  }
  if (ev.type === 'yellow-card') {
    return (
      <div className="wgt-tl2-content">
        <span className="wgt-tl2-label">Yellow Card</span>
        <PlayerName name={ev.player} jersey={ev.jerseyNo} />
      </div>
    );
  }
  if (ev.type === 'orange-card') {
    return (
      <div className="wgt-tl2-content">
        <span className="wgt-tl2-label">Orange Card</span>
        <PlayerName name={ev.player} jersey={ev.jerseyNo} />
      </div>
    );
  }
  if (ev.type === 'red-card') {
    return (
      <div className="wgt-tl2-content">
        <span className="wgt-tl2-label">Red Card</span>
        <PlayerName name={ev.player} jersey={ev.jerseyNo} />
      </div>
    );
  }
  if (ev.type === 'substitution') {
    return (
      <div className="wgt-tl2-content">
        {ev.playerOff && (
          <div className={`wgt-tl2-sub-row wgt-tl2-sub-row--${side}`}>
            {side === 'right' && <span className="wgt-tl2-ico wgt-tl2-ico--sub-out"><ArrowDown size={11} strokeWidth={2} /></span>}
            <div className="wgt-tl2-sub-text">
              <span className="wgt-tl2-label">Off</span>
              <PlayerName name={ev.playerOff} jersey={ev.jerseyNoOff} />
            </div>
            {side === 'left' && <span className="wgt-tl2-ico wgt-tl2-ico--sub-out"><ArrowDown size={11} strokeWidth={2} /></span>}
          </div>
        )}
        {ev.player && (
          <div className={`wgt-tl2-sub-row wgt-tl2-sub-row--${side}`}>
            {side === 'right' && <span className="wgt-tl2-ico wgt-tl2-ico--sub-in"><ArrowUp size={11} strokeWidth={2} /></span>}
            <div className="wgt-tl2-sub-text">
              <span className="wgt-tl2-label">On</span>
              <PlayerName name={ev.player} jersey={ev.jerseyNo} />
            </div>
            {side === 'left' && <span className="wgt-tl2-ico wgt-tl2-ico--sub-in"><ArrowUp size={11} strokeWidth={2} /></span>}
          </div>
        )}
      </div>
    );
  }
  if (ev.type === 'custom') {
    return (
      <div className="wgt-tl2-content">
        <span className="wgt-tl2-label">{ev.detail}</span>
      </div>
    );
  }
  return null;
}

function renderHCard(
  ev: TimelineEvent,
  teamColor: string,
  onDelete: () => void,
  canDelete: boolean,
  onEdit?: () => void,
  isEditing?: boolean,
) {
  let label = '';
  let playerNode: React.ReactNode = null;

  if (ev.type === 'score') {
    const scoreLabel = ev.scoreA !== undefined ? ` [${ev.scoreA}-${ev.scoreB}]` : '';
    label = `${ev.detail || 'Score'}${scoreLabel}`;
    playerNode = ev.player ? <PlayerName name={ev.player} jersey={ev.jerseyNo} /> : null;
  } else if (ev.type === 'yellow-card') {
    label = 'Yellow Card';
    playerNode = ev.player ? <PlayerName name={ev.player} jersey={ev.jerseyNo} /> : null;
  } else if (ev.type === 'orange-card') {
    label = 'Orange Card';
    playerNode = ev.player ? <PlayerName name={ev.player} jersey={ev.jerseyNo} /> : null;
  } else if (ev.type === 'red-card') {
    label = 'Red Card';
    playerNode = ev.player ? <PlayerName name={ev.player} jersey={ev.jerseyNo} /> : null;
  } else if (ev.type === 'substitution') {
    label = 'Substitution';
    playerNode = (
      <span className="wgt-tl2-hplayer-sub">
        {ev.player && <><span className="wgt-tl2-sub-arr"><ArrowUp size={9} strokeWidth={2.5} /></span><PlayerName name={ev.player} jersey={ev.jerseyNo} /></>}
        {ev.player && ev.playerOff && <span className="wgt-tl2-sub-sep">/</span>}
        {ev.playerOff && <><span className="wgt-tl2-sub-arr wgt-tl2-sub-arr--out"><ArrowDown size={9} strokeWidth={2.5} /></span><PlayerName name={ev.playerOff} jersey={ev.jerseyNoOff} /></>}
      </span>
    );
  } else if (ev.type === 'custom') {
    label = ev.detail ?? '';
  }

  return (
    <div className={`wgt-tl2-hcard${isEditing ? ' wgt-tl2-hcard--editing' : ''}`} style={{ '--hc': teamColor } as React.CSSProperties}>
      {renderEventIcon(ev)}
      <span className="wgt-tl2-hlabel">{label}</span>
      {playerNode && <span className="wgt-tl2-hplayer">{playerNode}</span>}
      {onEdit && (
        <button className={`wgt-tl2-hedit${isEditing ? ' wgt-tl2-hedit--active' : ''}`} onClick={onEdit}><Pencil size={11} strokeWidth={2} /></button>
      )}
      {canDelete && (
        <button className="wgt-tl2-hdel" onClick={onDelete}><X size={11} strokeWidth={2} /></button>
      )}
    </div>
  );
}

interface EditDraft {
  player: string;
  jerseyNo: string;
  playerOff: string;
  jerseyNoOff: string;
}

export function TimelineWidget({ widgetId, config }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const { pages, addTimelineEvent, deleteTimelineEvent } = store;
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { teams: teamDbTeams } = useTeamDbStore();
  // Simple Names (App Settings) — card/sub events already arrive
  // pre-simplified (see PlayerListWidget/SubWidget, which write them);
  // score events are derived here straight from scoreLog's raw `scorer`,
  // so they need the same treatment applied at the same point.
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({ player: '', jerseyNo: '', playerOff: '', jerseyNoOff: '' });
  const [pickerTarget, setPickerTarget] = useState<'player' | 'playerOff' | null>(null);

  const layout: 'vertical' | 'horizontal' = config.layout ?? 'vertical';
  const toggleLayout = () =>
    updateWidgetConfig(widgetId, { layout: layout === 'vertical' ? 'horizontal' : 'vertical' });

  const allWidgets = pages.flatMap(p => p.widgets);
  // Both fall back to the sole matching widget on this page when nothing's
  // been explicitly linked in settings — an explicit pick always wins.
  const linkedTimer = autoLinkedWidget(pages, widgetId, config.linkedTimerWidgetId, 'timer');
  const linkedScoreboard = autoLinkedWidget(pages, widgetId, config.linkedScoreboardId, 'scoreboard');
  const timerCfg = linkedTimer?.config ?? null;
  const scoreboardCfg = linkedScoreboard?.config ?? null;

  const teamAName  = scoreboardCfg?.teamAName  ?? 'Team A';
  const teamBName  = scoreboardCfg?.teamBName  ?? 'Team B';
  const teamAColor = scoreboardCfg?.teamAColor ?? '#e74c3c';
  const teamBColor = scoreboardCfg?.teamBColor ?? '#3498db';

  // Resolved the same way the scoreboard itself would (explicit link, or
  // the two Player List widgets on its page assigned by teamSide/position).
  const { a: scoreboardPlA, b: scoreboardPlB } = linkedScoreboard
    ? autoLinkedWidgetPair(pages, linkedScoreboard.id, scoreboardCfg?.linkedPlayerListA, scoreboardCfg?.linkedPlayerListB, 'player-list')
    : {};
  const resolveSquad = (side: 'A' | 'B') => {
    const plw = side === 'A' ? scoreboardPlA : scoreboardPlB;
    const { team: teamData, starters, subs } = resolvePlayerListRoster(plw, side, teamDbTeams);
    const assigned = new Set([...starters, ...subs].filter(Boolean));
    return (teamData?.players ?? [])
      .filter((p: any) => assigned.has(p.id))
      .sort((a: any, b: any) => (parseInt(a.jerseyNo) || 999) - (parseInt(b.jerseyNo) || 999));
  };

  const inBreak = !!(timerCfg?.inBreak);
  const breakMs = timerCfg?.breakCurrentMs ?? 0;
  const periods  = timerCfg?.periods ?? 2;
  const currentPeriod = timerCfg?.currentPeriod ?? 1;
  const breakLabel =
    (periods === 2 && currentPeriod === 2) || (periods === 4 && currentPeriod === 3)
      ? 'Half Time'
      : `Break`;

  const scoreEvents: TimelineEvent[] = (scoreboardCfg?.scoreLog ?? []).map((e: Record<string, any>) => ({
    id: `sl-${e.id}`,
    type: 'score' as TimelineEventType,
    timeStr: e.timeStr ?? '',
    timeMs: e.timeMs ?? 0,
    team: e.team as 'A' | 'B',
    player: e.scorer ? disp(e.scorer) : undefined,
    jerseyNo: e.jerseyNo || undefined,
    detail: e.action,
    scoreA: e.scoreA,
    scoreB: e.scoreB,
  }));

  const ownEvents: TimelineEvent[] = config.events ?? [];
  const allEvents = useMemo(
    () => [...ownEvents, ...scoreEvents].sort((a, b) => b.timeMs - a.timeMs),
    [ownEvents, scoreEvents]
  );
  const eventsH = useMemo(() => [...allEvents].reverse(), [allEvents]);

  const confirmAdd = () => {
    if (!detail.trim()) return;
    addTimelineEvent(widgetId, {
      type: 'custom',
      timeStr: getCurrentTimeStr(timerCfg),
      timeMs: Date.now(),
      detail: detail.trim(),
    });
    setDetail('');
    setAdding(false);
  };

  const isReadOnly = (ev: TimelineEvent) => ev.id.startsWith('sl-');
  const hasPlayer = (ev: TimelineEvent) =>
    ['score', 'yellow-card', 'orange-card', 'red-card', 'substitution'].includes(ev.type);

  const startEdit = (ev: TimelineEvent) => {
    setEditingId(ev.id);
    setEditDraft({ player: ev.player ?? '', jerseyNo: ev.jerseyNo ?? '', playerOff: ev.playerOff ?? '', jerseyNoOff: ev.jerseyNoOff ?? '' });
  };
  const cancelEdit = () => { setEditingId(null); setPickerTarget(null); };
  const saveEdit = () => {
    if (!editingId) return;
    if (editingId.startsWith('sl-')) {
      const origId = editingId.slice(3);
      const scoreLog: any[] = scoreboardCfg?.scoreLog ?? [];
      const updated = scoreLog.map((e: any) =>
        e.id === origId ? { ...e, scorer: editDraft.player, jerseyNo: editDraft.jerseyNo } : e
      );
      if (linkedScoreboard) updateWidgetConfig(linkedScoreboard.id, { scoreLog: updated });
    } else {
      const events: TimelineEvent[] = config.events ?? [];
      const updated = events.map(e =>
        e.id === editingId
          ? { ...e, player: editDraft.player, jerseyNo: editDraft.jerseyNo, playerOff: editDraft.playerOff, jerseyNoOff: editDraft.jerseyNoOff }
          : e
      );
      updateWidgetConfig(widgetId, { events: updated });
    }
    setEditingId(null);
  };

  const EditForm = ({ ev }: { ev: TimelineEvent }) => {
    const PlayerBtn = ({ field }: { field: 'player' | 'playerOff' }) => {
      const name = field === 'player' ? editDraft.player : editDraft.playerOff;
      return (
        <button
          className={`wgt-tl2-edit-pickbtn${pickerTarget === field ? ' wgt-tl2-edit-pickbtn--open' : ''}`}
          onClick={() => setPickerTarget(pickerTarget === field ? null : field)}
        >
          <span className="wgt-tl2-edit-pickbtn-name">{name || '— No player —'}</span>
          <span className="wgt-tl2-edit-pickbtn-ico"><ChevronDown size={11} strokeWidth={2} /></span>
        </button>
      );
    };

    return (
      <div className="wgt-tl2-edit-form">
        {ev.type === 'substitution' ? (
          <>
            <div className="wgt-tl2-edit-row">
              <span className="wgt-tl2-edit-lbl"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><ArrowUp size={9} strokeWidth={2.5} /> On</span></span>
              <PlayerBtn field="player" />
              <input className="wgt-tl2-edit-inp wgt-tl2-edit-inp--no" value={editDraft.jerseyNo} placeholder="#"
                onChange={e => setEditDraft(d => ({ ...d, jerseyNo: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }} />
            </div>
            <div className="wgt-tl2-edit-row">
              <span className="wgt-tl2-edit-lbl"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><ArrowDown size={9} strokeWidth={2.5} /> Off</span></span>
              <PlayerBtn field="playerOff" />
              <input className="wgt-tl2-edit-inp wgt-tl2-edit-inp--no" value={editDraft.jerseyNoOff} placeholder="#"
                onChange={e => setEditDraft(d => ({ ...d, jerseyNoOff: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }} />
            </div>
          </>
        ) : (
          <div className="wgt-tl2-edit-row">
            <PlayerBtn field="player" />
            <input className="wgt-tl2-edit-inp wgt-tl2-edit-inp--no" value={editDraft.jerseyNo} placeholder="#"
              onChange={e => setEditDraft(d => ({ ...d, jerseyNo: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }} />
          </div>
        )}
        <div className="wgt-tl2-edit-actions">
          <button className="wgt-tl2-edit-save" onClick={saveEdit}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={11} strokeWidth={2} /> Save</span>
          </button>
          <button className="wgt-tl2-edit-cancel" onClick={cancelEdit}>Cancel</button>
        </div>
      </div>
    );
  };

  const tlStyle = {
    '--tl-font-event':  `${config.fontSizeEvent  ?? 11}px`,
    '--tl-font-time':   `${config.fontSizeTime   ?? 10}px`,
    '--tl-font-team':   `${config.fontSizeTeam   ?? 11}px`,
    '--tl-font-player': `${config.fontSizePlayer ?? 10}px`,
    '--tl-bubble-h':    `${config.bubbleHeight   ?? 24}px`,
    '--tl-bubble-bg':   config.bubbleBg       || 'var(--accent, #3498db)',
    '--tl-bubble-tc':   config.bubbleTextColor || '#fff',
    '--tl-row-min-h':   `${config.rowMinHeight  ?? 48}px`,
    '--tl-spine-w':     `${config.spineWidth    ?? 1}px`,
    '--tl-spine-color': config.spineColor || 'var(--border)',
    ...(config.bgColor ? { background: config.bgColor } : {}),
  } as React.CSSProperties;

  return (
    <div className="wgt-timeline" style={tlStyle}>

      {/* Team header */}
      {(config.showTeamHeader ?? true) && (
        <div className="wgt-tl2-teams">
          <div className="wgt-tl2-team wgt-tl2-team--a">
            <span className="wgt-tl2-team-dot" style={{ background: teamAColor }} />
            <span className="wgt-tl2-team-name" style={{ color: teamAColor }}>{teamAName}</span>
          </div>
          <div className="wgt-tl2-vsep" />
          <div className="wgt-tl2-team wgt-tl2-team--b">
            <span className="wgt-tl2-team-name" style={{ color: teamBColor }}>{teamBName}</span>
            <span className="wgt-tl2-team-dot" style={{ background: teamBColor }} />
          </div>
          <button
            className="wgt-tl2-layout-btn"
            onClick={toggleLayout}
            title={layout === 'vertical' ? 'Switch to horizontal view' : 'Switch to vertical view'}
          >
            {layout === 'vertical' ? <ArrowLeftRight size={13} strokeWidth={2} /> : <ArrowUpDown size={13} strokeWidth={2} />}
          </button>
        </div>
      )}

      {/* Break / halftime indicator */}
      {inBreak && (
        <div className="wgt-tl2-break-banner">
          <span className="wgt-tl2-break-dot" />
          <span className="wgt-tl2-break-label">{breakLabel}</span>
          {breakMs > 0 && (
            <span className="wgt-tl2-break-time">{formatTime(breakMs, 'mm:ss')}</span>
          )}
        </div>
      )}

      {/* ── Horizontal layout ── */}
      {layout === 'horizontal' && (
        <div className="wgt-tl2-h-wrap">
          <div className="wgt-tl2-h-team-label wgt-tl2-h-team-label--a" style={{ color: teamAColor }}>
            {teamAName}
          </div>

          <div className="wgt-tl2-h-scroll">
            {eventsH.length === 0 && <div className="wgt-tl-empty">No events yet</div>}
            {eventsH.map(ev => {
              if (ev.type === 'period' || !ev.team) {
                return (
                  <div key={ev.id} className="wgt-tl2-hdivider">
                    <span className="wgt-tl2-hdivider-label">{ev.detail || ev.timeStr}</span>
                    {!isReadOnly(ev) && (
                      <button className="wgt-tl2-hdivider-del" onClick={() => deleteTimelineEvent(widgetId, ev.id)}><X size={11} strokeWidth={2} /></button>
                    )}
                  </div>
                );
              }

              const isA = ev.team === 'A';
              const tc = isA ? teamAColor : teamBColor;
              const editing = editingId === ev.id;
              const card = renderHCard(
                ev, tc,
                () => deleteTimelineEvent(widgetId, ev.id), !isReadOnly(ev),
                hasPlayer(ev) ? () => editing ? cancelEdit() : startEdit(ev) : undefined,
                editing,
              );

              return (
                <div key={ev.id} className="wgt-tl2-hcol">
                  <div className="wgt-tl2-hcol-top">
                    {isA && card}
                    {isA && editing && <EditForm ev={ev} />}
                    {isA && <div className="wgt-tl2-hconn" />}
                  </div>
                  <div className="wgt-tl2-hcol-mid">
                    <div className="wgt-tl2-bubble">{ev.timeStr}</div>
                  </div>
                  <div className="wgt-tl2-hcol-bot">
                    {!isA && <div className="wgt-tl2-hconn" />}
                    {!isA && card}
                    {!isA && editing && <EditForm ev={ev} />}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="wgt-tl2-h-team-label wgt-tl2-h-team-label--b" style={{ color: teamBColor }}>
            {teamBName}
          </div>
        </div>
      )}

      {/* ── Vertical layout ── */}
      {layout === 'vertical' && (
        <div className="wgt-tl2-events">
          <div className="wgt-tl2-spine-line" />

          {allEvents.length === 0 && <div className="wgt-tl-empty">No events yet</div>}

          {allEvents.map(ev => {
            if (ev.type === 'period' || !ev.team) {
              return (
                <div key={ev.id} className="wgt-tl2-period-row">
                  <div className="wgt-tl2-period-rule" />
                  <span className="wgt-tl2-period-label">{ev.detail || ev.timeStr}</span>
                  <div className="wgt-tl2-period-rule" />
                  {!isReadOnly(ev) && (
                    <button className="wgt-tl2-del wgt-tl2-del--period" onClick={() => deleteTimelineEvent(widgetId, ev.id)}><X size={12} strokeWidth={2} /></button>
                  )}
                </div>
              );
            }

            const isLeft = ev.team === 'A';
            const side = isLeft ? 'left' : 'right';
            const isSub = ev.type === 'substitution';
            const editing = editingId === ev.id;

            return (
              <React.Fragment key={ev.id}>
                <div className={`wgt-tl2-row${editing ? ' wgt-tl2-row--editing' : ''}`}>
                  <div className={`wgt-tl2-side wgt-tl2-side--left${isLeft ? ' wgt-tl2-side--active' : ''}`}>
                    {isLeft && renderEventContent(ev, 'left')}
                    {isLeft && !isSub && renderEventIcon(ev)}
                  </div>
                  <div className="wgt-tl2-center">
                    <div className="wgt-tl2-bubble">{ev.timeStr}</div>
                  </div>
                  <div className={`wgt-tl2-side wgt-tl2-side--right${!isLeft ? ' wgt-tl2-side--active' : ''}`}>
                    {!isLeft && !isSub && renderEventIcon(ev)}
                    {!isLeft && renderEventContent(ev, side)}
                  </div>
                  {hasPlayer(ev) && (
                    <button
                      className={`wgt-tl2-edit-btn${editing ? ' wgt-tl2-edit-btn--active' : ''}`}
                      onClick={() => editing ? cancelEdit() : startEdit(ev)}
                    ><Pencil size={11} strokeWidth={2} /></button>
                  )}
                  {!isReadOnly(ev) && (
                    <button className="wgt-tl2-del" onClick={() => deleteTimelineEvent(widgetId, ev.id)}><X size={12} strokeWidth={2} /></button>
                  )}
                </div>
                {editing && <EditForm ev={ev} />}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* Custom event form */}
      {adding ? (
        <div className="wgt-tl-form">
          <input
            className="wgt-tl-input"
            placeholder="Event description"
            value={detail}
            autoFocus
            onChange={e => setDetail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmAdd(); if (e.key === 'Escape') setAdding(false); }}
          />
          <div className="wgt-tl-form-actions">
            <button className="wgt-tl-confirm" onClick={confirmAdd}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={12} strokeWidth={2} /> Add</span>
            </button>
            <button className="wgt-tl-cancel" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="wgt-tl-add-bar">
          <button className="wgt-tl-add-btn" title="Add custom event" onClick={() => setAdding(true)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><StickyNote size={13} strokeWidth={2} /> Custom</span>
          </button>
          <button
            className="wgt-tl-add-btn wgt-tl-add-btn--halftime"
            title="Insert half-time / period break divider"
            onClick={() => {
              const periods = timerCfg?.periods ?? 2;
              const period  = timerCfg?.currentPeriod ?? 1;
              let label = 'Half Time';
              if (periods === 4) label = period <= 2 ? 'End of Q2' : 'End of Q3';
              else if (periods > 2) label = `End of Period ${period}`;
              addTimelineEvent(widgetId, {
                type: 'period',
                timeStr: getCurrentTimeStr(timerCfg),
                timeMs: Date.now(),
                detail: label,
              });
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Pause size={13} strokeWidth={2} /> Half Time</span>
          </button>
          <button
            className="wgt-tl-add-btn wgt-tl-add-btn--danger"
            title="Clear all timeline events"
            disabled={allEvents.length === 0}
            onClick={() => {
              if (!confirm('Clear all timeline events?')) return;
              const beforeEvents = config.events;
              const beforeScoreLog = scoreboardCfg?.scoreLog;
              updateWidgetConfig(widgetId, { events: [] });
              if (linkedScoreboard) updateWidgetConfig(linkedScoreboard.id, { scoreLog: [] });
              useUndoStore.getState().pushUndo('Cleared timeline', () => {
                updateWidgetConfig(widgetId, { events: beforeEvents });
                if (linkedScoreboard) updateWidgetConfig(linkedScoreboard.id, { scoreLog: beforeScoreLog });
              });
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><RotateCcw size={13} strokeWidth={2} /> Clear</span>
          </button>
        </div>
      )}

      {/* ── Player picker dialog ── */}
      {pickerTarget && editingId && (() => {
        const editingEvent = allEvents.find(ev => ev.id === editingId);
        const squad: any[] = editingEvent?.team ? resolveSquad(editingEvent.team) : [];
        const teamColor = editingEvent?.team === 'A' ? teamAColor : teamBColor;
        const teamName  = editingEvent?.team === 'A' ? teamAName  : teamBName;
        const currentName = pickerTarget === 'player' ? editDraft.player : editDraft.playerOff;

        const pick = (name: string, jerseyNo: string) => {
          if (pickerTarget === 'player') setEditDraft(d => ({ ...d, player: name, jerseyNo }));
          else setEditDraft(d => ({ ...d, playerOff: name, jerseyNoOff: jerseyNo }));
          setPickerTarget(null);
        };

        return (
          <div className="wgt-tl2-picker-overlay" onClick={() => setPickerTarget(null)}>
            <div className="wgt-tl2-picker" style={{ borderTopColor: teamColor }} onClick={e => e.stopPropagation()}>
              <div className="wgt-tl2-picker-hdr" style={{ borderBottomColor: teamColor }}>
                <span className="wgt-tl2-picker-dot" style={{ background: teamColor }} />
                <span className="wgt-tl2-picker-team">{teamName}</span>
                <span className="wgt-tl2-picker-label">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    {pickerTarget === 'playerOff'
                      ? <><ArrowDown size={10} strokeWidth={2.5} /> Off</>
                      : <><ArrowUp size={10} strokeWidth={2.5} /> On / Scorer</>}
                  </span>
                </span>
                <button className="wgt-tl2-picker-close" onClick={() => setPickerTarget(null)}><X size={13} strokeWidth={2} /></button>
              </div>
              <div className="wgt-tl2-picker-list">
                <button
                  className={`wgt-tl2-picker-opt${!currentName ? ' wgt-tl2-picker-opt--active' : ''}`}
                  onClick={() => pick('', '')}
                >
                  <span className="wgt-tl2-picker-name">— No player —</span>
                </button>
                {squad.map((p: any) => (
                  <button
                    key={p.id}
                    className={`wgt-tl2-picker-opt${currentName === p.name ? ' wgt-tl2-picker-opt--active' : ''}`}
                    onClick={() => pick(p.name, p.jerseyNo ?? '')}
                  >
                    {p.jerseyNo && <span className="wgt-tl2-picker-no">{p.jerseyNo}</span>}
                    <span className="wgt-tl2-picker-name">{disp(p.name)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
