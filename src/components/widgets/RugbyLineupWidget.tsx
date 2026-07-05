import { useState, useRef, useEffect, useMemo, useCallback, useContext } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import type { Player } from '../../types/tournament';
import { CanvasActionContext } from '../../lib/canvasContext';

interface RPlayer {
  number: number;
  name: string;
  jerseyNo?: string;
  position: string;
  x: number;
  y: number;
  jerseyColor: string;
  textColor: string;
}

const POSITIONS_META: { number: number; position: string; x: number; y: number }[] = [
  { number: 1,  position: 'Loosehead Prop',  x: 27, y: 13 },
  { number: 2,  position: 'Hooker',           x: 50, y: 13 },
  { number: 3,  position: 'Tighthead Prop',   x: 73, y: 13 },
  { number: 6,  position: 'Open Flanker',     x: 13, y: 29 },
  { number: 4,  position: 'L Lock',           x: 35, y: 29 },
  { number: 5,  position: 'R Lock',           x: 58, y: 29 },
  { number: 7,  position: 'Blind Flanker',    x: 80, y: 29 },
  { number: 8,  position: 'Number 8',         x: 50, y: 42 },
  { number: 9,  position: 'Scrum Half',       x: 50, y: 52 },
  { number: 10, position: 'Fly Half',         x: 30, y: 62 },
  { number: 12, position: 'Inside Centre',    x: 64, y: 62 },
  { number: 11, position: 'Left Wing',        x: 11, y: 76 },
  { number: 13, position: 'Outside Centre',   x: 31, y: 76 },
  { number: 15, position: 'Full Back',        x: 53, y: 76 },
  { number: 14, position: 'Right Wing',       x: 78, y: 76 },
];

const JERSEY_PRESETS = [
  '#ffffff', '#f0f0f0', '#222222', '#e74c3c', '#c0392b',
  '#3498db', '#2980b9', '#2ecc71', '#27ae60', '#f39c12',
  '#e67e22', '#9b59b6', '#1abc9c', '#e91e63', '#ff5722', '#607d8b',
];

const NUM_PRESETS = ['#222222', '#ffffff', '#e74c3c', '#3498db', '#f39c12', '#2ecc71'];

function buildDefaultPlayers(teamColor: string): RPlayer[] {
  return POSITIONS_META.map(p => ({ ...p, name: '', jerseyColor: teamColor, textColor: '#222222' }));
}

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

export function RugbyLineupWidget({ widgetId, config: cfg, w, h }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const pages = store.pages; // always use main canvas pages for player data lookups
  const { tournaments } = useTournamentStore();

  const teamColor: string  = cfg.teamColor  ?? '#3498db';
  const fieldColor: string = cfg.fieldColor ?? '#2d7a3a';
  const players: RPlayer[] = (cfg.players?.length === 15) ? cfg.players : buildDefaultPlayers(teamColor);
  const side: 'A' | 'B'   = cfg.teamSide ?? 'A';

  // Resolve team name and available players from linked tournament
  const linkedTournament = useMemo(() =>
    tournaments.find(t => t.id === cfg.linkedTournamentId), [tournaments, cfg.linkedTournamentId]);
  const linkedTeam = side === 'A' ? linkedTournament?.teamA : linkedTournament?.teamB;
  const teamName: string = linkedTeam?.name ?? cfg.teamName ?? 'Team Name';

  const [layoutEdit, setLayoutEdit]     = useState(false);
  const [editing, setEditing]           = useState<number | null>(null);
  const [draft, setDraft]               = useState('');
  const [colorPicking, setColorPicking] = useState<number | null>(null);
  const [dragPos, setDragPos]           = useState<{ num: number; x: number; y: number } | null>(null);

  const dragging    = useRef<{ num: number; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const dragPosRef  = useRef<{ num: number; x: number; y: number } | null>(null);
  const fieldRef    = useRef<HTMLDivElement>(null);

  const getPlayer = (num: number): RPlayer =>
    players.find(p => p.number === num) ??
    { ...(POSITIONS_META.find(p => p.number === num)!), name: '', jerseyColor: teamColor, textColor: '#222222' };

  const getDisplayPos = (num: number) =>
    (dragPos?.num === num) ? { x: dragPos.x, y: dragPos.y } : { x: getPlayer(num).x, y: getPlayer(num).y };

  const updatePlayer = useCallback((num: number, updates: Partial<RPlayer>) => {
    const updated = players.map(p => p.number === num ? { ...p, ...updates } : p);
    updateWidgetConfig(widgetId, { players: updated });
  }, [players, updateWidgetConfig, widgetId]);

  // Global drag listeners
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !fieldRef.current) return;
      const rect = fieldRef.current.getBoundingClientRect();
      const x = Math.max(4, Math.min(96, dragging.current.origX + ((e.clientX - dragging.current.startX) / rect.width) * 100));
      const y = Math.max(4, Math.min(96, dragging.current.origY + ((e.clientY - dragging.current.startY) / rect.height) * 100));
      dragPosRef.current = { num: dragging.current.num, x, y };
      setDragPos({ num: dragging.current.num, x, y });
    };
    const onUp = () => {
      if (!dragging.current) return;
      if (dragPosRef.current) updatePlayer(dragging.current.num, { x: dragPosRef.current.x, y: dragPosRef.current.y });
      dragging.current = null; dragPosRef.current = null; setDragPos(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [updatePlayer]);

  // Live substitution overrides: when a PlayerListWidget is linked, read its starters array
  // so that after a sub the incoming player's name appears at the right position on field.
  const linkedPlw = cfg.linkedPlayerListId
    ? pages.flatMap(p => p.widgets).find(w => w.id === cfg.linkedPlayerListId)
    : null;
  const subOverrides = useMemo(() => {
    if (!linkedPlw || !linkedTeam) return {} as Record<number, { name: string; jerseyNo?: string; isSub: boolean }>;
    const plStarters: string[] = linkedPlw.config?.starters ?? [];
    const subbedOn: Set<string> = new Set(linkedPlw.config?.subbedOnPlayers ?? []);
    // All players on this team (starters + subs) so we can look up incoming subs by id
    const allPlayers = linkedTeam.players ?? [];
    const playerById = Object.fromEntries(allPlayers.map((p: Player) => [p.id, p]));
    const overrides: Record<number, { name: string; jerseyNo?: string; isSub: boolean }> = {};
    POSITIONS_META.forEach((pm, i) => {
      const id = plStarters[i];
      if (!id) return;
      const p = playerById[id];
      if (!p) return;
      overrides[pm.number] = { name: p.name, jerseyNo: p.jerseyNo || undefined, isSub: subbedOn.has(id) };
    });
    return overrides;
  }, [linkedPlw, linkedTeam]);

  // Available players: from linked tournament team, then fall back to any player-list widget
  const availablePlayers = useMemo((): Player[] => {
    if (linkedTeam?.players?.length) return linkedTeam.players;
    const seen = new Set<string>();
    const result: Player[] = [];
    for (const page of pages) {
      for (const widget of page.widgets) {
        if (widget.type !== 'player-list') continue;
        const t = tournaments.find(t => t.id === widget.config.linkedTournamentId);
        const wSide: 'A' | 'B' = widget.config.teamSide ?? 'A';
        const team = wSide === 'A' ? t?.teamA : t?.teamB;
        for (const p of team?.players ?? []) {
          if (!seen.has(p.id)) { seen.add(p.id); result.push(p); }
        }
      }
    }
    return result;
  }, [linkedTeam, pages, tournaments]);

  const startEdit = (num: number) => { setEditing(num); setDraft(getPlayer(num).name); setColorPicking(null); };
  const commitEdit = () => { if (editing !== null) { updatePlayer(editing, { name: draft }); setEditing(null); } };

  // Switch team side — update team name accordingly
  const switchSide = (newSide: 'A' | 'B') => {
    const newTeam = newSide === 'A' ? linkedTournament?.teamA : linkedTournament?.teamB;
    updateWidgetConfig(widgetId, { teamSide: newSide, ...(newTeam ? { teamName: newTeam.name } : {}) });
  };

  const setTeamColorAll = (color: string) => {
    const updated = players.map(p => ({ ...p, jerseyColor: color }));
    updateWidgetConfig(widgetId, { teamColor: color, players: updated });
  };

  const jerseySize = Math.max(18, Math.min(38, Math.round(Math.min(w, h * 0.85) / 14)));
  const nameSize   = Math.max(9,  Math.round(jerseySize * 0.45));
  const posSize    = Math.max(6,  Math.round(jerseySize * 0.28));
  // Name pill width: ~23% of widget width, let names wrap to 2 lines instead of truncating
  const nameWidth  = Math.min(Math.floor(w * 0.23), 115);

  const filteredPlayers = availablePlayers.filter(ap =>
    draft.length === 0 || ap.name.toLowerCase().includes(draft.toLowerCase())
  ).slice(0, 10);

  return (
    <div className="rugby-lineup" style={{ width: w, height: h, pointerEvents: 'auto' }} onClick={() => setColorPicking(null)}>

      {/* Header */}
      <div className="rugby-lineup-header">
        <label className="rugby-team-color-wrap" title="Field background color">
          <span className="rugby-team-color-swatch" style={{ background: fieldColor, borderRadius: 2 }} />
          <input type="color" value={fieldColor} className="rugby-color-hidden"
            onChange={e => updateWidgetConfig(widgetId, { fieldColor: e.target.value })} />
        </label>
        <label className="rugby-team-color-wrap" title="Team jersey color (applies to all)">
          <span className="rugby-team-color-swatch" style={{ background: teamColor }} />
          <input type="color" value={teamColor} className="rugby-color-hidden"
            onChange={e => setTeamColorAll(e.target.value)} />
        </label>

        {linkedTournament ? (
          <div className="rugby-side-toggle">
            <button
              className={`rugby-side-btn${side === 'A' ? ' rugby-side-btn--active' : ''}`}
              onClick={e => { e.stopPropagation(); switchSide('A'); }}
              style={{ '--sc': linkedTournament.teamA.color } as React.CSSProperties}
            >A</button>
            <span className="rugby-lineup-team-name">{teamName}</span>
            <button
              className={`rugby-side-btn${side === 'B' ? ' rugby-side-btn--active' : ''}`}
              onClick={e => { e.stopPropagation(); switchSide('B'); }}
              style={{ '--sc': linkedTournament.teamB.color } as React.CSSProperties}
            >B</button>
          </div>
        ) : (
          <span className="rugby-lineup-team-name">{teamName}</span>
        )}

        <button
          className={`rugby-layout-btn${layoutEdit ? ' rugby-layout-btn--active' : ''}`}
          onClick={e => { e.stopPropagation(); setLayoutEdit(v => !v); }}
          title="Drag player positions"
        >{layoutEdit ? '✓ Done' : '⠿ Move'}</button>
      </div>

      {/* Field */}
      <div className="rugby-lineup-field" ref={fieldRef}
        style={{ background: fieldColor, '--rugby-name-w': `${nameWidth}px` } as React.CSSProperties}>
        {/* Field markings */}
        <div className="rfl rfl--try-top" />
        <div className="rfl rfl--22-top"  />
        <div className="rfl rfl--10-top"  />
        <div className="rfl rfl--center"  />
        <div className="rfl rfl--10-bot"  />
        <div className="rfl rfl--22-bot"  />
        <div className="rfl rfl--try-bot" />

        {/* Players */}
        {POSITIONS_META.map(({ number: num }) => {
          const p = getPlayer(num);
          const override = subOverrides[num];
          const displayName = override ? override.name : p.name;
          const displayJerseyNo = override?.jerseyNo ?? (p.jerseyNo ?? num);
          const isSub = !!override?.isSub;
          const pos = getDisplayPos(num);
          const isEditing = editing === num;
          const isColorPicking = colorPicking === num;
          const isDraggingThis = dragging.current?.num === num;

          return (
            <div
              key={num}
              className={`rugby-player-slot${layoutEdit ? ' rugby-player-slot--moveable' : ''}${isDraggingThis ? ' rugby-player-slot--dragging' : ''}`}
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
              onMouseDown={e => {
                if (!layoutEdit) return;
                e.preventDefault(); e.stopPropagation();
                dragging.current = { num, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y };
              }}
              onClick={e => {
                e.stopPropagation();
                if (!layoutEdit && !isEditing) startEdit(num);
              }}
            >
              {/* Jersey — right-click for color */}
              <div
                className="rugby-jersey-wrap"
                title={layoutEdit ? 'Drag to reposition' : 'Click name to edit · Right-click jersey for colors'}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setColorPicking(num); setEditing(null); }}
              >
                <svg viewBox="0 0 40 36" width={jerseySize * 1.6} height={jerseySize * 1.4}>
                  <path d="M8 2 L0 10 L8 14 L8 34 L32 34 L32 14 L40 10 L32 2 L26 6 Q20 10 14 6 Z"
                    fill={p.jerseyColor} stroke="rgba(0,0,0,0.3)" strokeWidth="1" />
                  <text x="20" y="24" textAnchor="middle" dominantBaseline="middle"
                    fontSize={jerseySize * 0.5} fontWeight="bold" fill={p.textColor}
                    fontFamily="sans-serif">{displayJerseyNo}</text>
                </svg>
              </div>

              {/* Name */}
              {isEditing ? (
                <div className="rugby-name-edit" onClick={e => e.stopPropagation()}>
                  <input
                    className="rugby-player-name-input"
                    value={draft}
                    autoFocus
                    style={{ fontSize: nameSize }}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }}
                  />
                  {filteredPlayers.length > 0 && (
                    <div className="rugby-player-list-drop">
                      {filteredPlayers.map(ap => (
                        <button key={ap.id} className="rugby-player-pick-item"
                          onMouseDown={e => { e.preventDefault(); updatePlayer(num, { name: ap.name, jerseyNo: ap.jerseyNo || undefined }); setEditing(null); }}>
                          {ap.jerseyNo && <span className="rugby-pick-no">{ap.jerseyNo}</span>}
                          <span>{ap.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <span className="rugby-player-name" style={{ fontSize: nameSize }}>
                  {displayName
                    ? <>{displayName}{isSub && <span className="rugby-sub-badge">↑</span>}</>
                    : <span style={{ opacity: 0.4 }}>—</span>}
                </span>
              )}

              <span className="rugby-player-pos" style={{ fontSize: posSize }}>{p.position}</span>

              {/* Color picker popover */}
              {isColorPicking && (
                <div className="rugby-color-picker" onClick={e => e.stopPropagation()}>
                  <div className="rugby-color-row">
                    <span className="rugby-color-label">Jersey</span>
                    <div className="rugby-color-presets">
                      {JERSEY_PRESETS.map(c => (
                        <button key={c} className="rugby-color-dot"
                          style={{ background: c, outline: p.jerseyColor === c ? '2px solid #fff' : 'none' }}
                          onClick={() => updatePlayer(num, { jerseyColor: c })} />
                      ))}
                    </div>
                    <label className="rugby-color-custom-wrap" title="Custom color">
                      <span className="rugby-color-dot" style={{ background: p.jerseyColor, border: '1px dashed #fff' }} />
                      <input type="color" value={p.jerseyColor} className="rugby-color-hidden"
                        onChange={e => updatePlayer(num, { jerseyColor: e.target.value })} />
                    </label>
                  </div>
                  <div className="rugby-color-row">
                    <span className="rugby-color-label">Number</span>
                    <div className="rugby-color-presets">
                      {NUM_PRESETS.map(c => (
                        <button key={c} className="rugby-color-dot"
                          style={{ background: c, outline: p.textColor === c ? '2px solid #aaa' : 'none' }}
                          onClick={() => updatePlayer(num, { textColor: c })} />
                      ))}
                    </div>
                    <label className="rugby-color-custom-wrap" title="Custom color">
                      <span className="rugby-color-dot" style={{ background: p.textColor, border: '1px dashed #fff' }} />
                      <input type="color" value={p.textColor} className="rugby-color-hidden"
                        onChange={e => updatePlayer(num, { textColor: e.target.value })} />
                    </label>
                  </div>
                  <button className="rugby-color-close" onClick={() => setColorPicking(null)}>✕</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
