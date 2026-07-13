import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTournamentStore, pushTournamentDataToHost } from '../stores/tournamentStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { syncClient } from '../lib/syncClient';
import { useVmixStore } from '../stores/vmixStore';
import { ConfirmButton } from './ConfirmButton';
import { useCanvasStore } from '../stores/canvasStore';
import type { Tournament, SportType, TournamentSettings, TournamentGroup, TournamentPot, GroupListVmixTarget } from '../types/tournament';
import { SPORT_LABELS, SPORT_POSITIONS, SPORT_DEFAULTS } from '../types/tournament';
import type { Player } from '../types/tournament';
import { LogoUrlPicker } from './LogoUrlPicker';
import { InputPickerDropdown } from './WidgetConfigPanel';
import { useTeamDbStore, type SavedTeam } from '../stores/teamDbStore';
import { useMatchScheduleStore, type ScheduledMatch } from '../stores/matchScheduleStore';
import { useMatchResultsStore, type SavedMatchResult } from '../stores/matchResultsStore';
import { resolveImageUrl, transparentLogoUrl } from '../lib/imageUrl';
import { guardScoreboardOverwrite, buildLoadMatchPatch } from '../utils/scoreboardSnapshot';

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

// Builds and downloads a CSV file from a header row + data rows, quoting
// every cell — shared by the Schedule and Results tab exporters below.
function downloadCSV(header: string[], rows: string[][], filename: string) {
  const escape = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
  const csv = [header, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportFixturesCSV(matches: ScheduledMatch[], tournamentName: string) {
  // Same column order the CSV importer expects, so an exported file can be
  // re-imported (or edited in Excel and brought back in) without remapping.
  const header = ['Date', 'Time', 'Team A', 'Team B', 'Venue', 'Broadcaster', 'Round'];
  const rows = matches.map(m => [m.date, m.time ?? '', m.teamAName, m.teamBName, m.venue ?? '', m.broadcaster ?? '', m.round ?? '']);
  downloadCSV(header, rows, `${tournamentName.replace(/[^a-z0-9]/gi, '_')}_schedule.csv`);
}

function exportResultsCSV(results: SavedMatchResult[], tournamentName: string) {
  const header = ['Date', 'Round', 'Team A', 'Score A', 'Score B', 'Team B'];
  const rows = results.map(r => [r.date, r.round ?? '', r.teamAName, String(r.scoreA), String(r.scoreB), r.teamBName]);
  downloadCSV(header, rows, `${tournamentName.replace(/[^a-z0-9]/gi, '_')}_results.csv`);
}

function downloadJSON(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Exports one tournament plus everything scoped to it (teams w/ rosters,
// schedule, results) — self-contained enough to hand off or restore later.
function exportTournamentJSON(tournament: Tournament, teams: SavedTeam[], matches: ScheduledMatch[], results: SavedMatchResult[]) {
  downloadJSON(
    { kind: 'gomolab-tournament-export', version: 1, exportedAt: Date.now(), tournament, teams, matches, results },
    `${tournament.name.replace(/[^a-z0-9]/gi, '_')}_tournament.json`
  );
}

// Exports every tournament and all related teams/schedule/results in the
// database, regardless of which one is selected.
function exportProjectJSON(tournaments: Tournament[], activeTournamentId: string, teams: SavedTeam[], matches: ScheduledMatch[], results: SavedMatchResult[]) {
  downloadJSON(
    { kind: 'gomolab-project-export', version: 1, exportedAt: Date.now(), tournaments, activeTournamentId, teams, matches, results },
    `gomolab_project_${new Date().toISOString().slice(0, 10)}.json`
  );
}

// Basic quoted-CSV / TSV row splitter, shared by every file importer below.
function splitDelimitedRow(line: string, sep: string): string[] {
  if (sep === '\t') return line.split('\t').map(c => c.trim());
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

function parsePlayerFile(text: string): Omit<Player, 'id'>[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';

  const result: Omit<Player, 'id'>[] = [];
  for (const line of lines) {
    const [col0 = '', col1 = '', col2 = ''] = splitDelimitedRow(line, sep);
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

interface ParsedFixtureRow {
  date: string; time?: string; teamAName: string; teamBName: string;
  venue?: string; broadcaster?: string; round?: string;
}

// Expected columns: Date (YYYY-MM-DD), Time, Team A, Team B, Venue, Broadcaster, Round.
// Only Date + both team names are required; the rest may be left blank.
function parseFixtureFile(text: string): ParsedFixtureRow[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';

  const result: ParsedFixtureRow[] = [];
  for (const line of lines) {
    const cols = splitDelimitedRow(line, sep).map(c => c.replace(/^"|"$/g, '').trim());
    const [date = '', time = '', teamAName = '', teamBName = '', venue = '', broadcaster = '', round = ''] = cols;
    if (/^date$/i.test(date)) continue; // header row
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!teamAName || !teamBName) continue;
    result.push({
      date, time: time || undefined, teamAName, teamBName,
      venue: venue || undefined, broadcaster: broadcaster || undefined, round: round || undefined,
    });
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

      <div className="tm-settings-group">
        <label className="tm-settings-label" title="Winning score auto-applied when a fixture is marked Bye/Walkover in the Schedule tab">W/O Score</label>
        <input
          className="tm-settings-input tm-settings-input--sm"
          type="number"
          min={0} max={999}
          value={s.walkoverWinScore ?? 1}
          onChange={e => updateTournamentSettings(tournament.id, { walkoverWinScore: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>

      <div className="tm-settings-group">
        <label className="tm-settings-label" title="Standings points per outcome — walkovers count as a normal win/loss, byes don't count at all">Win/Draw/Loss Pts</label>
        <div style={{ display: 'flex', gap: 4 }}>
          <input className="tm-settings-input tm-settings-input--sm" type="number" min={0} max={99} title="Win"
            value={s.pointsWin ?? 3}
            onChange={e => updateTournamentSettings(tournament.id, { pointsWin: Math.max(0, Number(e.target.value) || 0) })} />
          <input className="tm-settings-input tm-settings-input--sm" type="number" min={0} max={99} title="Draw"
            value={s.pointsDraw ?? 1}
            onChange={e => updateTournamentSettings(tournament.id, { pointsDraw: Math.max(0, Number(e.target.value) || 0) })} />
          <input className="tm-settings-input tm-settings-input--sm" type="number" min={0} max={99} title="Loss"
            value={s.pointsLoss ?? 0}
            onChange={e => updateTournamentSettings(tournament.id, { pointsLoss: Math.max(0, Number(e.target.value) || 0) })} />
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

// Tournament.groups was a plain string[] before group prefixes/capacity were
// added — tolerate any group that's still in that shape (e.g. a stale
// pre-migration remote client) instead of crashing on `.name`.
function normalizeGroups(groups: unknown): TournamentGroup[] {
  return ((groups as TournamentGroup[] | undefined) ?? []).map(g =>
    typeof g === 'string' ? { name: g as string, prefix: (g as string).charAt(0).toUpperCase() } : g
  );
}

// Tournament.pots was a plain string[] before per-category scoping was
// added — tolerate any pot that's still in that shape.
function normalizePots(pots: unknown): TournamentPot[] {
  return ((pots as TournamentPot[] | undefined) ?? []).map(p =>
    typeof p === 'string' ? { name: p as string } : p
  );
}

// Resolves each group member to a 1-based slot — fully manual, no auto-fill:
// only teams with an explicit `groupPosition` occupy a slot. If two teams
// claim the SAME slot, it's left blank (neither wins) so the group list
// push doesn't guess — those teams are reported in `conflictTeamIds`. Teams
// with no explicit position (or a conflicted one) are reported in
// `unpositioned` instead of being silently placed somewhere.
function resolveGroupSlots(members: SavedTeam[], slotCount?: number): { slots: (SavedTeam | null)[]; conflictTeamIds: Set<string>; unpositioned: SavedTeam[] } {
  const withPos = members.filter(t => t.groupPosition != null && t.groupPosition >= 1);
  const maxPos = withPos.reduce((m, t) => Math.max(m, t.groupPosition!), 0);
  const size = Math.max(slotCount ?? 0, maxPos);
  const slots: (SavedTeam | null)[] = Array(size).fill(null);
  const conflictSlots = new Set<number>();
  const conflictTeamIds = new Set<string>();
  for (const t of withPos) {
    const idx = t.groupPosition! - 1;
    if (slots[idx] === null && !conflictSlots.has(idx)) {
      slots[idx] = t;
    } else {
      conflictSlots.add(idx);
      const other = slots[idx];
      if (other) conflictTeamIds.add(other.id);
      slots[idx] = null;
      conflictTeamIds.add(t.id);
    }
  }
  const unpositioned = members.filter(t => !withPos.includes(t) || conflictTeamIds.has(t.id));
  return { slots, conflictTeamIds, unpositioned };
}

// ── Teams tab: teams belonging to the selected tournament (a competition can
// hold any number of teams — pick 2 of them per fixture in the Schedule tab) ──
function TeamsPanel({ tournament }: { tournament: Tournament }) {
  const tournamentId = tournament.id;
  const { teams: allTeams, addTeam, updateTeam, deleteTeam, duplicateTeam } = useTeamDbStore();
  const { updateTournament } = useTournamentStore();
  const { matches, updateMatch: updateScheduleMatch } = useMatchScheduleStore();
  const teams = useMemo(() => allTeams.filter(t => t.tournamentId === tournamentId), [allTeams, tournamentId]);
  const categories = tournament.categories ?? [];
  const [newCategoryName, setNewCategoryName] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [duplicateTarget, setDuplicateTarget] = useState('');
  // Drag a team card onto a category section header to move it there —
  // alternative to the bulk "Move Selected" button for a single team.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverSection, setDragOverSection] = useState<string | null>(null);

  const handleAdd = () => {
    addTeam({ name: 'New Team', color: '#3498db', tournamentId });
  };

  const toggleSelected = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Duplicates every selected team into the chosen category (or into EVERY
  // category at once via "All Categories") — each copy gets its own fresh,
  // empty roster since players differ per category.
  const bulkDuplicate = () => {
    if (selectedIds.size === 0 || !duplicateTarget) return;
    const targets = duplicateTarget === '__all__' ? categories : [duplicateTarget];
    for (const id of selectedIds) {
      for (const cat of targets) {
        const newId = duplicateTeam(id);
        if (newId) updateTeam(newId, { category: cat });
      }
    }
    setSelectedIds(new Set());
  };

  // Moves every selected team into the chosen category in place (no
  // duplicate) — a team can only be in one category, so "All Categories"
  // isn't a valid move target.
  const moveSelected = () => {
    if (selectedIds.size === 0 || !duplicateTarget || duplicateTarget === '__all__') return;
    for (const id of selectedIds) updateTeam(id, { category: duplicateTarget });
    setSelectedIds(new Set());
  };

  const dropOnSection = (label: string | null) => {
    if (draggedId) updateTeam(draggedId, { category: label === 'Uncategorized' ? undefined : (label ?? undefined) });
    setDraggedId(null);
    setDragOverSection(null);
  };

  const addCategory = () => {
    const name = newCategoryName.trim();
    if (!name || categories.includes(name)) return;
    updateTournament(tournamentId, { categories: [...categories, name] });
    setNewCategoryName('');
  };

  const removeCategory = (name: string) => {
    updateTournament(tournamentId, { categories: categories.filter(c => c !== name) });
    for (const t of teams) {
      if (t.category === name) updateTeam(t.id, { category: undefined });
    }
  };

  // Setting a team's status auto-applies the same matchType to that team's
  // not-yet-completed fixtures — matching by name since ScheduledMatch only
  // stores a denormalized team name, not a team id.
  const setTeamStatus = (team: SavedTeam, status: SavedTeam['status']) => {
    updateTeam(team.id, { status });
    const win = tournament.settings?.walkoverWinScore ?? SPORT_DEFAULTS[tournament.sport].walkoverWinScore;
    const nameKey = team.name.trim().toLowerCase();
    const shortKey = (team.shortName ?? '').trim().toLowerCase();
    const isTeam = (n?: string, s?: string) =>
      !!n && (n.trim().toLowerCase() === nameKey || (!!shortKey && (s ?? '').trim().toLowerCase() === shortKey));
    for (const m of matches) {
      if (m.completedAt) continue;
      const isA = isTeam(m.teamAName, m.teamAShortName);
      const isB = !isA && isTeam(m.teamBName, m.teamBShortName);
      if (!isA && !isB) continue;
      if (!status) {
        updateScheduleMatch(m.id, { matchType: undefined, walkoverLoser: undefined });
        continue;
      }
      const loserSide: 'A' | 'B' = isA ? 'A' : 'B';
      updateScheduleMatch(m.id, {
        matchType: status,
        walkoverLoser: status === 'walkover' ? loserSide : undefined,
        scoreA: loserSide === 'A' ? 0 : win,
        scoreB: loserSide === 'A' ? win : 0,
      });
    }
  };

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto' }}>
      <div className="tm-groups-bar">
        <span className="tm-groups-label">Categories:</span>
        {categories.map(c => (
          <span key={c} className="tm-group-chip">
            {c}
            <button onClick={() => removeCategory(c)} title={`Remove ${c} (unassigns any teams in it)`}>×</button>
          </span>
        ))}
        <input
          className="tm-input tm-groups-add-input"
          placeholder="e.g. Men, Women, U21"
          value={newCategoryName}
          onChange={e => setNewCategoryName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addCategory(); }}
        />
        <button className="tm-io-btn" onClick={addCategory} disabled={!newCategoryName.trim()}>+ Add Category</button>
      </div>

      {categories.length > 0 && selectedIds.size > 0 && (
        <div className="tm-draw-vmix-cfg" style={{ marginTop: 10 }}>
          <span className="tm-groups-label">{selectedIds.size} selected —</span>
          <select className="tm-input" value={duplicateTarget} onChange={e => setDuplicateTarget(e.target.value)} style={{ width: 160 }}>
            <option value="">— pick category —</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
            <option value="__all__">All Categories</option>
          </select>
          <button className="tm-io-btn" onClick={bulkDuplicate} disabled={!duplicateTarget}>⧉ Duplicate Selected</button>
          <button className="tm-io-btn" onClick={moveSelected} disabled={!duplicateTarget || duplicateTarget === '__all__'}>→ Move Selected</button>
          <button className="tm-io-btn" onClick={() => setSelectedIds(new Set())}>Clear Selection</button>
        </div>
      )}

      {teams.length === 0 ? (
        <div className="tm-win-placeholder" style={{ marginTop: 12 }}>
          <span>No teams in this tournament yet.</span>
        </div>
      ) : (
        (categories.length > 0
          ? [...categories.map(c => ({ label: c, items: teams.filter(t => t.category === c) })), { label: 'Uncategorized', items: teams.filter(t => !t.category) }]
          : [{ label: null as string | null, items: teams }]
        ).map(section => (section.label && section.items.length === 0) ? null : (
          <div
            key={section.label ?? '__all__'}
            style={{
              marginTop: 16, borderRadius: 8, transition: 'box-shadow 0.12s',
              boxShadow: categories.length > 0 && dragOverSection === (section.label ?? '__all__') ? 'inset 0 0 0 2px var(--accent)' : 'none',
            }}
            onDragOver={categories.length > 0 ? (e => { e.preventDefault(); setDragOverSection(section.label ?? '__all__'); }) : undefined}
            onDragLeave={categories.length > 0 ? (() => setDragOverSection(prev => prev === (section.label ?? '__all__') ? null : prev)) : undefined}
            onDrop={categories.length > 0 ? (e => { e.preventDefault(); dropOnSection(section.label); }) : undefined}
          >
            {section.label && (
              <div className="tm-draw-section-title" style={{ marginBottom: 8 }}>{section.label} ({section.items.length})</div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {section.items.map(t => (
                <div
                  key={t.id}
                  draggable={categories.length > 0}
                  onDragStart={categories.length > 0 ? (() => setDraggedId(t.id)) : undefined}
                  onDragEnd={categories.length > 0 ? (() => { setDraggedId(null); setDragOverSection(null); }) : undefined}
                  style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: 10,
                  background: 'var(--bg-2)', border: `1px solid ${t.status ? 'var(--red)' : 'var(--border)'}`, borderRadius: 8,
                }}>
                  {categories.length > 0 && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(t.id)}
                      onChange={() => toggleSelected(t.id)}
                      title="Select for bulk duplicate"
                      style={{ flexShrink: 0, cursor: 'pointer' }}
                    />
                  )}
                  <LogoUrlPicker
                    compact
                    value={t.logo ?? ''}
                    onChange={logo => updateTeam(t.id, { logo })}
                    thumbSize={{ w: 44, h: 44 }}
                    tournamentId={tournamentId}
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
                    <select
                      className="tm-sched-type-select"
                      title="Bye/Walkover auto-applies to this team's not-yet-completed fixtures"
                      value={t.status ?? ''}
                      onChange={e => setTeamStatus(t, (e.target.value || undefined) as SavedTeam['status'])}
                      style={{ width: '100%' }}
                    >
                      <option value="">Active</option>
                      <option value="bye">BYE (sitting out)</option>
                      <option value="walkover">WALKOVER (withdrawn)</option>
                    </select>
                    {categories.length > 0 && (
                      <select
                        className="tm-sched-type-select"
                        title="Competition category"
                        value={t.category ?? ''}
                        onChange={e => updateTeam(t.id, { category: e.target.value || undefined })}
                        style={{ width: '100%' }}
                      >
                        <option value="">— No Category —</option>
                        {categories.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'flex-start' }}>
                    <button
                      className="btn btn--ghost btn--small"
                      title="Duplicate this team into another category (fresh empty roster)"
                      onClick={() => duplicateTeam(t.id)}
                      style={{ color: 'var(--text-muted)' }}
                    >⧉</button>
                    <button
                      className="btn btn--ghost btn--small"
                      title="Delete team"
                      onClick={() => deleteTeam(t.id)}
                      style={{ color: 'var(--text-muted)' }}
                    >×</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="tm-sidebar-new-btn" onClick={handleAdd}>＋ Add Team</button>
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

// Rendered via a portal into document.body, positioned above its anchor
// button with fixed coordinates: fixture rows have overflow:hidden (for the
// rounded-card layout), which would silently clip an absolutely-positioned
// popup nested inside them — a portal escapes that, same fix as TeamPicker.
function ScheduleTeamPicker({ side, tournamentId, onPick }: {
  side: 'A' | 'B'; tournamentId?: string;
  onPick: (t: { name: string; shortName?: string; color: string; logo?: string }) => void;
}) {
  const { teams: allTeams } = useTeamDbStore();
  const teams = useMemo(() => tournamentId ? allTeams.filter(t => t.tournamentId === tournamentId) : allTeams, [allTeams, tournamentId]);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
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

  const toggle = () => {
    if (!open && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      // Open upward, anchored just above the button, so it's never clipped
      // by the fixture row's own layout regardless of where it sits on screen.
      setPos({ left: r.left, bottom: window.innerHeight - r.top + 6 });
    }
    setOpen(v => !v);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button ref={anchorRef} className="tm-sched-pick-btn" title={`Pick saved team for side ${side}`}
        onClick={e => { e.stopPropagation(); toggle(); }}>👥</button>
      {open && pos && createPortal(
        <div ref={popupRef} onClick={e => e.stopPropagation()} style={{
          position: 'fixed', left: pos.left, bottom: pos.bottom, zIndex: 10000, minWidth: 180, maxHeight: 220,
          overflowY: 'auto', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 -4px 16px rgba(0,0,0,.5)',
        }}>
          {teams.length === 0 ? (
            <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)' }}>No saved teams</div>
          ) : teams.map(t => (
            <div key={t.id} onClick={() => { onPick(t); setOpen(false); }}
              style={{ padding: '5px 8px', fontSize: 11, cursor: 'pointer', color: 'var(--text-secondary)',
                borderBottom: '1px solid var(--border)' }}>
              {t.name}{t.category ? <span style={{ color: 'var(--text-muted)' }}> — {t.category}</span> : ''}
            </div>
          ))}
        </div>,
        document.body
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

// Per-fixture "Send to Scoreboard" — lets a fixture be pushed straight from
// the DB's Schedule tab, without needing the on-canvas Upcoming Matches
// widget. Mirrors MatchScheduleWidget's send logic (same guard + patch).
function ScoreboardSendButton({ match, scoreboards, onSend }: {
  match: ScheduledMatch;
  scoreboards: { id: string; label?: string }[];
  onSend: (targetId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
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

  if (match.sentAt) {
    return <span className="tm-sched-sent-tag" title="Already sent to a scoreboard">✓ Sent</span>;
  }
  if (scoreboards.length === 0) {
    return <button className="tm-sched-send-btn" disabled title="No scoreboard widget on the canvas">→ Send</button>;
  }
  if (scoreboards.length === 1) {
    return (
      <button className="tm-sched-send-btn" title="Send this fixture to the scoreboard" onClick={() => onSend(scoreboards[0].id)}>
        → Send
      </button>
    );
  }

  const toggle = () => {
    if (!open && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setPos({ left: r.left, bottom: window.innerHeight - r.top + 6 });
    }
    setOpen(v => !v);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button ref={anchorRef} className="tm-sched-send-btn" title="Pick which scoreboard to send to" onClick={toggle}>→ Send</button>
      {open && pos && createPortal(
        <div ref={popupRef} style={{
          position: 'fixed', left: pos.left, bottom: pos.bottom, zIndex: 10000, minWidth: 170, maxHeight: 220,
          overflowY: 'auto', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 -4px 16px rgba(0,0,0,.5)',
        }}>
          {scoreboards.map(sb => (
            <div key={sb.id} onClick={() => { onSend(sb.id); setOpen(false); }}
              style={{ padding: '6px 10px', fontSize: 11, cursor: 'pointer', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
              {sb.label || sb.id}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

function SchedulePanel({ tournament }: { tournament: Tournament }) {
  const { matches: allMatches, addMatch, updateMatch, deleteMatch, markSent } = useMatchScheduleStore();
  const { teams: allTeams } = useTeamDbStore();
  const { pages, updateWidgetConfig, resetWidgetTimer } = useCanvasStore();
  const { results: allResults, addResult, updateResult, deleteResult } = useMatchResultsStore();
  const matches = useMemo(
    () => allMatches.filter(m => m.tournamentId === tournament.id),
    [allMatches, tournament.id]
  );
  const scoreboards = useMemo(
    () => pages.flatMap(p => p.widgets).filter(w => w.type === 'scoreboard').map(w => ({ id: w.id, label: w.label })),
    [pages]
  );
  const sendToScoreboard = (m: typeof matches[number], targetId: string) => {
    const allWidgets = pages.flatMap(p => p.widgets);
    const target = allWidgets.find(w => w.id === targetId);
    if (!target) return;
    if (!guardScoreboardOverwrite(target.config, addResult)) return;
    updateWidgetConfig(target.id, buildLoadMatchPatch(m));
    // A new match starting means the previous one's clock shouldn't carry over.
    if (target.config.linkedTimerWidgetId) resetWidgetTimer(target.config.linkedTimerWidgetId);
    markSent(m.id);
  };
  const scopedTeams = useMemo(
    () => allTeams.filter(t => t.tournamentId === tournament.id),
    [allTeams, tournament.id]
  );

  const [importPreview, setImportPreview] = useState<ParsedFixtureRow[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fixtures always show the CURRENT tournament name — keep the stored
  // `competition` field in sync (it's what downstream widgets/results read)
  // so renaming the tournament doesn't leave stale fixtures behind.
  useEffect(() => {
    for (const m of matches) {
      if (m.competition !== tournament.name) updateMatch(m.id, { competition: tournament.name });
    }
  }, [tournament.name, matches, updateMatch]);

  // Bye/Walkover are fully automatic, no manual per-fixture picker: a fixture
  // with no Team B name is a bye; a fixture where either team currently has
  // 'walkover' status set in the Team Database is a walkover for that side.
  // Keeps every not-yet-completed fixture in sync as fixtures/team statuses change.
  useEffect(() => {
    const win = tournament.settings?.walkoverWinScore ?? SPORT_DEFAULTS[tournament.sport].walkoverWinScore;
    const statusOf = (name: string, shortName?: string) => {
      const key = name.trim().toLowerCase();
      const shortKey = (shortName ?? '').trim().toLowerCase();
      return scopedTeams.find(t =>
        t.name.trim().toLowerCase() === key || (!!shortKey && (t.shortName ?? '').trim().toLowerCase() === shortKey)
      )?.status;
    };
    for (const m of matches) {
      if (m.completedAt) continue;
      const isByeAuto = !m.teamBName || !m.teamBName.trim();
      let nextType: ScheduledMatch['matchType'];
      let nextLoser: 'A' | 'B' | undefined;
      if (isByeAuto) {
        nextType = 'bye';
      } else if (statusOf(m.teamAName, m.teamAShortName) === 'walkover') {
        nextType = 'walkover'; nextLoser = 'A';
      } else if (statusOf(m.teamBName, m.teamBShortName) === 'walkover') {
        nextType = 'walkover'; nextLoser = 'B';
      }
      if (nextType === m.matchType && nextLoser === m.walkoverLoser) continue;
      if (!nextType) {
        updateMatch(m.id, { matchType: undefined, walkoverLoser: undefined });
      } else {
        updateMatch(m.id, {
          matchType: nextType, walkoverLoser: nextLoser,
          scoreA: nextLoser === 'A' ? 0 : win,
          scoreB: nextLoser === 'A' ? win : 0,
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, scopedTeams, tournament.settings?.walkoverWinScore, tournament.sport]);

  // A bye/walkover has no live match to run on a scoreboard, so it never
  // reaches the normal "Save Result" step — without this, the score set on
  // the fixture just sits on the Schedule row and never becomes a Result,
  // which looked like "the score I set doesn't show up, it's stuck at 0-0".
  // Writes/updates/removes a linked Result directly as the fixture changes.
  useEffect(() => {
    for (const m of matches) {
      const existing = allResults.find(r => r.sourceScheduleId === m.id);
      if (m.matchType) {
        const data = {
          tournamentId: tournament.id,
          date: m.date, time: m.time,
          competition: m.competition ?? tournament.name, round: m.round,
          teamAName: m.teamAName, teamAShortName: m.teamAShortName, teamALogo: m.teamALogo, teamAColor: m.teamAColor,
          scoreA: m.scoreA ?? 0,
          teamBName: m.teamBName, teamBShortName: m.teamBShortName, teamBLogo: m.teamBLogo, teamBColor: m.teamBColor,
          scoreB: m.scoreB ?? 0,
          matchType: m.matchType, walkoverLoser: m.walkoverLoser,
          sourceScheduleId: m.id,
        };
        if (!existing) {
          addResult(data);
        } else if (
          existing.scoreA !== data.scoreA || existing.scoreB !== data.scoreB ||
          existing.walkoverLoser !== data.walkoverLoser || existing.round !== data.round ||
          existing.date !== data.date || existing.time !== data.time ||
          existing.teamAName !== data.teamAName || existing.teamBName !== data.teamBName ||
          existing.teamAShortName !== data.teamAShortName || existing.teamBShortName !== data.teamBShortName
        ) {
          updateResult(existing.id, data);
        }
      } else if (existing) {
        // No longer a bye/walkover (e.g. team reinstated) — drop the auto result.
        deleteResult(existing.id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, allResults, tournament.id, tournament.name]);

  const handleAdd = () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    addMatch({
      tournamentId: tournament.id, competition: tournament.name,
      date: dateStr, teamAName: 'Team A', teamAColor: '#e74c3c', teamBName: 'Team B', teamBColor: '#3498db',
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      const rows = parseFixtureFile(text);
      if (rows.length > 0) setImportPreview(rows);
      else alert('No valid fixtures found in file.\n\nExpected columns: Date (YYYY-MM-DD), Time, Team A, Team B, Venue, Broadcaster, Round\nFormats: CSV, TSV, or plain text');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Resolves a team name against this tournament's saved teams (case-insensitive)
  // so an imported fixture picks up the right color/logo/short name automatically.
  const resolveTeam = (name: string, fallbackColor: string) => {
    const t = scopedTeams.find(t2 => t2.name.trim().toLowerCase() === name.trim().toLowerCase());
    return {
      name, shortName: t?.shortName, color: t?.color ?? fallbackColor, logo: t?.logo,
    };
  };

  const confirmImport = () => {
    if (!importPreview) return;
    for (const row of importPreview) {
      const a = resolveTeam(row.teamAName, '#e74c3c');
      const b = resolveTeam(row.teamBName, '#3498db');
      addMatch({
        tournamentId: tournament.id, competition: tournament.name,
        date: row.date, time: row.time, venue: row.venue, broadcaster: row.broadcaster, round: row.round,
        teamAName: a.name, teamAShortName: a.shortName, teamAColor: a.color, teamALogo: a.logo,
        teamBName: b.name, teamBShortName: b.shortName, teamBColor: b.color, teamBLogo: b.logo,
      });
    }
    setImportPreview(null);
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
        <button className="tm-io-btn" title="Import fixtures from CSV / TSV / TXT" onClick={() => fileInputRef.current?.click()}>
          ↑ Import
        </button>
        <button className="tm-io-btn" title="Export fixtures as CSV (Excel compatible)"
          onClick={() => exportFixturesCSV(matches, tournament.name)} disabled={matches.length === 0}>
          ↓ Export CSV
        </button>
        <button className="tm-sidebar-new-btn" onClick={handleAdd}>＋ Add Fixture</button>
        <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }} onChange={handleFileChange} />
      </div>

      {importPreview && (
        <div className="tm-import-preview" style={{ marginBottom: 12 }}>
          <div className="tm-import-preview-title">
            Found <strong>{importPreview.length}</strong> fixture{importPreview.length !== 1 ? 's' : ''}
          </div>
          <div className="tm-import-preview-list">
            {importPreview.slice(0, 5).map((row, i) => (
              <div key={i} className="tm-import-preview-row">
                <span className="tm-import-preview-jersey">{row.date}</span>
                <span className="tm-import-preview-name">{row.teamAName} vs {row.teamBName}</span>
                {row.venue && <span className="tm-import-preview-pos">{row.venue}</span>}
              </div>
            ))}
            {importPreview.length > 5 && (
              <div className="tm-import-preview-more">+{importPreview.length - 5} more…</div>
            )}
          </div>
          <div className="tm-import-preview-actions">
            <button className="tm-io-btn tm-io-btn--ok" onClick={confirmImport}>Add {importPreview.length} fixture{importPreview.length !== 1 ? 's' : ''}</button>
            <button className="tm-io-btn" onClick={() => setImportPreview(null)}>Cancel</button>
          </div>
        </div>
      )}

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
                <div key={m.id} className={`tm-sched-row${m.completedAt ? ' tm-sched-row--completed' : ''}`}>
                  {m.completedAt && <span className="tm-sched-completed-badge">✓ Completed</span>}
                  <EditableDate value={m.date} onChange={date => updateMatch(m.id, { date })} />
                  <div className="tm-sched-divider" />

                  <div className="tm-sched-matchup">
                    <div className="tm-sched-team">
                      <LogoUrlPicker compact value={m.teamALogo ?? ''} onChange={logo => updateMatch(m.id, { teamALogo: logo })}
                        thumbSize={{ w: 36, h: 36 }} thumbContent={<ScheduleBadge logo={m.teamALogo} color={m.teamAColor} />} tournamentId={tournament.id} />
                      <EditableText className="tm-sched-team-name" value={m.teamAName} placeholder="Team A"
                        onChange={v => updateMatch(m.id, { teamAName: v })} />
                      <ScheduleTeamPicker side="A" tournamentId={tournament.id} onPick={t => updateMatch(m.id, { teamAName: t.name, teamAShortName: t.shortName, teamAColor: t.color, teamALogo: t.logo })} />
                    </div>
                    <div className="tm-sched-vs-col">
                      {m.matchType && (
                        <span className="tm-sched-type-badge" title={
                          m.matchType === 'bye'
                            ? 'Automatic — no Team B name set'
                            : `Automatic — ${m.walkoverLoser === 'A' ? m.teamAName : m.teamBName} is on Walkover status in the Team Database`
                        }>{m.matchType === 'bye' ? 'BYE' : 'W/O'}</span>
                      )}
                      {m.matchType ? (
                        <span className="tm-sched-vs tm-sched-score">
                          <EditableText value={String(m.scoreA ?? 0)} onChange={v => updateMatch(m.id, { scoreA: Number(v) || 0 })} />
                          <span className="tm-sched-score-sep">–</span>
                          <EditableText value={String(m.scoreB ?? 0)} onChange={v => updateMatch(m.id, { scoreB: Number(v) || 0 })} />
                        </span>
                      ) : (
                        <span className="tm-sched-vs">VS</span>
                      )}
                      <EditableText className="tm-sched-round" value={m.round ?? ''} placeholder="Round"
                        onChange={v => updateMatch(m.id, { round: v })} />
                    </div>
                    <div className="tm-sched-team tm-sched-team--b">
                      <ScheduleTeamPicker side="B" tournamentId={tournament.id} onPick={t => updateMatch(m.id, { teamBName: t.name, teamBShortName: t.shortName, teamBColor: t.color, teamBLogo: t.logo })} />
                      <EditableText className="tm-sched-team-name" value={m.teamBName} placeholder="Team B"
                        onChange={v => updateMatch(m.id, { teamBName: v })} />
                      <LogoUrlPicker compact value={m.teamBLogo ?? ''} onChange={logo => updateMatch(m.id, { teamBLogo: logo })}
                        thumbSize={{ w: 36, h: 36 }} thumbContent={<ScheduleBadge logo={m.teamBLogo} color={m.teamBColor} />} tournamentId={tournament.id} />
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

                  <div className="tm-sched-divider" />
                  <div className="tm-sched-send-col">
                    <ScoreboardSendButton match={m} scoreboards={scoreboards} onSend={id => sendToScoreboard(m, id)} />
                  </div>

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
function formatSavedAt(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Same fixture-card layout as the Schedule tab (score in place of "VS",
// competition/saved-time in place of venue/broadcaster) so a finished match
// visually reads as the same object moving from one tab to the other.
function ResultsPanel({ tournament }: { tournament: Tournament }) {
  const { results: allResults, updateResult, deleteResult } = useMatchResultsStore();
  const results = useMemo(
    () => allResults.filter(r => r.tournamentId === tournament.id),
    [allResults, tournament.id]
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="tm-io-btn" title="Export results as CSV (Excel compatible)"
          onClick={() => exportResultsCSV(results, tournament.name)}>
          ↓ Export CSV
        </button>
      </div>
      <div className="tm-sched-rows">
        {results.map(r => (
          <div key={r.id} className="tm-sched-row">
            <EditableDate value={r.date} onChange={date => updateResult(r.id, { date })} />
            <div className="tm-sched-divider" />

            <div className="tm-sched-matchup">
              <div className="tm-sched-team">
                <div style={{ width: 36, height: 36, flexShrink: 0 }}><ScheduleBadge logo={r.teamALogo} color={r.teamAColor} /></div>
                <EditableText className="tm-sched-team-name" value={r.teamAShortName || r.teamAName}
                  onChange={v => updateResult(r.id, r.teamAShortName ? { teamAShortName: v } : { teamAName: v })} />
              </div>
              <div className="tm-sched-vs-col">
                {r.matchType && (
                  <span className="tm-sched-type-badge">{r.matchType === 'bye' ? 'BYE' : 'W/O'}</span>
                )}
                <span className="tm-sched-vs tm-sched-score">
                  <EditableText value={String(r.scoreA)} onChange={v => updateResult(r.id, { scoreA: Number(v) || 0 })} />
                  <span className="tm-sched-score-sep">–</span>
                  <EditableText value={String(r.scoreB)} onChange={v => updateResult(r.id, { scoreB: Number(v) || 0 })} />
                </span>
                <EditableText className="tm-sched-round" value={r.round ?? ''} placeholder="Round"
                  onChange={v => updateResult(r.id, { round: v })} />
              </div>
              <div className="tm-sched-team tm-sched-team--b">
                <EditableText className="tm-sched-team-name" value={r.teamBShortName || r.teamBName}
                  onChange={v => updateResult(r.id, r.teamBShortName ? { teamBShortName: v } : { teamBName: v })} />
                <div style={{ width: 36, height: 36, flexShrink: 0 }}><ScheduleBadge logo={r.teamBLogo} color={r.teamBColor} /></div>
              </div>
            </div>

            <div className="tm-sched-divider" />
            <div className="tm-sched-venue">
              <EditableText className="tm-sched-venue-name" value={r.competition ?? ''} placeholder="Competition"
                onChange={v => updateResult(r.id, { competition: v })} />
              <span className="tm-sched-venue-league">{tournament.name}</span>
            </div>

            <div className="tm-sched-divider" />
            <div className="tm-sched-time">
              <span className="tm-sched-time-val">{r.time ? formatTimeDisplay(r.time) : '—'}</span>
              <span className="tm-sched-time-tz">Kickoff</span>
            </div>

            <div className="tm-sched-divider" />
            <div className="tm-sched-time">
              <span className="tm-sched-time-val">{formatSavedAt(r.savedAt)}</span>
              <span className="tm-sched-time-tz">End Time</span>
            </div>

            <button className="tm-sched-del" title="Delete result" onClick={() => deleteResult(r.id)}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Standings tab: one table per pool/group (or one overall table if the
// tournament has no groups defined) computed from saved results. Byes don't
// count at all (nothing was played); walkovers count as a normal win/loss
// for the team that didn't forfeit, same as any other result.
interface StandingRow {
  teamId: string; name: string; shortName?: string; logo?: string; color: string;
  played: number; won: number; drawn: number; lost: number;
  pf: number; pa: number; pts: number;
}

function computeStandings(teams: SavedTeam[], results: SavedMatchResult[], settings: TournamentSettings): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  for (const t of teams) {
    rows.set(t.id, { teamId: t.id, name: t.name, shortName: t.shortName, logo: t.logo, color: t.color, played: 0, won: 0, drawn: 0, lost: 0, pf: 0, pa: 0, pts: 0 });
  }
  const findRow = (name: string, shortName?: string) => {
    const key = name.trim().toLowerCase();
    const shortKey = (shortName ?? '').trim().toLowerCase();
    const t = teams.find(t2 =>
      t2.name.trim().toLowerCase() === key || (!!shortKey && (t2.shortName ?? '').trim().toLowerCase() === shortKey)
    );
    return t ? rows.get(t.id) : undefined;
  };
  for (const r of results) {
    if (r.matchType === 'bye') continue; // nothing was actually played
    const rowA = findRow(r.teamAName, r.teamAShortName);
    const rowB = findRow(r.teamBName, r.teamBShortName);
    if (!rowA || !rowB) continue; // team isn't part of this group/tournament
    rowA.played++; rowB.played++;
    rowA.pf += r.scoreA; rowA.pa += r.scoreB;
    rowB.pf += r.scoreB; rowB.pa += r.scoreA;
    if (r.scoreA > r.scoreB) {
      rowA.won++; rowA.pts += settings.pointsWin;
      rowB.lost++; rowB.pts += settings.pointsLoss;
    } else if (r.scoreB > r.scoreA) {
      rowB.won++; rowB.pts += settings.pointsWin;
      rowA.lost++; rowA.pts += settings.pointsLoss;
    } else {
      rowA.drawn++; rowB.drawn++;
      rowA.pts += settings.pointsDraw; rowB.pts += settings.pointsDraw;
    }
  }
  return Array.from(rows.values()).sort((a, b) =>
    b.pts - a.pts || (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf
  );
}

function StandingsTable({ title, rows }: { title: string; rows: StandingRow[] }) {
  return (
    <div className="tm-standings-table">
      <div className="tm-standings-title">{title}</div>
      <div className="tm-standings-row tm-standings-row--head">
        <span className="tm-standings-team">Team</span>
        <span>P</span><span>W</span><span>D</span><span>L</span>
        <span>PF</span><span>PA</span><span>+/-</span><span>Pts</span>
      </div>
      {rows.map((r, i) => (
        <div key={r.teamId} className={`tm-standings-row${i < 2 ? ' tm-standings-row--top' : ''}`}>
          <span className="tm-standings-team">
            <div style={{ width: 22, height: 22, flexShrink: 0 }}><ScheduleBadge logo={r.logo} color={r.color} /></div>
            {r.shortName || r.name}
          </span>
          <span>{r.played}</span><span>{r.won}</span><span>{r.drawn}</span><span>{r.lost}</span>
          <span>{r.pf}</span><span>{r.pa}</span><span>{r.pf - r.pa > 0 ? '+' : ''}{r.pf - r.pa}</span>
          <span className="tm-standings-pts">{r.pts}</span>
        </div>
      ))}
    </div>
  );
}

function StandingsPanel({ tournament }: { tournament: Tournament }) {
  const { teams: allTeams } = useTeamDbStore();
  const { results: allResults } = useMatchResultsStore();
  const settings = tournament.settings ?? SPORT_DEFAULTS[tournament.sport];
  const teams = useMemo(() => allTeams.filter(t => t.tournamentId === tournament.id), [allTeams, tournament.id]);
  const results = useMemo(() => allResults.filter(r => r.tournamentId === tournament.id), [allResults, tournament.id]);
  const groups = normalizeGroups(tournament.groups);
  const categories = tournament.categories ?? [];

  if (teams.length === 0) {
    return (
      <div className="tm-win-content" style={{ padding: 16 }}>
        <div className="tm-win-placeholder">
          <span>Add teams in the 👥 Teams tab to see standings.</span>
        </div>
      </div>
    );
  }

  // Groups/tables for one scope (a category, or the whole tournament when
  // no categories are defined) — untagged groups stay visible in every scope.
  const renderScope = (scopeTeams: SavedTeam[], scopeGroups: TournamentGroup[], label: string | null) => (
    <div key={label ?? '__all__'} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {label && <div className="tm-draw-section-title">{label}</div>}
      {scopeGroups.length === 0 ? (
        <StandingsTable title={label ?? tournament.name} rows={computeStandings(scopeTeams, results, settings)} />
      ) : (
        <>
          {scopeGroups.map(g => (
            <StandingsTable key={g.name} title={g.name} rows={computeStandings(scopeTeams.filter(t => t.group === g.name), results, settings)} />
          ))}
          {scopeTeams.some(t => !t.group) && (
            <StandingsTable title="Unassigned" rows={computeStandings(scopeTeams.filter(t => !t.group), results, settings)} />
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {categories.length === 0 ? (
        renderScope(teams, groups, null)
      ) : (
        <>
          {categories.map(c => renderScope(
            teams.filter(t => t.category === c),
            groups.filter(g => !g.category || g.category === c),
            c
          ))}
          {teams.some(t => !t.category) && renderScope(
            teams.filter(t => !t.category),
            groups.filter(g => !g.category),
            'Uncategorized'
          )}
        </>
      )}
    </div>
  );
}

// ── Draw tab: live pot-based draw — a team is picked per pot (randomly or
// by clicking one), then always waits for the operator to manually pick its
// destination group (no auto-assignment), pushing each pick to a configured
// vMix input in real time for an on-air draw graphic.
interface LastDrawn { team: SavedTeam; pot: string; group: string; }

// A team armed by clicking its card, awaiting a slot click to complete
// the pairing (or vice versa — see `armedSlot`).
interface ArmedTeam { team: SavedTeam; pot: string; }
interface ArmedSlot { group: string; position: number; }

function DrawPanel({ tournament }: { tournament: Tournament }) {
  const { teams: allTeams, updateTeam } = useTeamDbStore();
  const { updateTournament } = useTournamentStore();
  const { client, vmixState } = useVmixStore();
  const allVmixInputs = vmixState?.inputs ?? [];
  const { liveSyncDraw, setLiveSyncDraw } = useAppSettings();
  // Only a non-host interactive (9877) client can push to the host — 9878
  // readonly and 9879 commentator clients never edit.
  const isRemoteInteractive = !isHostClient && !syncClient.isReadOnly && !syncClient.isCommentator;
  const categories = tournament.categories ?? [];
  // Which category's draw is currently in view — groups/pots/teams tagged
  // for another category are hidden, so each category runs its own
  // independent draw. Untagged groups/pots/teams stay visible everywhere
  // (keeps single-category tournaments working exactly as before).
  const [activeCategory, setActiveCategory] = useState('');
  // Setup (Groups & Pots config + Assignments table) is one-time/occasional
  // work — split it into its own sub-tab so the daily-use Live Draw view
  // isn't buried below it.
  const [drawSubTab, setDrawSubTab] = useState<'live' | 'settings'>('live');
  const allGroups = normalizeGroups(tournament.groups);
  const allPots = normalizePots(tournament.pots);
  const inScope = (category?: string) => !activeCategory || !category || category === activeCategory;
  const teams = useMemo(
    () => allTeams.filter(t => t.tournamentId === tournament.id && inScope(t.category)),
    [allTeams, tournament.id, activeCategory]
  );
  const pots = allPots.filter(p => inScope(p.category));
  const groups = allGroups.filter(g => inScope(g.category));
  const drawCfg = tournament.drawVmix ?? {};
  const [lastDrawn, setLastDrawn] = useState<LastDrawn | null>(null);
  // Editable, order-free draw: either a team or a group can be picked first
  // — whichever is picked second completes the pairing. Clicking the same
  // one again cancels it ("in case I got it wrong").
  const [armedTeam, setArmedTeam] = useState<ArmedTeam | null>(null);
  // A specific empty slot (group + position) armed by clicking its card,
  // awaiting a team click to complete the pairing in one step — no
  // separate "pick a group" then "pick a position" stages.
  const [armedSlot, setArmedSlot] = useState<ArmedSlot | null>(null);
  // Filled slots are locked (greyed, not clickable) by default so a live
  // on-air draw can't be bumped by a stray click — Edit unlocks them so a
  // mistake can be cleared with a click instead of hunting through Assignments.
  const [editMode, setEditMode] = useState(false);
  // Once a team is already placed in a group, it's still pickable in the
  // pot lists by default (lets you re-pick/move it). Turn this on to hide
  // already-placed teams there instead, so the picker only shows who's
  // still left to draw.
  const [hideAssignedTeams, setHideAssignedTeams] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupPrefix, setNewGroupPrefix] = useState('');
  const [newGroupCapacity, setNewGroupCapacity] = useState('');
  const [newGroupCategory, setNewGroupCategory] = useState('');
  const [newPotName, setNewPotName] = useState('');
  const [vmixCfgOpen, setVmixCfgOpen] = useState(false);
  // Bulk-edit selection for the Assignments table — apply a Pot/Group to
  // every selected team at once instead of one dropdown at a time.
  const [assignSelectedIds, setAssignSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPot, setBulkPot] = useState('');
  const [bulkGroup, setBulkGroup] = useState('');
  const toggleAssignSelected = (id: string) => setAssignSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const applyBulkPot = () => {
    if (assignSelectedIds.size === 0 || !bulkPot) return;
    for (const id of assignSelectedIds) updateTeam(id, { pot: bulkPot === '__clear__' ? undefined : bulkPot });
    setBulkPot('');
  };
  const applyBulkGroup = () => {
    if (assignSelectedIds.size === 0 || !bulkGroup) return;
    for (const id of assignSelectedIds) updateTeam(id, { group: bulkGroup === '__clear__' ? undefined : bulkGroup, groupPosition: undefined });
    setBulkGroup('');
  };
  // Group/pot names are static text by default (renaming needs to cascade
  // to every team + vMix target referencing them) — Edit unlocks renaming.
  const [setupEditMode, setSetupEditMode] = useState(false);
  // Drag a group chip/card onto another to reorder — reordered within the
  // full unfiltered list so groups from other categories keep their spot.
  const [draggedGroup, setDraggedGroup] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const reorderGroups = (draggedName: string, targetName: string) => {
    if (draggedName === targetName) return;
    const next = [...allGroups];
    const from = next.findIndex(g => g.name === draggedName);
    const to = next.findIndex(g => g.name === targetName);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateTournament(tournament.id, { groups: next });
  };


  const addGroup = () => {
    const name = newGroupName.trim();
    if (!name || allGroups.some(g => g.name === name)) return;
    const prefix = newGroupPrefix.trim() || name.charAt(0).toUpperCase();
    const capacity = newGroupCapacity.trim() ? Number(newGroupCapacity) : undefined;
    const category = newGroupCategory || activeCategory || undefined;
    updateTournament(tournament.id, { groups: [...allGroups, { name, prefix, capacity, category }] });
    setNewGroupName('');
    setNewGroupPrefix('');
    setNewGroupCapacity('');
    setNewGroupCategory('');
  };

  const updateGroupDef = (name: string, patch: Partial<TournamentGroup>) => {
    updateTournament(tournament.id, { groups: allGroups.map(g => g.name === name ? { ...g, ...patch } : g) });
  };

  const removeGroup = (name: string) => {
    updateTournament(tournament.id, { groups: allGroups.filter(g => g.name !== name) });
    for (const t of teams) {
      if (t.group === name) updateTeam(t.id, { group: undefined });
    }
  };

  // Renames a group and cascades the new name to every team's `group` field
  // and any "Group List → vMix" targets pointing at it — both store the
  // group by name, so a plain field edit would silently break those links.
  const renameGroup = (oldName: string, newName: string) => {
    const name = newName.trim();
    if (!name || name === oldName || allGroups.some(g => g.name === name)) return;
    updateTournament(tournament.id, {
      groups: allGroups.map(g => g.name === oldName ? { ...g, name } : g),
      groupListVmix: groupListTargets.map(t => t.group === oldName ? { ...t, group: name } : t),
    });
    for (const t of allTeams) {
      if (t.tournamentId === tournament.id && t.group === oldName) updateTeam(t.id, { group: name });
    }
  };

  const addPot = () => {
    const name = newPotName.trim();
    if (!name || allPots.some(p => p.name === name)) return;
    updateTournament(tournament.id, { pots: [...allPots, { name, category: activeCategory || undefined }] });
    setNewPotName('');
  };

  const removePot = (name: string) => {
    updateTournament(tournament.id, { pots: allPots.filter(p => p.name !== name) });
    for (const t of teams) {
      if (t.pot === name) updateTeam(t.id, { pot: undefined });
    }
  };

  // Renames a pot and cascades the new name to every team's `pot` field.
  const renamePot = (oldName: string, newName: string) => {
    const name = newName.trim();
    if (!name || name === oldName || allPots.some(p => p.name === name)) return;
    updateTournament(tournament.id, { pots: allPots.map(p => p.name === oldName ? { ...p, name } : p) });
    for (const t of allTeams) {
      if (t.tournamentId === tournament.id && t.pot === oldName) updateTeam(t.id, { pot: name });
    }
  };

  const setDrawCfg = (patch: Partial<NonNullable<Tournament['drawVmix']>>) =>
    updateTournament(tournament.id, { drawVmix: { ...drawCfg, ...patch } });

  const pushDrawToVmix = (team: SavedTeam, pot: string, group?: string) => {
    if (!client || !drawCfg.inputKey) return;
    if (drawCfg.fieldTeamName) client.setTextField(drawCfg.inputKey, drawCfg.fieldTeamName, team.name);
    if (drawCfg.fieldTeamShort) client.setTextField(drawCfg.inputKey, drawCfg.fieldTeamShort, team.shortName ?? '');
    if (drawCfg.fieldPot) client.setTextField(drawCfg.inputKey, drawCfg.fieldPot, pot);
    if (group && drawCfg.fieldGroup) client.setTextField(drawCfg.inputKey, drawCfg.fieldGroup, group);
    // Push a transparent placeholder when the team has no logo, rather than
    // skipping the field and leaving whatever image was there before.
    if (drawCfg.fieldTeamLogo) client.setImageField(drawCfg.inputKey, drawCfg.fieldTeamLogo, team.logo || transparentLogoUrl());
  };

  // Group-list pushes: whole-group team lists to numbered vMix fields, one
  // target per on-air "Group A" style title.
  const groupListTargets = tournament.groupListVmix ?? [];
  const setGroupListTargets = (next: GroupListVmixTarget[]) => updateTournament(tournament.id, { groupListVmix: next });
  const updateGroupListTarget = (id: string, patch: Partial<GroupListVmixTarget>) =>
    setGroupListTargets(groupListTargets.map(t => t.id === id ? { ...t, ...patch } : t));

  // Same numbered-prefix pattern as the Player List widget's vMix Name Sync:
  // type/pick a sample field like "Team1.Text" or "Logo1.Source" and the
  // trailing digit + suffix is stripped, leaving a reusable prefix for
  // every slot.
  const derivePrefix = (v: string) => v.replace(/\.(Text|Source)$/i, '').replace(/\d+$/, '');

  const pushGroupListToVmix = (target: GroupListVmixTarget) => {
    if (!client || !target.inputKey) return;
    const g = groups.find(gr => gr.name === target.group);
    const members = teams.filter(t => t.group === target.group);
    const { slots } = resolveGroupSlots(members, g?.capacity);
    for (let i = 0; i < slots.length; i++) {
      const t = slots[i];
      if (target.fieldPrefix) client.setTextField(target.inputKey, `${target.fieldPrefix}${i + 1}.Text`, t ? t.name : '');
      if (target.fieldShortPrefix) client.setTextField(target.inputKey, `${target.fieldShortPrefix}${i + 1}.Text`, t ? (t.shortName ?? '') : '');
      if (target.fieldLogoPrefix) client.setImageField(target.inputKey, `${target.fieldLogoPrefix}${i + 1}.Source`, (t?.logo) || transparentLogoUrl());
    }
  };

  // Auto-push whenever the relevant group's membership actually changes
  // (not on every unrelated render) for any target with autoSync on.
  const groupMembershipKey = teams.map(t => `${t.id}:${t.group ?? ''}`).sort().join(',');
  useEffect(() => {
    for (const target of groupListTargets) {
      if (target.autoSync && target.group && target.inputKey) pushGroupListToVmix(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupMembershipKey, JSON.stringify(groupListTargets), client]);

  // Live Sync (remote 9877 only): auto-push to the host a moment after any
  // draw-relevant change, so the host (and everyone watching its broadcast)
  // sees the draw happen live instead of waiting for a manual "Save to Host".
  // Fingerprinted across ALL of this tournament's teams (not just the
  // current category tab) so a switch of tabs doesn't miss a pending change.
  const allTournamentTeams = useMemo(
    () => allTeams.filter(t => t.tournamentId === tournament.id),
    [allTeams, tournament.id]
  );
  const drawSyncFingerprint = allTournamentTeams
    .map(t => `${t.id}:${t.pot ?? ''}:${t.group ?? ''}:${t.groupPosition ?? ''}`)
    .sort().join(',') + '|' + JSON.stringify(allGroups) + '|' + JSON.stringify(allPots);
  useEffect(() => {
    if (!liveSyncDraw || !isRemoteInteractive) return;
    const timer = setTimeout(() => pushTournamentDataToHost(), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawSyncFingerprint, liveSyncDraw, isRemoteInteractive]);

  // First pot (in order) that still has an undrawn (no group yet) team —
  // only used to target the random "Draw Next" button, not to restrict
  // manual clicking (any team/group can be picked or repicked any time).
  const currentPot = pots.find(p => teams.some(t => t.pot === p.name && !t.group))?.name;
  const groupIsFull = (g: TournamentGroup) => g.capacity != null && teams.filter(t => t.group === g.name).length >= g.capacity;
  const hasOpenGroup = groups.some(g => !groupIsFull(g));
  const canDraw = !!currentPot && groups.length > 0 && hasOpenGroup;

  const drawTeamMode = tournament.drawTeamMode ?? 'random';

  // A team can only land in a group that's untagged (shared) or tagged for
  // that team's own category — never a group belonging to a DIFFERENT
  // category, even when viewing "All".
  const categoryMismatch = (team: SavedTeam, group: string) => {
    const g = allGroups.find(gr => gr.name === group);
    return !!(g?.category && team.category && g.category !== team.category);
  };

  const finalizeAssignment = (team: SavedTeam, pot: string, group: string, position: number) => {
    if (categoryMismatch(team, group)) { setArmedTeam(null); setArmedSlot(null); return; }
    updateTeam(team.id, { group, groupPosition: position });
    setLastDrawn({ team, pot, group });
    pushDrawToVmix(team, pot, group);
    setArmedTeam(null);
    setArmedSlot(null);
  };

  // Clicking a team card — works for any team, drawn or not, in any pot, so
  // an existing assignment can always be picked up and moved elsewhere. A
  // group+position slot is never auto-picked — it always waits for a
  // manual slot click. Once a slot is already armed, though, only an
  // undrawn team can fill it this way — an already-placed team has to be
  // freed first (Edit mode / Assignments) rather than silently re-picked.
  const handleTeamClick = (team: SavedTeam, pot: string) => {
    if (armedSlot) {
      if (team.group || categoryMismatch(team, armedSlot.group)) return;
      finalizeAssignment(team, pot, armedSlot.group, armedSlot.position);
      return;
    }
    if (armedTeam?.team.id === team.id) { setArmedTeam(null); return; }
    setArmedTeam({ team, pot });
    pushDrawToVmix(team, pot);
  };

  // Clicking an empty slot card inside a group — works whether or not a
  // team is armed yet, so the slot can be picked first. Either way, one
  // click on an empty slot both assigns the group AND the position.
  const handleSlotClick = (group: string, position: number) => {
    if (armedTeam) {
      finalizeAssignment(armedTeam.team, armedTeam.pot, group, position);
      return;
    }
    setArmedSlot(prev => (prev && prev.group === group && prev.position === position) ? null : { group, position });
  };

  const drawNext = () => {
    if (!currentPot || !hasOpenGroup) return;
    const undrawn = teams.filter(t => t.pot === currentPot && !t.group);
    if (undrawn.length === 0 || groups.length === 0) return;
    const team = undrawn[Math.floor(Math.random() * undrawn.length)];
    if (armedSlot) finalizeAssignment(team, currentPot, armedSlot.group, armedSlot.position);
    else { setArmedTeam({ team, pot: currentPot }); pushDrawToVmix(team, currentPot); }
  };

  const resetDraw = () => {
    for (const t of teams) {
      if (t.pot) updateTeam(t.id, { group: undefined, groupPosition: undefined });
    }
    setLastDrawn(null);
    setArmedTeam(null);
    setArmedSlot(null);
  };

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {categories.length > 0 && (
        <div className="tm-draw-section">
          <div className="tm-draw-section-title">🏷️ Category — each runs its own draw</div>
          <div className="tm-draw-group-cards">
            <div
              className={`tm-draw-group-card tm-draw-group-card--pickable${!activeCategory ? ' tm-draw-group-card--armed' : ''}`}
              onClick={() => setActiveCategory('')}
            >
              <div className="tm-draw-group-card-title">All</div>
            </div>
            {categories.map(c => (
              <div
                key={c}
                className={`tm-draw-group-card tm-draw-group-card--pickable${activeCategory === c ? ' tm-draw-group-card--armed' : ''}`}
                onClick={() => setActiveCategory(c)}
              >
                <div className="tm-draw-group-card-title">{c}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isRemoteInteractive && (
        <div className="tm-draw-vmix-cfg">
          <button
            className={`tm-io-btn${liveSyncDraw ? ' tm-io-btn--active' : ''}`}
            title="Auto-push every draw change to the host as it happens, instead of needing a manual Save to Host"
            onClick={() => setLiveSyncDraw(!liveSyncDraw)}
          >{liveSyncDraw ? '🔴 Live Sync: On' : '⚪ Live Sync: Off'}</button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {liveSyncDraw ? 'Every draw change is pushed to the host automatically.' : 'Turn on to auto-push draw changes to the host as you make them.'}
          </span>
        </div>
      )}

      <div className="tm-draw-group-tabs">
        <button
          className={`tm-draw-group-tab${drawSubTab === 'live' ? ' tm-draw-group-tab--active' : ''}`}
          onClick={() => setDrawSubTab('live')}
        >🎬 Live Draw</button>
        <button
          className={`tm-draw-group-tab${drawSubTab === 'settings' ? ' tm-draw-group-tab--active' : ''}`}
          onClick={() => setDrawSubTab('settings')}
        >⚙️ Settings</button>
      </div>

      {drawSubTab === 'settings' && (
      <>
      <div className="tm-draw-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="tm-draw-section-title">⚙️ Setup — Groups &amp; Pots</div>
        <button
          className={`tm-io-btn${setupEditMode ? ' tm-io-btn--active' : ''}`}
          style={{ flex: 'none' }}
          title="Unlock renaming group/pot names"
          onClick={() => setSetupEditMode(e => !e)}
        >{setupEditMode ? '🔓 Editing' : '✏️ Edit'}</button>
      </div>
      <div className="tm-groups-bar">
        <span className="tm-groups-label">Pools/Groups:</span>
        {groups.map(g => {
          const count = teams.filter(t => t.group === g.name).length;
          return (
            <span
              key={g.name}
              className={`tm-group-chip tm-group-chip--editable${dragOverGroup === g.name ? ' tm-draw-group-card--drag-over' : ''}`}
              draggable={!setupEditMode}
              title={setupEditMode ? undefined : 'Drag to reorder'}
              onDragStart={() => setDraggedGroup(g.name)}
              onDragOver={e => { e.preventDefault(); setDragOverGroup(g.name); }}
              onDragLeave={() => setDragOverGroup(prev => prev === g.name ? null : prev)}
              onDrop={e => { e.preventDefault(); if (draggedGroup) reorderGroups(draggedGroup, g.name); setDraggedGroup(null); setDragOverGroup(null); }}
              onDragEnd={() => { setDraggedGroup(null); setDragOverGroup(null); }}
              style={{ cursor: setupEditMode ? 'default' : 'grab' }}
            >
              {setupEditMode ? (
                <input
                  className="tm-group-chip-input"
                  defaultValue={g.name}
                  style={{ width: 90, fontWeight: 700 }}
                  title="Rename group"
                  onClick={e => e.stopPropagation()}
                  onBlur={e => renameGroup(g.name, e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              ) : g.name}
              <input
                className="tm-group-chip-input"
                value={g.prefix ?? ''}
                placeholder="Px"
                title="Prefix used for each team's position label in this group (e.g. A → A1, A2…)"
                onChange={e => updateGroupDef(g.name, { prefix: e.target.value })}
              />
              <input
                className="tm-group-chip-input"
                type="number"
                min={0}
                value={g.capacity ?? ''}
                placeholder="Max"
                title="Max teams allowed in this group (blank = unlimited)"
                onChange={e => updateGroupDef(g.name, { capacity: e.target.value ? Number(e.target.value) : undefined })}
              />
              {g.capacity != null && <span className="tm-group-chip-count">{count}/{g.capacity}</span>}
              <button onClick={() => removeGroup(g.name)} title={`Remove ${g.name} (unassigns any teams in it)`}>×</button>
            </span>
          );
        })}
        <input
          className="tm-input tm-groups-add-input"
          placeholder="New group name"
          value={newGroupName}
          onChange={e => setNewGroupName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addGroup(); }}
          style={{ width: 110 }}
        />
        <input
          className="tm-input tm-groups-add-input"
          placeholder="Prefix"
          value={newGroupPrefix}
          onChange={e => setNewGroupPrefix(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addGroup(); }}
          style={{ width: 50 }}
        />
        <input
          className="tm-input tm-groups-add-input"
          type="number"
          min={0}
          placeholder="Max"
          value={newGroupCapacity}
          onChange={e => setNewGroupCapacity(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addGroup(); }}
          style={{ width: 50 }}
        />
        {categories.length > 0 && (
          <select
            className="tm-input"
            value={newGroupCategory}
            onChange={e => setNewGroupCategory(e.target.value)}
            title="Which category this new group belongs to (blank = current tab)"
            style={{ width: 110 }}
          >
            <option value="">{activeCategory ? `— ${activeCategory} (tab) —` : '— no category —'}</option>
            {categories.filter(c => c !== activeCategory).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <button className="tm-io-btn" onClick={addGroup} disabled={!newGroupName.trim()}>+ Add Group</button>
      </div>
      <div className="tm-groups-bar" style={{ marginTop: -6 }}>
        <span className="tm-groups-label">Draw Pots:</span>
        {pots.map(p => (
          <span key={p.name} className="tm-group-chip tm-group-chip--pot">
            {setupEditMode ? (
              <input
                className="tm-group-chip-input"
                defaultValue={p.name}
                style={{ width: 90, fontWeight: 700 }}
                title="Rename pot"
                onBlur={e => renamePot(p.name, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            ) : p.name}
            <button onClick={() => removePot(p.name)} title={`Remove ${p.name} (unassigns any teams in it)`}>×</button>
          </span>
        ))}
        <input
          className="tm-input tm-groups-add-input"
          placeholder="New pot name"
          value={newPotName}
          onChange={e => setNewPotName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addPot(); }}
        />
        <button className="tm-io-btn" onClick={addPot} disabled={!newPotName.trim()}>+ Add Pot</button>
      </div>
      </div>

      {teams.length > 0 && (
        <div className="tm-draw-section">
          <div className="tm-draw-section-title">📋 Assignments</div>

          {assignSelectedIds.size > 0 && (
            <div className="tm-draw-vmix-cfg">
              <span className="tm-groups-label">{assignSelectedIds.size} selected —</span>
              <select className="tm-input" value={bulkPot} onChange={e => setBulkPot(e.target.value)} style={{ width: 140 }}>
                <option value="">— pick pot —</option>
                {pots.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                <option value="__clear__">— No Pot —</option>
              </select>
              <button className="tm-io-btn" onClick={applyBulkPot} disabled={!bulkPot}>Apply Pot</button>
              <select className="tm-input" value={bulkGroup} onChange={e => setBulkGroup(e.target.value)} style={{ width: 140 }}>
                <option value="">— pick group —</option>
                {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                <option value="__clear__">— No Group —</option>
              </select>
              <button className="tm-io-btn" onClick={applyBulkGroup} disabled={!bulkGroup}>Apply Group</button>
              <button className="tm-io-btn" onClick={() => setAssignSelectedIds(new Set())}>Clear Selection</button>
            </div>
          )}

          {(categories.length > 0
            ? [...categories.map(c => ({ label: c, items: teams.filter(t => t.category === c) })), { label: 'Uncategorized', items: teams.filter(t => !t.category) }]
            : [{ label: null as string | null, items: teams }]
          ).map(section => (section.label && section.items.length === 0) ? null : (
            <div key={section.label ?? '__all__'} style={{ marginBottom: 12 }}>
              {section.label && <div className="tm-groups-label" style={{ display: 'block', marginBottom: 6 }}>{section.label}</div>}
              <div className="tm-draw-assign-table">
                <div className="tm-draw-assign-row tm-draw-assign-row--head" style={{ gridTemplateColumns: 'auto 2fr 1fr 1fr 1fr' }}>
                  <span></span><span>Team</span><span>Pot</span><span>Group</span><span>Position</span>
                </div>
                {section.items.map(t => {
                  const g = groups.find(gr => gr.name === t.group);
                  const members = teams.filter(t2 => t2.group === t.group);
                  const slotCount = g?.capacity ?? Math.max(members.length + 3, 8);
                  const prefix = g?.prefix || (t.group ?? '').charAt(0).toUpperCase();
                  return (
                    <div key={t.id} className="tm-draw-assign-row" style={{ gridTemplateColumns: 'auto 2fr 1fr 1fr 1fr' }}>
                      <input
                        type="checkbox"
                        checked={assignSelectedIds.has(t.id)}
                        onChange={() => toggleAssignSelected(t.id)}
                        title="Select for bulk pot/group change"
                      />
                      <span className="tm-draw-assign-team">
                        <div style={{ width: 22, height: 22, flexShrink: 0 }}><ScheduleBadge logo={t.logo} color={t.color} /></div>
                        {t.name}
                        {t.category && <span className="tm-team-cat-badge">{t.category}</span>}
                      </span>
                      <select
                        className="tm-sched-type-select"
                        title="Seeding pot for the live draw"
                        value={t.pot ?? ''}
                        onChange={e => updateTeam(t.id, { pot: e.target.value || undefined })}
                      >
                        <option value="">— No Pot —</option>
                        {pots.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                      </select>
                      <select
                        className="tm-sched-type-select"
                        title="Pool/group"
                        value={t.group ?? ''}
                        onChange={e => updateTeam(t.id, { group: e.target.value || undefined })}
                      >
                        <option value="">— No Group —</option>
                        {groups.map(gr => <option key={gr.name} value={gr.name}>{gr.name}</option>)}
                      </select>
                      {t.group ? (
                        <select
                          className="tm-sched-type-select"
                          title="Slot position within this group"
                          value={t.groupPosition ?? ''}
                          onChange={e => updateTeam(t.id, { groupPosition: e.target.value ? Number(e.target.value) : undefined })}
                        >
                          <option value="">— No Position —</option>
                          {Array.from({ length: slotCount }, (_, i) => i + 1).map(n => {
                            const takenBy = members.find(t2 => t2.id !== t.id && t2.groupPosition === n);
                            return (
                              <option key={n} value={n}>{prefix}{n}{takenBy ? ` (clash: ${takenBy.name})` : ''}</option>
                            );
                          })}
                        </select>
                      ) : <span />}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      </>
      )}

      {drawSubTab === 'live' && (
      <>
      {groups.length > 0 && (
        <div className="tm-draw-section">
          <div className="tm-draw-section-title">🏁 Final Group List</div>
          {(categories.length > 0
            ? [...categories.map(c => ({ label: c, items: groups.filter(g => g.category === c) })), { label: 'Uncategorized', items: groups.filter(g => !g.category) }]
            : [{ label: null as string | null, items: groups }]
          ).map(section => (section.label && section.items.length === 0) ? null : (
            <div key={section.label ?? '__all__'} style={{ marginBottom: 12 }}>
              {section.label && <div className="tm-groups-label" style={{ display: 'block', marginBottom: 6 }}>{section.label}</div>}
              <div className="tm-draw-group-cards">
                {section.items.map(g => {
                  const members = teams.filter(t => t.group === g.name);
                  const slotCount = g.capacity ?? Math.max(members.length + 3, 8);
                  const { slots } = resolveGroupSlots(members, g.capacity);
                  const prefix = g.prefix || g.name.charAt(0).toUpperCase();
                  return (
                    <div
                      key={g.name}
                      className={`tm-draw-pot-card${dragOverGroup === g.name ? ' tm-draw-group-card--drag-over' : ''}`}
                      draggable
                      title="Drag the card to reorder groups"
                      onDragStart={() => setDraggedGroup(g.name)}
                      onDragOver={e => { e.preventDefault(); setDragOverGroup(g.name); }}
                      onDragLeave={() => setDragOverGroup(prev => prev === g.name ? null : prev)}
                      onDrop={e => { e.preventDefault(); if (draggedGroup) reorderGroups(draggedGroup, g.name); setDraggedGroup(null); setDragOverGroup(null); }}
                      onDragEnd={() => { setDraggedGroup(null); setDragOverGroup(null); }}
                      style={{ cursor: 'grab' }}
                    >
                      <div className="tm-draw-pot-title">
                        {g.name.toUpperCase()}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {Array.from({ length: slotCount }, (_, i) => i + 1).map(n => {
                          const t = slots[n - 1];
                          return (
                            <div key={n} className="tm-draw-final-row">
                              <span className="tm-draw-final-pos">{prefix}{n}</span>
                              {t ? (
                                <>
                                  <div style={{ width: 24, height: 24, flexShrink: 0 }}><ScheduleBadge logo={t.logo} color={t.color} /></div>
                                  <span className="tm-draw-final-name">{t.name}</span>
                                </>
                              ) : (
                                <span className="tm-draw-final-name tm-draw-final-name--empty">— Empty —</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {pots.length === 0 || groups.length === 0 ? (
        <div className="tm-win-placeholder">
          <span>Add at least one Group and one Pot in the ⚙️ Settings tab, then assign each team to a pot there.</span>
        </div>
      ) : (
      <div className="tm-draw-section">
      <div className="tm-draw-section-title">🎬 Live Draw</div>
      <div className="tm-draw-vmix-cfg">
        <span className="tm-groups-label" title="'Manual' lets you click a team chip in the current pot to draw it yourself, instead of the system picking blindly">Team Draw:</span>
        <div className="tm-timer-mode-toggle">
          <button
            className={`tm-timer-mode-btn ${drawTeamMode === 'random' ? 'tm-timer-mode-btn--active' : ''}`}
            onClick={() => updateTournament(tournament.id, { drawTeamMode: 'random' })}
          >🎲 Random</button>
          <button
            className={`tm-timer-mode-btn ${drawTeamMode === 'manual' ? 'tm-timer-mode-btn--active' : ''}`}
            onClick={() => updateTournament(tournament.id, { drawTeamMode: 'manual' })}
          >✋ Manual (click team)</button>
        </div>
      </div>

      <div className="tm-draw-hero">
        {armedTeam ? (
          <>
            <div style={{ width: 56, height: 56, flexShrink: 0 }}>
              <ScheduleBadge logo={armedTeam.team.logo} color={armedTeam.team.color} />
            </div>
            <div className="tm-draw-hero-info">
              <span className="tm-draw-hero-name">{armedTeam.team.name}</span>
              <span className="tm-draw-hero-detail">⏳ Pick a group below…</span>
            </div>
          </>
        ) : armedSlot ? (
          <div className="tm-draw-hero-info">
            <span className="tm-draw-hero-name">{armedSlot.group} — {(groups.find(g => g.name === armedSlot.group)?.prefix || armedSlot.group.charAt(0).toUpperCase())}{armedSlot.position}</span>
            <span className="tm-draw-hero-detail">⏳ Pick a team below…</span>
          </div>
        ) : lastDrawn ? (
          <>
            <div style={{ width: 56, height: 56, flexShrink: 0 }}>
              <ScheduleBadge logo={lastDrawn.team.logo} color={lastDrawn.team.color} />
            </div>
            <div className="tm-draw-hero-info">
              <span className="tm-draw-hero-name">{lastDrawn.team.name}</span>
              <span className="tm-draw-hero-detail">{lastDrawn.pot} → {lastDrawn.group}</span>
            </div>
          </>
        ) : (
          <span className="tm-draw-hero-empty">No team drawn yet</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {drawTeamMode === 'manual' ? (
          <div className="tm-draw-manual-hint" style={{ flex: 1 }}>
            {armedTeam ? '⏳ Pick a slot below' : armedSlot ? `⏳ Pick a team below for ${armedSlot.group}` : '👆 Click any team or empty slot to pair them — pick either first, click again to cancel'}
          </div>
        ) : (
          <button className="tm-sidebar-new-btn" onClick={drawNext} disabled={!canDraw && !armedSlot} style={{ flex: 1 }}>
            {armedSlot ? `🎲 Draw Next → ${armedSlot.group}` : canDraw ? `🎲 Draw Next (${currentPot})` : '🎉 Draw Complete'}
          </button>
        )}
        <button
          className={`tm-io-btn${editMode ? ' tm-io-btn--active' : ''}`}
          title="Unlock filled slots so a mistake can be cleared with a click"
          onClick={() => setEditMode(e => !e)}
        >{editMode ? '🔓 Editing' : '✏️ Edit'}</button>
        <button
          className={`tm-io-btn${hideAssignedTeams ? ' tm-io-btn--active' : ''}`}
          title="Hide already-placed teams from the pot lists below, instead of leaving them pickable to re-draw/move"
          onClick={() => setHideAssignedTeams(v => !v)}
        >{hideAssignedTeams ? '🙈 Hiding Placed' : '👁 Show All'}</button>
        <ConfirmButton
          className="tm-io-btn"
          label="↺ Reset Draw"
          confirmLabel="Reset"
          message="Clear every team's group assignment from this draw?"
          onConfirm={resetDraw}
        />
      </div>

      {(categories.length > 0
        ? [...categories.map(c => ({ label: c, items: groups.filter(g => g.category === c) })), { label: 'Uncategorized', items: groups.filter(g => !g.category) }]
        : [{ label: null as string | null, items: groups }]
      ).map(section => (section.label && section.items.length === 0) ? null : (
        <div key={section.label ?? '__all__'}>
          {section.label && <div className="tm-groups-label" style={{ display: 'block', marginBottom: 6 }}>{section.label}</div>}
          <div className="tm-draw-group-cards">
            {section.items.map(g => {
              const members = teams.filter(t => t.group === g.name);
              const full = groupIsFull(g);
              const slotCount = g.capacity ?? Math.max(members.length + 3, 8);
              const { slots } = resolveGroupSlots(members, g.capacity);
              const prefix = g.prefix || g.name.charAt(0).toUpperCase();
              return (
                <div
                  key={g.name}
                  className={`tm-draw-group-card${full ? ' tm-draw-group-card--full' : ''}${dragOverGroup === g.name ? ' tm-draw-group-card--drag-over' : ''}`}
                  draggable
                  title="Drag the card to reorder groups"
                  onDragStart={() => setDraggedGroup(g.name)}
                  onDragOver={e => { e.preventDefault(); setDragOverGroup(g.name); }}
                  onDragLeave={() => setDragOverGroup(prev => prev === g.name ? null : prev)}
                  onDrop={e => { e.preventDefault(); if (draggedGroup) reorderGroups(draggedGroup, g.name); setDraggedGroup(null); setDragOverGroup(null); }}
                  onDragEnd={() => { setDraggedGroup(null); setDragOverGroup(null); }}
                  style={{ cursor: 'grab' }}
                >
                  <div className="tm-draw-group-card-title">
                    {g.name}{g.capacity != null ? ` (${members.length}/${g.capacity})` : ''}
                  </div>
                  <div className="tm-draw-slot-grid">
                    {Array.from({ length: slotCount }, (_, i) => i + 1).map(n => {
                      const occupant = slots[n - 1];
                      const armed = armedSlot?.group === g.name && armedSlot.position === n;
                      // An armed team can't drop into a slot whose group belongs
                      // to a different category.
                      const blocked = !occupant && !!armedTeam && categoryMismatch(armedTeam.team, g.name);
                      const clickable = (!occupant && !blocked) || editMode;
                      return (
                        <div
                          key={n}
                          className={`tm-draw-slot-card${occupant ? ' tm-draw-slot-card--filled' : blocked ? ' tm-draw-slot-card--filled' : ' tm-draw-slot-card--pickable'}${armed ? ' tm-draw-slot-card--armed' : ''}${occupant && editMode ? ' tm-draw-slot-card--editable' : ''}`}
                          title={occupant ? (editMode ? `Click to remove ${occupant.name}` : occupant.category ? `Category: ${occupant.category}` : undefined) : blocked ? 'Not pickable for the armed team’s category' : undefined}
                          onClick={clickable ? () => (occupant ? updateTeam(occupant.id, { group: undefined, groupPosition: undefined }) : handleSlotClick(g.name, n)) : undefined}
                        >
                          <span className="tm-draw-slot-card-label">{prefix}{n}</span>
                          {occupant && <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={occupant.logo} color={occupant.color} /></div>}
                          <span className="tm-draw-slot-card-team">{occupant ? (occupant.shortName || occupant.name) : 'Empty'}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {pots.map(p => {
        const potTeamsAll = teams.filter(t => t.pot === p.name);
        const potTeams = hideAssignedTeams ? potTeamsAll.filter(t => !t.group) : potTeamsAll;
        return (
          <div key={p.name} className="tm-draw-pot-card">
            <div className="tm-draw-pot-title">{p.name}{p.name === currentPot ? ' — drawing now' : ''}</div>
            <div className="tm-draw-group-cards">
              {potTeamsAll.length === 0 ? (
                <span className="tm-draw-pot-empty">No teams assigned to this pot</span>
              ) : potTeams.length === 0 ? (
                <span className="tm-draw-pot-empty">All teams in this pot are already placed</span>
              ) : potTeams.map(t => {
                const armed = armedTeam?.team.id === t.id;
                // Once a slot is armed, only an undrawn, category-matching
                // team can fill it via this tile.
                const blocked = !!armedSlot && (!!t.group || categoryMismatch(t, armedSlot.group));
                return (
                  <div
                    key={t.id}
                    className={`tm-draw-group-card tm-draw-team-card${t.group ? ' tm-draw-team-card--drawn' : ''}${blocked ? ' tm-draw-group-card--full' : ' tm-draw-group-card--pickable'}${armed ? ' tm-draw-group-card--armed' : ''}`}
                    title={blocked ? 'Not pickable for the armed slot' : t.category ? `Category: ${t.category}` : undefined}
                    onClick={blocked ? undefined : () => handleTeamClick(t, p.name)}
                  >
                    <div style={{ width: 32, height: 32, flexShrink: 0 }}><ScheduleBadge logo={t.logo} color={t.color} /></div>
                    <span className="tm-draw-group-card-title">{t.name}</span>
                    {t.category && <span className="tm-team-cat-badge">{t.category}</span>}
                    {t.group && <span className="tm-draw-team-card-dest">→ {t.group}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      </div>
      )}

      <div className="tm-draw-section">
        <button className="tm-draw-section-toggle" onClick={() => setVmixCfgOpen(o => !o)}>
          <span className="tm-draw-section-title" style={{ margin: 0 }}>{vmixCfgOpen ? '▼' : '▶'} 📡 vMix Output</span>
        </button>
        {vmixCfgOpen && (
          <>
            <div className="tm-draw-vmix-cfg">
              <span className="tm-groups-label">Current draw (live, on each draw):</span>
              <div style={{ width: 220 }}>
                <InputPickerDropdown
                  currentKey={drawCfg.inputKey ?? ''}
                  currentTitle={allVmixInputs.find(i => i.key === drawCfg.inputKey)?.title}
                  allInputs={allVmixInputs}
                  onSelect={key => setDrawCfg({ inputKey: key })}
                />
              </div>
              <input className="tm-input" placeholder="Team name field" value={drawCfg.fieldTeamName ?? ''}
                onChange={e => setDrawCfg({ fieldTeamName: e.target.value })} style={{ width: 120 }} />
              <input className="tm-input" placeholder="Short field" value={drawCfg.fieldTeamShort ?? ''}
                onChange={e => setDrawCfg({ fieldTeamShort: e.target.value })} style={{ width: 100 }} />
              <input className="tm-input" placeholder="Logo field" value={drawCfg.fieldTeamLogo ?? ''}
                onChange={e => setDrawCfg({ fieldTeamLogo: e.target.value })} style={{ width: 100 }} />
              <input className="tm-input" placeholder="Group field" value={drawCfg.fieldGroup ?? ''}
                onChange={e => setDrawCfg({ fieldGroup: e.target.value })} style={{ width: 100 }} />
              <input className="tm-input" placeholder="Pot field" value={drawCfg.fieldPot ?? ''}
                onChange={e => setDrawCfg({ fieldPot: e.target.value })} style={{ width: 100 }} />
            </div>

            <div className="tm-draw-vmix-cfg" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <span className="tm-groups-label">Group List (whole group, numbered fields):</span>
              {groupListTargets.map(target => (
                <div key={target.id} className="vil-cfg-block">
                  <div className="vil-cfg-header">
                    <select
                      className="tm-input"
                      value={target.group}
                      onChange={e => updateGroupListTarget(target.id, { group: e.target.value })}
                      style={{ flex: 1 }}
                    >
                      <option value="">— select group —</option>
                      {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                    </select>
                    <button className="btn btn--ghost btn--small" onClick={() => setGroupListTargets(groupListTargets.filter(t => t.id !== target.id))}>×</button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    <div style={{ width: 220 }}>
                      <InputPickerDropdown
                        currentKey={target.inputKey ?? ''}
                        currentTitle={allVmixInputs.find(i => i.key === target.inputKey)?.title}
                        allInputs={allVmixInputs}
                        onSelect={key => updateGroupListTarget(target.id, { inputKey: key })}
                      />
                    </div>
                    <input className="tm-input" placeholder="Pick e.g. Team1.Text → auto-prefix"
                      value={target.fieldPrefix ? `${target.fieldPrefix}1.Text` : ''}
                      onChange={e => updateGroupListTarget(target.id, { fieldPrefix: derivePrefix(e.target.value) })}
                      style={{ width: 190 }} />
                    <input className="tm-input" placeholder="Pick e.g. Short1.Text → auto-prefix"
                      value={target.fieldShortPrefix ? `${target.fieldShortPrefix}1.Text` : ''}
                      onChange={e => updateGroupListTarget(target.id, { fieldShortPrefix: derivePrefix(e.target.value) })}
                      style={{ width: 190 }} />
                    <input className="tm-input" placeholder="Pick e.g. Logo1.Source → auto-prefix"
                      value={target.fieldLogoPrefix ? `${target.fieldLogoPrefix}1.Source` : ''}
                      onChange={e => updateGroupListTarget(target.id, { fieldLogoPrefix: derivePrefix(e.target.value) })}
                      style={{ width: 190 }} />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                      <input type="checkbox" checked={target.autoSync ?? false} onChange={e => updateGroupListTarget(target.id, { autoSync: e.target.checked })} />
                      Auto-sync
                    </label>
                    <button className="tm-io-btn" onClick={() => pushGroupListToVmix(target)} disabled={!target.group || !target.inputKey}>📡 Push List</button>
                  </div>
                </div>
              ))}
              <button
                className="btn btn--ghost btn--small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => setGroupListTargets([...groupListTargets, { id: crypto.randomUUID(), group: groups[0]?.name ?? '', autoSync: false }])}
              >+ Add Group List Target</button>
            </div>
          </>
        )}
      </div>
      </>
      )}
    </div>
  );
}

// ── Small persistent tournament picker shown atop tournament-scoped tabs ──────
function TournamentScopeHeader({ tournaments, selectedId, onSelect }: {
  tournaments: Tournament[]; selectedId: string; onSelect: (id: string) => void;
}) {
  return (
    <div className="tm-scope-header">
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>🏆 Tournament:</span>
      <select className="tm-input" style={{ fontSize: 15, padding: '6px 10px', height: 34, maxWidth: 360, flex: 'none' }}
        value={selectedId} onChange={e => onSelect(e.target.value)}>
        {tournaments.length === 0 && <option value="">— none —</option>}
        {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </div>
  );
}

// ── Draggable window ──────────────────────────────────────────────────────────
const isHostClient = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function TournamentManager({ onClose }: Props) {
  const { tournaments, updateTournament, deleteTournament, setActiveTournament, defaultTournamentId, setDefaultTournament } = useTournamentStore();
  const { pages, updateWidgetConfig } = useCanvasStore();
  const { remoteEditMode, setRemoteEditMode } = useAppSettings();

  const handleSaveToHost = () => {
    pushTournamentDataToHost();
    setRemoteEditMode(false);
  };
  const handleDiscardAndResync = () => {
    setRemoteEditMode(false);
    syncClient.send({ type: 'REQUEST_STATE' });
  };

  // Window position (drag)
  const [pos, setPos] = useState(() => ({
    x: Math.max(20, Math.round(window.innerWidth / 2 - 520)),
    y: Math.max(20, Math.round(window.innerHeight / 2 - 330)),
  }));
  const dragRef = useRef({ active: false, ox: 0, oy: 0, ix: 0, iy: 0 });
  const [isMaximized, setIsMaximized] = useState(false);

  const startDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isMaximized) return;
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

  const [selectedId, setSelectedId] = useState(
    (defaultTournamentId && tournaments.some(t => t.id === defaultTournamentId)) ? defaultTournamentId : (tournaments[0]?.id ?? '')
  );
  const [addingNew, setAddingNew] = useState(tournaments.length === 0);
  const [editTournName, setEditTournName] = useState(false);
  const [tournNameVal, setTournNameVal] = useState('');
  const [confirmDeleteTournament, setConfirmDeleteTournament] = useState(false);
  const [applyStatus, setApplyStatus] = useState('');
  const [tab, setTab] = useState<'tournaments' | 'teams' | 'players' | 'schedule' | 'results' | 'standings' | 'draw'>('tournaments');
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
    setConfirmDeleteTournament(false);
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
      {/* Subtle backdrop — no longer closes on click (that bypassed
          confirmation); the × button is the only way to close now. */}
      <div className="tm-backdrop" />

      {/* Floating window */}
      <div
        className={`tm-window${isMaximized ? ' tm-window--maximized' : ''}`}
        style={isMaximized ? undefined : { left: pos.x, top: pos.y }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="tm-titlebar" onMouseDown={startDrag} onDoubleClick={() => setIsMaximized(m => !m)}>
          <span className="tm-titlebar-icon">🏆</span>
          <span className="tm-titlebar-title">Tournament Database</span>
          <div className="tm-win-ctrls">
            <button
              className="tm-win-ctrl"
              onClick={() => setIsMaximized(m => !m)}
              title={isMaximized ? 'Restore' : 'Maximize'}
            >{isMaximized ? '🗗' : '⛶'}</button>
            <ConfirmButton
              className="tm-win-ctrl tm-win-ctrl--close"
              label="×"
              confirmLabel="Close"
              message="Close this window?"
              onConfirm={onClose}
            />
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
          <button
            onClick={() => setTab('standings')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'standings' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'standings' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >🏅 Standings</button>
          <button
            onClick={() => setTab('draw')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'draw' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'draw' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >🎲 Draw</button>
        </div>

        {/* Remote-only (not host, not the deliberately view-only readonly client):
            local edits don't sync live — must be explicitly pushed */}
        {!isHostClient && !syncClient.isReadOnly && (
          <div className="tm-remote-edit-bar">
            {remoteEditMode ? (
              <>
                <span className="tm-remote-edit-status tm-remote-edit-status--editing">✏️ Editing locally — not synced to host yet</span>
                <button className="tm-io-btn tm-io-btn--ok" onClick={handleSaveToHost}>💾 Save to Host</button>
                <button className="tm-io-btn" onClick={handleDiscardAndResync}>↩ Discard &amp; Resync</button>
              </>
            ) : (
              <>
                <span className="tm-remote-edit-status">🔒 Live view — synced from host</span>
                <button className="tm-io-btn" onClick={() => setRemoteEditMode(true)}>✏️ Edit</button>
              </>
            )}
          </div>
        )}

        {/* Main area */}
        {tab === 'teams' || tab === 'players' || tab === 'schedule' || tab === 'results' || tab === 'standings' || tab === 'draw' ? (
          <div className="tm-win-body--scoped">
            <TournamentScopeHeader tournaments={tournaments} selectedId={selectedId} onSelect={selectTournament} />
            {!selected ? (
              <div className="tm-win-placeholder">
                <span>Create a tournament first in the 🏆 Tournaments tab.</span>
              </div>
            ) : tab === 'teams' ? (
              <TeamsPanel tournament={selected} />
            ) : tab === 'players' ? (
              <PlayersPanel tournamentId={selected.id} />
            ) : tab === 'schedule' ? (
              <SchedulePanel tournament={selected} />
            ) : tab === 'standings' ? (
              <StandingsPanel tournament={selected} />
            ) : tab === 'draw' ? (
              <DrawPanel tournament={selected} />
            ) : (
              <ResultsPanel tournament={selected} />
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
              <button
                className="tm-btn"
                title="Export every tournament and all related data (teams, rosters, schedules, results) as one JSON file"
                onClick={() => exportProjectJSON(tournaments, selectedId, teams, scheduledMatches, savedResults)}
              >⬇ Export Project</button>
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
                    className="tm-btn"
                    title={defaultTournamentId === selected.id ? 'Unset as default (Tournament Database will open to the first tournament instead)' : 'Set as default — the Tournament Database opens to this tournament automatically'}
                    onClick={() => setDefaultTournament(selected.id)}
                  >{defaultTournamentId === selected.id ? '⭐ Default' : '☆ Set Default'}</button>
                  <button
                    className="tm-btn"
                    title="Export this tournament and everything related to it (teams, rosters, schedule, results) as a JSON file"
                    onClick={() => exportTournamentJSON(selected, scopedTeams, scopedMatches, scopedResults)}
                  >⬇ Export Tournament</button>
                  {confirmDeleteTournament ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Delete? Teams/fixtures/results stay saved.</span>
                      <button
                        className="tm-btn tm-btn--danger"
                        onClick={() => {
                          deleteTournament(selected.id);
                          const next = tournaments.find(t => t.id !== selected.id);
                          setSelectedId(next?.id ?? '');
                          if (!next) setAddingNew(false);
                          setConfirmDeleteTournament(false);
                        }}
                      >Confirm</button>
                      <button className="tm-btn" onClick={() => setConfirmDeleteTournament(false)}>Cancel</button>
                    </div>
                  ) : (
                    <button
                      className="tm-btn tm-btn--danger"
                      onClick={() => setConfirmDeleteTournament(true)}
                    >🗑 Delete</button>
                  )}
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
