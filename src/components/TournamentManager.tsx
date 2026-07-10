import { useState, useRef, useEffect, useMemo } from 'react';
import { useTournamentStore } from '../stores/tournamentStore';
import { useCanvasStore } from '../stores/canvasStore';
import type { Tournament, SportType } from '../types/tournament';
import { SPORT_LABELS, SPORT_POSITIONS, SPORT_DEFAULTS } from '../types/tournament';
import type { Player } from '../types/tournament';
import { LogoUrlPicker } from './LogoUrlPicker';
import { useTeamDbStore } from '../stores/teamDbStore';
import { useMatchScheduleStore } from '../stores/matchScheduleStore';
import { useMatchResultsStore } from '../stores/matchResultsStore';
import { resolveImageUrl } from '../lib/imageUrl';

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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const id = addTournament({ name: name.trim(), sport });
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
function PlayerRow({ player, sport, onUpdate, onDelete }: {
  player: Player; sport: SportType;
  onUpdate: (patch: Partial<Omit<Player, 'id'>>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [jersey, setJersey] = useState(player.jerseyNo);
  const [name, setName] = useState(player.name);
  const [pos, setPos] = useState(player.position);

  const save = () => {
    onUpdate({ jerseyNo: jersey.trim(), name: name.trim() || player.name, position: pos.trim() });
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
function AddPlayerRow({ sport, onAdd }: {
  sport: SportType; onAdd: (p: Omit<Player, 'id'>) => void;
}) {
  const [jersey, setJersey] = useState('');
  const [name, setName] = useState('');
  const [pos, setPos] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd({ jerseyNo: jersey.trim(), name: name.trim(), position: pos.trim() });
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
        list="pos-add-team" />
      <datalist id="pos-add-team">
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

interface ImportPreview { players: Omit<Player, 'id'>[]; }

// ── Players tab: manage a team's roster, scoped to the selected tournament ────
function PlayersPanel({ tournamentId }: { tournamentId: string }) {
  const { teams: allTeams, addPlayer, updatePlayer, deletePlayer, replaceTeamPlayers } = useTeamDbStore();
  const teams = useMemo(() => allTeams.filter(t => t.tournamentId === tournamentId), [allTeams, tournamentId]);
  const [selectedTeamId, setSelectedTeamId] = useState(teams[0]?.id ?? '');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!teams.find(t => t.id === selectedTeamId)) setSelectedTeamId(teams[0]?.id ?? '');
  }, [teams, selectedTeamId]);

  if (teams.length === 0) {
    return (
      <div className="tm-win-content" style={{ padding: 16 }}>
        <div className="tm-win-placeholder">
          <span>No teams in this tournament yet — add one in the 👥 Teams tab first, then manage its roster here.</span>
        </div>
      </div>
    );
  }

  const team = teams.find(t => t.id === selectedTeamId);
  const sorted = team ? [...team.players].sort((a, b) => {
    const n1 = parseInt(a.jerseyNo) || 999;
    const n2 = parseInt(b.jerseyNo) || 999;
    return n1 !== n2 ? n1 - n2 : a.name.localeCompare(b.name);
  }) : [];

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
    if (!importPreview || !team) return;
    if (mode === 'replace') {
      replaceTeamPlayers(team.id, importPreview.players);
    } else {
      importPreview.players.forEach(p => addPlayer(team.id, p));
    }
    setImportPreview(null);
  };

  return (
    <div className="tm-win-body">
      {/* Left: team list */}
      <div className="tm-win-sidebar">
        <div className="tm-sidebar-list">
          {teams.map(t => (
            <div
              key={t.id}
              className={`tm-tourn-item ${t.id === selectedTeamId ? 'tm-tourn-item--active' : ''}`}
              onClick={() => setSelectedTeamId(t.id)}
            >
              <span className="tm-tourn-sport-tag">{t.players.length} player{t.players.length !== 1 ? 's' : ''}</span>
              <span className="tm-tourn-item-name">{t.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right: roster */}
      <div className="tm-win-content">
        {team && (
          <div className="tm-team-col">
            <div className="tm-team-col-header" style={{ '--tc': team.color } as React.CSSProperties}>
              <div className="tm-team-logo-wrap">
                {team.logo
                  ? <img src={resolveImageUrl(team.logo)} alt="" style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: '50%' }} />
                  : <div style={{ width: 32, height: 32, borderRadius: '50%', background: team.color }} />}
              </div>
              <span className="tm-team-col-name">{team.name}</span>
              <span className="tm-team-col-count">{team.players.length}</span>
            </div>

            {/* Import / Export toolbar */}
            <div className="tm-io-bar">
              <button className="tm-io-btn" title="Import players from CSV / TSV / TXT" onClick={() => fileInputRef.current?.click()}>
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
              <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }} onChange={handleFileChange} />
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
                  <button className="tm-io-btn tm-io-btn--danger" onClick={() => confirmImport('replace')}>Replace all</button>
                  <button className="tm-io-btn tm-io-btn--ok" onClick={() => confirmImport('append')}>Append</button>
                  <button className="tm-io-btn" onClick={() => setImportPreview(null)}>Cancel</button>
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
                  sport="custom"
                  onUpdate={patch => updatePlayer(team.id, p.id, patch)}
                  onDelete={() => deletePlayer(team.id, p.id)}
                />
              ))}
              {sorted.length === 0 && <div className="tm-pl-empty">No players — add below</div>}
            </div>

            {/* Add row pinned at bottom */}
            <div className="tm-pl-add-footer">
              <AddPlayerRow sport="custom" onAdd={p => addPlayer(team.id, p)} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Teams tab: teams belonging to the selected tournament (a competition can
// hold any number of teams — pick 2 of them per fixture in the Schedule tab) ──
function TeamsPanel({ tournamentId }: { tournamentId: string }) {
  const { teams: allTeams, addTeam, updateTeam, deleteTeam } = useTeamDbStore();
  const teams = useMemo(() => allTeams.filter(t => t.tournamentId === tournamentId), [allTeams, tournamentId]);

  const handleAdd = () => {
    addTeam({ name: 'New Team', color: '#3498db', tournamentId });
  };

  if (teams.length === 0) {
    return (
      <div className="tm-win-content" style={{ padding: 16 }}>
        <div className="tm-win-placeholder">
          <span>No teams in this tournament yet.</span>
        </div>
        <button className="tm-sidebar-new-btn" style={{ marginTop: 12 }} onClick={handleAdd}>＋ Add Team</button>
      </div>
    );
  }

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="tm-sidebar-new-btn" onClick={handleAdd}>＋ Add Team</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {teams.map(t => (
          <div key={t.id} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: 10,
            background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8,
          }}>
            <LogoUrlPicker
              compact
              value={t.logo ?? ''}
              onChange={logo => updateTeam(t.id, { logo })}
              thumbSize={{ w: 44, h: 44 }}
            />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <input
                className="tm-input"
                value={t.name}
                placeholder="Team name"
                onChange={e => updateTeam(t.id, { name: e.target.value })}
                style={{ fontSize: 12 }}
              />
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  className="tm-input"
                  value={t.shortName ?? ''}
                  placeholder="Short"
                  onChange={e => updateTeam(t.id, { shortName: e.target.value })}
                  style={{ fontSize: 11, width: 60 }}
                />
                <input
                  type="color"
                  value={t.color}
                  title="Team color"
                  onChange={e => updateTeam(t.id, { color: e.target.value })}
                  style={{ width: 24, height: 24, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                />
              </div>
            </div>
            <button
              className="btn btn--ghost btn--small"
              title="Delete team"
              onClick={() => deleteTeam(t.id)}
              style={{ color: 'var(--text-muted)', alignSelf: 'flex-start' }}
            >×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Schedule tab: upcoming fixtures, pickable from a scoreboard's "Load Match" ─
// Redesigned to match a fixture-card reference (sportyblocks-style): no bordered
// input boxes — every text field is a plain label that becomes editable on
// double-click, matching the clean list-of-cards look.

function getTzAbbrev(): string {
  const parts = new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ');
  return parts[parts.length - 1] || '';
}

function formatTimeDisplay(time?: string): string {
  if (!time) return '—';
  const m = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return time;
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m[2]}${ampm}`;
}

function ScheduleTeamPicker({ side, tournamentId, onPick }: {
  side: 'A' | 'B'; tournamentId?: string;
  onPick: (t: { name: string; shortName?: string; color: string; logo?: string }) => void;
}) {
  const { teams: allTeams } = useTeamDbStore();
  const teams = useMemo(() => tournamentId ? allTeams.filter(t => t.tournamentId === tournamentId) : allTeams, [allTeams, tournamentId]);
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button ref={anchorRef} className="tm-sched-pick-btn" title={`Pick saved team for side ${side}`}
        onClick={() => setOpen(v => !v)}>👥</button>
      {open && (
        <div ref={popupRef} style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 400, marginTop: 4, minWidth: 180, maxHeight: 220,
          overflowY: 'auto', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 4px 16px rgba(0,0,0,.5)',
        }}>
          {teams.length === 0 ? (
            <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)' }}>No saved teams</div>
          ) : teams.map(t => (
            <div key={t.id} onClick={() => { onPick(t); setOpen(false); }}
              style={{ padding: '5px 8px', fontSize: 11, cursor: 'pointer', color: 'var(--text-secondary)',
                borderBottom: '1px solid var(--border)' }}>{t.name}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// Plain label that turns into an <input> on double-click, and commits on blur/Enter.
function EditableText({ value, onChange, placeholder, className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string;
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
        className={`tm-sched-edit-input ${className ?? ''}`}
        value={draft}
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
    <span className={`tm-sched-editable ${className ?? ''}`} onDoubleClick={() => { setDraft(value); setEditing(true); }} title="Double-click to edit">
      {value || <span className="tm-sched-placeholder">{placeholder}</span>}
    </span>
  );
}

function EditableDate({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) requestAnimationFrame(() => ref.current?.focus()); }, [editing]);

  const d = value ? new Date(value + 'T00:00:00') : null;
  const valid = !!d && !isNaN(d.getTime());

  if (editing) {
    return (
      <input ref={ref} type="date" className="tm-sched-date-input" value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(false); }}
      />
    );
  }
  return (
    <div className="tm-sched-date" onDoubleClick={() => setEditing(true)} title="Double-click to change date">
      <span className="tm-sched-date-num">{valid ? d!.getDate() : '—'}</span>
      <span className="tm-sched-date-dow">{valid ? d!.toLocaleDateString('en-US', { weekday: 'short' }) : ''}</span>
    </div>
  );
}

function EditableTime({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) requestAnimationFrame(() => ref.current?.focus()); }, [editing]);
  const tz = useMemo(getTzAbbrev, []);

  if (editing) {
    return (
      <input ref={ref} type="time" className="tm-sched-time-input" value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(false); }}
      />
    );
  }
  return (
    <div className="tm-sched-time" onDoubleClick={() => setEditing(true)} title="Double-click to change time">
      <span className="tm-sched-time-val">{formatTimeDisplay(value)}</span>
      <span className="tm-sched-time-tz">{value ? tz : ''}</span>
    </div>
  );
}

function ScheduleBadge({ logo, color }: { logo?: string; color: string }) {
  return (
    <div className="tm-sched-badge" style={{ background: logo ? 'transparent' : color }}>
      {logo && <img src={resolveImageUrl(logo)} alt="" className="tm-sched-badge-img" />}
    </div>
  );
}

function SchedulePanel({ tournament }: { tournament: Tournament }) {
  const { matches: allMatches, addMatch, updateMatch, deleteMatch } = useMatchScheduleStore();
  const matches = useMemo(
    () => allMatches.filter(m => m.tournamentId === tournament.id),
    [allMatches, tournament.id]
  );

  // Fixtures always show the CURRENT tournament name — keep the stored
  // `competition` field in sync (it's what downstream widgets/results read)
  // so renaming the tournament doesn't leave stale fixtures behind.
  useEffect(() => {
    for (const m of matches) {
      if (m.competition !== tournament.name) updateMatch(m.id, { competition: tournament.name });
    }
  }, [tournament.name, matches, updateMatch]);

  const handleAdd = () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    addMatch({
      tournamentId: tournament.id, competition: tournament.name,
      date: dateStr, teamAName: 'Team A', teamAColor: '#e74c3c', teamBName: 'Team B', teamBColor: '#3498db',
    });
  };

  const groups = useMemo(() => {
    const map = new Map<string, typeof matches>();
    for (const m of matches) {
      const d = new Date(m.date + 'T00:00:00');
      const key = isNaN(d.getTime()) ? 'Unscheduled' : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return Array.from(map.entries());
  }, [matches]);

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="tm-sidebar-new-btn" onClick={handleAdd}>＋ Add Fixture</button>
      </div>
      {matches.length === 0 ? (
        <div className="tm-win-placeholder">
          <span>No fixtures in this tournament yet — add one here, then pick it from a scoreboard's "📅 Load Match" button.</span>
        </div>
      ) : (
        groups.map(([label, rows]) => (
          <div key={label} className="tm-sched-group">
            <div className="tm-sched-group-title">{label}</div>
            <div className="tm-sched-rows">
              {rows.map(m => (
                <div key={m.id} className="tm-sched-row">
                  <EditableDate value={m.date} onChange={date => updateMatch(m.id, { date })} />
                  <div className="tm-sched-divider" />

                  <div className="tm-sched-matchup">
                    <div className="tm-sched-team">
                      <LogoUrlPicker compact value={m.teamALogo ?? ''} onChange={logo => updateMatch(m.id, { teamALogo: logo })}
                        thumbSize={{ w: 36, h: 36 }} thumbContent={<ScheduleBadge logo={m.teamALogo} color={m.teamAColor} />} />
                      <EditableText className="tm-sched-team-name" value={m.teamAName} placeholder="Team A"
                        onChange={v => updateMatch(m.id, { teamAName: v })} />
                      <ScheduleTeamPicker side="A" tournamentId={tournament.id} onPick={t => updateMatch(m.id, { teamAName: t.name, teamAShortName: t.shortName, teamAColor: t.color, teamALogo: t.logo })} />
                    </div>
                    <span className="tm-sched-vs">VS</span>
                    <div className="tm-sched-team tm-sched-team--b">
                      <ScheduleTeamPicker side="B" tournamentId={tournament.id} onPick={t => updateMatch(m.id, { teamBName: t.name, teamBShortName: t.shortName, teamBColor: t.color, teamBLogo: t.logo })} />
                      <EditableText className="tm-sched-team-name" value={m.teamBName} placeholder="Team B"
                        onChange={v => updateMatch(m.id, { teamBName: v })} />
                      <LogoUrlPicker compact value={m.teamBLogo ?? ''} onChange={logo => updateMatch(m.id, { teamBLogo: logo })}
                        thumbSize={{ w: 36, h: 36 }} thumbContent={<ScheduleBadge logo={m.teamBLogo} color={m.teamBColor} />} />
                    </div>
                  </div>

                  <div className="tm-sched-divider" />
                  <div className="tm-sched-venue">
                    <EditableText className="tm-sched-venue-name" value={m.venue ?? ''} placeholder="Venue"
                      onChange={v => updateMatch(m.id, { venue: v })} />
                    <span className="tm-sched-venue-league" title="Competition (follows this tournament's name)">{tournament.name}</span>
                  </div>

                  <div className="tm-sched-divider" />
                  <div className="tm-sched-broadcaster">
                    <EditableText className="tm-sched-broadcaster-name" value={m.broadcaster ?? ''} placeholder="Broadcaster"
                      onChange={v => updateMatch(m.id, { broadcaster: v })} />
                    <span className="tm-sched-broadcaster-label">Watch on</span>
                  </div>

                  <div className="tm-sched-divider" />
                  <EditableTime value={m.time} onChange={time => updateMatch(m.id, { time })} />

                  <button className="tm-sched-del" title="Delete fixture" onClick={() => deleteMatch(m.id)}>×</button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ── Results tab: saved match results belonging to the selected tournament ─────
// Populated by a scoreboard's "💾 Save Result" (or the auto-save-on-overwrite
// guard) — this tab just surfaces what's already been recorded.
function ResultsPanel({ tournamentId }: { tournamentId: string }) {
  const { results: allResults, deleteResult } = useMatchResultsStore();
  const results = useMemo(
    () => allResults.filter(r => r.tournamentId === tournamentId),
    [allResults, tournamentId]
  );

  if (results.length === 0) {
    return (
      <div className="tm-win-content" style={{ padding: 16 }}>
        <div className="tm-win-placeholder">
          <span>No saved results yet for this tournament — use "💾 Save Result" on a linked scoreboard widget.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {results.map(r => (
          <div key={r.id} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: 10,
            background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8,
          }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 84, flexShrink: 0 }}>{r.date}</span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              {r.teamALogo
                ? <img src={resolveImageUrl(r.teamALogo)} alt="" style={{ width: 24, height: 24, objectFit: 'contain', borderRadius: '50%', flexShrink: 0 }} />
                : <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.teamAColor, flexShrink: 0 }} />}
              <span style={{ fontSize: 12, fontWeight: r.scoreA > r.scoreB ? 700 : 400, color: 'var(--text-primary)' }}>
                {r.teamAShortName || r.teamAName}
              </span>
              <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{r.scoreA} – {r.scoreB}</strong>
              <span style={{ fontSize: 12, fontWeight: r.scoreB > r.scoreA ? 700 : 400, color: 'var(--text-primary)' }}>
                {r.teamBShortName || r.teamBName}
              </span>
              {r.teamBLogo
                ? <img src={resolveImageUrl(r.teamBLogo)} alt="" style={{ width: 24, height: 24, objectFit: 'contain', borderRadius: '50%', flexShrink: 0 }} />
                : <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.teamBColor, flexShrink: 0 }} />}
            </div>
            {r.round && <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{r.round}</span>}
            <button className="btn btn--ghost btn--small" title="Delete result"
              onClick={() => deleteResult(r.id)} style={{ color: 'var(--text-muted)', flexShrink: 0 }}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Small persistent tournament picker shown atop tournament-scoped tabs ──────
function TournamentScopeHeader({ tournaments, selectedId, onSelect }: {
  tournaments: Tournament[]; selectedId: string; onSelect: (id: string) => void;
}) {
  return (
    <div className="tm-scope-header">
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>🏆 Tournament:</span>
      <select className="tm-input" style={{ fontSize: 12, maxWidth: 260, flex: 'none' }}
        value={selectedId} onChange={e => onSelect(e.target.value)}>
        {tournaments.length === 0 && <option value="">— none —</option>}
        {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
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
  const [tab, setTab] = useState<'tournaments' | 'teams' | 'players' | 'schedule' | 'results'>('tournaments');
  const { teams } = useTeamDbStore();
  const { matches: scheduledMatches } = useMatchScheduleStore();
  const { results: savedResults } = useMatchResultsStore();

  // Apply-to-Canvas now only resets a linked TIMER's period/duration/mode —
  // team/roster population for scoreboards and player-lists happens per-fixture
  // (Schedule tab's "Send to Scoreboard", and each widget's own 👥 team picker)
  // since a tournament can hold many teams, not a fixed Team A/B pair.
  const applyToCanvas = () => {
    if (!selected) return;
    const s = selected.settings ?? SPORT_DEFAULTS[selected.sport];
    const allWidgets = pages.flatMap(p => p.widgets);
    const linkedTimerIds = new Set<string>();
    let count = 0;

    allWidgets.forEach(w => {
      if (w.config.linkedTournamentId !== selected.id) return;
      if (w.type !== 'timer' || w.config.running) return;

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
    });

    // Clear timeline events linked to any of the above timers
    allWidgets.forEach(w => {
      if (w.type !== 'timeline') return;
      if (w.config.linkedTimerWidgetId && linkedTimerIds.has(w.config.linkedTimerWidgetId)) {
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

  // Scoped to whichever tournament is currently selected — Teams/Players/
  // Schedule/Results all derive from this one piece of state, so picking a
  // different tournament (Tournaments tab, or the scope picker on those
  // tabs) instantly changes what they show.
  const scopedTeams = useMemo(() => selected ? teams.filter(t => t.tournamentId === selected.id) : [], [teams, selected]);
  const scopedPlayerCount = useMemo(() => scopedTeams.reduce((n, t) => n + t.players.length, 0), [scopedTeams]);
  const scopedMatches = useMemo(() => selected ? scheduledMatches.filter(m => m.tournamentId === selected.id) : [], [scheduledMatches, selected]);
  const scopedResults = useMemo(() => selected ? savedResults.filter(r => r.tournamentId === selected.id) : [], [savedResults, selected]);

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

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 2, padding: '6px 10px 0', borderBottom: '1px solid var(--border)' }}>
          <button
            onClick={() => setTab('tournaments')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'tournaments' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'tournaments' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >🏆 Tournaments</button>
          <button
            onClick={() => setTab('teams')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'teams' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'teams' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >👥 Teams{scopedTeams.length > 0 ? ` (${scopedTeams.length})` : ''}</button>
          <button
            onClick={() => setTab('players')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'players' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'players' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >🎽 Players{scopedPlayerCount > 0 ? ` (${scopedPlayerCount})` : ''}</button>
          <button
            onClick={() => setTab('schedule')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'schedule' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'schedule' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >📅 Schedule{scopedMatches.length > 0 ? ` (${scopedMatches.length})` : ''}</button>
          <button
            onClick={() => setTab('results')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'results' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'results' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >🏁 Results{scopedResults.length > 0 ? ` (${scopedResults.length})` : ''}</button>
        </div>

        {/* Main area */}
        {tab === 'teams' || tab === 'players' || tab === 'schedule' || tab === 'results' ? (
          <div className="tm-win-body--scoped">
            <TournamentScopeHeader tournaments={tournaments} selectedId={selectedId} onSelect={selectTournament} />
            {!selected ? (
              <div className="tm-win-placeholder">
                <span>Create a tournament first in the 🏆 Tournaments tab.</span>
              </div>
            ) : tab === 'teams' ? (
              <TeamsPanel tournamentId={selected.id} />
            ) : tab === 'players' ? (
              <PlayersPanel tournamentId={selected.id} />
            ) : tab === 'schedule' ? (
              <SchedulePanel tournament={selected} />
            ) : (
              <ResultsPanel tournamentId={selected.id} />
            )}
          </div>
        ) : (
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
                      if (!confirm(`Delete "${selected.name}"? Its teams, players, fixtures, and results stay saved but will no longer be linked to a tournament.`)) return;
                      deleteTournament(selected.id);
                      const next = tournaments.find(t => t.id !== selected.id);
                      setSelectedId(next?.id ?? '');
                      if (!next) setAddingNew(false);
                    }}
                  >🗑 Delete</button>
                </div>

                {/* Period / time settings */}
                <SettingsBar tournament={selected} onApply={applyToCanvas} />

                {/* Quick summary + jump-to links for this tournament's related data */}
                <div style={{ display: 'flex', gap: 8, padding: '12px 16px', flexWrap: 'wrap' }}>
                  <button className="tm-sidebar-new-btn" onClick={() => setTab('teams')}>
                    👥 {scopedTeams.length} team{scopedTeams.length !== 1 ? 's' : ''}
                  </button>
                  <button className="tm-sidebar-new-btn" onClick={() => setTab('players')}>
                    🎽 {scopedPlayerCount} player{scopedPlayerCount !== 1 ? 's' : ''}
                  </button>
                  <button className="tm-sidebar-new-btn" onClick={() => setTab('schedule')}>
                    📅 {scopedMatches.length} fixture{scopedMatches.length !== 1 ? 's' : ''}
                  </button>
                  <button className="tm-sidebar-new-btn" onClick={() => setTab('results')}>
                    🏁 {scopedResults.length} result{scopedResults.length !== 1 ? 's' : ''}
                  </button>
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
        )}

        {/* Status bar */}
        <div className="tm-win-statusbar">
          {tab === 'teams' ? (
            <span>{scopedTeams.length} team{scopedTeams.length !== 1 ? 's' : ''}{selected ? ` in ${selected.name}` : ''}</span>
          ) : tab === 'players' ? (
            <span>{scopedPlayerCount} player{scopedPlayerCount !== 1 ? 's' : ''} across {scopedTeams.length} team{scopedTeams.length !== 1 ? 's' : ''}</span>
          ) : tab === 'schedule' ? (
            <span>{scopedMatches.length} fixture{scopedMatches.length !== 1 ? 's' : ''}{selected ? ` in ${selected.name}` : ''}</span>
          ) : tab === 'results' ? (
            <span>{scopedResults.length} result{scopedResults.length !== 1 ? 's' : ''}{selected ? ` in ${selected.name}` : ''}</span>
          ) : (
            <>
              <span>{tournaments.length} tournament{tournaments.length !== 1 ? 's' : ''}</span>
              {applyStatus && <span className="tm-apply-status">{applyStatus}</span>}
              <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 10 }}>double-click row to edit</span>
            </>
          )}
        </div>
      </div>
    </>
  );
}
