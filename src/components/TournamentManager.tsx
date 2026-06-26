import { useState, useRef } from 'react';
import { useTournamentStore } from '../stores/tournamentStore';
import { useCanvasStore } from '../stores/canvasStore';
import type { Tournament, SportType } from '../types/tournament';
import { SPORT_LABELS, SPORT_POSITIONS, SPORT_DEFAULTS } from '../types/tournament';
import type { Player } from '../types/tournament';
import { LogoUrlPicker } from './LogoUrlPicker';

// ── Import / Export helpers ───────────────────────────────────────────────────

function exportTeamCSV(players: Player[], teamName: string) {
  const escape = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
  const header = '#,Name,Position';
  const rows = [...players]
    .sort((a, b) => (parseInt(a.jerseyNo) || 999) - (parseInt(b.jerseyNo) || 999))
    .map(p => [escape(p.jerseyNo), escape(p.name), escape(p.position)].join(','));
  const csv = [header, ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${teamName.replace(/[^a-z0-9]/gi, '_')}_players.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function parsePlayerFile(text: string): Omit<Player, 'id'>[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const sep = lines[0].includes('\t') ? '\t' : ',';

  function splitRow(line: string): string[] {
    if (sep === '\t') return line.split('\t').map(c => c.trim());
    // Basic quoted-CSV split
    const cols: string[] = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur.trim());
    return cols;
  }

  const result: Omit<Player, 'id'>[] = [];
  for (const line of lines) {
    const [col0 = '', col1 = '', col2 = ''] = splitRow(line);
    const jerseyNo = col0.replace(/^"|"$/g, '').trim();
    const name     = col1.replace(/^"|"$/g, '').trim();
    const position = col2.replace(/^"|"$/g, '').trim();
    // Skip header rows
    if (!name || /^(name|player|full.?name)$/i.test(name)) continue;
    if (/^(#|no\.?|jersey|number|num)$/i.test(jerseyNo)) continue;
    result.push({ jerseyNo, name, position });
  }
  return result;
}

interface Props { onClose: () => void }

const SPORT_TYPES = Object.keys(SPORT_LABELS) as SportType[];

// ── Add-tournament form ───────────────────────────────────────────────────────
function AddTournamentForm({ onDone }: { onDone: (id: string) => void }) {
  const { addTournament } = useTournamentStore();
  const [name, setName] = useState('');
  const [sport, setSport] = useState<SportType>('football');
  const [teamAName, setTeamAName] = useState('');
  const [teamBName, setTeamBName] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const id = addTournament({
      name: name.trim(), sport,
      teamAName: teamAName.trim() || 'Team A',
      teamBName: teamBName.trim() || 'Team B',
    });
    onDone(id);
  };

  return (
    <div className="tm-new-tourn-panel">
      <div className="tm-section-label">New Tournament</div>
      <form className="tm-new-tourn-form" onSubmit={submit}>
        <div className="tm-form-row">
          <label className="tm-form-label">Name</label>
          <input className="tm-input" placeholder="e.g. Premier League 2026" value={name}
            onChange={e => setName(e.target.value)} autoFocus />
        </div>
        <div className="tm-form-row">
          <label className="tm-form-label">Sport</label>
          <select className="tm-input" value={sport} onChange={e => setSport(e.target.value as SportType)}>
            {SPORT_TYPES.map(s => <option key={s} value={s}>{SPORT_LABELS[s]}</option>)}
          </select>
        </div>
        <div className="tm-form-row">
          <label className="tm-form-label">Team A</label>
          <input className="tm-input" placeholder="Team A name" value={teamAName} onChange={e => setTeamAName(e.target.value)} />
        </div>
        <div className="tm-form-row">
          <label className="tm-form-label">Team B</label>
          <input className="tm-input" placeholder="Team B name" value={teamBName} onChange={e => setTeamBName(e.target.value)} />
        </div>
        <div className="tm-form-actions">
          <button className="tm-btn tm-btn--primary" type="submit" disabled={!name.trim()}>
            Create Tournament
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Player row ────────────────────────────────────────────────────────────────
function PlayerRow({ player, tournamentId, side, sport, onDelete }: {
  player: Player; tournamentId: string; side: 'A' | 'B';
  sport: SportType; onDelete: () => void;
}) {
  const { updatePlayer } = useTournamentStore();
  const [editing, setEditing] = useState(false);
  const [jersey, setJersey] = useState(player.jerseyNo);
  const [name, setName] = useState(player.name);
  const [pos, setPos] = useState(player.position);

  const save = () => {
    updatePlayer(tournamentId, side, player.id, {
      jerseyNo: jersey.trim(), name: name.trim() || player.name, position: pos.trim(),
    });
    setEditing(false);
  };

  const positions = SPORT_POSITIONS[sport] ?? [];

  if (editing) {
    return (
      <div className="tm-pl-row tm-pl-row--edit">
        <input className="tm-pl-cell tm-pl-cell--jersey tm-input" value={jersey}
          onChange={e => setJersey(e.target.value)} placeholder="#" />
        <input className="tm-pl-cell tm-pl-cell--name tm-input" value={name}
          onChange={e => setName(e.target.value)} placeholder="Name" autoFocus />
        <input className="tm-pl-cell tm-pl-cell--pos tm-input" value={pos}
          onChange={e => setPos(e.target.value)} placeholder="Pos"
          list={`pos-${player.id}`} />
        <datalist id={`pos-${player.id}`}>
          {positions.map(p => <option key={p} value={p} />)}
        </datalist>
        <div className="tm-pl-cell tm-pl-cell--actions">
          <button className="tm-icon-btn tm-icon-btn--save" onClick={save} title="Save">✓</button>
          <button className="tm-icon-btn" onClick={() => setEditing(false)} title="Cancel">✕</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tm-pl-row" onDoubleClick={() => setEditing(true)}>
      <span className="tm-pl-cell tm-pl-cell--jersey">{player.jerseyNo || '—'}</span>
      <span className="tm-pl-cell tm-pl-cell--name">{player.name}</span>
      <span className="tm-pl-cell tm-pl-cell--pos">{player.position}</span>
      <div className="tm-pl-cell tm-pl-cell--actions">
        <button className="tm-icon-btn tm-icon-btn--edit" onClick={() => setEditing(true)} title="Edit">✎</button>
        <button className="tm-icon-btn tm-icon-btn--del" onClick={e => { e.stopPropagation(); onDelete(); }} title="Delete">×</button>
      </div>
    </div>
  );
}

// ── Add-player row ────────────────────────────────────────────────────────────
function AddPlayerRow({ tournamentId, side, sport }: {
  tournamentId: string; side: 'A' | 'B'; sport: SportType;
}) {
  const { addPlayer } = useTournamentStore();
  const [jersey, setJersey] = useState('');
  const [name, setName] = useState('');
  const [pos, setPos] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    addPlayer(tournamentId, side, { jerseyNo: jersey.trim(), name: name.trim(), position: pos.trim() });
    setJersey(''); setName(''); setPos('');
  };

  const positions = SPORT_POSITIONS[sport] ?? [];

  return (
    <form className="tm-pl-row tm-pl-add-row" onSubmit={submit}>
      <input className="tm-pl-cell tm-pl-cell--jersey tm-input" value={jersey}
        onChange={e => setJersey(e.target.value)} placeholder="#" />
      <input className="tm-pl-cell tm-pl-cell--name tm-input" value={name}
        onChange={e => setName(e.target.value)} placeholder="Player name…" />
      <input className="tm-pl-cell tm-pl-cell--pos tm-input" value={pos}
        onChange={e => setPos(e.target.value)} placeholder="Pos"
        list={`pos-add-${side}`} />
      <datalist id={`pos-add-${side}`}>
        {positions.map(p => <option key={p} value={p} />)}
      </datalist>
      <div className="tm-pl-cell tm-pl-cell--actions">
        <button className="tm-icon-btn tm-icon-btn--save" type="submit" disabled={!name.trim()} title="Add player">+</button>
      </div>
    </form>
  );
}

// ── Settings bar ─────────────────────────────────────────────────────────────
function SettingsBar({ tournament, onApply }: { tournament: Tournament; onApply: () => void }) {
  const { updateTournamentSettings } = useTournamentStore();
  const s = tournament.settings ?? SPORT_DEFAULTS[tournament.sport];

  const msToMmSs = (ms: number) => {
    if (ms === 0) return '00:00';
    const m = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  const mmSsToMs = (str: string) => {
    const [m = 0, sec = 0] = str.split(':').map(Number);
    return (m * 60 + sec) * 1000;
  };

  return (
    <div className="tm-settings-bar">
      <div className="tm-settings-group">
        <label className="tm-settings-label">Periods</label>
        <select
          className="tm-settings-input tm-settings-input--sm"
          value={s.periods}
          onChange={e => updateTournamentSettings(tournament.id, { periods: Number(e.target.value) })}
        >
          {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      <div className="tm-settings-group">
        <label className="tm-settings-label">Duration</label>
        <input
          className="tm-settings-input"
          defaultValue={msToMmSs(s.periodDurationMs)}
          key={`pd-${s.periodDurationMs}`}
          placeholder="45:00"
          onBlur={e => {
            const ms = mmSsToMs(e.target.value);
            if (ms > 0) updateTournamentSettings(tournament.id, { periodDurationMs: ms });
          }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>

      <div className="tm-settings-group">
        <label className="tm-settings-label">Half-time</label>
        <input
          className="tm-settings-input"
          defaultValue={msToMmSs(s.halfTimeDurationMs)}
          key={`ht-${s.halfTimeDurationMs}`}
          placeholder="15:00"
          onBlur={e => updateTournamentSettings(tournament.id, { halfTimeDurationMs: mmSsToMs(e.target.value) })}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>

      <div className="tm-settings-group">
        <label className="tm-settings-label">Starters</label>
        <input
          className="tm-settings-input tm-settings-input--sm"
          type="number"
          min={1} max={20}
          value={s.maxOnField}
          onChange={e => updateTournamentSettings(tournament.id, { maxOnField: Number(e.target.value) })}
        />
      </div>

      <div className="tm-settings-group">
        <label className="tm-settings-label">Subs</label>
        <input
          className="tm-settings-input tm-settings-input--sm"
          type="number"
          min={0} max={20}
          value={s.maxSubs ?? 7}
          onChange={e => updateTournamentSettings(tournament.id, { maxSubs: Number(e.target.value) })}
        />
      </div>

      <div className="tm-settings-group">
        <label className="tm-settings-label">Timer</label>
        <div className="tm-timer-mode-toggle">
          <button
            className={`tm-timer-mode-btn ${(s.timerMode ?? 'countup') === 'countup' ? 'tm-timer-mode-btn--active' : ''}`}
            onClick={() => updateTournamentSettings(tournament.id, { timerMode: 'countup' })}
          >▲ Up</button>
          <button
            className={`tm-timer-mode-btn ${(s.timerMode ?? 'countup') === 'countdown' ? 'tm-timer-mode-btn--active' : ''}`}
            onClick={() => updateTournamentSettings(tournament.id, { timerMode: 'countdown' })}
          >▼ Down</button>
        </div>
      </div>

      <button className="tm-apply-btn" onClick={onApply} title="Push all settings to linked canvas widgets">
        ▶ Apply to Canvas
      </button>
    </div>
  );
}

// ── Team column ───────────────────────────────────────────────────────────────
interface ImportPreview { players: Omit<Player, 'id'>[]; }

function TeamColumn({ tournament, side }: { tournament: Tournament; side: 'A' | 'B' }) {
  const { updateTeam, deletePlayer, addPlayer, replaceTeamPlayers } = useTournamentStore();
  const team = side === 'A' ? tournament.teamA : tournament.teamB;
  const [editName, setEditName] = useState(false);
  const [nameVal, setNameVal] = useState(team.name);
  const [shortVal, setShortVal] = useState(team.shortName ?? '');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sorted = [...team.players].sort((a, b) => {
    const n1 = parseInt(a.jerseyNo) || 999;
    const n2 = parseInt(b.jerseyNo) || 999;
    return n1 !== n2 ? n1 - n2 : a.name.localeCompare(b.name);
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      const players = parsePlayerFile(text);
      if (players.length > 0) setImportPreview({ players });
      else alert('No valid players found in file.\n\nExpected columns: # (jersey), Name, Position\nFormats: CSV, TSV, or plain text');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const confirmImport = (mode: 'replace' | 'append') => {
    if (!importPreview) return;
    if (mode === 'replace') {
      replaceTeamPlayers(tournament.id, side, importPreview.players);
    } else {
      importPreview.players.forEach(p => addPlayer(tournament.id, side, p));
    }
    setImportPreview(null);
  };

  return (
    <div className="tm-team-col">
      {/* Team header */}
      <div className="tm-team-col-header" style={{ '--tc': team.color } as React.CSSProperties}>
        <input
          type="color"
          className="tm-color-swatch"
          value={team.color}
          title="Team color"
          onChange={e => updateTeam(tournament.id, side, { color: e.target.value })}
        />
        <div className="tm-team-logo-wrap">
          <LogoUrlPicker
            compact
            value={team.logo ?? ''}
            onChange={url => updateTeam(tournament.id, side, { logo: url || undefined })}
          />
        </div>
        <div className="tm-team-name-wrap">
          {editName ? (
            <input
              className="tm-team-name-edit"
              value={nameVal}
              autoFocus
              onChange={e => setNameVal(e.target.value)}
              onBlur={() => {
                updateTeam(tournament.id, side, { name: nameVal.trim() || team.name });
                setEditName(false);
              }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          ) : (
            <span className="tm-team-col-name" onClick={() => { setNameVal(team.name); setEditName(true); }}>
              {team.name}
            </span>
          )}
          <input
            className="tm-team-shortname"
            value={shortVal}
            placeholder="Short"
            title="Short name (e.g. MCI, LIV)"
            onChange={e => setShortVal(e.target.value)}
            onBlur={() => updateTeam(tournament.id, side, { shortName: shortVal.trim() })}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </div>
        <span className="tm-team-col-count">{team.players.length}</span>
      </div>

      {/* Import / Export toolbar */}
      <div className="tm-io-bar">
        <button
          className="tm-io-btn"
          title="Import players from CSV / TSV / TXT"
          onClick={() => fileInputRef.current?.click()}
        >
          ↑ Import
        </button>
        <button
          className="tm-io-btn"
          title="Export players as CSV (Excel compatible)"
          onClick={() => exportTeamCSV(team.players, team.name)}
          disabled={team.players.length === 0}
        >
          ↓ Export CSV
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.tsv,.txt"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </div>

      {/* Import preview */}
      {importPreview && (
        <div className="tm-import-preview">
          <div className="tm-import-preview-title">
            Found <strong>{importPreview.players.length}</strong> players
          </div>
          <div className="tm-import-preview-list">
            {importPreview.players.slice(0, 5).map((p, i) => (
              <div key={i} className="tm-import-preview-row">
                <span className="tm-import-preview-jersey">{p.jerseyNo || '—'}</span>
                <span className="tm-import-preview-name">{p.name}</span>
                {p.position && <span className="tm-import-preview-pos">{p.position}</span>}
              </div>
            ))}
            {importPreview.players.length > 5 && (
              <div className="tm-import-preview-more">+{importPreview.players.length - 5} more…</div>
            )}
          </div>
          <div className="tm-import-preview-actions">
            <button className="tm-io-btn tm-io-btn--danger" onClick={() => confirmImport('replace')}>
              Replace all
            </button>
            <button className="tm-io-btn tm-io-btn--ok" onClick={() => confirmImport('append')}>
              Append
            </button>
            <button className="tm-io-btn" onClick={() => setImportPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Column headers */}
      <div className="tm-pl-header-row">
        <span className="tm-pl-cell tm-pl-cell--jersey">#</span>
        <span className="tm-pl-cell tm-pl-cell--name">Name</span>
        <span className="tm-pl-cell tm-pl-cell--pos">Pos</span>
        <span className="tm-pl-cell tm-pl-cell--actions" />
      </div>

      {/* Players */}
      <div className="tm-pl-list">
        {sorted.map(p => (
          <PlayerRow
            key={p.id}
            player={p}
            tournamentId={tournament.id}
            side={side}
            sport={tournament.sport}
            onDelete={() => deletePlayer(tournament.id, side, p.id)}
          />
        ))}
        {sorted.length === 0 && <div className="tm-pl-empty">No players — add below</div>}
      </div>

      {/* Add row pinned at bottom */}
      <div className="tm-pl-add-footer">
        <AddPlayerRow tournamentId={tournament.id} side={side} sport={tournament.sport} />
      </div>
    </div>
  );
}

// ── Draggable window ──────────────────────────────────────────────────────────
export function TournamentManager({ onClose }: Props) {
  const { tournaments, updateTournament, deleteTournament, setActiveTournament } = useTournamentStore();
  const { pages, updateWidgetConfig } = useCanvasStore();

  // Window position (drag)
  const [pos, setPos] = useState(() => ({
    x: Math.max(20, Math.round(window.innerWidth / 2 - 520)),
    y: Math.max(20, Math.round(window.innerHeight / 2 - 330)),
  }));
  const dragRef = useRef({ active: false, ox: 0, oy: 0, ix: 0, iy: 0 });

  const startDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.tm-win-ctrl')) return;
    dragRef.current = { active: true, ox: e.clientX, oy: e.clientY, ix: pos.x, iy: pos.y };
    const onMove = (me: MouseEvent) => {
      if (!dragRef.current.active) return;
      setPos({
        x: Math.max(0, dragRef.current.ix + me.clientX - dragRef.current.ox),
        y: Math.max(0, dragRef.current.iy + me.clientY - dragRef.current.oy),
      });
    };
    const onUp = () => {
      dragRef.current.active = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  const [selectedId, setSelectedId] = useState(tournaments[0]?.id ?? '');
  const [addingNew, setAddingNew] = useState(tournaments.length === 0);
  const [editTournName, setEditTournName] = useState(false);
  const [tournNameVal, setTournNameVal] = useState('');
  const [applyStatus, setApplyStatus] = useState('');

  const applyToCanvas = () => {
    if (!selected) return;
    const s = selected.settings ?? SPORT_DEFAULTS[selected.sport];
    const allWidgets = pages.flatMap(p => p.widgets);
    const linkedTimerIds = new Set<string>();
    const linkedScoreboardIds = new Set<string>();
    let count = 0;

    // Pass 1: all widgets directly linked to this tournament
    allWidgets.forEach(w => {
      if (w.config.linkedTournamentId !== selected.id) return;

      if (w.type === 'timer' && !w.config.running) {
        const tMode = s.timerMode ?? 'countup';
        const startMs = tMode === 'countdown' ? s.periodDurationMs : 0;
        updateWidgetConfig(w.id, {
          // Timing config from tournament
          periods:             s.periods,
          durationMs:          s.periodDurationMs,
          breakDurationMs:     s.halfTimeDurationMs,
          mode:                tMode,
          // Reset match state
          currentMs:           startMs,
          currentPeriod:       1,
          periodStartMs:       0,
          inBreak:             false,
          breakCurrentMs:      0,
          overrunning:         false,
          resumeMs:            null,
          resumePeriodStartMs: null,
          // Reset extra time state (keep ET config like etDurationMs, extraTimePeriods)
          inExtraTime:         false,
          etCurrentPeriod:     1,
          etCurrentMs:         w.config.etDurationMs ?? 300000,
          etPeriodStartMs:     0,
          etInBreak:           false,
          etBreakCurrentMs:    0,
          etOverrunning:       false,
          // Reset after-ET state
          inAfterEt:           false,
          afterEtCurrentMs:    w.config.afterEtDurationMs ?? 0,
          afterEtOverrunning:  false,
          // Reset final-play state
          inFinalPlay:         false,
          finalPlayMs:         0,
          finalPlayPendingNext: false,
        });
        linkedTimerIds.add(w.id);
        count++;
      }

      if (w.type === 'scoreboard') {
        updateWidgetConfig(w.id, {
          teamAName:      selected.teamA.name,
          teamBName:      selected.teamB.name,
          teamAShortName: selected.teamA.shortName ?? '',
          teamBShortName: selected.teamB.shortName ?? '',
          teamAColor:     selected.teamA.color,
          teamBColor:     selected.teamB.color,
          teamALogo:      selected.teamA.logo ?? '',
          teamBLogo:      selected.teamB.logo ?? '',
          scoreA:         0,
          scoreB:         0,
          scoreLog:       [],
          cardsA:         [],
          cardsB:         [],
        });
        linkedScoreboardIds.add(w.id);
        count++;
      }

      if (w.type === 'player-list') {
        const side = (w.config.teamSide ?? 'A') as 'A' | 'B';
        const team = side === 'A' ? selected.teamA : selected.teamB;
        const players = team.players ?? [];
        // First maxOnField players become starters, rest become subs
        const starters = players.slice(0, s.maxOnField);
        const subs     = players.slice(s.maxOnField);
        updateWidgetConfig(w.id, {
          maxOnField:      s.maxOnField,
          starters,
          subs,
          onField:         [],
          entries:         {},
          accumulated:     {},
          subbedOnPlayers: [],
        });
        count++;
      }
    });

    // Pass 2: clear timeline events linked to any of the above timers/scoreboards
    allWidgets.forEach(w => {
      if (w.type !== 'timeline') return;
      const timerLinked = w.config.linkedTimerWidgetId && linkedTimerIds.has(w.config.linkedTimerWidgetId);
      const boardLinked = w.config.linkedScoreboardId && linkedScoreboardIds.has(w.config.linkedScoreboardId);
      if (timerLinked || boardLinked) {
        updateWidgetConfig(w.id, { events: [] });
        count++;
      }
    });

    const msg = count > 0
      ? `Applied to ${count} widget${count !== 1 ? 's' : ''} ✓`
      : 'No linked widgets found on canvas';
    setApplyStatus(msg);
    setTimeout(() => setApplyStatus(''), 3000);
  };

  const selected = tournaments.find(t => t.id === selectedId);

  const selectTournament = (id: string) => {
    setSelectedId(id);
    setActiveTournament(id);
    setAddingNew(false);
    setEditTournName(false);
  };

  return (
    <>
      {/* Subtle backdrop — click to close */}
      <div className="tm-backdrop" onClick={onClose} />

      {/* Floating window */}
      <div
        className="tm-window"
        style={{ left: pos.x, top: pos.y }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="tm-titlebar" onMouseDown={startDrag}>
          <span className="tm-titlebar-icon">🏆</span>
          <span className="tm-titlebar-title">Tournament Database</span>
          <div className="tm-win-ctrls">
            <button className="tm-win-ctrl tm-win-ctrl--close" onClick={onClose} title="Close">×</button>
          </div>
        </div>

        {/* Main area */}
        <div className="tm-win-body">
          {/* Left: tournament list */}
          <div className="tm-win-sidebar">
            <div className="tm-sidebar-toolbar">
              <button
                className={`tm-sidebar-new-btn ${addingNew ? 'tm-sidebar-new-btn--active' : ''}`}
                onClick={() => setAddingNew(true)}
              >＋ New</button>
            </div>
            <div className="tm-sidebar-list">
              {tournaments.map(t => (
                <div
                  key={t.id}
                  className={`tm-tourn-item ${t.id === selectedId && !addingNew ? 'tm-tourn-item--active' : ''}`}
                  onClick={() => selectTournament(t.id)}
                >
                  <span className="tm-tourn-sport-tag">{SPORT_LABELS[t.sport]?.split('/')[0].trim()}</span>
                  <span className="tm-tourn-item-name">{t.name}</span>
                </div>
              ))}
              {tournaments.length === 0 && (
                <div className="tm-sidebar-empty">No tournaments yet</div>
              )}
            </div>
          </div>

          {/* Right: content */}
          <div className="tm-win-content">
            {addingNew && (
              <AddTournamentForm onDone={id => selectTournament(id)} />
            )}

            {!addingNew && selected && (
              <div className="tm-win-detail">
                {/* Tournament toolbar */}
                <div className="tm-tourn-toolbar">
                  <div className="tm-tourn-toolbar-left">
                    {editTournName ? (
                      <input
                        className="tm-tourn-name-edit"
                        value={tournNameVal}
                        autoFocus
                        onChange={e => setTournNameVal(e.target.value)}
                        onBlur={() => {
                          if (tournNameVal.trim()) updateTournament(selected.id, { name: tournNameVal.trim() });
                          setEditTournName(false);
                        }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      />
                    ) : (
                      <span
                        className="tm-tourn-title"
                        onClick={() => { setTournNameVal(selected.name); setEditTournName(true); }}
                        title="Click to rename"
                      >{selected.name}</span>
                    )}
                    <select
                      className="tm-sport-select"
                      value={selected.sport}
                      onChange={e => updateTournament(selected.id, { sport: e.target.value as SportType })}
                    >
                      {SPORT_TYPES.map(s => <option key={s} value={s}>{SPORT_LABELS[s]}</option>)}
                    </select>
                  </div>
                  <button
                    className="tm-btn tm-btn--danger"
                    onClick={() => {
                      if (!confirm(`Delete "${selected.name}" and all its players?`)) return;
                      deleteTournament(selected.id);
                      const next = tournaments.find(t => t.id !== selected.id);
                      setSelectedId(next?.id ?? '');
                      if (!next) setAddingNew(false);
                    }}
                  >🗑 Delete</button>
                </div>

                {/* Period / time settings */}
                <SettingsBar tournament={selected} onApply={applyToCanvas} />

                {/* Both teams side by side */}
                <div className="tm-teams-area">
                  <TeamColumn tournament={selected} side="A" />
                  <div className="tm-teams-divider" />
                  <TeamColumn tournament={selected} side="B" />
                </div>
              </div>
            )}

            {!addingNew && !selected && (
              <div className="tm-win-placeholder">
                <span>Select a tournament from the left, or create a new one.</span>
              </div>
            )}
          </div>
        </div>

        {/* Status bar */}
        <div className="tm-win-statusbar">
          <span>{tournaments.length} tournament{tournaments.length !== 1 ? 's' : ''}</span>
          {selected && (
            <span>
              {selected.teamA.name}: {selected.teamA.players.length} players
              &nbsp;·&nbsp;
              {selected.teamB.name}: {selected.teamB.players.length} players
            </span>
          )}
          {applyStatus && <span className="tm-apply-status">{applyStatus}</span>}
          <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 10 }}>double-click row to edit</span>
        </div>
      </div>
    </>
  );
}
