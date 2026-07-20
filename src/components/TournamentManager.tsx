import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTournamentStore, pushTournamentDataToHost } from '../stores/tournamentStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { syncClient } from '../lib/syncClient';
import { useVmixStore } from '../stores/vmixStore';
import { ConfirmButton } from './ConfirmButton';
import { EventPicker } from './EventPicker';
import { useCanvasStore } from '../stores/canvasStore';
import type { Tournament, SportType, TournamentSettings, TournamentGroup, TournamentPot, GroupListVmixTarget } from '../types/tournament';
import { SPORT_LABELS, SPORT_POSITIONS, SPORT_DEFAULTS } from '../types/tournament';
import type { Player } from '../types/tournament';
import { LogoUrlPicker } from './LogoUrlPicker';
import { InputPickerDropdown } from './WidgetConfigPanel';
import {
  generateRoundRobin, generateDoubleRoundRobin, generateKnockout, generateKnockoutFromSlots,
  buildGroupKnockoutSlots, offsetRounds, shuffle, PLACEHOLDER_COLOR, type ScheduleTeamRef, type GeneratedFixture,
} from '../lib/scheduleGen';
import { useTeamDbStore, type SavedTeam } from '../stores/teamDbStore';
import { useMatchScheduleStore, type ScheduledMatch } from '../stores/matchScheduleStore';
import { useMatchResultsStore, type SavedMatchResult } from '../stores/matchResultsStore';
import { resolveImageUrl, transparentLogoUrl } from '../lib/imageUrl';
import { guardScoreboardOverwrite, buildLoadMatchPatch, useLiveFixtureIds } from '../utils/scoreboardSnapshot';

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
  const header = ['Date', 'Time', 'Team A', 'Team B', 'Venue', 'Category', 'Group', 'Round'];
  const rows = matches.map(m => [m.date, m.time ?? '', m.teamAName, m.teamBName, m.venue ?? '', m.category ?? '', m.group ?? '', m.round ?? '']);
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
  venue?: string; category?: string; group?: string; round?: string;
}

// Expected columns: Date (YYYY-MM-DD), Time, Team A, Team B, Venue, Category, Group, Round.
// Only Date + both team names are required; the rest may be left blank.
function parseFixtureFile(text: string): ParsedFixtureRow[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';

  const result: ParsedFixtureRow[] = [];
  for (const line of lines) {
    const cols = splitDelimitedRow(line, sep).map(c => c.replace(/^"|"$/g, '').trim());
    const [date = '', time = '', teamAName = '', teamBName = '', venue = '', category = '', group = '', round = ''] = cols;
    if (/^date$/i.test(date)) continue; // header row
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!teamAName || !teamBName) continue;
    result.push({
      date, time: time || undefined, teamAName, teamBName,
      venue: venue || undefined, category: category || undefined, group: group || undefined, round: round || undefined,
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
function PlayersPanel({ tournament, activeCategory }: { tournament: Tournament; activeCategory: string }) {
  const { teams: allTeams, addPlayer, updatePlayer, deletePlayer, replaceTeamPlayers } = useTeamDbStore();
  const tournamentId = tournament.id;
  const categories = tournament.categories ?? [];
  const teams = useMemo(() => allTeams.filter(t => t.tournamentId === tournamentId), [allTeams, tournamentId]);
  const teamSections = useMemo(() => {
    if (categories.length === 0) return [{ label: null as string | null, items: teams }];
    // A specific category is selected in the top bar — filter down to just it.
    if (activeCategory) return [{ label: null as string | null, items: teams.filter(t => t.category === activeCategory) }];
    return [...categories.map(c => ({ label: c, items: teams.filter(t => t.category === c) })), { label: 'Uncategorized', items: teams.filter(t => !t.category) }]
      .filter(section => section.items.length > 0);
  }, [teams, categories, activeCategory]);
  const visibleTeams = useMemo(() => teamSections.flatMap(s => s.items), [teamSections]);
  const [selectedTeamId, setSelectedTeamId] = useState(visibleTeams[0]?.id ?? '');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Re-picks the selected team whenever it falls out of view — either it was
  // deleted, or the top bar's category filter changed to one it's not in.
  useEffect(() => {
    if (!visibleTeams.find(t => t.id === selectedTeamId)) setSelectedTeamId(visibleTeams[0]?.id ?? '');
  }, [visibleTeams, selectedTeamId]);

  if (teams.length === 0) {
    return (
      <div className="tm-win-content" style={{ padding: 16 }}>
        <div className="tm-win-placeholder">
          <span>No teams in this tournament yet — add one in the 👥 Teams tab first, then manage its roster here.</span>
        </div>
      </div>
    );
  }

  if (visibleTeams.length === 0) {
    return (
      <div className="tm-win-content" style={{ padding: 16 }}>
        <div className="tm-win-placeholder">
          <span>No teams in the "{activeCategory}" category — pick a different one from the top bar, or add teams to it in the 👥 Teams tab.</span>
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
          {teamSections.map(section => (
            <div key={section.label ?? '__all__'}>
              {section.label && <div className="tm-sidebar-section-label">{section.label}</div>}
              {section.items.map(t => (
                <div
                  key={t.id}
                  className={`tm-tourn-item ${t.id === selectedTeamId ? 'tm-tourn-item--active' : ''}`}
                  onClick={() => setSelectedTeamId(t.id)}
                >
                  <span className="tm-tourn-sport-tag">{t.players.length} player{t.players.length !== 1 ? 's' : ''}</span>
                  <span className="tm-tourn-item-name">{t.name}</span>
                  {t.category && <span className="tm-tourn-item-category">{t.category}</span>}
                </div>
              ))}
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
              <div className="tm-team-name-wrap">
                <span className="tm-team-col-name">{team.name}</span>
                {team.category && <span className="tm-tourn-item-category">{team.category}</span>}
              </div>
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
export function normalizeGroups(groups: unknown): TournamentGroup[] {
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
  const { results, updateResult } = useMatchResultsStore();
  const teams = useMemo(() => allTeams.filter(t => t.tournamentId === tournamentId), [allTeams, tournamentId]);
  const categories = tournament.categories ?? [];
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryEditMode, setCategoryEditMode] = useState(false);
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

  // Renames a category and cascades the new name everywhere it's stored by
  // name — teams, draw groups/pots tagged to it, scheduled fixtures, and
  // saved results — since a plain rename-in-place would otherwise silently
  // orphan every team/fixture/result already tagged with the old name.
  const renameCategory = (oldName: string, newName: string) => {
    const name = newName.trim();
    if (!name || name === oldName || categories.includes(name)) return;
    updateTournament(tournamentId, {
      categories: categories.map(c => c === oldName ? name : c),
      groups: (tournament.groups ?? []).map(g => g.category === oldName ? { ...g, category: name } : g),
      pots: (tournament.pots ?? []).map(p => p.category === oldName ? { ...p, category: name } : p),
    });
    for (const t of teams) {
      if (t.category === oldName) updateTeam(t.id, { category: name });
    }
    for (const m of matches) {
      if (m.tournamentId === tournamentId && m.category === oldName) updateScheduleMatch(m.id, { category: name });
    }
    for (const r of results) {
      if (r.tournamentId === tournamentId && r.category === oldName) updateResult(r.id, { category: name });
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
      <div className="tm-groups-bar tm-groups-bar--lg">
        <span className="tm-groups-label tm-groups-label--lg">Categories:</span>
        {categories.map(c => (
          <span key={c} className="tm-group-chip tm-group-chip--lg">
            {categoryEditMode ? (
              <input
                className="tm-group-chip-input tm-group-chip-input--lg"
                defaultValue={c}
                title="Rename category"
                onClick={e => e.stopPropagation()}
                onBlur={e => renameCategory(c, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            ) : c}
            <button onClick={() => removeCategory(c)} title={`Remove ${c} (unassigns any teams in it)`}>×</button>
          </span>
        ))}
        <input
          className="tm-input tm-groups-add-input tm-groups-add-input--lg"
          placeholder="e.g. Men, Women, U21"
          value={newCategoryName}
          onChange={e => setNewCategoryName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addCategory(); }}
        />
        <button className="tm-io-btn" onClick={addCategory} disabled={!newCategoryName.trim()}>+ Add Category</button>
        {categories.length > 0 && (
          <button
            className={`tm-io-btn${categoryEditMode ? ' tm-io-btn--active' : ''}`}
            title="Rename existing categories"
            onClick={() => setCategoryEditMode(v => !v)}
          >{categoryEditMode ? '🔓 Editing' : '✏️ Edit'}</button>
        )}
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
function EditableText({ value, onChange, placeholder, className, disabled }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string; disabled?: boolean;
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
    <span
      className={`tm-sched-editable ${className ?? ''}`}
      onDoubleClick={disabled ? undefined : () => { setDraft(value); setEditing(true); }}
      title={disabled ? undefined : 'Double-click to edit'}
    >
      {value || <span className="tm-sched-placeholder">{placeholder}</span>}
    </span>
  );
}

function EditableDate({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
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
    <div className="tm-sched-date" onDoubleClick={disabled ? undefined : () => setEditing(true)} title={disabled ? undefined : 'Double-click to change date'}>
      <span className="tm-sched-date-num">{valid ? d!.getDate() : '—'}</span>
      <span className="tm-sched-date-dow">{valid ? d!.toLocaleDateString('en-US', { weekday: 'short' }) : ''}</span>
    </div>
  );
}

function EditableTime({ value, onChange, disabled }: { value?: string; onChange: (v: string) => void; disabled?: boolean }) {
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
    <div className="tm-sched-time" onDoubleClick={disabled ? undefined : () => setEditing(true)} title={disabled ? undefined : 'Double-click to change time'}>
      <span className="tm-sched-time-val">{formatTimeDisplay(value)}</span>
      <span className="tm-sched-time-tz">{value ? tz : ''}</span>
    </div>
  );
}

export function ScheduleBadge({ logo, color }: { logo?: string; color: string }) {
  return (
    <div className="tm-sched-badge" style={{ background: logo ? 'transparent' : color }}>
      {logo && <img src={resolveImageUrl(logo)} alt="" className="tm-sched-badge-img" draggable={false} />}
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

function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type ScheduleFormat = 'rr-single' | 'rr-double' | 'knockout' | 'groups-knockout';

const SCHEDULE_FORMAT_LABELS: Record<ScheduleFormat, string> = {
  'rr-single': 'Round Robin (Single)',
  'rr-double': 'Round Robin (Double / Home & Away)',
  'knockout': 'Knockout (Single Elimination)',
  'groups-knockout': 'Groups + Knockout',
};

// Auto-generates fixtures for the Schedule tab — reads groups/teams from the
// Draw tab (when present) so a tournament that's already been drawn doesn't
// need every fixture typed in by hand. Round-robin formats use real drawn
// groups when available (or the whole team pool as one group otherwise);
// knockout formats placeholder unresolved entrants (e.g. "Winner of
// Semifinal 1", "1st Group A") since real names aren't known until earlier
// rounds/groups are completed — the operator swaps those in via the normal
// team picker as results come in.
function GenerateScheduleModal({ tournament, scopedTeams, onClose, onGenerate }: {
  tournament: Tournament;
  scopedTeams: SavedTeam[];
  onClose: () => void;
  onGenerate: (fixtures: { date: string; time?: string; round: string; category?: string; group?: string; teamA: ScheduleTeamRef; teamB: ScheduleTeamRef | null }[]) => void;
}) {
  const categories = tournament.categories ?? [];
  const ALL_CATEGORIES = '__all__';
  const [format, setFormat] = useState<ScheduleFormat>('rr-single');
  const [category, setCategory] = useState<string>(categories.length > 0 ? ALL_CATEGORIES : '');
  const [advanceCount, setAdvanceCount] = useState(2);
  const [startDate, setStartDate] = useState(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  });
  const [daysBetween, setDaysBetween] = useState(7);
  const [time, setTime] = useState('');
  const [randomize, setRandomize] = useState(true);
  const [thirdPlacePlayoff, setThirdPlacePlayoff] = useState(false);

  const toRef = (t: SavedTeam): ScheduleTeamRef => ({ name: t.name, shortName: t.shortName, color: t.color, logo: t.logo });

  type PreviewFixture = GeneratedFixture & { groupName?: string; fixtureCategory?: string };

  // Runs the whole generator for ONE category (or the whole tournament, when
  // `cat` is undefined) — pulled out so "All Categories" can just call this
  // once per category and concatenate the results, each staying tagged with
  // its own category. Every category's rounds start at roundIndex 0, so
  // running "All" schedules every category in parallel on the same calendar
  // dates (Round 1 for Men and Women both land on the start date, etc.) —
  // the normal way multi-category tournaments actually run.
  const generateForCategory = (cat: string | undefined): { fixtures: PreviewFixture[]; warnings: string[] } => {
    const inScope = (c?: string) => !cat || !c || c === cat;
    const teamsInScope = scopedTeams.filter(t => inScope(t.category));
    const groupsInScope = normalizeGroups(tournament.groups).filter(g => inScope(g.category));
    const groupMembers = (groupName: string) =>
      teamsInScope.filter(t => t.group === groupName)
        .sort((a, b) => (a.groupPosition ?? 9999) - (b.groupPosition ?? 9999) || a.name.localeCompare(b.name));

    const warnPrefix = cat ? `[${cat}] ` : '';
    const warnings: string[] = [];
    let fixtures: PreviewFixture[] = [];

    if (format === 'rr-single' || format === 'rr-double') {
      const gen = format === 'rr-single' ? generateRoundRobin : generateDoubleRoundRobin;
      if (groupsInScope.length > 0) {
        for (const g of groupsInScope) {
          let members = groupMembers(g.name).map(toRef);
          if (members.length < 2) {
            if (members.length === 1) warnings.push(`${warnPrefix}Group ${g.name} has only 1 team — skipped.`);
            continue;
          }
          if (randomize) members = shuffle(members);
          fixtures = fixtures.concat(gen(members, g.name).map(f => ({ ...f, groupName: g.name })));
        }
        const assignedIds = new Set(groupsInScope.flatMap(g => groupMembers(g.name).map(t => t.id)));
        const unassigned = teamsInScope.filter(t => !assignedIds.has(t.id));
        if (unassigned.length > 0) warnings.push(`${warnPrefix}${unassigned.length} team(s) not assigned to a group were skipped.`);
      } else {
        let members = teamsInScope.map(toRef);
        if (members.length < 2) warnings.push(`${warnPrefix}Not enough teams to schedule (need at least 2).`);
        else {
          if (randomize) members = shuffle(members);
          fixtures = gen(members);
        }
      }
    } else if (format === 'knockout') {
      let members = teamsInScope.map(toRef);
      if (members.length < 2) warnings.push(`${warnPrefix}Not enough teams to schedule (need at least 2).`);
      else {
        if (randomize) members = shuffle(members);
        fixtures = generateKnockout(members, thirdPlacePlayoff);
      }
    } else if (format === 'groups-knockout') {
      if (groupsInScope.length === 0) {
        warnings.push(`${warnPrefix}No groups found for this scope — set up groups in the Draw tab first.`);
      } else {
        let maxRoundIdx = -1;
        for (const g of groupsInScope) {
          let members = groupMembers(g.name).map(toRef);
          if (members.length < 2) {
            if (members.length === 1) warnings.push(`${warnPrefix}Group ${g.name} has only 1 team — skipped.`);
            continue;
          }
          if (randomize) members = shuffle(members);
          const f = generateRoundRobin(members, g.name);
          fixtures = fixtures.concat(f.map(x => ({ ...x, groupName: g.name })));
          if (f.length) maxRoundIdx = Math.max(maxRoundIdx, Math.max(...f.map(x => x.roundIndex)));
        }
        const slots = buildGroupKnockoutSlots(groupsInScope.map(g => g.name), advanceCount);
        fixtures = fixtures.concat(offsetRounds(generateKnockoutFromSlots(slots, thirdPlacePlayoff), maxRoundIdx + 1));
      }
    }

    const prefix = cat ? `${cat} · ` : '';
    fixtures = fixtures.map(f => ({ ...f, round: prefix ? `${prefix}${f.round}` : f.round, fixtureCategory: cat }));

    return { fixtures, warnings };
  };

  const preview = useMemo(() => {
    if (category === ALL_CATEGORIES) {
      let fixtures: PreviewFixture[] = [];
      let warnings: string[] = [];
      for (const cat of categories) {
        const result = generateForCategory(cat);
        fixtures = fixtures.concat(result.fixtures);
        warnings = warnings.concat(result.warnings);
      }
      return { fixtures, warnings };
    }
    return generateForCategory(categories.length > 0 ? category : undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, scopedTeams, tournament.groups, randomize, advanceCount, category, categories, thirdPlacePlayoff]);

  const matchCount = preview.fixtures.length;
  const roundCount = matchCount ? Math.max(...preview.fixtures.map(f => f.roundIndex)) + 1 : 0;

  const handleGenerate = () => {
    if (matchCount === 0) return;
    // The Schedule tab's display/running order now follows insertion order
    // (via each fixture's auto-assigned sortIndex), not date — so fixtures
    // must be handed to onGenerate already interleaved by round: every
    // Round 1 (across every group and category) first, then every Round 2,
    // etc. A stable sort by roundIndex does this while preserving each
    // round's original group/category ordering as the tiebreak.
    const inRoundOrder = [...preview.fixtures].sort((a, b) => a.roundIndex - b.roundIndex);
    onGenerate(inRoundOrder.map(f => ({
      date: addDaysToDateStr(startDate, f.roundIndex * daysBetween),
      time: time || undefined,
      round: f.round,
      category: f.fixtureCategory,
      group: f.groupName ?? f.stage,
      teamA: f.a,
      teamB: f.b,
    })));
    onClose();
  };

  return (
    <div className="tm-gen-backdrop" onClick={onClose}>
      <div className="tm-gen-modal" onClick={e => e.stopPropagation()}>
        <div className="tm-gen-title">🪄 Generate Schedule</div>

        <label className="tm-gen-label">Format</label>
        <select className="tm-input" value={format} onChange={e => setFormat(e.target.value as ScheduleFormat)}>
          {(Object.keys(SCHEDULE_FORMAT_LABELS) as ScheduleFormat[]).map(f => (
            <option key={f} value={f}>{SCHEDULE_FORMAT_LABELS[f]}</option>
          ))}
        </select>

        {categories.length > 0 && (
          <>
            <label className="tm-gen-label">Category</label>
            <select className="tm-input" value={category} onChange={e => setCategory(e.target.value)}>
              <option value={ALL_CATEGORIES}>All Categories (generates one schedule per category)</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </>
        )}

        {format === 'groups-knockout' && (
          <>
            <label className="tm-gen-label">Teams advancing per group to knockout stage</label>
            <input className="tm-input" type="number" min={1} value={advanceCount}
              onChange={e => setAdvanceCount(Math.max(1, parseInt(e.target.value, 10) || 1))} />
          </>
        )}

        <div className="tm-gen-row">
          <div style={{ flex: 1 }}>
            <label className="tm-gen-label">Start Date</label>
            <input className="tm-input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="tm-gen-label">Time (optional)</label>
            <input className="tm-input" type="time" value={time} onChange={e => setTime(e.target.value)} style={{ width: '100%' }} />
          </div>
        </div>

        <label className="tm-gen-label">Days between rounds</label>
        <input className="tm-input" type="number" min={0} value={daysBetween}
          onChange={e => setDaysBetween(Math.max(0, parseInt(e.target.value, 10) || 0))} />

        <label className="tm-gen-checkbox">
          <input type="checkbox" checked={randomize} onChange={e => setRandomize(e.target.checked)} />
          Randomize team order / seeding
        </label>

        {(format === 'knockout' || format === 'groups-knockout') && (
          <label className="tm-gen-checkbox">
            <input type="checkbox" checked={thirdPlacePlayoff} onChange={e => setThirdPlacePlayoff(e.target.checked)} />
            Play 3rd/4th place — Semifinal losers play for 3rd
          </label>
        )}

        {preview.warnings.length > 0 && (
          <div className="tm-gen-warn">
            {preview.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}

        <div className="tm-gen-actions">
          <button className="tm-io-btn tm-io-btn--ok" onClick={handleGenerate} disabled={matchCount === 0}>
            Generate {matchCount} fixture{matchCount !== 1 ? 's' : ''}{roundCount ? ` · ${roundCount} round${roundCount !== 1 ? 's' : ''}` : ''}
          </button>
          <button className="tm-io-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function SchedulePanel({ tournament, activeCategory }: { tournament: Tournament; activeCategory: string }) {
  const { matches: allMatches, addMatch, updateMatch, deleteMatch, markSent } = useMatchScheduleStore();
  const { updateTournament } = useTournamentStore();
  const { teams: allTeams } = useTeamDbStore();
  const { pages, updateWidgetConfig, resetWidgetTimer } = useCanvasStore();
  const { addResult } = useMatchResultsStore();
  // Every fixture in this tournament, regardless of the category filter —
  // used when sending a fixture to a scoreboard from any category view.
  const allTournamentMatches = useMemo(
    () => allMatches.filter(m => m.tournamentId === tournament.id),
    [allMatches, tournament.id]
  );
  // View-filtered for everything the operator actually sees/acts on. Untagged
  // fixtures stay visible under every category filter — same "untagged =
  // universal" convention used for groups/pots in the Draw tab.
  const matches = useMemo(
    () => allTournamentMatches.filter(m => !activeCategory || !m.category || m.category === activeCategory),
    [allTournamentMatches, activeCategory]
  );
  const scoreboards = useMemo(
    () => pages.flatMap(p => p.widgets).filter(w => w.type === 'scoreboard').map(w => ({ id: w.id, label: w.label })),
    [pages]
  );
  const liveFixtureIds = useLiveFixtureIds();
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
  const [showGenerate, setShowGenerate] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // Two-step swap: click 🔄 Swap on one fixture to arm it, then click ↔ Swap
  // Here on the target fixture to complete it — a distinct button on the
  // target row rather than a dropdown, so it's obvious which click does what.
  const [armedSwapId, setArmedSwapId] = useState<string | null>(null);

  const venues = tournament.venues ?? [];
  const [newVenueName, setNewVenueName] = useState('');
  const addVenue = () => {
    const name = newVenueName.trim();
    if (!name || venues.includes(name)) return;
    updateTournament(tournament.id, { venues: [...venues, name] });
    setNewVenueName('');
  };
  const removeVenue = (name: string) => {
    updateTournament(tournament.id, { venues: venues.filter(v => v !== name) });
    for (const m of matches) {
      if (m.venue === name) updateMatch(m.id, { venue: undefined });
    }
  };

  // Bulk fixture selection — numbers/checkboxes on each row, "Select
  // All"/"Deselect All", and a bulk-edit/delete bar for whatever's checked.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelectedIds(new Set(matches.map(m => m.id)));
  const deselectAll = () => setSelectedIds(new Set());
  const toggleEditMode = () => setEditMode(v => { if (v) { setSelectedIds(new Set()); setArmedSwapId(null); } return !v; });
  const [bulkVenue, setBulkVenue] = useState('');
  const [bulkCategory, setBulkCategory] = useState('');
  const [bulkGroup, setBulkGroup] = useState('');
  const applyBulkVenue = () => {
    if (selectedIds.size === 0 || !bulkVenue) return;
    for (const id of selectedIds) updateMatch(id, { venue: bulkVenue === '__clear__' ? undefined : bulkVenue });
  };
  const applyBulkCategory = () => {
    if (selectedIds.size === 0 || !bulkCategory) return;
    for (const id of selectedIds) updateMatch(id, { category: bulkCategory === '__clear__' ? undefined : bulkCategory });
  };
  const applyBulkGroup = () => {
    if (selectedIds.size === 0 || !bulkGroup) return;
    for (const id of selectedIds) updateMatch(id, { group: bulkGroup === '__clear__' ? undefined : bulkGroup });
  };
  const deleteSelected = () => {
    for (const id of selectedIds) deleteMatch(id);
    setSelectedIds(new Set());
  };

  // Each position in the list is a fixed SLOT — its id, date, time,
  // sortIndex (count number), venue, competition never move. Reordering
  // swaps the MATCH CONTENT (which teams are playing, round/category/group,
  // score/progress) between slots instead — the count number and the
  // manually-set time you gave that slot stay exactly where they are;
  // only which fixture occupies the slot changes.
  const [draggedFixtureId, setDraggedFixtureId] = useState<string | null>(null);
  const [dragOverFixtureId, setDragOverFixtureId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragStateRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);
  const matchContentOf = (m: ScheduledMatch) => ({
    teamAName: m.teamAName, teamAShortName: m.teamAShortName, teamALogo: m.teamALogo, teamAColor: m.teamAColor,
    teamBName: m.teamBName, teamBShortName: m.teamBShortName, teamBLogo: m.teamBLogo, teamBColor: m.teamBColor,
    round: m.round, category: m.category, group: m.group,
    matchType: m.matchType, walkoverLoser: m.walkoverLoser, scoreA: m.scoreA, scoreB: m.scoreB,
    sentAt: m.sentAt, completedAt: m.completedAt,
  });
  const moveFixture = (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const ordered = matches; // already ordered by sortIndex (the count number)
    const fromIdx = ordered.findIndex(m => m.id === draggedId);
    const toIdx = ordered.findIndex(m => m.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    // Simulate moving the CONTENT (not the slot) from fromIdx to toIdx —
    // everything between shifts by one, same as a normal list reorder —
    // then hand each slot whichever content should now sit in it.
    const contents = ordered.map(matchContentOf);
    const reorderedContents = [...contents];
    const [movedContent] = reorderedContents.splice(fromIdx, 1);
    reorderedContents.splice(toIdx, 0, movedContent);
    const lo = Math.min(fromIdx, toIdx);
    const hi = Math.max(fromIdx, toIdx);
    for (let k = lo; k <= hi; k++) {
      updateMatch(ordered[k].id, reorderedContents[k]);
    }
  };
  const moveFixtureBy = (id: string, direction: -1 | 1) => {
    const idx = matches.findIndex(m => m.id === id);
    const neighbor = matches[idx + direction];
    if (idx === -1 || !neighbor) return;
    moveFixture(id, neighbor.id);
  };

  // Native HTML5 drag-and-drop (draggable/dragstart/dragover/drop) doesn't
  // fire reliably in this app's WebView, so dragging is done with plain mouse
  // events instead: press, move past a small threshold to arm it (so normal
  // clicks/double-clicks on the card's fields still work), then hit-test
  // whichever row is under the cursor via elementFromPoint so the card being
  // dragged visually "snaps"/highlights onto whatever it's covering.
  const startFixtureDrag = (m: ScheduledMatch) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('input, button, select, textarea, a')) return;
    const startX = e.clientX, startY = e.clientY;
    dragStateRef.current = { id: m.id, startX, startY, active: false };
    const onMove = (ev: MouseEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (!st.active) {
        if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) < 6) return;
        st.active = true;
        setDraggedFixtureId(st.id);
        document.body.style.userSelect = 'none';
      }
      ev.preventDefault();
      setDragPos({ x: ev.clientX, y: ev.clientY });
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const rowEl = under?.closest('[data-fixture-row]') as HTMLElement | null;
      const overId = rowEl?.getAttribute('data-fixture-row') ?? null;
      setDragOverFixtureId(overId && overId !== st.id ? overId : null);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      const st = dragStateRef.current;
      if (st?.active) {
        setDragOverFixtureId(overId => {
          if (overId) moveFixture(st.id, overId);
          return null;
        });
      }
      dragStateRef.current = null;
      setDraggedFixtureId(null);
      setDragPos(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleGeneratedFixtures = (fixtures: { date: string; time?: string; round: string; category?: string; group?: string; teamA: ScheduleTeamRef; teamB: ScheduleTeamRef | null }[]) => {
    for (const f of fixtures) {
      addMatch({
        tournamentId: tournament.id, competition: tournament.name,
        date: f.date, time: f.time, round: f.round, category: f.category, group: f.group,
        teamAName: f.teamA.name, teamAShortName: f.teamA.shortName, teamAColor: f.teamA.color, teamALogo: f.teamA.logo,
        teamBName: f.teamB?.name ?? '', teamBShortName: f.teamB?.shortName, teamBColor: f.teamB?.color ?? '#95a5a6', teamBLogo: f.teamB?.logo,
      });
    }
  };

  // Fixtures always show the CURRENT tournament name — keep the stored
  // `competition` field in sync (it's what downstream widgets/results read)
  // so renaming the tournament doesn't leave stale fixtures behind.
  useEffect(() => {
    for (const m of allTournamentMatches) {
      if (m.competition !== tournament.name) updateMatch(m.id, { competition: tournament.name });
    }
  }, [tournament.name, allTournamentMatches, updateMatch]);

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
      else alert('No valid fixtures found in file.\n\nExpected columns: Date (YYYY-MM-DD), Time, Team A, Team B, Venue, Category, Group, Round\nFormats: CSV, TSV, or plain text');
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
        date: row.date, time: row.time, venue: row.venue, category: row.category, group: row.group, round: row.round,
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

  // Sequential fixture numbers in the same order they're displayed, spanning
  // every month group — not reset per group.
  const numberOf = useMemo(
    () => new Map(groups.flatMap(([, rows]) => rows).map((m, i) => [m.id, i + 1])),
    [groups]
  );
  const allSelected = matches.length > 0 && selectedIds.size === matches.length;

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button className={`tm-io-btn${editMode ? ' tm-io-btn--ok' : ''}`} onClick={toggleEditMode}>
          {editMode ? '✓ Done Editing' : '✏️ Edit'}
        </button>
        <button className="tm-io-btn" title="Export fixtures as CSV (Excel compatible)"
          onClick={() => exportFixturesCSV(matches, tournament.name)} disabled={matches.length === 0}>
          ↓ Export CSV
        </button>
      </div>

      {editMode && (
        <div className="tm-groups-bar">
          <span className="tm-groups-label">Venues:</span>
          {venues.map(v => (
            <span key={v} className="tm-group-chip">
              {v}
              <button onClick={() => removeVenue(v)} title={`Remove ${v} (unassigns any fixtures using it)`}>×</button>
            </span>
          ))}
          <input
            className="tm-input tm-groups-add-input"
            placeholder="e.g. Court 1, Main Hall"
            value={newVenueName}
            onChange={e => setNewVenueName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addVenue(); }}
          />
          <button className="tm-io-btn" onClick={addVenue} disabled={!newVenueName.trim()}>+ Add Venue</button>
        </div>
      )}

      {editMode && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tm-io-btn" onClick={selectAll} disabled={matches.length === 0 || allSelected}>☑ Select All</button>
            <button className="tm-io-btn" onClick={deselectAll} disabled={selectedIds.size === 0}>☐ Deselect All</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tm-io-btn" title="Auto-generate fixtures (round robin, knockout, groups + knockout)" onClick={() => setShowGenerate(true)}>
              🪄 Generate Schedule
            </button>
            <button className="tm-io-btn" title="Import fixtures from CSV / TSV / TXT" onClick={() => fileInputRef.current?.click()}>
              ↑ Import
            </button>
            <button className="tm-sidebar-new-btn" onClick={handleAdd}>＋ Add Fixture</button>
            <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }} onChange={handleFileChange} />
          </div>
        </div>
      )}

      {editMode && selectedIds.size > 0 && (
        <div className="tm-draw-vmix-cfg" style={{ marginBottom: 12 }}>
          <span className="tm-groups-label">{selectedIds.size} selected —</span>
          <select className="tm-input" value={bulkVenue} onChange={e => setBulkVenue(e.target.value)} style={{ width: 140 }}>
            <option value="">— pick venue —</option>
            {venues.map(v => <option key={v} value={v}>{v}</option>)}
            <option value="__clear__">— No Venue —</option>
          </select>
          <button className="tm-io-btn" onClick={applyBulkVenue} disabled={!bulkVenue}>Apply Venue</button>
          {(tournament.categories ?? []).length > 0 && (
            <>
              <select className="tm-input" value={bulkCategory} onChange={e => setBulkCategory(e.target.value)} style={{ width: 140 }}>
                <option value="">— pick category —</option>
                {(tournament.categories ?? []).map(c => <option key={c} value={c}>{c}</option>)}
                <option value="__clear__">— No Category —</option>
              </select>
              <button className="tm-io-btn" onClick={applyBulkCategory} disabled={!bulkCategory}>Apply Category</button>
            </>
          )}
          <select className="tm-input" value={bulkGroup} onChange={e => setBulkGroup(e.target.value)} style={{ width: 140 }}>
            <option value="">— pick group —</option>
            {normalizeGroups(tournament.groups).map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
            <option value="__clear__">— No Group —</option>
          </select>
          <button className="tm-io-btn" onClick={applyBulkGroup} disabled={!bulkGroup}>Apply Group</button>
          <ConfirmButton
            className="tm-io-btn tm-io-btn--danger"
            label={`🗑 Delete ${selectedIds.size}`}
            confirmLabel="Delete"
            message={`Delete ${selectedIds.size} selected fixture${selectedIds.size !== 1 ? 's' : ''}?`}
            onConfirm={deleteSelected}
          />
          <button className="tm-io-btn" onClick={deselectAll}>Clear Selection</button>
        </div>
      )}

      {showGenerate && (
        <GenerateScheduleModal
          tournament={tournament}
          scopedTeams={scopedTeams}
          onClose={() => setShowGenerate(false)}
          onGenerate={handleGeneratedFixtures}
        />
      )}

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
              {rows.map(m => {
                const idxInAll = matches.findIndex(x => x.id === m.id);
                const isLive = liveFixtureIds.has(m.id);
                return (
                <div
                  key={m.id}
                  data-fixture-row={m.id}
                  className={`tm-sched-row${m.completedAt ? ' tm-sched-row--completed' : ''}${selectedIds.has(m.id) ? ' tm-sched-row--selected' : ''}${editMode ? ' tm-sched-row--draggable' : ''}${draggedFixtureId === m.id ? ' tm-sched-row--dragging' : ''}${dragOverFixtureId === m.id && draggedFixtureId !== m.id ? ' tm-sched-row--drag-over' : ''}${isLive ? ' tm-sched-row--live' : ''}`}
                  onMouseDown={editMode ? startFixtureDrag(m) : undefined}
                  title={editMode ? 'Drag onto another slot to swap which match plays there — that slot\'s count/time stays put' : undefined}
                >
                  {editMode && (
                    <div className="tm-sched-row-move">
                      <button
                        className="tm-sched-row-move-btn"
                        disabled={idxInAll <= 0}
                        title="Swap into the slot above (count/time stays with the slot)"
                        onClick={() => moveFixtureBy(m.id, -1)}
                      >▲</button>
                      <button
                        className="tm-sched-row-move-btn"
                        disabled={idxInAll < 0 || idxInAll >= matches.length - 1}
                        title="Swap into the slot below (count/time stays with the slot)"
                        onClick={() => moveFixtureBy(m.id, 1)}
                      >▼</button>
                    </div>
                  )}
                  <input
                    type="checkbox"
                    className="tm-sched-row-check"
                    checked={selectedIds.has(m.id)}
                    onChange={() => toggleSelected(m.id)}
                    title="Select for bulk edit/delete"
                    style={editMode ? undefined : { visibility: 'hidden' }}
                  />
                  <span className="tm-sched-row-num">{numberOf.get(m.id)}</span>
                  <div className="tm-sched-divider" />
                  {isLive && <span className="tm-sched-live-badge">● LIVE</span>}
                  {m.completedAt && <span className="tm-sched-completed-badge">✓ Completed</span>}
                  <EditableDate value={m.date} onChange={date => updateMatch(m.id, { date })} disabled={!editMode} />
                  <div className="tm-sched-divider" />

                  <div className="tm-sched-matchup">
                    <div className="tm-sched-team">
                      <EditableText className="tm-sched-team-name" value={m.teamAName} placeholder="Team A"
                        onChange={v => updateMatch(m.id, { teamAName: v })} disabled={!editMode} />
                      <LogoUrlPicker compact value={m.teamALogo ?? ''} onChange={logo => updateMatch(m.id, { teamALogo: logo })}
                        thumbSize={{ w: 36, h: 36 }} thumbContent={<ScheduleBadge logo={m.teamALogo} color={m.teamAColor} />} tournamentId={tournament.id} disabled={!editMode} />
                      {editMode && <ScheduleTeamPicker side="A" tournamentId={tournament.id} onPick={t => updateMatch(m.id, { teamAName: t.name, teamAShortName: t.shortName, teamAColor: t.color, teamALogo: t.logo })} />}
                    </div>
                    <div className="tm-sched-vs-col">
                      {m.matchType && (
                        <span className="tm-sched-type-badge" title={
                          m.matchType === 'bye'
                            ? 'Automatic — no Team B name set'
                            : `Automatic — ${m.walkoverLoser === 'A' ? m.teamAName : m.teamBName} is on Walkover status in the Team Database`
                        }>{m.matchType === 'bye' ? 'BYE' : 'W/O'}</span>
                      )}
                      {m.venueLabel && (
                        <span className="tm-sched-venue-badge" title={`Synced from venue: ${m.venueLabel}`}>📍 {m.venueLabel}</span>
                      )}
                      {m.matchType ? (
                        <span className="tm-sched-vs tm-sched-score">
                          <EditableText value={String(m.scoreA ?? 0)} onChange={v => updateMatch(m.id, { scoreA: Number(v) || 0 })} disabled={!editMode} />
                          <span className="tm-sched-score-sep">–</span>
                          <EditableText value={String(m.scoreB ?? 0)} onChange={v => updateMatch(m.id, { scoreB: Number(v) || 0 })} disabled={!editMode} />
                        </span>
                      ) : (
                        <span className="tm-sched-vs">VS</span>
                      )}
                      {editMode ? (
                        <EditableText className="tm-sched-round" value={m.round ?? ''} placeholder="Round"
                          onChange={v => updateMatch(m.id, { round: v })} />
                      ) : (
                        m.round && <span className="tm-sched-round">{m.round}</span>
                      )}
                    </div>
                    <div className="tm-sched-team tm-sched-team--b">
                      {editMode && <ScheduleTeamPicker side="B" tournamentId={tournament.id} onPick={t => updateMatch(m.id, { teamBName: t.name, teamBShortName: t.shortName, teamBColor: t.color, teamBLogo: t.logo })} />}
                      <LogoUrlPicker compact value={m.teamBLogo ?? ''} onChange={logo => updateMatch(m.id, { teamBLogo: logo })}
                        thumbSize={{ w: 36, h: 36 }} thumbContent={<ScheduleBadge logo={m.teamBLogo} color={m.teamBColor} />} tournamentId={tournament.id} disabled={!editMode} />
                      <EditableText className="tm-sched-team-name" value={m.teamBName} placeholder="Team B"
                        onChange={v => updateMatch(m.id, { teamBName: v })} disabled={!editMode} />
                    </div>
                  </div>

                  <div className="tm-sched-divider" />
                  <div className="tm-sched-venue">
                    {editMode ? (
                      venues.length > 0 ? (
                        <select
                          className="tm-sched-catgroup-select"
                          value={m.venue ?? ''}
                          onChange={e => updateMatch(m.id, { venue: e.target.value || undefined })}
                        >
                          <option value="">— Venue —</option>
                          {m.venue && !venues.includes(m.venue) && <option value={m.venue}>{m.venue}</option>}
                          {venues.map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      ) : (
                        <EditableText className="tm-sched-venue-name" value={m.venue ?? ''} placeholder="Venue"
                          onChange={v => updateMatch(m.id, { venue: v })} />
                      )
                    ) : (
                      m.venue && <span className="tm-sched-venue-name">{m.venue}</span>
                    )}
                    <span className="tm-sched-venue-league" title="Competition (follows this tournament's name)">{tournament.name}</span>
                  </div>

                  <div className="tm-sched-divider" />
                  <div className="tm-sched-catgroup">
                    {editMode ? (() => {
                      const knownGroups = normalizeGroups(tournament.groups)
                        .filter(g => !m.category || !g.category || g.category === m.category);
                      // A knockout-generated fixture's group is auto-set to its bracket
                      // stage (e.g. "Quarterfinal") rather than a real Draw group — show
                      // it as a selectable option even though it isn't one of those.
                      const isAutoStage = !!m.group && !knownGroups.some(g => g.name === m.group);
                      return (
                        <select
                          className="tm-sched-catgroup-select"
                          value={m.group ?? ''}
                          onChange={e => updateMatch(m.id, { group: e.target.value || undefined })}
                          title={isAutoStage ? 'Auto-set from the knockout bracket stage' : undefined}
                        >
                          <option value="">— Group —</option>
                          {isAutoStage && <option value={m.group}>{m.group} (stage)</option>}
                          {knownGroups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                        </select>
                      );
                    })() : (
                      m.group && <span className="tm-sched-catgroup-select">{m.group}</span>
                    )}
                    {editMode ? (
                      (tournament.categories ?? []).length > 0 && (
                        <select
                          className="tm-sched-catgroup-select tm-sched-catgroup-select--secondary"
                          value={m.category ?? ''}
                          onChange={e => updateMatch(m.id, { category: e.target.value || undefined })}
                        >
                          <option value="">— Category —</option>
                          {m.category && !(tournament.categories ?? []).includes(m.category) && <option value={m.category}>{m.category}</option>}
                          {(tournament.categories ?? []).map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      )
                    ) : (
                      m.category && <span className="tm-sched-catgroup-select tm-sched-catgroup-select--secondary">{m.category}</span>
                    )}
                  </div>

                  <div className="tm-sched-divider" />
                  {editMode ? (
                    <EditableTime value={m.time} onChange={time => updateMatch(m.id, { time })} />
                  ) : (
                    m.time && (
                      <div className="tm-sched-time">
                        <span className="tm-sched-time-val">{formatTimeDisplay(m.time)}</span>
                        <span className="tm-sched-time-tz">{getTzAbbrev()}</span>
                      </div>
                    )
                  )}

                  <div className="tm-sched-divider" />
                  <div className="tm-sched-send-col">
                    {editMode ? (
                      armedSwapId === m.id ? (
                        <button className="tm-sched-send-btn tm-sched-send-btn--cancel" title="Cancel swap" onClick={() => setArmedSwapId(null)}>✕ Cancel</button>
                      ) : armedSwapId ? (
                        <button className="tm-sched-send-btn tm-sched-send-btn--swap-here" title="Complete the swap with this fixture" onClick={() => { moveFixture(armedSwapId, m.id); setArmedSwapId(null); }}>↔ Swap Here</button>
                      ) : (
                        <button className="tm-sched-send-btn" title="Pick this fixture to swap, then click Swap Here on the target" onClick={() => setArmedSwapId(m.id)}>🔄 Swap</button>
                      )
                    ) : (
                      <ScoreboardSendButton match={m} scoreboards={scoreboards} onSend={id => sendToScoreboard(m, id)} />
                    )}
                  </div>

                  {editMode && <button className="tm-sched-del" title="Delete fixture" onClick={() => deleteMatch(m.id)}>×</button>}
                </div>
                );
              })}
            </div>
          </div>
        ))
      )}
      {draggedFixtureId && dragPos && createPortal(
        (() => {
          const dm = matches.find(x => x.id === draggedFixtureId);
          if (!dm) return null;
          return (
            <div className="tm-sched-drag-ghost" style={{ left: dragPos.x, top: dragPos.y }}>
              <ScheduleBadge logo={dm.teamALogo} color={dm.teamAColor} />
              <span className="tm-sched-drag-ghost-vs">{dm.teamAShortName || dm.teamAName} vs {dm.teamBShortName || dm.teamBName}</span>
              <ScheduleBadge logo={dm.teamBLogo} color={dm.teamBColor} />
            </div>
          );
        })(),
        document.body
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
// competition/saved-time in place of venue/category-group) so a finished match
// visually reads as the same object moving from one tab to the other.
// Union of two per-team count maps into aligned rows (a label present on
// only one side still gets a row, with 0 on the other) — same idiom used by
// HeadToHeadPanel/computeTeamTournamentStats, kept local here since this one
// is scoped to a single result rather than a whole tournament.
function mergeCountRows(a: Record<string, number>, b: Record<string, number>): { label: string; a: number; b: number }[] {
  const labels = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Array.from(labels)
    .map(label => ({ label, a: a[label] ?? 0, b: b[label] ?? 0 }))
    .sort((x, y) => (y.a + y.b) - (x.a + x.b));
}

// Expanded detail for a single result — point-type breakdown, shootout
// outcome, and card counts, whichever were actually captured for that match
// (older/manually-entered results may have none of this, hence the empty
// state). Reuses the scoreboard widget's `.wgt-h2h-table` styling so the
// "two teams either side of a bordered label column" look stays consistent
// across the app.
function ResultDetail({ r }: { r: SavedMatchResult }) {
  const aBreakdown: Record<string, number> = {};
  const bBreakdown: Record<string, number> = {};
  for (const e of r.scoreLog ?? []) {
    const map = e.team === 'A' ? aBreakdown : bBreakdown;
    map[e.action] = (map[e.action] ?? 0) + 1;
  }
  const rows = mergeCountRows(aBreakdown, bBreakdown);

  const cardTally = (team: 'A' | 'B') => {
    const t = { yellow: 0, orange: 0, red: 0 };
    for (const c of r.cards ?? []) if (c.team === team) t[c.type]++;
    return t;
  };
  const aCards = cardTally('A');
  const bCards = cardTally('B');
  const hasCards = aCards.yellow + aCards.orange + aCards.red + bCards.yellow + bCards.orange + bCards.red > 0;
  const hasTable = rows.length > 0 || hasCards;

  if (!hasTable && !r.shootout) {
    return <div className="tm-result-detail"><div className="tm-result-detail-empty">No further detail captured for this match.</div></div>;
  }

  return (
    <div className="tm-result-detail">
      {r.shootout && (
        <div className="tm-result-detail-shootout">
          🥅 Decided on penalties: <span style={{ color: r.teamAColor }}>{r.shootout.scoreA}</span>
          {' – '}
          <span style={{ color: r.teamBColor }}>{r.shootout.scoreB}</span>
        </div>
      )}
      {hasTable && (
        <table className="wgt-h2h-table">
          <tbody>
            {rows.map(row => (
              <tr className="wgt-h2h-row" key={row.label}>
                <td className="wgt-h2h-cell--a" style={{ color: r.teamAColor }}>{row.a}</td>
                <td className="wgt-h2h-cell--label">{row.label}</td>
                <td className="wgt-h2h-cell--b" style={{ color: r.teamBColor }}>{row.b}</td>
              </tr>
            ))}
            {aCards.yellow + bCards.yellow > 0 && (
              <tr className="wgt-h2h-row"><td className="wgt-h2h-cell--a" style={{ color: r.teamAColor }}>{aCards.yellow}</td><td className="wgt-h2h-cell--label">🟨 Yellow</td><td className="wgt-h2h-cell--b" style={{ color: r.teamBColor }}>{bCards.yellow}</td></tr>
            )}
            {aCards.orange + bCards.orange > 0 && (
              <tr className="wgt-h2h-row"><td className="wgt-h2h-cell--a" style={{ color: r.teamAColor }}>{aCards.orange}</td><td className="wgt-h2h-cell--label">🟧 Orange</td><td className="wgt-h2h-cell--b" style={{ color: r.teamBColor }}>{bCards.orange}</td></tr>
            )}
            {aCards.red + bCards.red > 0 && (
              <tr className="wgt-h2h-row"><td className="wgt-h2h-cell--a" style={{ color: r.teamAColor }}>{aCards.red}</td><td className="wgt-h2h-cell--label">🟥 Red</td><td className="wgt-h2h-cell--b" style={{ color: r.teamBColor }}>{bCards.red}</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ResultsPanel({ tournament }: { tournament: Tournament }) {
  const { results: allResults, updateResult, deleteResult } = useMatchResultsStore();
  const [editMode, setEditMode] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => setExpandedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
        <button className={`tm-io-btn${editMode ? ' tm-io-btn--ok' : ''}`} onClick={() => setEditMode(v => !v)}>
          {editMode ? '✓ Done Editing' : '✏️ Edit'}
        </button>
        <button className="tm-io-btn" title="Export results as CSV (Excel compatible)"
          onClick={() => exportResultsCSV(results, tournament.name)}>
          ↓ Export CSV
        </button>
      </div>
      <div className="tm-sched-rows">
        {results.map(r => (
          <div key={r.id} className="tm-sched-row-wrap">
          <div className="tm-sched-row">
            <button
              className={`tm-result-expand-btn${expandedIds.has(r.id) ? ' tm-result-expand-btn--open' : ''}`}
              title={expandedIds.has(r.id) ? 'Hide details' : 'Show details (score breakdown, shootout, cards)'}
              onClick={() => toggleExpanded(r.id)}
            >▸</button>
            <EditableDate value={r.date} onChange={date => updateResult(r.id, { date })} disabled={!editMode} />
            <div className="tm-sched-divider" />

            <div className="tm-sched-matchup">
              <div className="tm-sched-team">
                <EditableText className="tm-sched-team-name" value={r.teamAShortName || r.teamAName}
                  onChange={v => updateResult(r.id, r.teamAShortName ? { teamAShortName: v } : { teamAName: v })} disabled={!editMode} />
                <div style={{ width: 36, height: 36, flexShrink: 0 }}><ScheduleBadge logo={r.teamALogo} color={r.teamAColor} /></div>
              </div>
              <div className="tm-sched-vs-col">
                {r.matchType && (
                  <span className="tm-sched-type-badge">{r.matchType === 'bye' ? 'BYE' : 'W/O'}</span>
                )}
                {r.venueLabel && (
                  <span className="tm-sched-venue-badge" title={`Synced from venue: ${r.venueLabel}`}>📍 {r.venueLabel}</span>
                )}
                <span className="tm-sched-vs tm-sched-score">
                  <EditableText value={String(r.scoreA)} onChange={v => updateResult(r.id, { scoreA: Number(v) || 0 })} disabled={!editMode} />
                  <span className="tm-sched-score-sep">–</span>
                  <EditableText value={String(r.scoreB)} onChange={v => updateResult(r.id, { scoreB: Number(v) || 0 })} disabled={!editMode} />
                </span>
                <EditableText className="tm-sched-round" value={r.round ?? ''} placeholder="Round"
                  onChange={v => updateResult(r.id, { round: v })} disabled={!editMode} />
              </div>
              <div className="tm-sched-team tm-sched-team--b">
                <div style={{ width: 36, height: 36, flexShrink: 0 }}><ScheduleBadge logo={r.teamBLogo} color={r.teamBColor} /></div>
                <EditableText className="tm-sched-team-name" value={r.teamBShortName || r.teamBName}
                  onChange={v => updateResult(r.id, r.teamBShortName ? { teamBShortName: v } : { teamBName: v })} disabled={!editMode} />
              </div>
            </div>

            <div className="tm-sched-divider" />
            <div className="tm-sched-venue">
              <EditableText className="tm-sched-venue-name" value={r.competition ?? ''} placeholder="Competition"
                onChange={v => updateResult(r.id, { competition: v })} disabled={!editMode} />
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

            {editMode && <button className="tm-sched-del" title="Delete result" onClick={() => deleteResult(r.id)}>×</button>}
          </div>
          {expandedIds.has(r.id) && <ResultDetail r={r} />}
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
export interface StandingRow {
  teamId: string; name: string; shortName?: string; logo?: string; color: string;
  played: number; won: number; drawn: number; lost: number;
  pf: number; pa: number; pts: number;
}

export function computeStandings(teams: SavedTeam[], results: SavedMatchResult[], settings: TournamentSettings): StandingRow[] {
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
    } else if (r.shootout) {
      // Level after regulation but decided by a shootout — counts as a
      // win/loss for standings purposes, not a draw.
      const aWon = r.shootout.winner === 'A';
      (aWon ? rowA : rowB).won++; (aWon ? rowA : rowB).pts += settings.pointsWin;
      (aWon ? rowB : rowA).lost++; (aWon ? rowB : rowA).pts += settings.pointsLoss;
    } else {
      rowA.drawn++; rowB.drawn++;
      rowA.pts += settings.pointsDraw; rowB.pts += settings.pointsDraw;
    }
  }
  return Array.from(rows.values()).sort((a, b) =>
    b.pts - a.pts || (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf
  );
}

export function StandingsTable({ title, rows, onTeamClick }: { title: string; rows: StandingRow[]; onTeamClick?: (name: string) => void }) {
  return (
    <div className="tm-standings-table">
      <div className="tm-standings-title">{title}</div>
      <div className="tm-standings-row tm-standings-row--head">
        <span>#</span>
        <span className="tm-standings-team">Team</span>
        <span>P</span><span>W</span><span>D</span><span>L</span>
        <span>PF</span><span>PA</span><span>+/-</span><span>Pts</span>
      </div>
      {rows.map((r, i) => (
        <div key={r.teamId} className={`tm-standings-row${i < 2 ? ' tm-standings-row--top' : ''}`}>
          <span className="tm-standings-pos">{i + 1}</span>
          <span
            className={`tm-standings-team${onTeamClick ? ' tm-standings-team--clickable' : ''}`}
            onClick={onTeamClick ? () => onTeamClick(r.name) : undefined}
            title={onTeamClick ? `View ${r.name}'s tournament stats & history` : undefined}
          >
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

// Read-only "everything about this team in this tournament" popup — opened
// by clicking a team name in Standings or the Bracket. Resolves the clicked
// display name back to a real SavedTeam (fails silently for a knockout
// placeholder like "1st Group A" or "Winner of …" that hasn't resolved to a
// real team yet — there's nothing to show for those).
function TeamInfoModal({ tournament, teamName, category, onClose }: { tournament: Tournament; teamName: string; category?: string; onClose: () => void }) {
  const { teams: allTeams } = useTeamDbStore();
  const { results: allResults } = useMatchResultsStore();
  const { matches: allMatches } = useMatchScheduleStore();

  // A club entering multiple categories duplicates its team entry per
  // category (see teamDbStore.duplicateTeam) — two SavedTeam rows can
  // legitimately share the same name. Require the category to match too
  // (when known) so this always resolves to the ONE team the user actually
  // clicked, not just whichever same-named team happens to be first.
  const team = useMemo(() => {
    const key = teamName.trim().toLowerCase();
    const candidates = allTeams.filter(t => t.tournamentId === tournament.id &&
      (t.name.trim().toLowerCase() === key || (t.shortName ?? '').trim().toLowerCase() === key));
    if (candidates.length <= 1) return candidates[0];
    return candidates.find(t => t.category === category) ?? candidates[0];
  }, [allTeams, tournament.id, teamName, category]);

  const results = useMemo(() => allResults.filter(r => r.tournamentId === tournament.id), [allResults, tournament.id]);

  // A result/fixture's category may only live in the `round` prefix ("Men ·
  // Quarterfinal 2") on data generated before the dedicated category field
  // existed.
  const effectiveCat = (c?: string, round?: string) => c ?? (round?.includes(' · ') ? round.split(' · ')[0] : undefined);

  const isTeam = (n?: string, s?: string, recCategory?: string, recRound?: string) => {
    if (!team || !n) return false;
    const nameKey = team.name.trim().toLowerCase();
    const shortKey = (team.shortName ?? '').trim().toLowerCase();
    const nameOk = n.trim().toLowerCase() === nameKey || (!!shortKey && (s ?? '').trim().toLowerCase() === shortKey);
    if (!nameOk) return false;
    // No category on this team (tournament has none, or team is unassigned) — name match is enough.
    if (!team.category) return true;
    // Otherwise also check the record's category — but only REJECT on an
    // actual conflict (a different category tagged). A record with no
    // category info at all (any result/fixture saved before this field
    // existed, or a plain round-robin round with no "Category · " prefix)
    // stays a match — same "untagged = visible everywhere" convention used
    // for groups/pots elsewhere in this app. Without this leniency, every
    // pre-existing result would wrongly disappear from a team's history.
    const recCat = effectiveCat(recCategory, recRound);
    return !recCat || recCat === team.category;
  };

  const standingRow = useMemo(() => {
    if (!team) return null;
    const settings = tournament.settings ?? SPORT_DEFAULTS[tournament.sport];
    const scopeTeams = allTeams.filter(t => t.tournamentId === tournament.id &&
      (team.group ? t.group === team.group : true) &&
      (team.category ? t.category === team.category : true));
    return computeStandings(scopeTeams, results, settings).find(row => row.teamId === team.id) ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, allTeams, tournament.id, tournament.settings, tournament.sport, results]);

  const history = useMemo(
    () => results
      .filter(r => isTeam(r.teamAName, r.teamAShortName, r.category, r.round) || isTeam(r.teamBName, r.teamBShortName, r.category, r.round))
      .sort((a, b) => b.date.localeCompare(a.date)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, team]
  );

  const upcoming = useMemo(
    () => allMatches
      .filter(m => m.tournamentId === tournament.id && !m.completedAt &&
        (isTeam(m.teamAName, m.teamAShortName, m.category, m.round) || isTeam(m.teamBName, m.teamBShortName, m.category, m.round)))
      .sort((a, b) => a.date.localeCompare(b.date)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament.id, team]
  );

  if (!team) return null;

  return (
    <div className="tm-gen-backdrop" onClick={onClose}>
      <div className="tm-team-info-modal" onClick={e => e.stopPropagation()}>
        <div className="tm-team-info-header">
          <div style={{ width: 56, height: 56, flexShrink: 0 }}><ScheduleBadge logo={team.logo} color={team.color} /></div>
          <div className="tm-team-info-heading">
            <div className="tm-team-info-name">{team.name}</div>
            <div className="tm-team-info-badges">
              {team.category && <span className="tm-team-cat-badge">{team.category}</span>}
              {team.group && <span className="tm-group-chip">{team.group}</span>}
              {team.pot && <span className="tm-group-chip tm-group-chip--pot">{team.pot}</span>}
              {team.players && team.players.length > 0 && <span className="tm-group-chip">{team.players.length} players</span>}
            </div>
          </div>
          <button className="tm-io-btn" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
        </div>

        {standingRow && (
          <div className="tm-team-info-stats">
            <div className="tm-team-info-stat"><span>{standingRow.played}</span><label>Played</label></div>
            <div className="tm-team-info-stat"><span>{standingRow.won}</span><label>Won</label></div>
            <div className="tm-team-info-stat"><span>{standingRow.drawn}</span><label>Drawn</label></div>
            <div className="tm-team-info-stat"><span>{standingRow.lost}</span><label>Lost</label></div>
            <div className="tm-team-info-stat"><span>{standingRow.pf}</span><label>For</label></div>
            <div className="tm-team-info-stat"><span>{standingRow.pa}</span><label>Against</label></div>
            <div className="tm-team-info-stat"><span>{standingRow.pf - standingRow.pa > 0 ? '+' : ''}{standingRow.pf - standingRow.pa}</span><label>+/-</label></div>
            <div className="tm-team-info-stat tm-team-info-stat--pts"><span>{standingRow.pts}</span><label>Points</label></div>
          </div>
        )}

        <div className="tm-team-info-section-title">🕐 Match History{history.length > 0 ? ` (${history.length})` : ''}</div>
        {history.length === 0 ? (
          <div className="tm-team-info-empty">No completed matches yet.</div>
        ) : (
          <div className="tm-team-info-list">
            {history.map(r => {
              const isA = isTeam(r.teamAName, r.teamAShortName);
              const oppName = isA ? r.teamBName : r.teamAName;
              const oppShort = isA ? r.teamBShortName : r.teamAShortName;
              const oppLogo = isA ? r.teamBLogo : r.teamALogo;
              const oppColor = isA ? r.teamBColor : r.teamAColor;
              const us = isA ? r.scoreA : r.scoreB;
              const them = isA ? r.scoreB : r.scoreA;
              const outcome = us > them ? 'W' : us < them ? 'L' : 'D';
              return (
                <div key={r.id} className="tm-team-info-row">
                  <span className={`tm-team-info-outcome tm-team-info-outcome--${outcome}`}>{outcome}</span>
                  <span className="tm-team-info-date">{r.date}</span>
                  <div style={{ width: 20, height: 20, flexShrink: 0 }}><ScheduleBadge logo={oppLogo} color={oppColor} /></div>
                  <span className="tm-team-info-opp">{oppShort || oppName}</span>
                  <span className="tm-team-info-score">{us}–{them}</span>
                  {r.round && <span className="tm-team-info-round">{r.round}</span>}
                </div>
              );
            })}
          </div>
        )}

        {upcoming.length > 0 && (
          <>
            <div className="tm-team-info-section-title">📅 Upcoming ({upcoming.length})</div>
            <div className="tm-team-info-list">
              {upcoming.map(m => {
                const isA = isTeam(m.teamAName, m.teamAShortName);
                const oppName = isA ? m.teamBName : m.teamAName;
                const oppShort = isA ? m.teamBShortName : m.teamAShortName;
                const oppLogo = isA ? m.teamBLogo : m.teamALogo;
                const oppColor = isA ? m.teamBColor : m.teamAColor;
                return (
                  <div key={m.id} className="tm-team-info-row">
                    <span className="tm-team-info-date">{m.date}</span>
                    <div style={{ width: 20, height: 20, flexShrink: 0 }}><ScheduleBadge logo={oppLogo} color={oppColor} /></div>
                    <span className="tm-team-info-opp">{m.teamBName ? (oppShort || oppName) : 'BYE'}</span>
                    {m.round && <span className="tm-team-info-round">{m.round}</span>}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// A regular (non-bye/walkover) played match's score lives in a separate
// SavedMatchResult, not on the fixture itself — matched by team names since
// there's no id link back for a manually-saved scoreboard result. Shared by
// the bracket viewer (to bold the winner) and the auto-advance effect below
// (to know who advances).
export function findMatchScore(m: ScheduledMatch, results: SavedMatchResult[], tournamentId: string): { a: number; b: number } | null {
  if (m.matchType) return { a: m.scoreA ?? 0, b: m.scoreB ?? 0 };
  if (!m.completedAt) return null;
  const r = results.find(res =>
    res.tournamentId === tournamentId &&
    ((res.teamAName === m.teamAName && res.teamBName === m.teamBName) ||
     (res.teamAName === m.teamBName && res.teamBName === m.teamAName))
  );
  if (!r) return null;
  return r.teamAName === m.teamAName ? { a: r.scoreA, b: r.scoreB } : { a: r.scoreB, b: r.scoreA };
}

// Like findMatchScore, but also resolves a shootout decider when the raw
// score is tied — a knockout match that went to a penalty shootout/place-kick
// competition stays level on scoreA/scoreB, so callers that need to know who
// actually won (bracket auto-advance, bracket-view bolding) should use this
// instead of comparing findMatchScore's {a,b} directly.
export function findMatchWinner(m: ScheduledMatch, results: SavedMatchResult[], tournamentId: string): { side: 'A' | 'B'; shootout?: { scoreA: number; scoreB: number } } | null {
  const score = findMatchScore(m, results, tournamentId);
  if (!score) return null;
  if (score.a > score.b) return { side: 'A' };
  if (score.b > score.a) return { side: 'B' };
  if (m.matchType || !m.completedAt) return null; // genuine unresolved draw (bye/walkover already handled above; incomplete fixture)
  const r = results.find(res =>
    res.tournamentId === tournamentId &&
    ((res.teamAName === m.teamAName && res.teamBName === m.teamBName) ||
     (res.teamAName === m.teamBName && res.teamBName === m.teamAName))
  );
  if (!r?.shootout) return null; // a genuine round-robin draw with no decider
  const straight = r.teamAName === m.teamAName;
  const side: 'A' | 'B' = straight ? r.shootout.winner : (r.shootout.winner === 'A' ? 'B' : 'A');
  const shootout = straight ? { scoreA: r.shootout.scoreA, scoreB: r.shootout.scoreB } : { scoreA: r.shootout.scoreB, scoreB: r.shootout.scoreA };
  return { side, shootout };
}

// Placeholder entrant names generated by the schedule generator for
// not-yet-known bracket slots — "Winner of Quarterfinal 2", "1st Group A".
// A slot only auto-fills while it still holds one of these; once an
// operator manually picks a real team, it's left alone.
export function isPlaceholderTeamName(name: string): boolean {
  return /^(Winner|Loser) of /.test(name) || /^\d+(st|nd|rd|th) /.test(name);
}

// A knockout-generated fixture's `group` is auto-set to its bracket stage
// name (see GenerateScheduleModal) — "Final" / "Semifinal" / "Quarterfinal" /
// "Round of N" — distinct from a real Draw pool group name, so this is how
// the bracket viewer tells which fixtures belong to a knockout tree.
export function knockoutStageSize(stage: string): number {
  if (stage === 'Final') return 2;
  if (stage === 'Semifinal') return 4;
  if (stage === 'Quarterfinal') return 8;
  const m = stage.match(/^Round of (\d+)$/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}
function isKnockoutStage(group?: string): boolean {
  return !!group && (group === 'Final' || group === 'Semifinal' || group === 'Quarterfinal' || /^Round of \d+$/.test(group));
}

// A knockout fixture's stage normally lives on `group` (auto-tagged at
// generation time). Fall back to parsing `round` — "[Category · ]Stage[
// N]" — so fixtures from a "Groups + Knockout" run generated before that
// tagging existed (or any hand-typed knockout fixture) still show up.
export function extractKnockoutStage(m: ScheduledMatch): string | null {
  if (m.group && isKnockoutStage(m.group)) return m.group;
  if (m.round) {
    const afterCategory = m.round.includes(' · ') ? m.round.split(' · ').pop()! : m.round;
    const stageOnly = afterCategory.replace(/\s+\d+$/, '').trim();
    if (isKnockoutStage(stageOnly)) return stageOnly;
  }
  return null;
}

// Bracket geometry — fixed sizes so connector lines can be computed exactly
// rather than measured from the DOM. Each match's vertical center in round r
// is the midpoint of the two matches feeding it in round r-1, so a
// connector line drawn to that exact point always lands dead-center on the
// next match, however many rounds there are.
export const BRACKET_MATCH_H = 60;
export const BRACKET_BASE_GAP = 30;
export const BRACKET_COL_W = 240;
export const BRACKET_COL_GAP = 60;

export function computeBracketCenters(stageCounts: number[]): number[][] {
  if (stageCounts.length === 0) return [];
  const unit0 = BRACKET_MATCH_H + BRACKET_BASE_GAP;
  const centers: number[][] = [Array.from({ length: stageCounts[0] }, (_, i) => unit0 / 2 + i * unit0)];
  for (let r = 1; r < stageCounts.length; r++) {
    const prev = centers[r - 1];
    centers.push(Array.from({ length: stageCounts[r] }, (_, i) =>
      ((prev[2 * i] ?? 0) + (prev[2 * i + 1] ?? prev[2 * i] ?? 0)) / 2
    ));
  }
  return centers;
}

// Read-only bracket graphic for its own tab — pulls fixtures straight from
// the Schedule (no separate bracket data model), grouped by knockout stage.
// If the tournament has categories, each generates its own separate bracket
// (see GenerateScheduleModal) — which one to display is the shared Category
// picker in the top TournamentScopeHeader bar, not a picker local to this tab.
function BracketPanel({ tournament, activeCategory }: { tournament: Tournament; activeCategory: string }) {
  const { matches: allMatches, addMatch, updateMatch } = useMatchScheduleStore();
  const { results: allResults } = useMatchResultsStore();
  const categories = tournament.categories ?? [];
  const category = activeCategory;
  const [editMode, setEditMode] = useState(false);
  const [selectedTeamName, setSelectedTeamName] = useState<string | null>(null);

  // A fixture's category may only live in the `round` prefix ("Men ·
  // Quarterfinal 2") on data generated before the dedicated category field
  // existed — fall back to that so old Groups + Knockout schedules still
  // scope correctly to the picked category.
  const effectiveCategory = (m: ScheduledMatch): string | undefined =>
    m.category ?? (m.round?.includes(' · ') ? m.round.split(' · ')[0] : undefined);

  const matches = useMemo(
    () => allMatches.filter(m =>
      m.tournamentId === tournament.id &&
      (categories.length === 0 || effectiveCategory(m) === category) &&
      !!extractKnockoutStage(m)
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament.id, category, categories.length]
  );

  const thirdPlaceMatch = useMemo(
    () => allMatches.find(m =>
      m.tournamentId === tournament.id &&
      (categories.length === 0 || effectiveCategory(m) === category) &&
      m.group === '3rd Place'
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament.id, category, categories.length]
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

  // The 3rd Place Playoff isn't a normal bracket round (it's fed by the two
  // Semifinal LOSERS, not winners) — position it in the Final's column, below
  // the Final match, and draw its own connector from the Semifinal matches.
  const semifinalStageIdx = stages.findIndex(([name]) => name === 'Semifinal');
  const finalStageIdx = stages.length - 1;
  const finalCenterY = centers[finalStageIdx]?.[0] ?? 0;
  const thirdPlaceY = finalCenterY + BRACKET_MATCH_H + BRACKET_BASE_GAP * 2.5;
  const containerHeight = thirdPlaceMatch
    ? Math.max(bracketHeight, thirdPlaceY + BRACKET_MATCH_H / 2 + 20)
    : bracketHeight;
  const naturalWidth = bracketWidth;
  const naturalHeight = containerHeight + 24;

  // Scales the whole bracket to fill whatever space this tab actually has —
  // a small 2-round bracket in a maximized window would otherwise sit tiny
  // in a sea of whitespace; a big one shrinks to fit instead of forcing a
  // scrollbar. Re-measures on every resize (window resize, panel resize).
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

  const findScore = (m: ScheduledMatch) => findMatchScore(m, allResults, tournament.id);
  const findWinner = (m: ScheduledMatch) => findMatchWinner(m, allResults, tournament.id);

  // Round-1 slot arrangement — lets an operator change which entrant (e.g.
  // "1st Group A") lands in which bracket position, without regenerating the
  // whole schedule. Only Round 1 is editable this way: later rounds are
  // winner placeholders that already get filled in automatically as results
  // come in (see the auto-advance effect in SchedulePanel).
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

  // Retro-fit for a bracket generated without "Play 3rd/4th place" checked —
  // adds the same fixture the generator would have, scheduled alongside the
  // Final, using Semifinal-loser placeholders the auto-advance effect then
  // fills in as each Semifinal is decided.
  const semifinalStage = stages.find(([name]) => name === 'Semifinal');
  const canAddThirdPlace = !!semifinalStage && !thirdPlaceMatch;
  const addThirdPlacePlayoff = () => {
    if (!semifinalStage) return;
    const finalStage = stages.find(([name]) => name === 'Final');
    const refMatch = finalStage?.[1][0] ?? semifinalStage[1][0];
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const prefix = categories.length > 0 ? `${category} · ` : '';
    addMatch({
      tournamentId: tournament.id,
      competition: tournament.name,
      date: refMatch?.date ?? todayStr,
      time: refMatch?.time,
      round: `${prefix}3rd Place Playoff`,
      category: categories.length > 0 ? category : undefined,
      group: '3rd Place',
      teamAName: 'Loser of Semifinal 1', teamAColor: PLACEHOLDER_COLOR,
      teamBName: 'Loser of Semifinal 2', teamBColor: PLACEHOLDER_COLOR,
    });
  };

  return (
    <div className="tm-win-content" style={{ padding: 16, overflow: 'auto' }}>
      <div className="tm-bracket-panel">
        <div className="tm-bracket-modal-header">
          {canAddThirdPlace && (
            <button className="tm-io-btn" onClick={addThirdPlacePlayoff} title="Add a 3rd/4th place playoff between the Semifinal losers">
              🥉 Add 3rd Place Playoff
            </button>
          )}
          {round1Slots.length > 0 && (
            <button
              className={`tm-io-btn${editMode ? ' tm-io-btn--ok' : ''}`}
              onClick={() => setEditMode(v => !v)}
              title="Swap which entrant lands in which Round 1 bracket slot"
            >
              {editMode ? '✓ Done Editing' : '✏️ Edit Arrangement'}
            </button>
          )}
        </div>
        {editMode && (
          <div className="tm-gen-warn" style={{ marginTop: 0 }}>
            ✏️ Edit mode: pick a different entrant in any Round 1 slot to swap it with whoever currently holds that spot.
          </div>
        )}

        {categories.length > 0 && !activeCategory ? (
          <div className="tm-win-placeholder">
            Pick a category from the top bar to view its bracket — each category generates its own separate bracket.
          </div>
        ) : stages.length === 0 ? (
          <div className="tm-win-placeholder">
            No knockout-stage fixtures found{categories.length > 0 ? ' for this category' : ''} — generate one via 🪄 Generate Schedule (Knockout or Groups + Knockout) in the Schedule tab.
          </div>
        ) : (
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
                  const editable = editMode && r === 0;
                  return (
                    <div
                      key={m.id}
                      className={`tm-bracket-match${editable ? ' tm-bracket-match--editing' : ''}`}
                      style={{ position: 'absolute', top: 24 + centerY - BRACKET_MATCH_H / 2, left: 0, width: BRACKET_COL_W, height: BRACKET_MATCH_H }}
                      title={win?.shootout ? `Won on penalties, ${win.shootout.scoreA}-${win.shootout.scoreB}` : undefined}
                    >
                      <div className={`tm-bracket-team${aWins ? ' tm-bracket-team--winner' : ''}`}>
                        <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={m.teamALogo} color={m.teamAColor} /></div>
                        {editable ? (
                          <select className="tm-bracket-slot-select" value={m.teamAName} onChange={e => swapSlot(m.id, 'A', e.target.value)}>
                            {round1Slots.map(s => <option key={`${s.matchId}-${s.side}`} value={s.name}>{s.name}</option>)}
                          </select>
                        ) : (
                          <span className="tm-bracket-team-name tm-bracket-team-name--clickable" onClick={() => setSelectedTeamName(m.teamAName)}>{m.teamAShortName || m.teamAName}</span>
                        )}
                        {score && <span className="tm-bracket-score">{score.a}{win?.shootout && aWins ? <sup className="tm-bracket-pens">p</sup> : null}</span>}
                      </div>
                      <div className={`tm-bracket-team${bWins ? ' tm-bracket-team--winner' : ''}`}>
                        <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={m.teamBLogo} color={m.teamBColor} /></div>
                        {editable && m.teamBName ? (
                          <select className="tm-bracket-slot-select" value={m.teamBName} onChange={e => swapSlot(m.id, 'B', e.target.value)}>
                            {round1Slots.map(s => <option key={`${s.matchId}-${s.side}`} value={s.name}>{s.name}</option>)}
                          </select>
                        ) : (
                          <span
                            className={m.teamBName ? 'tm-bracket-team-name tm-bracket-team-name--clickable' : 'tm-bracket-team-name'}
                            onClick={m.teamBName ? () => setSelectedTeamName(m.teamBName) : undefined}
                          >{m.teamBName ? (m.teamBShortName || m.teamBName) : 'BYE'}</span>
                        )}
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
                      <span className="tm-bracket-team-name tm-bracket-team-name--clickable" onClick={() => setSelectedTeamName(thirdPlaceMatch.teamAName)}>{thirdPlaceMatch.teamAShortName || thirdPlaceMatch.teamAName}</span>
                      {score && <span className="tm-bracket-score">{score.a}{win?.shootout && aWins ? <sup className="tm-bracket-pens">p</sup> : null}</span>}
                    </div>
                    <div className={`tm-bracket-team${bWins ? ' tm-bracket-team--winner' : ''}`}>
                      <div style={{ width: 26, height: 26, flexShrink: 0 }}><ScheduleBadge logo={thirdPlaceMatch.teamBLogo} color={thirdPlaceMatch.teamBColor} /></div>
                      <span
                        className={thirdPlaceMatch.teamBName ? 'tm-bracket-team-name tm-bracket-team-name--clickable' : 'tm-bracket-team-name'}
                        onClick={thirdPlaceMatch.teamBName ? () => setSelectedTeamName(thirdPlaceMatch.teamBName) : undefined}
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
        )}
        {selectedTeamName && (
          <TeamInfoModal
            tournament={tournament}
            teamName={selectedTeamName}
            category={categories.length > 0 ? category : undefined}
            onClose={() => setSelectedTeamName(null)}
          />
        )}
      </div>
    </div>
  );
}

function StandingsPanel({ tournament, activeCategory }: { tournament: Tournament; activeCategory: string }) {
  const { teams: allTeams } = useTeamDbStore();
  const { results: allResults } = useMatchResultsStore();
  const settings = tournament.settings ?? SPORT_DEFAULTS[tournament.sport];
  const teams = useMemo(() => allTeams.filter(t => t.tournamentId === tournament.id), [allTeams, tournament.id]);
  const results = useMemo(() => allResults.filter(r => r.tournamentId === tournament.id), [allResults, tournament.id]);
  const groups = normalizeGroups(tournament.groups);
  const categories = tournament.categories ?? [];
  const [selectedTeam, setSelectedTeam] = useState<{ name: string; category?: string } | null>(null);

  if (teams.length === 0) {
    return (
      <div className="tm-win-content" style={{ padding: 16 }}>
        <div className="tm-win-placeholder">
          <span>Add teams in the 👥 Teams tab to see standings.</span>
        </div>
      </div>
    );
  }

  // Groups/tables for one scope (a category, or the whole tournament when no
  // categories are defined) — untagged groups stay visible in every scope.
  // `categoryValue` is the ACTUAL category to tag a team click with (distinct
  // from `label`, which for the "Uncategorized" bucket is display text, not
  // a real category value) — see TeamInfoModal for why this matters.
  const renderScope = (scopeTeams: SavedTeam[], scopeGroups: TournamentGroup[], label: string | null, categoryValue: string | undefined) => (
    <div key={label ?? '__all__'} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {label && <div className="tm-draw-section-title">{label}</div>}
      {scopeGroups.length === 0 ? (
        <StandingsTable title={label ?? tournament.name} rows={computeStandings(scopeTeams, results, settings)} onTeamClick={name => setSelectedTeam({ name, category: categoryValue })} />
      ) : (
        <>
          {scopeGroups.map(g => (
            <StandingsTable key={g.name} title={g.name} rows={computeStandings(scopeTeams.filter(t => t.group === g.name), results, settings)} onTeamClick={name => setSelectedTeam({ name, category: categoryValue })} />
          ))}
          {scopeTeams.some(t => !t.group) && (
            <StandingsTable title="Unassigned" rows={computeStandings(scopeTeams.filter(t => !t.group), results, settings)} onTeamClick={name => setSelectedTeam({ name, category: categoryValue })} />
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {categories.length === 0 ? (
        renderScope(teams, groups, null, undefined)
      ) : activeCategory ? (
        // A specific category is selected in the top bar — show just that one.
        renderScope(
          teams.filter(t => t.category === activeCategory),
          groups.filter(g => !g.category || g.category === activeCategory),
          activeCategory,
          activeCategory
        )
      ) : (
        <>
          {categories.map(c => renderScope(
            teams.filter(t => t.category === c),
            groups.filter(g => !g.category || g.category === c),
            c,
            c
          ))}
          {teams.some(t => !t.category) && renderScope(
            teams.filter(t => !t.category),
            groups.filter(g => !g.category),
            'Uncategorized',
            undefined
          )}
        </>
      )}
      {selectedTeam && (
        <TeamInfoModal tournament={tournament} teamName={selectedTeam.name} category={selectedTeam.category} onClose={() => setSelectedTeam(null)} />
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

function DrawPanel({ tournament, activeCategory }: { tournament: Tournament; activeCategory: string }) {
  const { teams: allTeams, updateTeam } = useTeamDbStore();
  const { updateTournament } = useTournamentStore();
  const { client, vmixState } = useVmixStore();
  const allVmixInputs = vmixState?.inputs ?? [];
  const { liveSyncDraw, setLiveSyncDraw } = useAppSettings();
  // Only a non-host interactive (9877) client can push to the host — 9878
  // readonly and 9879 commentator clients never edit.
  const isRemoteInteractive = !isHostClient && !syncClient.isReadOnly && !syncClient.isCommentator;
  const categories = tournament.categories ?? [];
  // Which category's draw is in view — groups/pots/teams tagged for another
  // category are hidden, so each category runs its own independent draw.
  // Untagged groups/pots/teams stay visible everywhere (keeps
  // single-category tournaments working exactly as before). Picked from the
  // shared Category selector in the top TournamentScopeHeader bar, not a
  // picker local to this tab.
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
function TournamentScopeHeader({ tournaments, selectedId, onSelect, categories, activeCategory, onSelectCategory, children }: {
  tournaments: Tournament[]; selectedId: string; onSelect: (id: string) => void;
  categories: string[]; activeCategory: string; onSelectCategory: (c: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="tm-scope-header">
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>🏆 Tournament:</span>
      <select className="tm-input" style={{ fontSize: 15, padding: '6px 10px', height: 34, maxWidth: 360, flex: 'none' }}
        value={selectedId} onChange={e => onSelect(e.target.value)}>
        {tournaments.length === 0 && <option value="">— none —</option>}
        {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      {categories.length > 0 && (
        <>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Category:</span>
          <div className="tm-scope-cat-bar">
            <button
              className={`tm-scope-cat-btn${!activeCategory ? ' tm-scope-cat-btn--active' : ''}`}
              onClick={() => onSelectCategory('')}
            >All</button>
            {categories.map(c => (
              <button
                key={c}
                className={`tm-scope-cat-btn${activeCategory === c ? ' tm-scope-cat-btn--active' : ''}`}
                onClick={() => onSelectCategory(c)}
              >{c}</button>
            ))}
          </div>
        </>
      )}
      {children}
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
  const [tab, setTab] = useState<'tournaments' | 'teams' | 'players' | 'schedule' | 'results' | 'standings' | 'bracket' | 'draw'>('tournaments');
  // Single category selector shared by every tournament-scoped tab (Schedule,
  // Standings, Bracket, Draw) — lives here instead of each tab having its own,
  // so switching category in one place scopes the whole window consistently.
  const [activeCategory, setActiveCategory] = useState('');
  const { teams } = useTeamDbStore();
  const { matches: scheduledMatches, updateMatch } = useMatchScheduleStore();
  const { results: savedResults, addResult, updateResult, deleteResult } = useMatchResultsStore();

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

  // A category picked in one tournament makes no sense once you switch to a
  // different one (or one that doesn't even have that category) — reset.
  useEffect(() => { setActiveCategory(''); }, [selectedId]);

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
  // Earliest/latest fixture date, offered as a default date range when
  // "pushing" this tournament to the cloud as a new Event — nothing to
  // derive it from until fixtures exist, so undefined (today) otherwise.
  const scopedDateRange = useMemo(() => {
    const dates = scopedMatches.map(m => m.date).filter(Boolean).sort();
    return dates.length > 0 ? { start: dates[0], end: dates[dates.length - 1] } : undefined;
  }, [scopedMatches]);

  // The four effects below used to live inside SchedulePanel, which only
  // mounts while the Schedule tab is active — so setting a team to Walkover
  // from the Team Database tab did nothing to Bracket/Standings until the
  // operator happened to visit Schedule. Living here instead (this component
  // is mounted for as long as a tournament is selected, regardless of tab)
  // means they keep running no matter which tab is open.

  // Bye/Walkover are fully automatic, no manual per-fixture picker: a fixture
  // with no Team B name is a bye; a fixture where either team currently has
  // 'walkover' status set in the Team Database is a walkover for that side.
  // Keeps every not-yet-completed fixture in sync as fixtures/team statuses change.
  useEffect(() => {
    if (!selected) return;
    const win = selected.settings?.walkoverWinScore ?? SPORT_DEFAULTS[selected.sport].walkoverWinScore;
    const statusOf = (name: string, shortName?: string) => {
      const key = name.trim().toLowerCase();
      const shortKey = (shortName ?? '').trim().toLowerCase();
      return scopedTeams.find(t =>
        t.name.trim().toLowerCase() === key || (!!shortKey && (t.shortName ?? '').trim().toLowerCase() === shortKey)
      )?.status;
    };
    for (const m of scopedMatches) {
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
  }, [scopedMatches, scopedTeams, selected?.settings?.walkoverWinScore, selected?.sport]);

  // A bye/walkover has no live match to run on a scoreboard, so it never
  // reaches the normal "Save Result" step — without this, the score set on
  // the fixture just sits on the Schedule row and never becomes a Result,
  // which looked like "the score I set doesn't show up, it's stuck at 0-0".
  // Writes/updates/removes a linked Result directly as the fixture changes.
  useEffect(() => {
    if (!selected) return;
    for (const m of scopedMatches) {
      const existing = scopedResults.find(r => r.sourceScheduleId === m.id);
      if (m.matchType) {
        const data = {
          tournamentId: selected.id,
          date: m.date, time: m.time,
          competition: m.competition ?? selected.name, round: m.round, category: m.category,
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
          existing.category !== data.category ||
          existing.date !== data.date || existing.time !== data.time ||
          existing.teamAName !== data.teamAName || existing.teamBName !== data.teamBName ||
          existing.teamAShortName !== data.teamAShortName || existing.teamBShortName !== data.teamBShortName
        ) {
          updateResult(existing.id, data);
        }
      } else if (existing && existing.matchType) {
        // Only ever remove a result THIS effect auto-generated (existing.matchType
        // set means it came from the bye/walkover branch above) — a normal result
        // saved from a live-played match has no matchType and must never be
        // touched here just because its fixture currently isn't a bye/walkover.
        deleteResult(existing.id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedMatches, scopedResults, selected?.id, selected?.name]);

  // Knockout bracket auto-advance: once a stage's match has a decided winner
  // (bye/walkover, or a completed regular match with a saved result), that
  // winner is written into its slot in the next stage's match — but only
  // while that slot still holds a placeholder ("Winner of …", "1st Group
  // A"); a manually-picked real team is never overwritten. Scoped per
  // category, since each category's bracket (see GenerateScheduleModal)
  // advances independently.
  useEffect(() => {
    if (!selected) return;
    const categories = selected.categories ?? [];
    const buckets: (string | undefined)[] = categories.length > 0 ? categories : [undefined];
    const matchIndexOf = (m: ScheduledMatch) => {
      const mm = m.round?.match(/(\d+)\s*$/);
      return mm ? parseInt(mm[1], 10) - 1 : 0;
    };
    for (const cat of buckets) {
      const bracketMatches = scopedMatches.filter(m => (cat === undefined || m.category === cat) && !!extractKnockoutStage(m));
      const thirdPlaceMatch = scopedMatches.find(m => (cat === undefined || m.category === cat) && m.group === '3rd Place');
      const byStage = new Map<string, ScheduledMatch[]>();
      for (const m of bracketMatches) {
        const key = extractKnockoutStage(m)!;
        if (!byStage.has(key)) byStage.set(key, []);
        byStage.get(key)!.push(m);
      }
      const stages = Array.from(byStage.entries()).sort((a, b) => knockoutStageSize(b[0]) - knockoutStageSize(a[0]));
      for (let r = 0; r < stages.length - 1; r++) {
        const stageName = stages[r][0];
        const curMatches = stages[r][1];
        const nextMatches = stages[r + 1][1];
        const nextByIndex = new Map(nextMatches.map(m => [matchIndexOf(m), m]));
        for (const cur of curMatches) {
          const win = findMatchWinner(cur, scopedResults, selected.id);
          if (!win) continue;
          const k = matchIndexOf(cur);
          const slot: 'A' | 'B' = k % 2 === 0 ? 'A' : 'B';
          const winner = win.side === 'A'
            ? { name: cur.teamAName, shortName: cur.teamAShortName, color: cur.teamAColor, logo: cur.teamALogo }
            : { name: cur.teamBName, shortName: cur.teamBShortName, color: cur.teamBColor, logo: cur.teamBLogo };
          const next = nextByIndex.get(Math.floor(k / 2));
          if (next && winner.name) {
            const curName = slot === 'A' ? next.teamAName : next.teamBName;
            if (curName !== winner.name && isPlaceholderTeamName(curName)) {
              updateMatch(next.id, slot === 'A'
                ? { teamAName: winner.name, teamAShortName: winner.shortName, teamAColor: winner.color, teamALogo: winner.logo }
                : { teamBName: winner.name, teamBShortName: winner.shortName, teamBColor: winner.color, teamBLogo: winner.logo });
            }
          }
          // 3rd/4th place playoff: the Semifinal LOSER fills the corresponding slot.
          if (thirdPlaceMatch && stageName === 'Semifinal') {
            const loser = win.side === 'A'
              ? { name: cur.teamBName, shortName: cur.teamBShortName, color: cur.teamBColor, logo: cur.teamBLogo }
              : { name: cur.teamAName, shortName: cur.teamAShortName, color: cur.teamAColor, logo: cur.teamALogo };
            if (loser.name) {
              const curName = slot === 'A' ? thirdPlaceMatch.teamAName : thirdPlaceMatch.teamBName;
              if (curName !== loser.name && isPlaceholderTeamName(curName)) {
                updateMatch(thirdPlaceMatch.id, slot === 'A'
                  ? { teamAName: loser.name, teamAShortName: loser.shortName, teamAColor: loser.color, teamALogo: loser.logo }
                  : { teamBName: loser.name, teamBShortName: loser.shortName, teamBColor: loser.color, teamBLogo: loser.logo });
              }
            }
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedMatches, scopedResults, selected?.id, selected?.categories]);

  // Groups → Knockout auto-fill: once every fixture in a Draw group's
  // round-robin stage is decided (completed or bye/walkover), that group's
  // final standings are computed and used to fill any "1st Group A"/"2nd
  // Group A" placeholder still sitting in the knockout stage — same
  // placeholder-only rule as the bracket auto-advance above, so a manual
  // pick is never overwritten.
  useEffect(() => {
    if (!selected) return;
    const allGroups = normalizeGroups(selected.groups);
    const categories = selected.categories ?? [];
    const buckets: (string | undefined)[] = categories.length > 0 ? categories : [undefined];
    const settings = selected.settings ?? SPORT_DEFAULTS[selected.sport];
    const placeholderRe = /^(\d+)(?:st|nd|rd|th) (.+)$/;

    for (const cat of buckets) {
      const catGroups = allGroups.filter(g => cat === undefined || !g.category || g.category === cat);
      if (catGroups.length === 0) continue;
      const bracketMatches = scopedMatches.filter(m => (cat === undefined || m.category === cat) && !!extractKnockoutStage(m));
      if (bracketMatches.length === 0) continue;

      const standingsByGroup = new Map<string, ReturnType<typeof computeStandings>>();
      for (const g of catGroups) {
        const groupMatches = scopedMatches.filter(m => m.group === g.name);
        if (groupMatches.length === 0) continue;
        if (!groupMatches.every(m => !!m.completedAt || !!m.matchType)) continue;
        const groupTeams = scopedTeams.filter(t => t.group === g.name && (cat === undefined || t.category === cat));
        standingsByGroup.set(g.name, computeStandings(groupTeams, scopedResults, settings));
      }
      if (standingsByGroup.size === 0) continue;

      for (const m of bracketMatches) {
        for (const side of ['A', 'B'] as const) {
          const curName = side === 'A' ? m.teamAName : m.teamBName;
          const placeholderMatch = curName?.match(placeholderRe);
          if (!placeholderMatch) continue;
          const rank = parseInt(placeholderMatch[1], 10);
          const groupName = placeholderMatch[2];
          const standing = standingsByGroup.get(groupName)?.[rank - 1];
          if (!standing) continue;
          updateMatch(m.id, side === 'A'
            ? { teamAName: standing.name, teamAShortName: standing.shortName, teamAColor: standing.color, teamALogo: standing.logo }
            : { teamBName: standing.name, teamBShortName: standing.shortName, teamBColor: standing.color, teamBLogo: standing.logo });
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedMatches, scopedResults, scopedTeams, selected?.id, selected?.categories, selected?.groups, selected?.settings, selected?.sport]);

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
            onClick={() => setTab('bracket')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'bracket' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'bracket' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >🏆 Bracket</button>
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
        {tab === 'teams' || tab === 'players' || tab === 'schedule' || tab === 'results' || tab === 'standings' || tab === 'bracket' || tab === 'draw' ? (
          <div className="tm-win-body--scoped">
            <TournamentScopeHeader
              tournaments={tournaments} selectedId={selectedId} onSelect={selectTournament}
              categories={selected?.categories ?? []} activeCategory={activeCategory} onSelectCategory={setActiveCategory}
            />
            {!selected ? (
              <div className="tm-win-placeholder">
                <span>Create a tournament first in the 🏆 Tournaments tab.</span>
              </div>
            ) : tab === 'teams' ? (
              <TeamsPanel tournament={selected} />
            ) : tab === 'players' ? (
              <PlayersPanel tournament={selected} activeCategory={activeCategory} />
            ) : tab === 'schedule' ? (
              <SchedulePanel tournament={selected} activeCategory={activeCategory} />
            ) : tab === 'standings' ? (
              <StandingsPanel tournament={selected} activeCategory={activeCategory} />
            ) : tab === 'bracket' ? (
              <BracketPanel tournament={selected} activeCategory={activeCategory} />
            ) : tab === 'draw' ? (
              <DrawPanel tournament={selected} activeCategory={activeCategory} />
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
                    className={`tm-btn${selected.cloudSyncEnabled ? ' tm-btn--cloud-active' : ''}`}
                    title={selected.cloudSyncEnabled
                      ? 'Cloud Sync is ON — this tournament\'s fixtures/results push to and pull from every other venue on the same account'
                      : 'Cloud Sync is OFF — this tournament stays local to this device only'}
                    onClick={() => updateTournament(selected.id, { cloudSyncEnabled: !selected.cloudSyncEnabled })}
                  >{selected.cloudSyncEnabled ? '☁ Cloud Sync On' : '☁ Cloud Sync Off'}</button>
                  <EventPicker
                    defaultName={selected.name}
                    defaultDateRange={scopedDateRange}
                    onPick={ev => updateTournament(selected.id, { eventId: ev.id, eventName: ev.name, cloudSyncEnabled: true })}
                  />
                  {selected.eventId && (
                    <span className="tm-event-linked-badge" title={`Linked to event: ${selected.eventName ?? selected.eventId}`}>
                      🔗 {selected.eventName ?? 'Linked event'}
                    </span>
                  )}
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
