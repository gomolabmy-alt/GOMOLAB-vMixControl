import { useState, useRef, useEffect, useMemo, Fragment } from 'react';
import {
  Check, X, Pencil, ArrowUp, ArrowDown, Play, Unlock, Users, Square, Wand2,
  AlertTriangle, CheckSquare, Trash2, ChevronRight, Circle, MapPin, RefreshCw,
  Timer, Target, Clock, CalendarDays, Clapperboard, Settings, ClipboardList,
  FlagTriangleRight, Dices, Hand, MousePointerClick, PartyPopper, EyeOff, Eye,
  Hourglass, RotateCcw, ChevronDown, Radio, Trophy, Search, Maximize2, Minimize2,
  Shirt, Lock, Link2, Cloud, Star, Save, Undo2, Award, ArrowRight, ArrowLeftRight,
  ListChecks, Plus,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { createPortal } from 'react-dom';
import { useTournamentStore, pushTournamentDataToHost } from '../stores/tournamentStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { syncClient } from '../lib/syncClient';
import { useVmixStore } from '../stores/vmixStore';
import { ConfirmButton } from './ConfirmButton';
import { EventPicker, type RemoteEvent } from './EventPicker';
import { useCanvasStore, formatTime } from '../stores/canvasStore';
import type { Tournament, SportType, TournamentSettings, TournamentGroup, TournamentPot, GroupListVmixTarget } from '../types/tournament';
import { SPORT_LABELS, SPORT_POSITIONS, SPORT_DEFAULTS, getRosterPositions } from '../types/tournament';
import type { Player } from '../types/tournament';
import { LogoUrlPicker } from './LogoUrlPicker';
import { InputPickerDropdown, RUGBY_UNION_INCS, RUGBY_LEAGUE_INCS } from './WidgetConfigPanel';
import { BracketView } from './BracketView';
import { ConfirmModal } from './ConfirmModal';
import { ExternalRosterLinkBar, PullPlayersButton } from './ExternalRosterPicker';
import { periodLabel } from './widgets/TimerWidget';
import { autoLinkedWidget } from '../lib/autoLink';
import {
  generateRoundRobin, generateDoubleRoundRobin, generateKnockout, generateKnockoutFromSlots,
  buildGroupKnockoutSlots, buildTieredKnockout, buildRankedPlacementKnockout, tierRank, offsetRounds, shuffle,
  ensureTopTeamHomeEarly, isPlacementRoundLabel, placementRoundRange,
  PLACEHOLDER_COLOR, type ScheduleTeamRef, type GeneratedFixture,
} from '../lib/scheduleGen';
import { useTeamDbStore, type SavedTeam } from '../stores/teamDbStore';
import { useMatchScheduleStore, type ScheduledMatch } from '../stores/matchScheduleStore';
import { useMatchResultsStore, type SavedMatchResult } from '../stores/matchResultsStore';
import { useRundownStore, sortRundownSegments, deriveRundownStatus, type RundownSegment } from '../stores/rundownStore';
import { resolveImageUrl, transparentLogoUrl } from '../lib/imageUrl';
import { guardScoreboardOverwrite, buildLoadMatchPatch, useLiveFixtureIds, useLiveScoreboardConfigs, findDuplicateResult, formatLate, parseScheduledDateTime } from '../utils/scoreboardSnapshot';
import { pushTournamentNow, computePushDiff, pushResultsOnly, pullResultsOnly, localizeTournamentLogos, type PushDiffItem } from '../lib/cloudSync';
import { simplifyPlayerName } from '../lib/simpleName';
import { computeMatchNumbers, useMatchNumbers } from '../utils/matchNumber';
import { sortResults, RESULT_SORT_LABELS, type ResultSortMode } from '../utils/resultSort';

// ── Import / Export helpers ───────────────────────────────────────────────────

// Native "Save As" dialog (see src-tauri/src/commands.rs's
// save_text_file_dialog) so an export lands wherever/whatever name the
// operator actually wants, instead of the old <a download> trick's fixed
// auto-generated name landing silently in the default downloads folder.
// Resolves quietly (no error) if the operator just cancels the dialog.
async function saveTextFile(content: string, filename: string): Promise<void> {
  try {
    await invoke('save_text_file_dialog', { defaultName: filename, content });
  } catch (err) {
    console.error('Export failed:', err);
    alert('Failed to save file.');
  }
}

async function exportTeamCSV(players: Player[], teamName: string) {
  const escape = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
  const header = '#,Name,Position';
  const rows = [...players]
    .sort((a, b) => (parseInt(a.jerseyNo) || 999) - (parseInt(b.jerseyNo) || 999))
    .map(p => [escape(p.jerseyNo), escape(p.name), escape(p.position)].join(','));
  const csv = [header, ...rows].join('\r\n');
  await saveTextFile(csv, `${teamName.replace(/[^a-z0-9]/gi, '_')}_players.csv`);
}

// Builds and saves a CSV file from a header row + data rows, quoting every
// cell — shared by the Schedule and Results tab exporters below.
async function downloadCSV(header: string[], rows: string[][], filename: string) {
  const escape = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
  const csv = [header, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
  // Leading UTF-8 BOM — without it, Excel very often misdetects the file's
  // encoding as the system's ANSI codepage instead of UTF-8, silently
  // mangling non-ASCII characters (the "·" separator used throughout round
  // text, e.g. "BOYS · Cup · Final") the moment the file is opened there,
  // and permanently corrupting them on save — which would then make a
  // re-imported row's round text fail to match anything on the way back in.
  const BOM = '\uFEFF'; // U+FEFF zero-width no-break space, used here as a UTF-8 signature
  await saveTextFile(BOM + csv, filename);
}

function exportFixturesCSV(
  matches: ScheduledMatch[], tournamentName: string,
  matchNumberPrefix: string | undefined, venuePrefixes: Record<string, string> | undefined,
) {
  // Match # and Tier are appended LAST, after the columns the CSV importer
  // expects (see parseFixtureFile) — it parses columns purely positionally
  // and ignores anything past the 8th, so a re-imported/edited export still
  // round-trips cleanly; both trailing columns are read-only/informational
  // on import. Tier only ever differs from Group/Round for a Cup/Plate/
  // Bowl/Shield or ranked-placement tournament (see findTierMismatches) —
  // included so a corrupted tier (a drag/swap leaving the wrong one behind)
  // is directly visible/diffable in the export instead of only showing up
  // in the app's own Schedule/Bracket tabs.
  const header = ['Date', 'Time', 'Team A', 'Team B', 'Venue', 'Category', 'Group', 'Round', 'Match #', 'Tier'];
  // Same computed "MB1"/"MC1"-style id shown as a badge in the Schedule tab
  // (see matchNumber.ts) — blank for every row if the tournament hasn't set
  // a match number prefix, same as the badge not showing there either.
  const matchNumbers = computeMatchNumbers(matches, matchNumberPrefix, venuePrefixes);
  const rows = matches.map(m => [
    m.date, m.time ?? '', m.teamAName, m.teamBName, m.venue ?? '', m.category ?? '', m.group ?? '', m.round ?? '',
    matchNumbers.get(m.id) ?? '', m.tier ?? '',
  ]);
  downloadCSV(header, rows, `${tournamentName.replace(/[^a-z0-9]/gi, '_')}_schedule.csv`);
}

function exportResultsCSV(results: SavedMatchResult[], tournamentName: string) {
  const header = ['Date', 'Round', 'Team A', 'Score A', 'Score B', 'Team B'];
  const rows = results.map(r => [r.date, r.round ?? '', r.teamAName, String(r.scoreA), String(r.scoreB), r.teamBName]);
  downloadCSV(header, rows, `${tournamentName.replace(/[^a-z0-9]/gi, '_')}_results.csv`);
}

async function downloadJSON(data: unknown, filename: string) {
  await saveTextFile(JSON.stringify(data, null, 2), filename);
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
// RFC 4180-correct: a doubled quote INSIDE a quoted field ("") is a literal
// quote character, not a close-then-reopen — e.g. a team name like
// `Johor "Tigers"` round-trips as `"Johor ""Tigers"""` through downloadCSV's
// escaper, and naively toggling on every single '"' (the old behavior here)
// silently dropped both quote characters on reimport instead of restoring
// the literal `"Tigers"` substring.
function splitDelimitedRow(line: string, sep: string): string[] {
  if (sep === '\t') return line.split('\t').map(c => c.trim());
  const cols: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
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

// Opening/editing/re-saving a CSV in Excel very commonly reformats a
// date-looking column on its own, even if that column was never touched —
// silently requiring the export's exact "YYYY-MM-DD" would drop every row of
// a re-imported file whenever this happens, which looked indistinguishable
// from the import just doing nothing. Tries the unambiguous numeric cases
// deterministically first (no locale-dependent Date parsing, so e.g.
// "13/07/2026" is never misread), then falls back to the browser's own date
// parser for anything else (e.g. a textual month like "25-Jul-2026") rather
// than giving up.
function normalizeDateCell(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const pad = (n: number) => String(n).padStart(2, '0');
  const numeric = s.match(/^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (numeric) {
    const [, a, b, c] = numeric;
    if (a.length === 4) { // Y/M/D or Y-M-D
      const month = parseInt(b, 10), day = parseInt(c, 10);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${a}-${pad(month)}-${pad(day)}`;
    } else {
      let month = parseInt(a, 10), day = parseInt(b, 10);
      const year = c.length === 2 ? `20${c}` : c;
      if (month > 12 && day <= 12) [month, day] = [day, month]; // was actually D/M/Y
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  // Last resort — e.g. "25 Jul 2026", "Jul 25, 2026". Only trusted when the
  // text contains letters (an actual month name), so a purely-numeric cell
  // that didn't match the deterministic parse above (genuinely ambiguous,
  // like "13-14-15") is rejected instead of guessed at.
  if (/[A-Za-z]/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return null;
}

// Excel commonly reformats a time-looking cell to 12-hour "H:MM AM/PM" on
// open/edit/save — the controller only ever stores/edits time in 24-hour
// "HH:MM" internally (EditableTime's native <input type="time"> requires
// exactly that), so anything else needs converting to the controller's own
// format rather than being carried through as a string the time picker
// can't display. An unrecognized format is dropped (left blank) rather than
// writing something the rest of the app can't use.
function normalizeTimeCell(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const hh = parseInt(h24[1], 10), mm = parseInt(h24[2], 10);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return `${String(hh).padStart(2, '0')}:${h24[2]}`;
  }
  const h12 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])$/);
  if (h12) {
    let hh = parseInt(h12[1], 10);
    const mm = h12[2];
    if (hh >= 1 && hh <= 12) {
      const isPM = /p/i.test(h12[3]);
      if (hh === 12) hh = 0;
      if (isPM) hh += 12;
      return `${String(hh).padStart(2, '0')}:${mm}`;
    }
  }
  return undefined;
}

// Expected columns: Date (YYYY-MM-DD, or a common alternate format — see
// normalizeDateCell), Time (24h "HH:MM", or 12h "H:MM AM/PM" — see
// normalizeTimeCell), Team A, Team B, Venue, Category, Group, Round. Only
// Date + both team names are required; the rest may be left blank.
function parseFixtureFile(text: string): ParsedFixtureRow[] {
  // Strip a leading UTF-8 BOM if the file has one (FileReader.readAsText
  // usually handles this itself, but not consistently across every tool
  // that might touch the file in between) — left in place, it would glue
  // onto the very first cell and make just that one row fail to parse.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';

  const result: ParsedFixtureRow[] = [];
  for (const line of lines) {
    // splitDelimitedRow already fully un-quotes/unescapes CSV cells (see its
    // own doc comment) — stripping a leading/trailing quote again here would
    // wrongly truncate a value that legitimately ends in one (e.g. a team
    // name like `Johor "Tigers"`). TSV cells never go through that quoting
    // logic at all (plain split on tab), so the extra strip is still needed
    // there as a defensive fallback for a tool (Excel) that quoted them anyway.
    const cols = splitDelimitedRow(line, sep).map(c => sep === '\t' ? c.replace(/^"|"$/g, '').trim() : c);
    const [dateRaw = '', timeRaw = '', teamAName = '', teamBName = '', venue = '', category = '', group = '', round = ''] = cols;
    if (/^date$/i.test(dateRaw)) continue; // header row
    const date = normalizeDateCell(dateRaw);
    if (!date) continue;
    if (!teamAName || !teamBName) continue;
    result.push({
      date, time: normalizeTimeCell(timeRaw), teamAName, teamBName,
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

// Same field set as the external roster API (see externalRoster.ts) — kept
// as one ordered list so the compact edit-row inputs and the read-mode
// summary badge can't drift out of sync with each other.
const PLAYER_STAT_FIELDS: { key: keyof Player & ('tries' | 'conversions' | 'penalties' | 'dropGoals' | 'yellowCards' | 'redCards' | 'appearances'); short: string; label: string }[] = [
  { key: 'tries', short: 'T', label: 'Tries' },
  { key: 'conversions', short: 'C', label: 'Conversions' },
  { key: 'penalties', short: 'P', label: 'Penalties' },
  { key: 'dropGoals', short: 'DG', label: 'Drop Goals' },
  { key: 'yellowCards', short: 'YC', label: 'Yellow Cards' },
  { key: 'redCards', short: 'RC', label: 'Red Cards' },
  { key: 'appearances', short: 'APP', label: 'Appearances' },
];

// ── Player row ────────────────────────────────────────────────────────────────
function PlayerRow({ player, positions, onUpdate, onDelete }: {
  player: Player; positions: string[];
  onUpdate: (patch: Partial<Omit<Player, 'id'>>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [jersey, setJersey] = useState(player.jerseyNo);
  const [name, setName] = useState(player.name);
  const [pos, setPos] = useState(player.position);
  const [stats, setStats] = useState<Partial<Record<typeof PLAYER_STAT_FIELDS[number]['key'], number | undefined>>>(() =>
    Object.fromEntries(PLAYER_STAT_FIELDS.map(f => [f.key, player[f.key]]))
  );
  // Simple Names (App Settings) — the read-only row display only; the
  // edit-mode input above always shows/edits the real stored name.
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const dispName = simplifyPlayerName(player.name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

  const save = () => {
    onUpdate({ jerseyNo: jersey.trim(), name: name.trim() || player.name, position: pos.trim(), ...stats });
    setEditing(false);
  };

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
        {PLAYER_STAT_FIELDS.map(f => (
          <input
            key={f.key} type="number" min={0} title={f.label}
            className="tm-pl-cell tm-pl-cell--stat tm-input"
            value={stats[f.key] ?? ''}
            onChange={e => setStats(s => ({ ...s, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) }))}
          />
        ))}
        <div className="tm-pl-cell tm-pl-cell--actions">
          <button className="tm-icon-btn tm-icon-btn--save" onClick={save} title="Save"><Check size={14} strokeWidth={2} /></button>
          <button className="tm-icon-btn" onClick={() => setEditing(false)} title="Cancel"><X size={14} strokeWidth={2} /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="tm-pl-row" onDoubleClick={() => setEditing(true)}>
      <span className="tm-pl-cell tm-pl-cell--jersey">{player.jerseyNo || '—'}</span>
      <span className="tm-pl-cell tm-pl-cell--name">{dispName}</span>
      <span className="tm-pl-cell tm-pl-cell--pos">{player.position}</span>
      {PLAYER_STAT_FIELDS.map(f => (
        <span key={f.key} className="tm-pl-cell tm-pl-cell--stat">{player[f.key] ?? ''}</span>
      ))}
      <div className="tm-pl-cell tm-pl-cell--actions">
        <button className="tm-icon-btn tm-icon-btn--edit" onClick={() => setEditing(true)} title="Edit"><Pencil size={14} strokeWidth={2} /></button>
        <button className="tm-icon-btn tm-icon-btn--del" onClick={e => { e.stopPropagation(); onDelete(); }} title="Delete">×</button>
      </div>
    </div>
  );
}

// ── Add-player row ────────────────────────────────────────────────────────────
function AddPlayerRow({ positions, onAdd }: {
  positions: string[]; onAdd: (p: Omit<Player, 'id'>) => void;
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
      {PLAYER_STAT_FIELDS.map(f => <span key={f.key} className="tm-pl-cell tm-pl-cell--stat" />)}
      <div className="tm-pl-cell tm-pl-cell--actions">
        <button className="tm-icon-btn tm-icon-btn--save" type="submit" disabled={!name.trim()} title="Add player">+</button>
      </div>
    </form>
  );
}

// ── Jersey sets (alternate kits) ────────────────────────────────────────────
function JerseySetsPanel({ team }: { team: SavedTeam }) {
  const { addJerseySet, updateJerseySet, deleteJerseySet, setJerseySetNumber } = useTeamDbStore();
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });
  const sets = team.jerseySets ?? [];
  const [expanded, setExpanded] = useState(sets.length > 0);
  const [activeSetId, setActiveSetId] = useState(sets[0]?.id ?? '');

  useEffect(() => {
    if (!sets.find(s => s.id === activeSetId)) setActiveSetId(sets[0]?.id ?? '');
  }, [sets, activeSetId]);

  const activeSet = sets.find(s => s.id === activeSetId);

  // Only numbered players are meaningful here — a player whose base jerseyNo
  // is a role marker (MNG/HC) always shows as that role badge in the Player
  // List widget regardless of any set override, so an override for them
  // would be inert.
  const numberedPlayers = [...team.players]
    .filter(p => p.jerseyNo && !isNaN(parseInt(p.jerseyNo)))
    .sort((a, b) => (parseInt(a.jerseyNo) || 999) - (parseInt(b.jerseyNo) || 999) || a.name.localeCompare(b.name));

  return (
    <div className="tm-jersey-sets">
      <button className="tm-jersey-sets-toggle" onClick={() => setExpanded(v => !v)}>
        {expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
        <Shirt size={13} strokeWidth={2} />
        <span>Jersey Sets{sets.length > 0 ? ` (${sets.length})` : ''}</span>
      </button>
      {expanded && (
        <div className="tm-jersey-sets-body">
          <div className="tm-jersey-set-tabs">
            {sets.map(s => (
              <div
                key={s.id}
                className={`tm-jersey-set-tab${s.id === activeSetId ? ' tm-jersey-set-tab--active' : ''}`}
                onClick={() => setActiveSetId(s.id)}
              >
                <EditableText value={s.name} onChange={name => updateJerseySet(team.id, s.id, { name })} placeholder="Set name" />
                <button
                  className="tm-jersey-set-tab-del"
                  title="Delete jersey set"
                  onClick={e => { e.stopPropagation(); deleteJerseySet(team.id, s.id); }}
                ><Trash2 size={12} strokeWidth={2} /></button>
              </div>
            ))}
            <button
              className="tm-jersey-set-add"
              onClick={() => setActiveSetId(addJerseySet(team.id, `Kit ${sets.length + 1}`))}
            ><Plus size={12} strokeWidth={2} /> Add set</button>
          </div>
          {activeSet ? (
            numberedPlayers.length === 0 ? (
              <p className="tm-jersey-sets-hint">Add numbered players to the roster first.</p>
            ) : (
              <div className="tm-jersey-set-grid">
                {numberedPlayers.map(p => (
                  <div key={p.id} className="tm-jersey-set-row">
                    <span className="tm-jersey-set-base" title="Base number">{p.jerseyNo}</span>
                    <input
                      key={`ov-${p.id}-${activeSet.numbers[p.id] ?? ''}`}
                      className="tm-input tm-jersey-set-override"
                      defaultValue={activeSet.numbers[p.id] ?? ''}
                      placeholder={p.jerseyNo}
                      maxLength={3}
                      onBlur={e => setJerseySetNumber(team.id, activeSet.id, p.id, e.target.value.trim())}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                    <span className="tm-jersey-set-name">{disp(p.name)}</span>
                  </div>
                ))}
              </div>
            )
          ) : (
            <p className="tm-jersey-sets-hint">
              Add a set (e.g. "Home", "Away") to give this team different numbers per kit — leave a
              player's box blank to keep their base number. The Player List widget will prompt which
              set to use once there are 2 or more.
            </p>
          )}
        </div>
      )}
    </div>
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

      {(tournament.sport === 'rugby_union' || tournament.sport === 'rugby_league') && (
        <div className="tm-settings-group">
          <label className="tm-settings-label" title="Quick-fills Starters/Subs above with each format's usual squad size — the numbers stay freely editable afterward">Format</label>
          <div className="tm-timer-mode-toggle">
            <button className="tm-timer-mode-btn" title="7 starters, 5 subs" onClick={() => updateTournamentSettings(tournament.id, { maxOnField: 7, maxSubs: 5 })}>7s</button>
            <button className="tm-timer-mode-btn" title="10 starters, 5 subs" onClick={() => updateTournamentSettings(tournament.id, { maxOnField: 10, maxSubs: 5 })}>10s</button>
            <button className="tm-timer-mode-btn" title="15 starters, 8 subs" onClick={() => updateTournamentSettings(tournament.id, { maxOnField: 15, maxSubs: 8 })}>15s</button>
          </div>
        </div>
      )}

      <div className="tm-settings-group">
        <label className="tm-settings-label">Timer</label>
        <div className="tm-timer-mode-toggle">
          <button
            className={`tm-timer-mode-btn ${(s.timerMode ?? 'countup') === 'countup' ? 'tm-timer-mode-btn--active' : ''}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => updateTournamentSettings(tournament.id, { timerMode: 'countup' })}
          ><ArrowUp size={14} strokeWidth={2} /> Up</button>
          <button
            className={`tm-timer-mode-btn ${(s.timerMode ?? 'countup') === 'countdown' ? 'tm-timer-mode-btn--active' : ''}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => updateTournamentSettings(tournament.id, { timerMode: 'countdown' })}
          ><ArrowDown size={14} strokeWidth={2} /> Down</button>
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

      <button className="tm-apply-btn" onClick={onApply} title="Push all settings to linked canvas widgets" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Play size={14} strokeWidth={2} /> Apply to Canvas
      </button>
    </div>
  );
}

interface ImportPreview { players: Omit<Player, 'id'>[]; }

// ── Players tab: manage a team's roster, scoped to the selected tournament ────
function PlayersPanel({ tournament, activeCategory }: { tournament: Tournament; activeCategory: string }) {
  const { teams: allTeams, addPlayer, updatePlayer, deletePlayer, replaceTeamPlayers, updateTeam } = useTeamDbStore();
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const dispName = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });
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
      <>
        <ExternalRosterLinkBar tournament={tournament} />
        <div className="tm-win-content" style={{ padding: 16 }}>
          <div className="tm-win-placeholder">
            <span>No teams in this tournament yet — add one in the Teams tab first, then manage its roster here.</span>
          </div>
        </div>
      </>
    );
  }

  if (visibleTeams.length === 0) {
    return (
      <>
        <ExternalRosterLinkBar tournament={tournament} />
        <div className="tm-win-content" style={{ padding: 16 }}>
          <div className="tm-win-placeholder">
            <span>No teams in the "{activeCategory}" category — pick a different one from the top bar, or add teams to it in the Teams tab.</span>
          </div>
        </div>
      </>
    );
  }

  const team = teams.find(t => t.id === selectedTeamId);
  const sorted = team ? [...team.players].sort((a, b) => {
    const n1 = parseInt(a.jerseyNo) || 999;
    const n2 = parseInt(b.jerseyNo) || 999;
    return n1 !== n2 ? n1 - n2 : a.name.localeCompare(b.name);
  }) : [];
  // Position autocomplete follows the tournament's real sport + format
  // (Sevens/Tens Starters count swaps in that format's own shorter rugby
  // position list — see getRosterPositions).
  const rosterMaxOnField = tournament.settings?.maxOnField ?? SPORT_DEFAULTS[tournament.sport]?.maxOnField ?? 11;
  const rosterPositions = getRosterPositions(tournament.sport, rosterMaxOnField);

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

  // Locally-counted stats (see statsSource below) must never get stomped by
  // a re-pull/re-import — same protection externalRoster.ts's own periodic
  // auto-sync already gives the API path; Append needs it too since it goes
  // through this same merge now.
  const LOCAL_TRACKABLE_KEYS: readonly string[] = ['tries', 'conversions', 'penalties', 'dropGoals', 'yellowCards', 'redCards'];

  const confirmImport = (mode: 'replace' | 'append') => {
    if (!importPreview || !team) return;
    if (mode === 'replace') {
      replaceTeamPlayers(team.id, importPreview.players);
    } else {
      // Match by name first — Append used to unconditionally addPlayer for
      // every row, so re-pulling/re-importing a roster already imported once
      // (e.g. jersey numbers weren't assigned on the source site yet the
      // first time) created an exact-duplicate second player instead of
      // filling in the number on the existing one. Only ever sets a field
      // the import actually has a real value for — never blanks out a
      // locally-entered jersey/position/stat just because this row's is empty.
      const skipStats = team.statsSource === 'local';
      const byName = new Map(team.players.map(p => [p.name.trim().toLowerCase(), p]));
      for (const p of importPreview.players) {
        const existing = byName.get(p.name.trim().toLowerCase());
        if (existing) {
          const patch: Partial<Omit<Player, 'id'>> = {};
          if (p.jerseyNo) patch.jerseyNo = p.jerseyNo;
          if (p.position) patch.position = p.position;
          for (const f of PLAYER_STAT_FIELDS) {
            if (skipStats && LOCAL_TRACKABLE_KEYS.includes(f.key)) continue;
            if (p[f.key] !== undefined) patch[f.key] = p[f.key];
          }
          if (Object.keys(patch).length > 0) updatePlayer(team.id, existing.id, patch);
        } else {
          addPlayer(team.id, p);
        }
      }
    }
    setImportPreview(null);
  };

  // Bulk twin of the per-team "Tries/Conv/Pen/Drop/Cards stats from:" picker
  // below — always applies to every team in this tournament (not just
  // whatever the category filter currently shows), since re-clicking through
  // each team one at a time to flip the same setting doesn't scale past a
  // handful of teams.
  const setAllStatsSource = (source: 'api' | 'local') => {
    for (const t of teams) updateTeam(t.id, { statsSource: source });
  };

  return (
    <>
    <ExternalRosterLinkBar tournament={tournament} />
    <div className="tm-stats-source-bulk">
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Tries/Conv/Pen/Drop/Cards stats for all {teams.length} team{teams.length !== 1 ? 's' : ''} in this tournament:
      </span>
      <button className="tm-io-btn" onClick={() => setAllStatsSource('api')}>External API</button>
      <button className="tm-io-btn" onClick={() => setAllStatsSource('local')}>Counted by this app</button>
    </div>
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
              <button className="tm-io-btn" title="Import players from CSV / TSV / TXT" onClick={() => fileInputRef.current?.click()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <ArrowUp size={14} strokeWidth={2} /> Import
              </button>
              <button
                className="tm-io-btn"
                title="Export players as CSV (Excel compatible)"
                onClick={() => exportTeamCSV(team.players, team.name)}
                disabled={team.players.length === 0}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <ArrowDown size={14} strokeWidth={2} /> Export CSV
              </button>
              <PullPlayersButton
                tournament={tournament}
                teamId={team.id}
                teamName={team.name}
                teamCategory={team.category}
                onPulled={players => setImportPreview({ players })}
              />
              <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }} onChange={handleFileChange} />
            </div>

            {/* Stats source: API sync vs. app-computed from this team's own
                saved match history (see src/lib/localPlayerStats.ts) */}
            <div className="tm-io-bar" style={{ marginTop: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Tries/Conv/Pen/Drop/Cards stats from:</span>
              <select
                className="field-input"
                style={{ fontSize: 11, padding: '2px 6px', width: 'auto' }}
                value={team.statsSource === 'local' ? 'local' : 'api'}
                onChange={e => updateTeam(team.id, { statsSource: e.target.value === 'local' ? 'local' : 'api' })}
              >
                <option value="api">External API</option>
                <option value="local">Counted by this app</option>
              </select>
            </div>
            {team.statsSource === 'local' && (
              <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '2px 2px 0' }}>
                Tries/Conv/Pen/Drop are computed from this team's saved match results (a Scoreboard score event only counts if a scorer was picked in its quick-scorer popup). Yellow/red cards count up live from the Player List widget's card buttons. Appearances still isn't tracked this way.
              </p>
            )}

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
                      <span className="tm-import-preview-name">{dispName(p.name)}</span>
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

            <JerseySetsPanel team={team} />

            {/* Players */}
            <div className="tm-pl-list">
              {/* Column headers — inside the same scroll container as the rows
                  (sticky, not a separate sibling) so a vertical scrollbar
                  insets both identically; a header outside the scroller would
                  stay full-width while the rows narrow by the scrollbar's
                  width, throwing every column out of alignment. */}
              <div className="tm-pl-header-row">
                <span className="tm-pl-cell tm-pl-cell--jersey">#</span>
                <span className="tm-pl-cell tm-pl-cell--name">Name</span>
                <span className="tm-pl-cell tm-pl-cell--pos">Pos</span>
                {PLAYER_STAT_FIELDS.map(f => (
                  <span key={f.key} className="tm-pl-cell tm-pl-cell--stat" title={f.label}>{f.short}</span>
                ))}
                <span className="tm-pl-cell tm-pl-cell--actions" />
              </div>
              {sorted.map(p => (
                <PlayerRow
                  key={p.id}
                  player={p}
                  positions={rosterPositions}
                  onUpdate={patch => updatePlayer(team.id, p.id, patch)}
                  onDelete={() => deletePlayer(team.id, p.id)}
                />
              ))}
              {sorted.length === 0 && <div className="tm-pl-empty">No players — add below</div>}
            </div>

            {/* Add row pinned at bottom */}
            <div className="tm-pl-add-footer">
              <AddPlayerRow positions={rosterPositions} onAdd={p => addPlayer(team.id, p)} />
            </div>
          </div>
        )}
      </div>
    </div>
    </>
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
  // stores a denormalized team name, not a team id. Only ever flags the
  // fixture (matchType/walkoverLoser) — never fills a score. A bye/walkover
  // only ever gets a score once the operator sends it to a scoreboard and
  // confirms it through the Walkover Confirm popup there (which suggests
  // the tournament's walkoverWinScore fresh at that point); this used to
  // pre-fill the score right here too, which is exactly the "auto fills
  // before it's sent to scoreboard" behavior that must never happen.
  const setTeamStatus = (team: SavedTeam, status: SavedTeam['status']) => {
    updateTeam(team.id, { status });
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
        scoreA: undefined,
        scoreB: undefined,
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
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            title="Rename existing categories"
            onClick={() => setCategoryEditMode(v => !v)}
          >{categoryEditMode ? <><Unlock size={14} strokeWidth={2} /> Editing</> : <><Pencil size={14} strokeWidth={2} /> Edit</>}</button>
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
          <button className="tm-io-btn" onClick={moveSelected} disabled={!duplicateTarget || duplicateTarget === '__all__'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ArrowRight size={14} strokeWidth={2} /> Move Selected</button>
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
  onPick: (t: { id: string; name: string; shortName?: string; color: string; logo?: string }) => void;
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
        onClick={e => { e.stopPropagation(); toggle(); }}><Users size={14} strokeWidth={2} /></button>
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
function ScoreboardSendButton({ match, scoreboards, onSend, onStop }: {
  match: ScheduledMatch;
  scoreboards: { id: string; label?: string }[];
  onSend: (targetId: string) => void;
  /** Stops a live fixture (clears sentAt so it's no longer "in progress") —
   *  only ever offered while sentAt is set and completedAt isn't (i.e. still
   *  actually live); a fixture already completed has nothing left to stop. */
  onStop: () => void;
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
    if (match.completedAt) {
      return <span className="tm-sched-sent-tag" title="Already sent to a scoreboard" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={14} strokeWidth={2} /> Sent</span>;
    }
    return (
      <span className="tm-sched-sent-tag tm-sched-sent-tag--live" title="Currently live on a scoreboard">
        <Check size={14} strokeWidth={2} /> Sent
        <button className="tm-sched-stop-btn" title="Stop this live game (clears its live status — doesn't touch the score)" onClick={onStop} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Square size={14} strokeWidth={2} fill="currentColor" /> Stop
        </button>
      </span>
    );
  }
  if (scoreboards.length === 0) {
    return <button className="tm-sched-send-btn" disabled title="No scoreboard widget on the canvas"><ArrowRight size={12} strokeWidth={2} /> Send</button>;
  }
  if (scoreboards.length === 1) {
    return (
      <button className="tm-sched-send-btn" title="Send this fixture to the scoreboard" onClick={() => onSend(scoreboards[0].id)}>
        <ArrowRight size={12} strokeWidth={2} /> Send
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
      <button ref={anchorRef} className="tm-sched-send-btn" title="Pick which scoreboard to send to" onClick={toggle}><ArrowRight size={12} strokeWidth={2} /> Send</button>
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

type ScheduleFormat = 'rr-single' | 'rr-double' | 'knockout' | 'groups-knockout' | 'groups-tiered';

const SCHEDULE_FORMAT_LABELS: Record<ScheduleFormat, string> = {
  'rr-single': 'Round Robin (Single)',
  'rr-double': 'Round Robin (Double / Home & Away)',
  'knockout': 'Knockout (Single Elimination)',
  'groups-knockout': 'Groups + Knockout',
  'groups-tiered': 'Groups + Tiered Knockout (Cup/Plate/Bowl/Shield)',
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
  onGenerate: (fixtures: { date: string; time?: string; round: string; category?: string; group?: string; tier?: string; teamA: ScheduleTeamRef; teamB: ScheduleTeamRef | null }[]) => void;
}) {
  const categories = tournament.categories ?? [];
  const ALL_CATEGORIES = '__all__';
  const [format, setFormat] = useState<ScheduleFormat>('rr-single');
  const [category, setCategory] = useState<string>(categories.length > 0 ? ALL_CATEGORIES : '');
  // Only used when generating "All Categories" at once — controls which
  // category's fixtures come first within each shared calendar round (all
  // categories still run in parallel, same date/round-by-round, same as
  // today; this just decides the display/running order, e.g. Men's Round 1
  // listed before Women's Round 1). One-off for this generation only —
  // doesn't touch the tournament's own category list/order used elsewhere.
  const [categoryOrder, setCategoryOrder] = useState<string[]>(categories);
  // Reconciled against the live category list (self-heals if a category was
  // added/removed elsewhere while this modal is open) rather than trusting
  // the state snapshot as-is.
  const orderedCategories = useMemo(
    () => categoryOrder.filter(c => categories.includes(c)).concat(categories.filter(c => !categoryOrder.includes(c))),
    [categoryOrder, categories],
  );
  const moveCategoryOrder = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= orderedCategories.length) return;
    const next = [...orderedCategories];
    [next[index], next[target]] = [next[target], next[index]];
    setCategoryOrder(next);
  };
  const [advanceCount, setAdvanceCount] = useState(2);
  const [tierCount, setTierCount] = useState(4);
  // Per-category overrides for how many teams advance (groups-knockout) or
  // how many tiers deep the bracket goes (groups-tiered) — e.g. Men's runs
  // Cup/Plate/Bowl/Shield (4 tiers) while Women's only has enough teams for
  // Cup/Plate (2). Falls back to the plain advanceCount/tierCount above for
  // any category without its own override — same "default unless
  // overridden" pattern as categoryOrder above, one-off for this
  // generation only. Shown/edited whenever a specific category is
  // selected (not just in "All Categories" mode) so the plain input above
  // always reflects exactly what generation will actually use for
  // whichever category is currently in view.
  const [advanceCountByCategory, setAdvanceCountByCategory] = useState<Record<string, number>>({});
  const [tierCountByCategory, setTierCountByCategory] = useState<Record<string, number>>({});
  const [useWildcards, setUseWildcards] = useState(false);
  // 'named' = today's Cup/Plate/Bowl/Shield reshuffle-pairing (unchanged
  // default); 'ranked' = only 1st+2nd pair into Cup, every rank below runs
  // its own independent placement bracket labeled by position instead of a
  // tier name (see buildRankedPlacementKnockout).
  const [tieredMode, setTieredMode] = useState<'named' | 'ranked'>('named');
  const [startDate, setStartDate] = useState(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  });
  const [daysBetween, setDaysBetween] = useState(7);
  const [time, setTime] = useState('');
  const [randomize, setRandomize] = useState(true);
  const [thirdPlacePlayoff, setThirdPlacePlayoff] = useState(false);

  const toRef = (t: SavedTeam): ScheduleTeamRef => ({ id: t.id, name: t.name, shortName: t.shortName, color: t.color, logo: t.logo });

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
    // Per-category override, falling back to the plain default — see
    // advanceCountByCategory/tierCountByCategory above.
    const effectiveAdvanceCount = (cat ? advanceCountByCategory[cat] : undefined) ?? advanceCount;
    const effectiveTierCount = (cat ? tierCountByCategory[cat] : undefined) ?? tierCount;

    if (format === 'rr-single' || format === 'rr-double') {
      const gen = format === 'rr-single' ? generateRoundRobin : generateDoubleRoundRobin;
      if (groupsInScope.length > 0) {
        for (const g of groupsInScope) {
          let members = groupMembers(g.name).map(toRef);
          if (members.length < 2) {
            if (members.length === 1) warnings.push(`${warnPrefix}Group ${g.name} has only 1 team — skipped.`);
            continue;
          }
          const topTeamName = members[0].name;
          if (randomize) members = shuffle(members);
          const groupFixtures = ensureTopTeamHomeEarly(gen(members), topTeamName);
          fixtures = fixtures.concat(groupFixtures.map(f => ({ ...f, groupName: g.name })));
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
          const topTeamName = members[0].name;
          if (randomize) members = shuffle(members);
          const f = ensureTopTeamHomeEarly(generateRoundRobin(members), topTeamName);
          fixtures = fixtures.concat(f.map(x => ({ ...x, groupName: g.name })));
          if (f.length) maxRoundIdx = Math.max(maxRoundIdx, Math.max(...f.map(x => x.roundIndex)));
        }
        const poolSizes = groupsInScope.map(g => groupMembers(g.name).length);
        if (poolSizes.length > 1 && Math.max(...poolSizes) !== Math.min(...poolSizes)) {
          warnings.push(`${warnPrefix}Pools are uneven in size (${Math.min(...poolSizes)}–${Math.max(...poolSizes)} teams) — some ranks won't exist in every pool.`);
        }
        const slots = buildGroupKnockoutSlots(groupsInScope.map(g => ({ name: g.name, size: groupMembers(g.name).length })), effectiveAdvanceCount);
        fixtures = fixtures.concat(offsetRounds(generateKnockoutFromSlots(slots, thirdPlacePlayoff), maxRoundIdx + 1));
      }
    } else if (format === 'groups-tiered') {
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
          const topTeamName = members[0].name;
          if (randomize) members = shuffle(members);
          const f = ensureTopTeamHomeEarly(generateRoundRobin(members), topTeamName);
          fixtures = fixtures.concat(f.map(x => ({ ...x, groupName: g.name })));
          if (f.length) maxRoundIdx = Math.max(maxRoundIdx, Math.max(...f.map(x => x.roundIndex)));
        }
        const poolSizes = groupsInScope.map(g => groupMembers(g.name).length);
        if (poolSizes.length > 1 && Math.max(...poolSizes) !== Math.min(...poolSizes)) {
          warnings.push(`${warnPrefix}Pools are uneven in size (${Math.min(...poolSizes)}–${Math.max(...poolSizes)} teams)${useWildcards ? ' — shortfalls will be filled with cross-pool "Best Nth-place" wildcards.' : ' — shortfalls will be filled with byes.'}`);
        }
        // 'named': adjacent tiers share a Quarterfinal (Cup+Plate,
        // Bowl+Shield, …) — the winner continues in the upper tier's own
        // bracket, the loser drops to the lower tier's, instead of each
        // tier running fully independently from round 1 (see
        // buildTieredKnockout). 'ranked': only 1st+2nd pair into Cup;
        // every rank below runs its own independent placement bracket
        // labeled by position, not a tier name (see
        // buildRankedPlacementKnockout). Both run on the same calendar
        // rounds as every other tier/category, same as how multiple
        // categories already run side by side today.
        const pools = groupsInScope.map(g => ({ name: g.name, size: groupMembers(g.name).length }));
        const tiered = tieredMode === 'ranked'
          ? buildRankedPlacementKnockout(pools, effectiveTierCount, thirdPlacePlayoff, useWildcards)
          : buildTieredKnockout(pools, effectiveTierCount, thirdPlacePlayoff, useWildcards);
        fixtures = fixtures.concat(offsetRounds(tiered.fixtures, maxRoundIdx + 1));
        warnings.push(...tiered.warnings.map(w => `${warnPrefix}${w}`));
      }
    }

    fixtures = fixtures.map(f => ({
      ...f,
      // `round` only ever holds the round/stage name itself — category and
      // group already ride along as their own dedicated fields (see
      // fixtureCategory below and `groupName` above), so merging them in
      // here too just meant duplicated text everywhere `round` gets shown.
      // Tier is the one exception: it's not otherwise reflected in the
      // round name at all, so a tiered fixture's stage reads as "Final
      // Plate"/"Final Cup" rather than an ambiguous plain "Final" — except
      // a placement-ladder round ("9th-12th Placing") is already fully
      // self-descriptive, so appending its own tier (identical text) would
      // just duplicate it.
      round: f.tier && !isPlacementRoundLabel(f.tier) ? `${f.round} ${f.tier}` : f.round,
      fixtureCategory: cat,
    }));

    return { fixtures, warnings };
  };

  const preview = useMemo(() => {
    if (category === ALL_CATEGORIES) {
      let fixtures: PreviewFixture[] = [];
      let warnings: string[] = [];
      for (const cat of orderedCategories) {
        const result = generateForCategory(cat);
        fixtures = fixtures.concat(result.fixtures);
        warnings = warnings.concat(result.warnings);
      }
      return { fixtures, warnings };
    }
    return generateForCategory(categories.length > 0 ? category : undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, scopedTeams, tournament.groups, randomize, advanceCount, tierCount, advanceCountByCategory, tierCountByCategory, useWildcards, tieredMode, category, categories, orderedCategories, thirdPlacePlayoff]);

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
      tier: f.tier,
      teamA: f.a,
      teamB: f.b,
    })));
    onClose();
  };

  return (
    <div className="tm-gen-backdrop" onClick={onClose}>
      <div className="tm-gen-modal" onClick={e => e.stopPropagation()}>
        <div className="tm-gen-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Wand2 size={16} strokeWidth={1.75} /> Generate Schedule</div>

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

        {category === ALL_CATEGORIES && orderedCategories.length > 1 && (
          <>
            <label className="tm-gen-label">Category order (which starts first each day — all categories still run in parallel on the same dates)</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {orderedCategories.map((c, i) => (
                <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ flex: 1 }}>{i + 1}. {c}</span>
                  <button type="button" className="tm-io-btn" disabled={i === 0}
                    onClick={() => moveCategoryOrder(i, -1)} title={`Move ${c} earlier`}>↑</button>
                  <button type="button" className="tm-io-btn" disabled={i === orderedCategories.length - 1}
                    onClick={() => moveCategoryOrder(i, 1)} title={`Move ${c} later`}>↓</button>
                </div>
              ))}
            </div>
          </>
        )}

        {format === 'groups-knockout' && (
          <>
            <label className="tm-gen-label">Teams advancing per group to knockout stage</label>
            {category === ALL_CATEGORIES && orderedCategories.length > 1 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {orderedCategories.map(c => (
                  <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ flex: 1 }}>{c}</span>
                    <input className="tm-input" style={{ width: 70 }} type="number" min={1}
                      value={advanceCountByCategory[c] ?? advanceCount}
                      onChange={e => setAdvanceCountByCategory(prev => ({ ...prev, [c]: Math.max(1, parseInt(e.target.value, 10) || 1) }))} />
                  </div>
                ))}
              </div>
            ) : (
              <input className="tm-input" type="number" min={1}
                value={categories.length > 0 && category !== ALL_CATEGORIES ? (advanceCountByCategory[category] ?? advanceCount) : advanceCount}
                onChange={e => {
                  const v = Math.max(1, parseInt(e.target.value, 10) || 1);
                  if (categories.length > 0 && category !== ALL_CATEGORIES) setAdvanceCountByCategory(prev => ({ ...prev, [category]: v }));
                  else setAdvanceCount(v);
                }} />
            )}
          </>
        )}

        {format === 'groups-tiered' && (
          <>
            <label className="tm-gen-label">Number of tiers (Cup, Plate, Bowl, Shield, …)</label>
            {category === ALL_CATEGORIES && orderedCategories.length > 1 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {orderedCategories.map(c => (
                  <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ flex: 1 }}>{c}</span>
                    <input className="tm-input" style={{ width: 70 }} type="number" min={1}
                      value={tierCountByCategory[c] ?? tierCount}
                      onChange={e => setTierCountByCategory(prev => ({ ...prev, [c]: Math.max(1, parseInt(e.target.value, 10) || 1) }))} />
                  </div>
                ))}
              </div>
            ) : (
              <input className="tm-input" type="number" min={1}
                value={categories.length > 0 && category !== ALL_CATEGORIES ? (tierCountByCategory[category] ?? tierCount) : tierCount}
                onChange={e => {
                  const v = Math.max(1, parseInt(e.target.value, 10) || 1);
                  if (categories.length > 0 && category !== ALL_CATEGORIES) setTierCountByCategory(prev => ({ ...prev, [category]: v }));
                  else setTierCount(v);
                }} />
            )}
            <label className="tm-gen-label">Tier naming</label>
            <select className="tm-input" value={tieredMode} onChange={e => setTieredMode(e.target.value as 'named' | 'ranked')}>
              <option value="named">Named tiers (Cup, Plate, Bowl, Shield…)</option>
              <option value="ranked">Ranked placement (1st+2nd → Cup; every rank below runs its own placement bracket, labeled by position)</option>
            </select>
            <label className="tm-gen-checkbox">
              <input type="checkbox" checked={useWildcards} onChange={e => setUseWildcards(e.target.checked)} />
              Fill uneven bracket shortfalls with cross-pool "Best Nth-place" wildcards instead of byes
            </label>
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

        {(format === 'knockout' || format === 'groups-knockout' || format === 'groups-tiered') && (
          <label className="tm-gen-checkbox">
            <input type="checkbox" checked={thirdPlacePlayoff} onChange={e => setThirdPlacePlayoff(e.target.checked)} />
            Play 3rd/4th place — Semifinal losers play for 3rd
          </label>
        )}

        {preview.warnings.length > 0 && (
          <div className="tm-gen-warn">
            {preview.warnings.map((w, i) => <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={14} strokeWidth={2} /> {w}</div>)}
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

// The standard knockout stage names — selectable as `group` values in the
// Schedule tab's fixture-row picker (see SchedulePanel) so an operator can
// explicitly set/correct which stage a fixture belongs to, same as the
// generator itself would tag it. "Round of N" varies by bracket size so
// isn't offered here — an unusual value like that still shows via the
// picker's "(stage)" fallback option instead of disappearing.
const KNOCKOUT_STAGE_OPTIONS = ['Quarterfinal', 'Semifinal', 'Final', '3rd Place'];

// A user-chosen sort for the Schedule tab, layered on TOP of the store's own
// sortIndex order (see matchScheduleStore's sortMatches) rather than
// replacing it — an empty key list ("Manual") falls straight through to
// today's default (drag-orderable, month/stage-grouped) behavior; any
// non-empty list applies a multi-column sort (each key breaks ties left by
// the ones before it) and switches the list to a flat, ungrouped display.
export type ScheduleSortKey = 'date' | 'time' | 'matchId' | 'category' | 'tier';
export const SCHEDULE_SORT_KEY_LABELS: Record<ScheduleSortKey, string> = {
  date: 'Date', time: 'Time', matchId: 'Match #', category: 'Category', tier: 'Tier',
};
function compareByScheduleSortKey(a: ScheduledMatch, b: ScheduledMatch, key: ScheduleSortKey): number {
  switch (key) {
    case 'date': return a.date.localeCompare(b.date);
    case 'time': return (a.time ?? '').localeCompare(b.time ?? '');
    // Match numbers (see matchNumber.ts) are always assigned by walking
    // fixtures in their current sortIndex order, so sorting by the number
    // itself is exactly sorting by sortIndex — no string parsing needed to
    // get "MB2" before "MB10" right.
    case 'matchId': return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
    case 'category': return (a.category ?? '').localeCompare(b.category ?? '');
    // tierRank (scheduleGen.ts) orders Cup→Plate→Bowl→Shield→Tier N→
    // placement-range labels sensibly — plain alphabetical would put "Bowl"
    // before "Cup".
    case 'tier': return tierRank(a.tier ?? '') - tierRank(b.tier ?? '');
  }
}
function sortScheduleBy(matches: ScheduledMatch[], keys: ScheduleSortKey[]): ScheduledMatch[] {
  if (keys.length === 0) return matches;
  return [...matches].sort((a, b) => {
    for (const key of keys) {
      const c = compareByScheduleSortKey(a, b, key);
      if (c !== 0) return c;
    }
    return 0;
  });
}

// A fixture's "stage" for display purposes in the Schedule tab — the
// knockout stage name (tier-prefixed when tiered, e.g. "Cup Quarterfinal")
// for a bracket fixture, or the pool/group name for a round-robin one.
// Undefined for a plain ungrouped tournament with no pools and no knockout
// stage at all. Used to insert a divider wherever this VALUE changes
// between one row and the next, in whatever order the rows are already
// in (match id/sortIndex by default, or a custom sort's order) — never to
// cluster/reorder rows away from that order, since categories/tiers run in
// parallel on the same dates and naturally interleave.
function fixtureStageLabel(m: ScheduledMatch): string | undefined {
  const stage = extractKnockoutStage(m);
  if (stage) return m.tier && !isPlacementRoundLabel(m.tier) ? `${m.tier} ${stage}` : stage;
  // extractKnockoutStage deliberately doesn't recognize '3rd Place' (it's fed
  // by Semifinal LOSERS, not a normal bracket round) — group it with the
  // tier's own Final instead of falling through to "Group Stage" below,
  // which it would otherwise incorrectly match since it does have a `group`.
  if (m.group === '3rd Place') return m.tier ? `${m.tier} Final` : 'Final';
  // Round-robin fixtures all sit under one combined "Group Stage" heading —
  // not split further into "Pool A"/"Pool B"/etc., which the fixture row
  // already shows via its own round text anyway.
  return m.group ? 'Group Stage' : undefined;
}

export interface TierMismatch {
  match: ScheduledMatch;
  side: 'A' | 'B';
  /** True when exactly one candidate tier value fits this fixture's own
   *  content — offered as a one-click fix, even when that value is
   *  `undefined` (a plain, untiered bracket). False when the reference
   *  resolves against more than one differently-tiered candidate — needs a
   *  human to look, not a guess, so `suggestedTier` is meaningless then. */
  resolvable: boolean;
  suggestedTier?: string;
  reason: string;
  /** The specific tier value(s) THIS check actually found evidence for —
   *  one value when unambiguous (same as suggestedTier), several when it's
   *  a genuine conflict (e.g. two different fixtures elsewhere both claim
   *  to be what this one is downstream of, under different tiers) — powers
   *  the repair picker's buttons so an operator picks between the actual
   *  candidates the mismatch itself surfaced, not an unrelated dropdown of
   *  every tier in the category. */
  candidates: (string | undefined)[];
  /** Every distinct tier value currently in use anywhere in this fixture's
   *  own category's bracket — a broader fallback button set for the picker
   *  below so there's always something to click even when `candidates`
   *  comes up empty (an entire ladder corrupted to the same wrong tier
   *  leaves nothing else to point to it) — never requires typing. */
  categoryTierOptions: string[];
}

// A knockout fixture's "Winner of X"/"Loser of X" entrant reveals exactly
// which bracket it's downstream of — this checks that against the
// fixture's own stored `tier`, catching mismatches in BOTH directions
// (tagged Cup but content says Plate, or vice versa; tagged a placement
// range but content says Cup; etc.), not just the "should be Cup" case.
// Two reference shapes, both produced by scheduleGen.ts's generators:
//  - A shared-QF-pair reference ("Cup/Plate Quarterfinal 1") carries the
//    tier directly in its own text — Winner implies the pair's upper tier,
//    Loser implies the lower, no lookup needed (buildPairedTierQuarterfinal).
//  - A bare reference ("Semifinal 1", "9th-10th Placing 1") carries no
//    tier at all by itself — ANY tier's own internal bracket can produce
//    "Winner of Semifinal 1" (buildTieredKnockout/buildRankedPlacementKnockout
//    both reuse the same generic runBracket/buildPlacementLadder machinery
//    per tier) — so this looks up whichever OTHER fixture in the same
//    tournament+category actually has that as its own bare round (via
//    bareStageLabel, which already reverses the "{stage} {tier}" suffix
//    format) and expects this fixture's tier to match that source's.
// A drag/swap performed before matchContentOf carried `tier` along with
// the rest of a swapped fixture's content (fixed earlier this session) is
// the most likely real-world cause — the content correctly moved, but
// tier stayed pinned to the slot it was swapped INTO.
export function findTierMismatches(allMatches: ScheduledMatch[]): TierMismatch[] {
  const out: TierMismatch[] = [];
  const categories = Array.from(new Set(allMatches.map(m => m.category ?? '')));
  for (const cat of categories) {
    // extractKnockoutStage deliberately doesn't recognize group === '3rd
    // Place' (see fixtureStageLabel above) — included explicitly here so a
    // 3rd Place Playoff/Bronze Final fixture (exactly the shape of fixture
    // this check exists to catch — see the earlier "5th-8th Placing Final"
    // report) isn't silently skipped.
    const bracket = allMatches.filter(m => (m.category ?? '') === cat && (!!extractKnockoutStage(m) || m.group === '3rd Place'));
    const pairTierValues = Array.from(new Set(bracket.map(m => m.tier).filter((t): t is string => !!t && t.includes('/'))));
    const categoryTierOptions = Array.from(new Set(bracket.map(m => m.tier).filter((t): t is string => !!t)))
      .sort((a, b) => tierRank(a) - tierRank(b));
    for (const m of bracket) {
      (['A', 'B'] as const).forEach(side => {
        const name = side === 'A' ? m.teamAName : m.teamBName;
        const refMatch = name?.match(/^(Winner|Loser) of (.+)$/);
        if (!refMatch) return;
        const [, kind, ref] = refMatch;

        const matchedPair = pairTierValues.find(p => ref === p || ref.startsWith(p + ' '));
        if (matchedPair) {
          const [upper, lower] = matchedPair.split('/');
          const expectedTier = kind === 'Winner' ? upper : lower;
          if (m.tier !== expectedTier) {
            out.push({ match: m, side, resolvable: true, suggestedTier: expectedTier, reason: `"${kind} of ${ref}" implies tier "${expectedTier}"`, candidates: [expectedTier], categoryTierOptions });
          }
          return;
        }

        // A reference into a ranked-placement ladder ("Winner of 9th-12th
        // Placing 1") is self-describing — the range it names ("9th-12th
        // Placing") IS the expected tier directly, with no need to look up
        // the referenced sibling's OWN tier (the sibling-lookup fallback
        // below trusts that fixture's current tier field, which can itself
        // be wrong and silently "agree" with an equally-wrong referencer —
        // exactly how a corrupted top-of-ladder fixture like "9th-12th
        // Placing 1" could go on masking every fixture that refers to it).
        const refBare = ref.replace(/\s+\d+$/, '');
        if (isPlacementRoundLabel(refBare) && m.tier !== refBare) {
          out.push({ match: m, side, resolvable: true, suggestedTier: refBare, reason: `"${kind} of ${ref}" implies tier "${refBare}"`, candidates: [refBare], categoryTierOptions });
          return;
        }

        const candidateMatches = bracket.filter(s => s.id !== m.id && bareStageLabel(s) === ref);
        if (candidateMatches.length === 0) return; // nothing to compare against yet — don't guess
        if (candidateMatches.some(c => (c.tier ?? '') === (m.tier ?? ''))) return; // consistent
        const distinctTiers = Array.from(new Set(candidateMatches.map(c => c.tier)));
        const resolvable = distinctTiers.length === 1;
        out.push({
          match: m, side, resolvable,
          suggestedTier: resolvable ? distinctTiers[0] : undefined,
          reason: resolvable
            ? `"${kind} of ${ref}" only exists tagged tier "${distinctTiers[0] ?? '(none)'}"`
            : `"${kind} of ${ref}" exists under multiple different tiers (${distinctTiers.map(t => t ?? '(none)').join(', ')})`,
          candidates: distinctTiers,
          categoryTierOptions,
        });
      });
    }

    // A first-round placement-ladder fixture (buildPlacementLadder's own
    // top round — fed directly by pool-rank placeholders like "3rd GROUP A",
    // never a "Winner/Loser of" reference, which is exactly what
    // distinguishes it from every later round in the same tree) always gets
    // its OWN bare round text as its tier — the tree's top round IS the
    // tree's root, by construction. Purely self-derived from the fixture's
    // own round text, so — unlike the Winner/Loser check above, which
    // trusts a referenced sibling's tier field — it can't be fooled by two
    // equally-wrong fixtures agreeing with each other.
    for (const m of bracket) {
      const isWinnerLoserRef = (name?: string) => !!name?.match(/^(Winner|Loser) of /);
      if (isWinnerLoserRef(m.teamAName) || isWinnerLoserRef(m.teamBName)) continue;
      const afterCategory = m.round?.includes(' · ') ? m.round.split(' · ').pop()! : (m.round ?? '');
      const bareRound = afterCategory.replace(/\s+\d+$/, '');
      if (!isPlacementRoundLabel(bareRound)) continue;
      if (m.tier === bareRound) continue; // consistent
      out.push({
        match: m, side: 'A', // no natural per-side split for this check — one flag per fixture
        resolvable: true,
        suggestedTier: bareRound,
        reason: `First round of its own ladder — tier should be "${bareRound}"`,
        candidates: [bareRound],
        categoryTierOptions,
      });
    }

    // A shared Quarterfinal fixture (buildPairedTierQuarterfinal) is fed
    // directly by pool-rank placeholders ("1st GROUP A", not "Winner/Loser
    // of..."), so the two checks above never look at it at all — it always
    // gets a NAMED tier (a combined pair like "Cup/5th-8th Placing" when it
    // splits into Cup and a lower placement ladder, or a plain "Cup"/"Plate"
    // for the older non-ranked format), never a bare placement-range value,
    // which belongs exclusively to the separate, independent lower
    // placement ladder. When this drifts wrong, it cascades hard: a
    // Semifinal's own "Winner of Cup/5th-8th Placing Quarterfinal 1"
    // reference can no longer resolve against anything (pairTierValues
    // above comes up empty), so Semifinal/Final end up unverifiable too.
    // The fixture's own round text still carries whatever tier was baked in
    // at generation time as a "{stage} {tier}" suffix (see the round-
    // suffix-append rule in GenerateScheduleModal) — never rewritten later
    // even if the separate tier field gets corrupted afterward — so the
    // original, correct value is recoverable directly, with no need for a
    // surviving clean sibling to compare against.
    for (const m of bracket) {
      if (extractKnockoutStage(m) !== 'Quarterfinal') continue;
      if (!m.tier || !isPlacementRoundLabel(m.tier)) continue; // already fine

      const afterCategory = m.round?.includes(' · ') ? m.round.split(' · ').pop()! : (m.round ?? '');
      const recovered = afterCategory.match(/^Quarterfinal(?:\s+\d+)?\s*(.*)$/)?.[1]?.trim();
      out.push({
        match: m, side: 'A', // no natural per-side split for this check — one flag per fixture
        resolvable: !!recovered,
        suggestedTier: recovered || undefined,
        reason: recovered
          ? `Its own round text still carries the original tier "${recovered}"`
          : `Tagged "${m.tier}" — a placement-range value that can never belong on a Quarterfinal`,
        candidates: recovered ? [recovered] : [],
        categoryTierOptions,
      });
    }

  }
  return out;
}

// One mismatched fixture's row in the banner below — never asks for typing.
// Buttons are the union of the ACTUAL candidate tiers the mismatch found
// evidence for (see TierMismatch.candidates — one when unambiguous, several
// when it's a genuine conflict) plus every other tier value already in use
// in this fixture's own category, so there's always something to click
// even when the smart check comes up with nothing (an entire ladder
// corrupted to the same wrong tier leaves nothing else to point to it).
function TierMismatchRow({ entries, matchNumbers, onFix }: {
  entries: TierMismatch[];
  matchNumbers: Map<string, string>;
  onFix: (id: string, tier: string | undefined) => void;
}) {
  const m = entries[0].match;
  const options = Array.from(new Set([
    ...entries.flatMap(e => e.candidates),
    ...entries.flatMap(e => e.categoryTierOptions),
  ]));
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 160 }}>
          {matchNumbers.get(m.id) ? `${matchNumbers.get(m.id)} — ` : ''}{m.teamAName} vs {m.teamBName}{' '}
          <span style={{ color: 'var(--text-muted)' }}>(currently "{m.tier ?? '(none)'}")</span>
        </span>
        {options.map(c => (
          <button key={c ?? '__none__'} className="tm-io-btn" onClick={() => onFix(m.id, c)}>
            {c ?? '(none)'}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 2 }}>{entries.map(e => e.reason).join('; ')}</div>
    </div>
  );
}

// Shared by SchedulePanel and BracketPanel — a fixture tagged with the wrong
// tier (see findTierMismatches) is wrong no matter which tab you're looking
// at it from, so both surface the exact same detection + repair picker.
function TierMismatchBanner({ mismatches, matchNumbers, onFix }: {
  mismatches: TierMismatch[];
  matchNumbers: Map<string, string>;
  onFix: (id: string, tier: string | undefined) => void;
}) {
  if (mismatches.length === 0) return null;
  const byMatch = new Map<string, TierMismatch[]>();
  for (const tm of mismatches) {
    if (!byMatch.has(tm.match.id)) byMatch.set(tm.match.id, []);
    byMatch.get(tm.match.id)!.push(tm);
  }
  const grouped = Array.from(byMatch.values());
  const resolvedOk = (entries: TierMismatch[]) => !entries.some(e => !e.resolvable) &&
    new Set(entries.map(e => e.suggestedTier)).size === 1;
  const fixableCount = grouped.filter(resolvedOk).length;
  return (
    <div className="tm-gen-warn" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
        <AlertTriangle size={14} strokeWidth={2} /> {grouped.length} fixture{grouped.length !== 1 ? 's' : ''} with a tier that doesn't match their own content
      </div>
      <div style={{ fontSize: 11, margin: '2px 0 6px' }}>
        Each one's own bracket content reveals which tier it's actually under — likely left behind by a drag/swap that carried Tier along too. Click the correct tier below to apply it. Corrects Tier only; nothing else about the fixture changes.
      </div>
      {grouped.map(entries => (
        <TierMismatchRow key={entries[0].match.id} entries={entries} matchNumbers={matchNumbers} onFix={onFix} />
      ))}
      {fixableCount > 1 && (
        <button className="tm-io-btn tm-io-btn--ok" onClick={() => grouped.forEach(entries => {
          if (!resolvedOk(entries)) return;
          const tier = entries[0].suggestedTier;
          onFix(entries[0].match.id, tier);
        })}>
          Fix all {fixableCount} auto-resolvable
        </button>
      )}
    </div>
  );
}

function SchedulePanel({ tournament, activeCategory, editMode }: {
  tournament: Tournament; activeCategory: string; editMode: boolean;
}) {
  const { matches: allMatches, addMatch, updateMatch, deleteMatch, markSent, unmarkSent } = useMatchScheduleStore();
  const { updateTournament } = useTournamentStore();
  const { teams: allTeams } = useTeamDbStore();
  const { pages, updateWidgetConfig, resetWidgetTimer } = useCanvasStore();
  const { results: savedResults, addResult, deleteResult, updateResult } = useMatchResultsStore();
  const periodsTotal = (tournament.settings ?? SPORT_DEFAULTS[tournament.sport]).periods;
  // Empty = "Manual" (today's default: drag-orderable, month/stage-grouped).
  // Non-empty = a multi-column sort, priority-ordered — see sortScheduleBy.
  const [sortKeys, setSortKeys] = useState<ScheduleSortKey[]>([]);
  const addSortKey = (key: ScheduleSortKey) => setSortKeys(prev => prev.includes(key) ? prev : [...prev, key]);
  const removeSortKey = (key: ScheduleSortKey) => setSortKeys(prev => prev.filter(k => k !== key));
  const moveSortKey = (index: number, dir: -1 | 1) => setSortKeys(prev => {
    const target = index + dir;
    if (target < 0 || target >= prev.length) return prev;
    const next = [...prev];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  // Manual drag/move-slot reordering only makes sense for the default order
  // — with a custom sort active, clicking "move up" would change the
  // fixture's sortIndex without visibly moving the row (since display order
  // now follows the chosen sort keys instead), so it's hidden rather than
  // silently doing something the operator can't see happen.
  const canReorder = editMode && sortKeys.length === 0;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => setExpandedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // Confirming "Stop" for a live fixture that already has a saved result —
  // undoing sentAt would otherwise silently orphan it (same guard as the
  // Upcoming Matches widget's own undo-sent flow).
  const [stopTarget, setStopTarget] = useState<{ matchId: string; resultId?: string } | null>(null);
  // Deleting a fixture is permanent and one misclick away (the × sits right
  // in the row) — confirm first, same as every other destructive action in
  // this window (native window.confirm() was already found unreliable in
  // the packaged Tauri webview, hence the shared ConfirmModal instead).
  const [deleteFixtureTarget, setDeleteFixtureTarget] = useState<ScheduledMatch | null>(null);
  const handleStopLive = (m: ScheduledMatch) => {
    const existing = findDuplicateResult(savedResults, {
      linkedScheduleMatchId: m.id, linkedTournamentId: m.tournamentId,
      subtitle: m.round, teamAName: m.teamAName, teamBName: m.teamBName,
    });
    if (existing) setStopTarget({ matchId: m.id, resultId: existing.id });
    else unmarkSent(m.id);
  };
  // Every fixture in this tournament, regardless of the category filter —
  // used when sending a fixture to a scoreboard from any category view.
  const allTournamentMatches = useMemo(
    () => allMatches.filter(m => m.tournamentId === tournament.id),
    [allMatches, tournament.id]
  );
  // Flags fixtures whose own content is inconsistent with their stored
  // tier (see findTierMismatches) — most often a leftover from a pre-fix
  // drag/swap — surfaced as a repairable banner instead of requiring a
  // manual hunt through every fixture's Tier field.
  const tierMismatches = useMemo(
    () => findTierMismatches(allTournamentMatches),
    [allTournamentMatches]
  );
  const fixTierMismatch = (id: string, tier: string | undefined) => updateMatch(id, { tier });
  // Counted independently per venue in schedule order (allTournamentMatches
  // is already kept sorted by the store) — two venues running in parallel
  // number their own matches "which match at this venue", rising together
  // in step (e.g. "MB1, MC1, MB2, MC2...").
  const matchNumbers = useMemo(
    () => computeMatchNumbers(allTournamentMatches, tournament.matchNumberPrefix, tournament.venuePrefixes),
    [allTournamentMatches, tournament.matchNumberPrefix, tournament.venuePrefixes]
  );
  // View-filtered for everything the operator actually sees/acts on. Untagged
  // fixtures stay visible under every category filter — same "untagged =
  // universal" convention used for groups/pots in the Draw tab.
  const matches = useMemo(
    () => allTournamentMatches.filter(m => !activeCategory || !m.category || m.category === activeCategory),
    [allTournamentMatches, activeCategory]
  );
  // Whether this tournament uses Cup/Plate/Bowl/Shield tiering at all — the
  // Tier field only shows in the fixture row when it does, so a plain
  // tournament's Schedule tab isn't cluttered with a field it never needs.
  const hasTiers = useMemo(() => allTournamentMatches.some(x => !!x.tier), [allTournamentMatches]);
  // venueLabel is stamped identically on every fixture a single-venue install
  // pushes (see cloudSync.ts) — showing it on every single row only tells the
  // operator something when two or more DIFFERENT venues' fixtures are
  // actually mixed together in this tournament's schedule.
  const hasMultipleVenues = useMemo(
    () => new Set(allTournamentMatches.map(m => m.venueLabel).filter(Boolean)).size > 1,
    [allTournamentMatches]
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
    const targetTimerCfg = autoLinkedWidget(pages, target.id, target.config.linkedTimerWidgetId, 'timer')?.config;
    if (!guardScoreboardOverwrite(target.config, addResult, targetTimerCfg)) return;
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
  // Two-step swap: click Swap on one fixture to arm it, then click ↔ Swap
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
  // Renames a venue in place and cascades the new name everywhere it's
  // stored by name — every fixture in the tournament (not just the current
  // category filter) plus its own match-number prefix letter — instead of
  // the old remove-then-re-add-a-new-one workflow, which unassigned every
  // fixture using it (same "rename cascades, doesn't just remove" reasoning
  // as the Teams tab's renameCategory).
  const renameVenue = (oldName: string, newName: string) => {
    const name = newName.trim();
    if (!name || name === oldName || venues.includes(name)) return;
    const { [oldName]: oldPrefix, ...restPrefixes } = venuePrefixes;
    updateTournament(tournament.id, {
      venues: venues.map(v => v === oldName ? name : v),
      venuePrefixes: oldPrefix !== undefined ? { ...restPrefixes, [name]: oldPrefix } : venuePrefixes,
    });
    for (const m of allTournamentMatches) {
      if (m.venue === oldName) updateMatch(m.id, { venue: name });
    }
  };
  // The letter used for this venue's fixtures in the auto match number
  // ("Court 1" -> "B" gives "MB1", "MB2"...) — freely chosen per venue, not
  // derived from the venue name, so two venues can't collide and the
  // operator can pick something short and meaningful (e.g. matching a real
  // court/pitch label already in use on printed schedules).
  const venuePrefixes = tournament.venuePrefixes ?? {};
  const setVenuePrefix = (venueName: string, code: string) => {
    updateTournament(tournament.id, { venuePrefixes: { ...venuePrefixes, [venueName]: code.toUpperCase().slice(0, 3) } });
  };

  // Bulk fixture selection — numbers/checkboxes on each row, "Select
  // All"/"Deselect All", and a bulk-edit/delete bar for whatever's checked.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // editMode itself lives in the parent (TournamentManager) now — its toggle
  // button moved into the shared TournamentScopeHeader bar — but exiting
  // edit mode should still drop any in-progress bulk selection/armed swap,
  // same as the old inline toggle handler used to do.
  useEffect(() => {
    if (!editMode) { setSelectedIds(new Set()); setArmedSwapId(null); }
  }, [editMode]);
  const toggleSelected = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelectedIds(new Set(matches.map(m => m.id)));
  const deselectAll = () => setSelectedIds(new Set());
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
    teamAId: m.teamAId, teamAName: m.teamAName, teamAShortName: m.teamAShortName, teamALogo: m.teamALogo, teamAColor: m.teamAColor,
    teamBId: m.teamBId, teamBName: m.teamBName, teamBShortName: m.teamBShortName, teamBLogo: m.teamBLogo, teamBColor: m.teamBColor,
    round: m.round, category: m.category, group: m.group, tier: m.tier,
    matchType: m.matchType, walkoverLoser: m.walkoverLoser, scoreA: m.scoreA, scoreB: m.scoreB,
    sentAt: m.sentAt, completedAt: m.completedAt,
  });
  // A group-stage (round-robin) fixture's "Round N" is meant to track
  // whichever numbered slot it's actually running in — not travel with the
  // match content on a swap like every other field does — so bracket
  // auto-advance's group-completion gating and the Standings/Bracket tabs
  // keep seeing round numbers that match the real running order. Scoped to
  // two fixtures in the SAME group+category (a swap across different
  // groups/categories has no shared round sequence to reconcile, so keeps
  // the plain full-content swap below).
  const isGroupStageFixture = (m: ScheduledMatch) => !extractKnockoutStage(m) && m.group !== '3rd Place' && !!m.group;
  const [pendingRoundSwap, setPendingRoundSwap] = useState<{ fromId: string; toId: string; fromRound?: string; toRound?: string } | null>(null);
  // A true swap — only these two slots' content exchanges; every fixture in
  // between keeps its own slot (date/time/count/venue) exactly as it was.
  // Matches what the drag/move-button tooltips already promise ("that
  // slot's count/time stays put") — a splice-based reorder would instead
  // shift everything between the two positions by one. `keepRound` additionally
  // leaves each slot's own `round` value in place instead of swapping it too
  // (see isGroupStageFixture above) — only ever true after the operator has
  // confirmed it via the modal below, since it also shifts Match # numbering.
  const applyFixtureSwap = (fromId: string, toId: string, keepRound: boolean) => {
    const ordered = matches;
    const fromIdx = ordered.findIndex(m => m.id === fromId);
    const toIdx = ordered.findIndex(m => m.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;
    const fromContent = matchContentOf(ordered[fromIdx]);
    const toContent = matchContentOf(ordered[toIdx]);
    if (keepRound) {
      updateMatch(ordered[fromIdx].id, { ...toContent, round: fromContent.round });
      updateMatch(ordered[toIdx].id, { ...fromContent, round: toContent.round });
    } else {
      updateMatch(ordered[fromIdx].id, toContent);
      updateMatch(ordered[toIdx].id, fromContent);
    }
  };
  const moveFixture = (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const fromM = matches.find(m => m.id === draggedId);
    const toM = matches.find(m => m.id === targetId);
    if (!fromM || !toM) return;
    const roundsDiffer = isGroupStageFixture(fromM) && isGroupStageFixture(toM) &&
      fromM.group === toM.group && fromM.category === toM.category && fromM.round !== toM.round;
    if (roundsDiffer) {
      setPendingRoundSwap({ fromId: draggedId, toId: targetId, fromRound: fromM.round, toRound: toM.round });
      return;
    }
    applyFixtureSwap(draggedId, targetId, false);
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

  const handleGeneratedFixtures = (fixtures: { date: string; time?: string; round: string; category?: string; group?: string; tier?: string; teamA: ScheduleTeamRef; teamB: ScheduleTeamRef | null }[]) => {
    for (const f of fixtures) {
      addMatch({
        tournamentId: tournament.id, competition: tournament.name,
        date: f.date, time: f.time, round: f.round, category: f.category, group: f.group, tier: f.tier,
        teamAId: f.teamA.id, teamAName: f.teamA.name, teamAShortName: f.teamA.shortName, teamAColor: f.teamA.color, teamALogo: f.teamA.logo,
        teamBId: f.teamB?.id, teamBName: f.teamB?.name ?? '', teamBShortName: f.teamB?.shortName, teamBColor: f.teamB?.color ?? '#95a5a6', teamBLogo: f.teamB?.logo,
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

  // A re-imported row is matched back to an existing fixture by team pair +
  // round (case-insensitive) — the export uses the exact same column order
  // (see exportFixturesCSV), so "export → edit a few times in Excel →
  // re-import" round-trips cleanly: a matched fixture only has the columns
  // that actually differ applied (updateMatch), an unmatched row is added as
  // new. A blank cell never clears an existing value — only a column that
  // was actually filled in and differs counts as a change, so re-importing a
  // CSV where only Time was edited doesn't wipe out Venue/Category/Group
  // that were never touched.
  // Matched against EVERY fixture in the tournament, not just whatever
  // category filter happens to be active — importing a full multi-category
  // file while viewing one category would otherwise fail to find the other
  // categories' existing fixtures and create duplicates for them instead of
  // updating them.
  const findImportMatch = (row: ParsedFixtureRow) => {
    const norm = (s: string) => s.trim().toLowerCase();
    const candidates = allTournamentMatches.filter(m =>
      norm(m.teamAName) === norm(row.teamAName) &&
      norm(m.teamBName) === norm(row.teamBName) &&
      norm(m.round ?? '') === norm(row.round ?? '')
    );
    if (candidates.length <= 1) return candidates[0];
    // More than one fixture shares this exact team pair + round text — e.g.
    // "Round 1" repeated across categories, or the same club fielding teams
    // (same display name) in both Men's and Women's. Round-tripping the
    // export unmodified would otherwise silently update whichever one
    // happened to come first, potentially applying a Men's row's date/venue
    // edit to the Women's fixture instead. Category still isn't REQUIRED to
    // match (a CSV edit is allowed to move a fixture between categories,
    // same as it's allowed to edit date/venue/group) — it's only used here
    // to break a genuine tie when one exists.
    return candidates.find(m => norm(m.category ?? '') === norm(row.category ?? '')) ?? candidates[0];
  };

  const importClassified = useMemo(
    () => importPreview?.map(row => ({ row, existing: findImportMatch(row) })) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [importPreview, allTournamentMatches]
  );

  const confirmImport = () => {
    if (!importClassified) return;
    for (const { row, existing } of importClassified) {
      if (existing) {
        const patch: Partial<ScheduledMatch> = {};
        if (row.date && row.date !== existing.date) patch.date = row.date;
        if (row.time !== undefined && row.time !== existing.time) patch.time = row.time;
        if (row.venue !== undefined && row.venue !== existing.venue) patch.venue = row.venue;
        if (row.category !== undefined && row.category !== existing.category) patch.category = row.category;
        if (row.group !== undefined && row.group !== existing.group) patch.group = row.group;
        if (Object.keys(patch).length > 0) updateMatch(existing.id, patch);
        continue;
      }
      const a = resolveTeam(row.teamAName, '#e74c3c');
      const b = resolveTeam(row.teamBName, '#3498db');
      addMatch({
        tournamentId: tournament.id, competition: tournament.name,
        // A row with no Category column value falls back to whichever
        // category is currently active in the picker bar — lets an operator
        // import a category-specific file (e.g. one without a Category
        // column at all) by just picking that category first, without
        // needing every row to spell it out.
        date: row.date, time: row.time, venue: row.venue, category: row.category ?? (activeCategory || undefined), group: row.group, round: row.round,
        teamAName: a.name, teamAShortName: a.shortName, teamAColor: a.color, teamALogo: a.logo,
        teamBName: b.name, teamBShortName: b.shortName, teamBColor: b.color, teamBLogo: b.logo,
      });
    }
    setImportPreview(null);
  };

  const groups = useMemo(() => {
    // A custom sort (see sortKeys) drops the month grouping entirely — it
    // reorders across dates by design (e.g. "all of one Category together"),
    // so a month-by-month split would just fight the very thing it's for.
    // The empty-string label renders no header at all (see below), giving a
    // flat, fully re-ordered list.
    if (sortKeys.length > 0) return [['', sortScheduleBy(matches, sortKeys)]] as [string, typeof matches][];
    const map = new Map<string, typeof matches>();
    for (const m of matches) {
      const d = new Date(m.date + 'T00:00:00');
      const key = isNaN(d.getTime()) ? 'Unscheduled' : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return Array.from(map.entries());
  }, [matches, sortKeys]);

  // Sequential fixture numbers in the same order they're displayed, spanning
  // every month group — not reset per group.
  const numberOf = useMemo(
    () => new Map(groups.flatMap(([, rows]) => rows).map((m, i) => [m.id, i + 1])),
    [groups]
  );
  const allSelected = matches.length > 0 && selectedIds.size === matches.length;

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button className="tm-io-btn" title="Export the WHOLE tournament's fixtures as CSV (every category, regardless of the current filter), including each fixture's Match # — Excel compatible"
          onClick={() => exportFixturesCSV(allTournamentMatches, tournament.name, tournament.matchNumberPrefix, tournament.venuePrefixes)} disabled={allTournamentMatches.length === 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ArrowDown size={14} strokeWidth={2} /> Export CSV
        </button>
      </div>

      <TierMismatchBanner mismatches={tierMismatches} matchNumbers={matchNumbers} onFix={fixTierMismatch} />

      <div className="tm-groups-bar" style={{ marginBottom: 12 }}>
        <span className="tm-groups-label">Sort by:</span>
        {sortKeys.length === 0 ? (
          <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Manual (drag order)</span>
        ) : (
          sortKeys.map((k, i) => (
            <span key={k} className="tm-group-chip">
              {i + 1}. {SCHEDULE_SORT_KEY_LABELS[k]}
              <button onClick={() => moveSortKey(i, -1)} disabled={i === 0} title="Higher sort priority" style={{ marginLeft: 4 }}>↑</button>
              <button onClick={() => moveSortKey(i, 1)} disabled={i === sortKeys.length - 1} title="Lower sort priority">↓</button>
              <button onClick={() => removeSortKey(k)} title={`Remove ${SCHEDULE_SORT_KEY_LABELS[k]} from the sort`}>×</button>
            </span>
          ))
        )}
        <select
          className="tm-input" style={{ width: 'auto' }} value=""
          onChange={e => { if (e.target.value) addSortKey(e.target.value as ScheduleSortKey); }}
        >
          <option value="">+ Add sort key…</option>
          {(Object.keys(SCHEDULE_SORT_KEY_LABELS) as ScheduleSortKey[]).filter(k => !sortKeys.includes(k)).map(k => (
            <option key={k} value={k}>{SCHEDULE_SORT_KEY_LABELS[k]}</option>
          ))}
        </select>
        {sortKeys.length > 0 && (
          <button className="tm-io-btn" onClick={() => setSortKeys([])} title="Clear all sort keys — back to manual drag order">Reset to manual</button>
        )}
      </div>

      {editMode && (
        <div className="tm-groups-bar">
          <span className="tm-groups-label">Venues:</span>
          {venues.map(v => (
            <span key={v} className="tm-group-chip tm-group-chip--editable">
              <input
                className="tm-group-chip-input"
                defaultValue={v}
                title="Rename venue"
                onClick={e => e.stopPropagation()}
                onBlur={e => renameVenue(v, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              <input
                className="tm-group-chip-input"
                value={venuePrefixes[v] ?? ''}
                placeholder="#"
                title={`Letter code for ${v}'s fixtures in the auto match number — e.g. "B" gives MB1, MB2...`}
                maxLength={3}
                onChange={e => setVenuePrefix(v, e.target.value)}
                onClick={e => e.stopPropagation()}
              />
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
        <div className="tm-groups-bar" style={{ marginTop: -6 }}>
          <span className="tm-groups-label">Match # Prefix:</span>
          <input
            className="tm-input tm-groups-add-input"
            style={{ flexBasis: 70 }}
            placeholder="e.g. M"
            value={tournament.matchNumberPrefix ?? ''}
            onChange={e => updateTournament(tournament.id, { matchNumberPrefix: e.target.value.toUpperCase().slice(0, 4) })}
          />
          <span className="tm-group-chip-count">
            {tournament.matchNumberPrefix
              ? `Numbers every fixture in running order, e.g. "${tournament.matchNumberPrefix}${venues[0] ? (venuePrefixes[venues[0]] || '') : ''}1" — set each venue's letter above.`
              : 'Off — leave blank to not number fixtures.'}
          </span>
        </div>
      )}

      {editMode && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tm-io-btn" onClick={selectAll} disabled={matches.length === 0 || allSelected} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckSquare size={14} strokeWidth={2} /> Select All</button>
            <button className="tm-io-btn" onClick={deselectAll} disabled={selectedIds.size === 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Square size={14} strokeWidth={2} /> Deselect All</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tm-io-btn" title="Auto-generate fixtures (round robin, knockout, groups + knockout)" onClick={() => setShowGenerate(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Wand2 size={14} strokeWidth={2} /> Generate Schedule
            </button>
            <button
              className="tm-io-btn"
              title={`Import fixtures from CSV / TSV / TXT — matched back to existing fixtures across the whole tournament (any category), so only what actually changed gets updated. A row with no Category column falls back to${activeCategory ? ` the current "${activeCategory}" filter` : ' none'}.`}
              onClick={() => fileInputRef.current?.click()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <ArrowUp size={14} strokeWidth={2} /> Import
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
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            label={<><Trash2 size={14} strokeWidth={2} /> Delete {selectedIds.size}</>}
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

      {importClassified && (
        <div className="tm-import-preview" style={{ marginBottom: 12 }}>
          <div className="tm-import-preview-title">
            Found <strong>{importClassified.length}</strong> fixture{importClassified.length !== 1 ? 's' : ''} —{' '}
            {importClassified.filter(x => !x.existing).length} new,{' '}
            {importClassified.filter(x => x.existing).length} matched to existing (only changed fields update)
          </div>
          <div className="tm-import-preview-list">
            {importClassified.slice(0, 5).map(({ row, existing }, i) => (
              <div key={i} className="tm-import-preview-row">
                <span className="tm-import-preview-jersey">{row.date}</span>
                <span className="tm-import-preview-name">{row.teamAName} vs {row.teamBName}</span>
                <span className="tm-import-preview-pos">{existing ? 'update' : 'new'}</span>
              </div>
            ))}
            {importClassified.length > 5 && (
              <div className="tm-import-preview-more">+{importClassified.length - 5} more…</div>
            )}
          </div>
          <div className="tm-import-preview-actions">
            <button className="tm-io-btn tm-io-btn--ok" onClick={confirmImport}>Import {importClassified.length} fixture{importClassified.length !== 1 ? 's' : ''}</button>
            <button className="tm-io-btn" onClick={() => setImportPreview(null)}>Cancel</button>
          </div>
        </div>
      )}

      {matches.length === 0 ? (
        <div className="tm-win-placeholder">
          <span>No fixtures in this tournament yet — add one here, then pick it from a scoreboard's "Load Match" button.</span>
        </div>
      ) : (
        // No longer sub-grouped by stage — the default view follows match id
        // (sortIndex) order straight through a month, same order whether or
        // not it happens to cross stage/tier boundaries. A divider (below)
        // marks wherever the stage/tier VALUE changes from one row to the
        // next in that same order — it never clusters/reorders rows to
        // group them, since categories/tiers run in parallel on the same
        // dates and naturally interleave; "Tier"/"Category" remain
        // available as explicit sort keys (see sortKeys above) for anyone
        // who wants same-tier rows walked consecutively.
        groups.map(([label, rows]) => (
          <div key={label} className="tm-sched-group">
            {label && <div className="tm-sched-group-title">{label}</div>}
            <div className="tm-sched-rows">
              {rows.map((m, i) => {
                const idxInAll = matches.findIndex(x => x.id === m.id);
                const isLive = liveFixtureIds.has(m.id);
                const stageLabel = fixtureStageLabel(m);
                const prevStageLabel = i > 0 ? fixtureStageLabel(rows[i - 1]) : undefined;
                const showDivider = !!stageLabel && stageLabel !== prevStageLabel;
                return (
                <Fragment key={m.id}>
                {showDivider && <div className="tm-sched-stage-title">{stageLabel}</div>}
                <div className="tm-sched-row-wrap">
                <div
                  data-fixture-row={m.id}
                  className={`tm-sched-row${m.completedAt ? ' tm-sched-row--completed' : ''}${selectedIds.has(m.id) ? ' tm-sched-row--selected' : ''}${canReorder ? ' tm-sched-row--draggable' : ''}${draggedFixtureId === m.id ? ' tm-sched-row--dragging' : ''}${dragOverFixtureId === m.id && draggedFixtureId !== m.id ? ' tm-sched-row--drag-over' : ''}${isLive ? ' tm-sched-row--live' : ''}`}
                  onMouseDown={canReorder ? startFixtureDrag(m) : undefined}
                  title={canReorder ? 'Drag onto another slot to swap which match plays there — that slot\'s count/time stays put' : undefined}
                >
                  {canReorder && (
                    <div className="tm-sched-row-move">
                      <button
                        className="tm-sched-row-move-btn"
                        disabled={idxInAll <= 0}
                        title="Swap into the slot above (count/time stays with the slot)"
                        onClick={() => moveFixtureBy(m.id, -1)}
                      ><ArrowUp size={12} strokeWidth={2} /></button>
                      <button
                        className="tm-sched-row-move-btn"
                        disabled={idxInAll < 0 || idxInAll >= matches.length - 1}
                        title="Swap into the slot below (count/time stays with the slot)"
                        onClick={() => moveFixtureBy(m.id, 1)}
                      ><ArrowDown size={12} strokeWidth={2} /></button>
                    </div>
                  )}
                  <button
                    className={`tm-result-expand-btn${expandedIds.has(m.id) ? ' tm-result-expand-btn--open' : ''}`}
                    title={expandedIds.has(m.id) ? 'Hide details' : 'Show details (score events, cards)'}
                    onClick={() => toggleExpanded(m.id)}
                  ><ChevronRight size={14} strokeWidth={2} /></button>
                  <input
                    type="checkbox"
                    className="tm-sched-row-check"
                    checked={selectedIds.has(m.id)}
                    onChange={() => toggleSelected(m.id)}
                    title="Select for bulk edit/delete"
                    style={editMode ? undefined : { visibility: 'hidden' }}
                  />
                  <span className="tm-sched-row-num">{numberOf.get(m.id)}</span>
                  {matchNumbers.has(m.id) && (
                    <span className="tm-sched-matchnum-badge" title="Auto match number (Match # Prefix + venue letter + running sequence)">
                      {matchNumbers.get(m.id)}
                    </span>
                  )}
                  <div className="tm-sched-divider" />
                  {isLive && <span className="tm-sched-live-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Circle size={8} fill="currentColor" stroke="none" /> LIVE</span>}
                  {m.completedAt && <span className="tm-sched-completed-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={11} strokeWidth={2} /> Completed</span>}
                  <EditableDate value={m.date} onChange={date => updateMatch(m.id, { date })} disabled={!editMode} />
                  <div className="tm-sched-divider" />

                  <div className="tm-sched-matchup">
                    <div className="tm-sched-team">
                      <EditableText className="tm-sched-team-name" value={m.teamAName} placeholder="Team A"
                        // Typing a name directly can't confirm it still
                        // matches whatever team teamAId used to point at
                        // (the ScheduleTeamPicker above is the only source
                        // that knows for sure) — clearing it here instead
                        // of leaving it stale is what the backfill/repair
                        // banner then re-resolves from this new name, same
                        // as any other never-set id.
                        onChange={v => updateMatch(m.id, { teamAName: v, teamAId: undefined })} disabled={!editMode} />
                      <LogoUrlPicker compact value={m.teamALogo ?? ''} onChange={logo => updateMatch(m.id, { teamALogo: logo })}
                        thumbSize={{ w: 36, h: 36 }} thumbContent={<ScheduleBadge logo={m.teamALogo} color={m.teamAColor} />} tournamentId={tournament.id} disabled={!editMode} />
                      {editMode && <ScheduleTeamPicker side="A" tournamentId={tournament.id} onPick={t => updateMatch(m.id, { teamAId: t.id, teamAName: t.name, teamAShortName: t.shortName, teamAColor: t.color, teamALogo: t.logo })} />}
                    </div>
                    <div className="tm-sched-vs-col">
                      {m.matchType && (
                        <span className="tm-sched-type-badge" title={
                          m.matchType === 'bye'
                            ? 'Automatic — no Team B name set'
                            : `Automatic — ${m.walkoverLoser === 'A' ? m.teamAName : m.teamBName} is on Walkover status in the Team Database`
                        }>{m.matchType === 'bye' ? 'BYE' : 'W/O'}</span>
                      )}
                      {hasMultipleVenues && m.venueLabel && (
                        <span className="tm-sched-venue-badge" title={`Synced from venue: ${m.venueLabel}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><MapPin size={11} strokeWidth={2} /> {m.venueLabel}</span>
                      )}
                      {m.matchType && m.completedAt ? (
                        <span className="tm-sched-vs tm-sched-score">
                          <EditableText value={String(m.scoreA ?? 0)} onChange={v => updateMatch(m.id, { scoreA: Number(v) || 0 })} disabled={!editMode} />
                          <span className="tm-sched-score-sep">–</span>
                          <EditableText value={String(m.scoreB ?? 0)} onChange={v => updateMatch(m.id, { scoreB: Number(v) || 0 })} disabled={!editMode} />
                        </span>
                      ) : (
                        <span className="tm-sched-vs">VS</span>
                      )}
                      {editMode && (
                        <button
                          className="tm-sched-swap-sides-btn"
                          title="Swap Team A / Team B (home/away)"
                          onClick={() => updateMatch(m.id, {
                            teamAId: m.teamBId, teamAName: m.teamBName, teamAShortName: m.teamBShortName,
                            teamAColor: m.teamBColor, teamALogo: m.teamBLogo,
                            teamBId: m.teamAId, teamBName: m.teamAName, teamBShortName: m.teamAShortName,
                            teamBColor: m.teamAColor, teamBLogo: m.teamALogo,
                            scoreA: m.scoreB, scoreB: m.scoreA,
                            walkoverLoser: m.walkoverLoser === 'A' ? 'B' : m.walkoverLoser === 'B' ? 'A' : m.walkoverLoser,
                          })}
                        ><ArrowLeftRight size={11} strokeWidth={2} /></button>
                      )}
                      {editMode ? (
                        <EditableText className="tm-sched-round" value={m.round ?? ''} placeholder="Round"
                          onChange={v => updateMatch(m.id, { round: v })} />
                      ) : (
                        m.round && <span className="tm-sched-round">{m.round}</span>
                      )}
                    </div>
                    <div className="tm-sched-team tm-sched-team--b">
                      {editMode && <ScheduleTeamPicker side="B" tournamentId={tournament.id} onPick={t => updateMatch(m.id, { teamBId: t.id, teamBName: t.name, teamBShortName: t.shortName, teamBColor: t.color, teamBLogo: t.logo })} />}
                      <LogoUrlPicker compact value={m.teamBLogo ?? ''} onChange={logo => updateMatch(m.id, { teamBLogo: logo })}
                        thumbSize={{ w: 36, h: 36 }} thumbContent={<ScheduleBadge logo={m.teamBLogo} color={m.teamBColor} />} tournamentId={tournament.id} disabled={!editMode} />
                      <EditableText className="tm-sched-team-name" value={m.teamBName} placeholder="Team B"
                        onChange={v => updateMatch(m.id, { teamBName: v, teamBId: undefined })} disabled={!editMode} />
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
                      // stage (e.g. "Quarterfinal") rather than a real Draw group. The
                      // fixed knockout-stage options below cover picking one explicitly
                      // (combined with the Tier field, this is what lets an operator set
                      // a fixture to e.g. "Final" + "Plate" by hand) — this extra
                      // "(stage)" option only appears for some OTHER, non-standard value
                      // (e.g. a custom "Round of 16") that isn't in either list, so it
                      // doesn't disappear from the dropdown.
                      const isAutoStage = !!m.group && !knownGroups.some(g => g.name === m.group) && !KNOCKOUT_STAGE_OPTIONS.includes(m.group);
                      return (
                        <select
                          className="tm-sched-catgroup-select"
                          value={m.group ?? ''}
                          onChange={e => updateMatch(m.id, { group: e.target.value || undefined })}
                          title={isAutoStage ? 'Auto-set from the knockout bracket stage' : undefined}
                        >
                          <option value="">— Group —</option>
                          {isAutoStage && <option value={m.group}>{m.group} (stage)</option>}
                          {KNOCKOUT_STAGE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
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
                    {/* Only for a Cup/Plate/Bowl/Shield tournament — distinct
                        from `group` (which for a knockout fixture just holds
                        the literal stage name "Semifinal"/"Final", identical
                        across every tier). This is what actually determines
                        which tier's bracket a fixture belongs to; there's no
                        other way to correct it if it's ever wrong (e.g. after
                        editing round text by hand) short of deleting and
                        regenerating the whole knockout stage. */}
                    {hasTiers && (editMode ? (
                      <EditableText className="tm-sched-catgroup-select tm-sched-catgroup-select--secondary" value={m.tier ?? ''} placeholder="Tier"
                        onChange={v => updateMatch(m.id, { tier: v || undefined })} />
                    ) : (
                      m.tier && <span className="tm-sched-catgroup-select tm-sched-catgroup-select--secondary">{m.tier}</span>
                    ))}
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
                        <button className="tm-sched-send-btn tm-sched-send-btn--cancel" title="Cancel swap" onClick={() => setArmedSwapId(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={12} strokeWidth={2} /> Cancel</button>
                      ) : armedSwapId ? (
                        <button className="tm-sched-send-btn tm-sched-send-btn--swap-here" title="Complete the swap with this fixture" onClick={() => { moveFixture(armedSwapId, m.id); setArmedSwapId(null); }}><ArrowLeftRight size={12} strokeWidth={2} /> Swap Here</button>
                      ) : (
                        <button className="tm-sched-send-btn" title="Pick this fixture to swap, then click Swap Here on the target" onClick={() => setArmedSwapId(m.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><RefreshCw size={12} strokeWidth={2} /> Swap</button>
                      )
                    ) : (
                      <ScoreboardSendButton match={m} scoreboards={scoreboards} onSend={id => sendToScoreboard(m, id)} onStop={() => handleStopLive(m)} />
                    )}
                  </div>

                  {editMode && <button className="tm-sched-del" title="Delete fixture" onClick={() => setDeleteFixtureTarget(m)}>×</button>}
                </div>
                {expandedIds.has(m.id) && (
                  <FixtureDetail
                    m={m}
                    result={savedResults.find(r => r.sourceScheduleId === m.id)}
                    editMode={editMode}
                    periodsTotal={periodsTotal}
                    sport={tournament.sport}
                    onUpdateResult={patch => {
                      const existing = savedResults.find(r => r.sourceScheduleId === m.id);
                      if (existing) updateResult(existing.id, patch);
                    }}
                  />
                )}
                </div>
                </Fragment>
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
      {stopTarget && (
        <ConfirmModal
          title="Stop live game?"
          message="This fixture has a saved result already. Stopping will remove that result and mark the fixture as not sent."
          confirmLabel="Stop & Remove Result"
          danger
          onConfirm={() => { deleteResult(stopTarget.resultId!); unmarkSent(stopTarget.matchId); setStopTarget(null); }}
          onCancel={() => setStopTarget(null)}
        />
      )}
      {deleteFixtureTarget && (
        <ConfirmModal
          title="Delete fixture?"
          message={`This removes "${deleteFixtureTarget.teamAName} vs ${deleteFixtureTarget.teamBName || 'TBD'}" from the schedule permanently. This can't be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { deleteMatch(deleteFixtureTarget.id); setDeleteFixtureTarget(null); }}
          onCancel={() => setDeleteFixtureTarget(null)}
        />
      )}
      {pendingRoundSwap && (
        <ConfirmModal
          title="Swap fixtures?"
          message={`"${pendingRoundSwap.fromRound ?? '(no round)'}" and "${pendingRoundSwap.toRound ?? '(no round)'}" will also relabel to match each match's new slot, so round numbering stays in running order — this can shift each fixture's Match # too.`}
          confirmLabel="Swap"
          onConfirm={() => { applyFixtureSwap(pendingRoundSwap.fromId, pendingRoundSwap.toId, true); setPendingRoundSwap(null); }}
          onCancel={() => setPendingRoundSwap(null)}
        />
      )}
    </div>
  );
}

// Quick-start titles for "+ Add Segment" — common non-match items on an
// event day's running order. Purely a convenience prefill: a segment is
// just free text (RundownSegment.title), so picking one here is no
// different from typing it by hand, and the title stays fully editable
// afterward either way. "Custom…" adds the same blank "New segment" the
// button used to add unconditionally.
const RUNDOWN_SEGMENT_PRESETS = [
  'Break', 'Setup Day', 'Opening Ceremony', 'Warm-up', 'Briefing',
  'Lunch Break', 'Technical Meeting', 'Medal Ceremony', 'Closing Ceremony', 'End of Day',
];

// ── Rundown tab: a broadcast-style running order for the whole event day —
// segments can be freeform (title/time/notes typed in directly) or linked
// to a real fixture from the Schedule (status/teams/score then follow that
// fixture automatically — see deriveRundownStatus in rundownStore.ts).
// Deliberately NOT tournament-scoped, unlike every other tab here — a
// rundown spans the whole day, which may cross several tournaments.
function RundownPanel() {
  const { segments: allSegments, addSegment, updateSegment, deleteSegment } = useRundownStore();
  const { matches } = useMatchScheduleStore();
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const segments = useMemo(() => [...allSegments].sort(sortRundownSegments), [allSegments]);
  const matchById = useMemo(() => new Map(matches.map(m => [m.id, m])), [matches]);
  const statusOf = (s: RundownSegment) =>
    deriveRundownStatus(s, s.linkedScheduleMatchId ? matchById.get(s.linkedScheduleMatchId) : undefined);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Group by date only when more than one date is actually in play — a
  // single-day rundown (the common case) just reads as one flat list.
  const dateGroups = useMemo(() => {
    const map = new Map<string, RundownSegment[]>();
    for (const s of segments) {
      if (!map.has(s.date)) map.set(s.date, []);
      map.get(s.date)!.push(s);
    }
    return Array.from(map.entries());
  }, [segments]);
  const showDateHeaders = dateGroups.length > 1;

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragStateRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);

  // Plain splice reorder (not SchedulePanel's content-preserving slot swap —
  // a segment's own time/notes/link should travel WITH it when moved, there's
  // no fixed-slot concept here).
  const moveSegment = (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const ordered = segments;
    const fromIdx = ordered.findIndex(s => s.id === draggedId);
    const toIdx = ordered.findIndex(s => s.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...ordered];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    reordered.forEach((s, i) => { if (s.sortIndex !== i) updateSegment(s.id, { sortIndex: i }); });
  };
  const moveSegmentBy = (id: string, direction: -1 | 1) => {
    const idx = segments.findIndex(s => s.id === id);
    const neighbor = segments[idx + direction];
    if (idx === -1 || !neighbor) return;
    moveSegment(id, neighbor.id);
  };

  // Native HTML5 drag-and-drop doesn't fire reliably in this app's WebView
  // (same finding as SchedulePanel's own fixture drag) — plain mouse events
  // instead: press, move past a small threshold to arm it, hit-test whatever
  // row is under the cursor via elementFromPoint.
  const startSegmentDrag = (s: RundownSegment) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('input, button, select, textarea, a')) return;
    const startX = e.clientX, startY = e.clientY;
    dragStateRef.current = { id: s.id, startX, startY, active: false };
    const onMove = (ev: MouseEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (!st.active) {
        if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) < 6) return;
        st.active = true;
        setDraggedId(st.id);
        document.body.style.userSelect = 'none';
      }
      ev.preventDefault();
      setDragPos({ x: ev.clientX, y: ev.clientY });
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const rowEl = under?.closest('[data-rundown-row]') as HTMLElement | null;
      const overId = rowEl?.getAttribute('data-rundown-row') ?? null;
      setDragOverId(overId && overId !== st.id ? overId : null);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      const st = dragStateRef.current;
      if (st?.active) {
        setDragOverId(overId => {
          if (overId) moveSegment(st.id, overId);
          return null;
        });
      }
      dragStateRef.current = null;
      setDraggedId(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const toggleSelected = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelectedIds(new Set(segments.map(s => s.id)));
  const deselectAll = () => setSelectedIds(new Set());
  const deleteSelected = () => { for (const id of selectedIds) deleteSegment(id); setSelectedIds(new Set()); };
  const allSelected = segments.length > 0 && selectedIds.size === segments.length;

  const handleAdd = (title: string) => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    addSegment({ date, title });
  };

  const renderRow = (s: RundownSegment) => {
    const linkedMatch = s.linkedScheduleMatchId ? matchById.get(s.linkedScheduleMatchId) : undefined;
    const orphaned = !!s.linkedScheduleMatchId && !linkedMatch;
    const status = statusOf(s);
    const idx = segments.findIndex(x => x.id === s.id);
    const scheduledTs = parseScheduledDateTime(s.date, s.time);
    const isLate = status === 'upcoming' && scheduledTs !== null && now > scheduledTs;

    return (
      <div key={s.id} className="tm-sched-row-wrap">
        <div
          data-rundown-row={s.id}
          className={`tm-sched-row${status === 'done' ? ' tm-sched-row--completed' : ''}${selectedIds.has(s.id) ? ' tm-sched-row--selected' : ''}${editMode ? ' tm-sched-row--draggable' : ''}${draggedId === s.id ? ' tm-sched-row--dragging' : ''}${dragOverId === s.id && draggedId !== s.id ? ' tm-sched-row--drag-over' : ''}${status === 'live' ? ' tm-sched-row--live' : ''}`}
          onMouseDown={editMode ? startSegmentDrag(s) : undefined}
          title={editMode ? 'Drag onto another slot to reorder' : undefined}
        >
          {editMode && (
            <div className="tm-sched-row-move">
              <button className="tm-sched-row-move-btn" disabled={idx <= 0} title="Move up" onClick={() => moveSegmentBy(s.id, -1)}><ArrowUp size={12} strokeWidth={2} /></button>
              <button className="tm-sched-row-move-btn" disabled={idx < 0 || idx >= segments.length - 1} title="Move down" onClick={() => moveSegmentBy(s.id, 1)}><ArrowDown size={12} strokeWidth={2} /></button>
            </div>
          )}
          <input
            type="checkbox"
            className="tm-sched-row-check"
            checked={selectedIds.has(s.id)}
            onChange={() => toggleSelected(s.id)}
            title="Select for bulk delete"
            style={editMode ? undefined : { visibility: 'hidden' }}
          />
          <EditableDate value={s.date} onChange={date => updateSegment(s.id, { date })} disabled={!editMode} />
          <EditableTime value={s.time} onChange={time => updateSegment(s.id, { time })} disabled={!editMode} />
          <div className="tm-sched-divider" />

          {status === 'live' && <span className="tm-sched-live-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Circle size={8} fill="currentColor" stroke="none" /> LIVE</span>}
          {status === 'done' && <span className="tm-sched-completed-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={11} strokeWidth={2} /> Done</span>}
          {isLate && <span className="tm-sched-venue-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#ff6b5b' }}><AlertTriangle size={11} strokeWidth={2} /> {formatLate(now - scheduledTs!)} late</span>}

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {linkedMatch ? (
                <span style={{ fontWeight: 700, fontSize: 12 }}>{linkedMatch.teamAName} vs {linkedMatch.teamBName}</span>
              ) : (
                <EditableText className="tm-sched-team-name" value={s.title} placeholder="Segment title" onChange={v => updateSegment(s.id, { title: v })} disabled={!editMode} />
              )}
              {s.linkedScheduleMatchId && (
                orphaned
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#ff6b5b', flexShrink: 0 }}><AlertTriangle size={11} strokeWidth={2} /> fixture missing</span>
                  : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}><Link2 size={11} strokeWidth={2} /> linked</span>
              )}
            </div>
            {editMode && (
              <EditableText value={s.notes ?? ''} placeholder="Notes" onChange={v => updateSegment(s.id, { notes: v })} />
            )}
          </div>

          {editMode && (
            <input
              type="number" min={0} className="tm-input" style={{ width: 56 }}
              value={s.durationMin ?? ''} placeholder="min"
              title="Planned duration in minutes"
              onChange={e => updateSegment(s.id, { durationMin: e.target.value ? Number(e.target.value) : undefined })}
            />
          )}

          {editMode && (
            s.linkedScheduleMatchId ? (
              <button className="tm-io-btn" onClick={() => updateSegment(s.id, { linkedScheduleMatchId: undefined })}>Unlink</button>
            ) : (
              <select
                className="tm-input" style={{ width: 150 }} value=""
                title="Link this segment to a real fixture — its status/teams/score will then follow that fixture automatically"
                onChange={e => {
                  const m = matches.find(x => x.id === e.target.value);
                  if (m) updateSegment(s.id, { linkedScheduleMatchId: m.id, title: `${m.teamAName} vs ${m.teamBName}` });
                }}
              >
                <option value="">Link to fixture…</option>
                {matches.map(m => <option key={m.id} value={m.id}>{m.date}{m.time ? ` ${m.time}` : ''} — {m.teamAName} vs {m.teamBName}</option>)}
              </select>
            )
          )}

          <button
            className="tm-result-expand-btn"
            title="Delete segment"
            onClick={() => deleteSegment(s.id)}
            style={editMode ? undefined : { visibility: 'hidden' }}
          ><X size={14} strokeWidth={2} /></button>
        </div>
      </div>
    );
  };

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          A running order for the whole event day — spans every tournament, not just one.
        </div>
        <button
          className={`tm-io-btn${editMode ? ' tm-io-btn--ok' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setEditMode(v => !v)}
        >
          {editMode ? <><Check size={14} strokeWidth={2} /> Done Editing</> : <><Pencil size={14} strokeWidth={2} /> Edit</>}
        </button>
      </div>

      {editMode && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tm-io-btn" onClick={selectAll} disabled={segments.length === 0 || allSelected} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckSquare size={14} strokeWidth={2} /> Select All</button>
            <button className="tm-io-btn" onClick={deselectAll} disabled={selectedIds.size === 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Square size={14} strokeWidth={2} /> Deselect All</button>
          </div>
          <select
            className="tm-sidebar-new-btn"
            value=""
            title="Add a rundown item — pick a common one or add a custom segment"
            onChange={e => { if (e.target.value) handleAdd(e.target.value === '__custom__' ? 'New segment' : e.target.value); }}
          >
            <option value="" disabled>＋ Add Segment</option>
            <option value="__custom__">Custom…</option>
            {RUNDOWN_SEGMENT_PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}

      {editMode && selectedIds.size > 0 && (
        <div className="tm-draw-vmix-cfg" style={{ marginBottom: 12 }}>
          <span className="tm-groups-label">{selectedIds.size} selected —</span>
          <ConfirmButton
            className="tm-io-btn tm-io-btn--danger"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            label={<><Trash2 size={14} strokeWidth={2} /> Delete {selectedIds.size}</>}
            confirmLabel="Delete"
            message={`Delete ${selectedIds.size} selected segment${selectedIds.size !== 1 ? 's' : ''}?`}
            onConfirm={deleteSelected}
          />
          <button className="tm-io-btn" onClick={deselectAll}>Clear Selection</button>
        </div>
      )}

      {segments.length === 0 ? (
        <div className="tm-win-placeholder">
          <span>No rundown segments yet — add one to start planning the day.</span>
        </div>
      ) : (
        dateGroups.map(([date, rows]) => (
          <div key={date} className="tm-sched-group">
            {showDateHeaders && <div className="tm-sched-group-title">{date}</div>}
            <div className="tm-sched-rows">
              {rows.map(renderRow)}
            </div>
          </div>
        ))
      )}

      {draggedId && dragPos && createPortal(
        (() => {
          const ds = segments.find(x => x.id === draggedId);
          if (!ds) return null;
          return (
            <div className="tm-sched-drag-ghost" style={{ left: dragPos.x, top: dragPos.y }}>
              {ds.title}
            </div>
          );
        })(),
        document.body
      )}
    </div>
  );
}

// ── Results tab: saved match results belonging to the selected tournament ─────
// Populated by a scoreboard's "Save Result" (or the auto-save-on-overwrite
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

type ScoreLogEntry = NonNullable<SavedMatchResult['scoreLog']>[number];
type CardEntry = NonNullable<SavedMatchResult['cards']>[number];

// Full, unambiguous score-type names for the manual event editor below —
// same label/points pairs the live scoreboard's increment buttons use
// (RUGBY_UNION_INCS/RUGBY_LEAGUE_INCS in WidgetConfigPanel.tsx), just
// spelled out ("Conversion" not "Conv") since this is a considered "pick
// the right type" context, not a quick tap during a live match. Matters for
// more than just display: classifyAction (localPlayerStats.ts) buckets a
// scoreLog entry into tries/conversions/penalties/dropGoals by loosely
// matching this same string, so picking from a known-good list here (kept
// in sync with the live buttons) avoids a typo silently dropping a manually
// -entered score out of a player's stats.
const RUGBY_ACTION_FULL_LABEL: Record<string, string> = { Try: 'Try', Conv: 'Conversion', Pen: 'Penalty', Drop: 'Drop Goal', PTry: 'Penalty Try' };
function rugbyScoreTypes(sport: SportType | undefined): { label: string; points: number }[] {
  const incs = sport === 'rugby_league' ? RUGBY_LEAGUE_INCS : RUGBY_UNION_INCS;
  return incs.map(inc => ({ label: RUGBY_ACTION_FULL_LABEL[inc.label] ?? inc.label, points: inc.value }));
}

// Per-event editable list for a result's scoreLog (who scored what, and
// when) and cards — the aggregate breakdown table above only ever showed
// counts per action type, never which player actually scored, so this is
// the only place "who made the score" can be seen or corrected at all.
// Read-only when editMode is off, matching every other field in these two
// tabs (Schedule/Results share the same edit-mode convention).
function ScoreEventsEditor({ r, editMode, onUpdate, periodsTotal, sport }: {
  r: SavedMatchResult; editMode: boolean; onUpdate: (patch: Partial<SavedMatchResult>) => void; periodsTotal: number; sport: SportType | undefined;
}) {
  const scoreLog = r.scoreLog ?? [];
  const cards = r.cards ?? [];
  const teamLabel = (team: 'A' | 'B') => team === 'A' ? (r.teamAShortName || r.teamAName) : (r.teamBShortName || r.teamBName);
  const teamColor = (team: 'A' | 'B') => team === 'A' ? r.teamAColor : r.teamBColor;
  const scoreTypes = useMemo(() => rugbyScoreTypes(sport), [sport]);

  const updateLog = (i: number, patch: Partial<ScoreLogEntry>) =>
    onUpdate({ scoreLog: scoreLog.map((e, idx) => idx === i ? { ...e, ...patch } : e) });
  const addLog = () => {
    const first = scoreTypes[0];
    onUpdate({ scoreLog: [...scoreLog, { team: 'A', action: first?.label ?? 'Try', points: first?.points ?? 5, period: periodsTotal >= 1 ? 1 : undefined }] });
  };

  const updateCard = (i: number, patch: Partial<CardEntry>) =>
    onUpdate({ cards: cards.map((c, idx) => idx === i ? { ...c, ...patch } : c) });
  const addCard = () => onUpdate({ cards: [...cards, { team: 'A', type: 'yellow' }] });

  // Delete is always available regardless of editMode — fixing a wrongly
  // attributed/duplicate event shouldn't require first toggling the tab's
  // broader field-edit mode. But it's still permanent, so it goes through
  // the same confirm step as every other destructive action here.
  const [pendingDelete, setPendingDelete] = useState<{ type: 'log' | 'card'; index: number } | null>(null);
  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.type === 'log') onUpdate({ scoreLog: scoreLog.filter((_, idx) => idx !== pendingDelete.index) });
    else onUpdate({ cards: cards.filter((_, idx) => idx !== pendingDelete.index) });
    setPendingDelete(null);
  };

  // A score type not on the current sport's canonical list (an older
  // free-typed action, or a custom one) shows the select as "Custom…" and
  // reveals a text input to edit/keep it — everything else stays a plain
  // dropdown so the common case can't drift into a typo. Explicitly forced
  // open per-row (rather than only inferred from the action text) so
  // picking "Custom…" doesn't immediately snap back to the last real match.
  const [customRows, setCustomRows] = useState<Set<number>>(new Set());
  const isCustom = (i: number, action: string) => customRows.has(i) || !scoreTypes.some(t => t.label === action);

  if (!editMode && scoreLog.length === 0 && cards.length === 0) return null;

  return (
    <>
      {(editMode || scoreLog.length > 0) && (
        <div className="tm-result-log">
          <div className="tm-result-log-hdr">
            <span>Score Events</span>
            {editMode && <button className="tm-io-btn" onClick={addLog}>+ Add</button>}
          </div>
          {scoreLog.length === 0 && <div className="tm-result-detail-empty">No score events recorded.</div>}
          {scoreLog.map((e, i) => (
            <div key={i} className="tm-result-log-row">
              {editMode ? (
                <>
                  <select className="field-input" style={{ width: 'auto' }} value={e.team} onChange={ev => updateLog(i, { team: ev.target.value as 'A' | 'B' })}>
                    <option value="A">{r.teamAShortName || r.teamAName}</option>
                    <option value="B">{r.teamBShortName || r.teamBName}</option>
                  </select>
                  <select className="field-input" style={{ width: 'auto' }}
                    value={isCustom(i, e.action) ? '__custom__' : e.action}
                    onChange={ev => {
                      if (ev.target.value === '__custom__') {
                        setCustomRows(prev => new Set(prev).add(i));
                        return;
                      }
                      setCustomRows(prev => { if (!prev.has(i)) return prev; const next = new Set(prev); next.delete(i); return next; });
                      const type = scoreTypes.find(t => t.label === ev.target.value);
                      updateLog(i, { action: ev.target.value, ...(type ? { points: type.points } : {}) });
                    }}>
                    {scoreTypes.map(t => <option key={t.label} value={t.label}>{t.label}</option>)}
                    <option value="__custom__">Custom…</option>
                  </select>
                  {isCustom(i, e.action) && (
                    <input className="field-input" style={{ width: 90 }} value={e.action} placeholder="Action" autoFocus
                      onChange={ev => updateLog(i, { action: ev.target.value })} />
                  )}
                  <input className="field-input" style={{ width: 48 }} type="number" value={e.points} placeholder="Pts"
                    onChange={ev => updateLog(i, { points: Number(ev.target.value) || 0 })} />
                  <input className="field-input" style={{ width: 130 }} value={e.scorer ?? ''} placeholder="Scorer name"
                    onChange={ev => updateLog(i, { scorer: ev.target.value })} />
                  <input className="field-input" style={{ width: 48 }} value={e.jerseyNo ?? ''} placeholder="#"
                    onChange={ev => updateLog(i, { jerseyNo: ev.target.value })} />
                  <input className="field-input" style={{ width: 64 }} value={e.timeStr ?? ''} placeholder="Time"
                    onChange={ev => updateLog(i, { timeStr: ev.target.value })} />
                  <input className="field-input" style={{ width: 44 }} type="number" min={1} max={periodsTotal || undefined}
                    value={e.period ?? ''} placeholder="Per." title="Period (half/quarter) this happened in"
                    onChange={ev => updateLog(i, { period: ev.target.value ? Number(ev.target.value) : undefined })} />
                </>
              ) : (
                <>
                  <span className="tm-result-log-team" style={{ color: teamColor(e.team) }}>{teamLabel(e.team)}</span>
                  <span className="tm-result-log-action">{e.action}</span>
                  <span className="tm-result-log-pts">{e.points}pt</span>
                  <span className="tm-result-log-scorer">{e.scorer ? `#${e.jerseyNo ?? '—'} ${e.scorer}` : '— no scorer picked —'}</span>
                  {e.period !== undefined && <span className="tm-result-log-period">{periodLabel(e.period, periodsTotal || 2)}</span>}
                  {e.timeStr && <span className="tm-result-log-time">{e.timeStr}</span>}
                </>
              )}
              <button className="tm-result-log-del" title="Remove event" onClick={() => setPendingDelete({ type: 'log', index: i })}>×</button>
            </div>
          ))}
        </div>
      )}
      {(editMode || cards.length > 0) && (
        <div className="tm-result-log">
          <div className="tm-result-log-hdr">
            <span>Cards</span>
            {editMode && <button className="tm-io-btn" onClick={addCard}>+ Add</button>}
          </div>
          {cards.length === 0 && <div className="tm-result-detail-empty">No cards recorded.</div>}
          {cards.map((c, i) => (
            <div key={i} className="tm-result-log-row">
              {editMode ? (
                <>
                  <select className="field-input" style={{ width: 'auto' }} value={c.team} onChange={ev => updateCard(i, { team: ev.target.value as 'A' | 'B' })}>
                    <option value="A">{r.teamAShortName || r.teamAName}</option>
                    <option value="B">{r.teamBShortName || r.teamBName}</option>
                  </select>
                  <select className="field-input" style={{ width: 'auto' }} value={c.type} onChange={ev => updateCard(i, { type: ev.target.value as CardEntry['type'] })}>
                    <option value="yellow">Yellow</option>
                    <option value="orange">Orange</option>
                    <option value="red">Red</option>
                  </select>
                </>
              ) : (
                <>
                  <span className="tm-result-log-team" style={{ color: teamColor(c.team) }}>{teamLabel(c.team)}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CardSquare type={c.type} /> {c.type === 'yellow' ? 'Yellow' : c.type === 'orange' ? 'Orange' : 'Red'}</span>
                </>
              )}
              <button className="tm-result-log-del" title="Remove card" onClick={() => setPendingDelete({ type: 'card', index: i })}>×</button>
            </div>
          ))}
        </div>
      )}
      {pendingDelete && (
        <ConfirmModal
          title={pendingDelete.type === 'log' ? 'Remove score event?' : 'Remove card?'}
          message="This can't be undone."
          confirmLabel="Remove"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}

// Expanded detail for a single result — point-type breakdown, shootout
// outcome, card counts, and (below that) the full editable list of
// individual score events/cards, whichever were actually captured for that
// match (older/manually-entered results may have none of this, hence the
// empty state). Reuses the scoreboard widget's `.wgt-h2h-table` styling so
// the "two teams either side of a bordered label column" look stays
// consistent across the app.
function ResultDetail({ r, editMode, onUpdate, periodsTotal, sport }: {
  r: SavedMatchResult; editMode: boolean; onUpdate: (patch: Partial<SavedMatchResult>) => void; periodsTotal: number; sport: SportType | undefined;
}) {
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

  if (!hasTable && !r.shootout && !r.timerSummary && !(r.lineup?.length) && !editMode && (r.scoreLog ?? []).length === 0 && (r.cards ?? []).length === 0) {
    return <div className="tm-result-detail"><div className="tm-result-detail-empty">No further detail captured for this match.</div></div>;
  }

  return (
    <div className="tm-result-detail">
      {r.timerSummary && (
        <div className="tm-result-detail-timer" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Timer size={12} strokeWidth={2} /> {formatTime(r.timerSummary.elapsedMs, 'mm:ss')} played
          {r.timerSummary.periodsPlayed > 1 && ` · ${r.timerSummary.periodsPlayed} periods`}
          {r.timerSummary.wentToExtraTime && ' · went to extra time'}
          {r.timerSummary.wentToAfterEt && ' · decided after ET'}
        </div>
      )}
      {r.shootout && (
        <div className="tm-result-detail-shootout" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Target size={12} strokeWidth={2} /> Decided on penalties: <span style={{ color: r.teamAColor }}>{r.shootout.scoreA}</span>
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
              <tr className="wgt-h2h-row"><td className="wgt-h2h-cell--a" style={{ color: r.teamAColor }}>{aCards.yellow}</td><td className="wgt-h2h-cell--label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CardSquare type="yellow" /> Yellow</td><td className="wgt-h2h-cell--b" style={{ color: r.teamBColor }}>{bCards.yellow}</td></tr>
            )}
            {aCards.orange + bCards.orange > 0 && (
              <tr className="wgt-h2h-row"><td className="wgt-h2h-cell--a" style={{ color: r.teamAColor }}>{aCards.orange}</td><td className="wgt-h2h-cell--label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CardSquare type="orange" /> Orange</td><td className="wgt-h2h-cell--b" style={{ color: r.teamBColor }}>{bCards.orange}</td></tr>
            )}
            {aCards.red + bCards.red > 0 && (
              <tr className="wgt-h2h-row"><td className="wgt-h2h-cell--a" style={{ color: r.teamAColor }}>{aCards.red}</td><td className="wgt-h2h-cell--label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CardSquare type="red" /> Red</td><td className="wgt-h2h-cell--b" style={{ color: r.teamBColor }}>{bCards.red}</td></tr>
            )}
          </tbody>
        </table>
      )}
      {(r.lineup?.length ?? 0) > 0 && <LineupSection r={r} />}
      <ScoreEventsEditor r={r} editMode={editMode} onUpdate={onUpdate} periodsTotal={periodsTotal} sport={sport} />
    </div>
  );
}

const CARD_COLORS: Record<'yellow' | 'orange' | 'red', string> = { yellow: '#f1c40f', orange: '#e67e22', red: '#e74c3c' };
function CardSquare({ type }: { type: 'yellow' | 'orange' | 'red' }) {
  return <Square size={11} fill={CARD_COLORS[type]} stroke="none" />;
}

// Who actually played, per side — captured from the linked Player List
// widget(s) at save time (see buildResultFromConfig's `lineup` field).
// Starters and subs-used are listed separately; a card icon is appended to
// any player who also appears in `r.cards` for that same jersey.
function LineupSection({ r }: { r: SavedMatchResult }) {
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const dispName = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });
  const cardsByPlayer = new Map<string, ('yellow' | 'orange' | 'red')[]>();
  for (const c of r.cards ?? []) {
    if (!c.playerId) continue;
    cardsByPlayer.set(c.playerId, [...(cardsByPlayer.get(c.playerId) ?? []), c.type]);
  }
  const side = (team: 'A' | 'B') => {
    const players = (r.lineup ?? []).filter(p => p.team === team);
    const starters = players.filter(p => p.section === 'starter');
    const subs = players.filter(p => p.section === 'sub');
    return (
      <div className="tm-result-lineup-col">
        <div className="tm-result-lineup-team" style={{ color: team === 'A' ? r.teamAColor : r.teamBColor }}>
          {team === 'A' ? r.teamAName : r.teamBName}
        </div>
        {starters.length > 0 && (
          <>
            <div className="tm-result-lineup-section">Starters</div>
            {starters.map(p => (
              <div className="tm-result-lineup-player" key={p.playerId}>
                <span className="tm-result-lineup-no">{p.jerseyNo || '—'}</span>
                <span>{dispName(p.name)}</span>
                {(cardsByPlayer.get(p.playerId) ?? []).map((t, i) => <CardSquare key={i} type={t} />)}
              </div>
            ))}
          </>
        )}
        {subs.filter(p => p.subbedOn).length > 0 && (
          <>
            <div className="tm-result-lineup-section">Subs used</div>
            {subs.filter(p => p.subbedOn).map(p => (
              <div className="tm-result-lineup-player" key={p.playerId}>
                <span className="tm-result-lineup-no">{p.jerseyNo || '—'}</span>
                <span>{dispName(p.name)}</span>
                {(cardsByPlayer.get(p.playerId) ?? []).map((t, i) => <CardSquare key={i} type={t} />)}
              </div>
            ))}
          </>
        )}
      </div>
    );
  };
  return (
    <div className="tm-result-lineup">
      {side('A')}
      {side('B')}
    </div>
  );
}

// Expanded detail for a single Schedule-tab fixture — a scheduled fixture
// itself has no scoreLog/cards (those only exist once a result is saved),
// so this looks up that fixture's saved result (if any) via
// sourceScheduleId and reuses the exact same editable score-events/cards
// list Results uses, so "who scored" can be corrected from either tab
// without having to go find the same match in the other one.
function FixtureDetail({ result, editMode, onUpdateResult, periodsTotal, sport }: {
  m: ScheduledMatch; result: SavedMatchResult | undefined; editMode: boolean;
  onUpdateResult: (patch: Partial<SavedMatchResult>) => void; periodsTotal: number; sport: SportType | undefined;
}) {
  if (!result) {
    return (
      <div className="tm-result-detail">
        <div className="tm-result-detail-empty">Not completed yet — score events and cards will show here once a result is saved for this fixture.</div>
      </div>
    );
  }
  return (
    <div className="tm-result-detail">
      <ScoreEventsEditor r={result} editMode={editMode} onUpdate={onUpdateResult} periodsTotal={periodsTotal} sport={sport} />
    </div>
  );
}

function ResultsPanel({ tournament }: { tournament: Tournament }) {
  const { results: allResults, updateResult, deleteResult } = useMatchResultsStore();
  const periodsTotal = (tournament.settings ?? SPORT_DEFAULTS[tournament.sport]).periods;
  const [editMode, setEditMode] = useState(false);
  // Same reasoning as the Schedule tab's fixture delete — a permanent,
  // one-click-away destructive action gets a confirm step.
  const [deleteResultTarget, setDeleteResultTarget] = useState<SavedMatchResult | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => setExpandedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [sortMode, setSortMode] = useState<ResultSortMode>('matchId');
  const matchNumbers = useMatchNumbers();
  const results = useMemo(() => {
    const scoped = allResults.filter(r => r.tournamentId === tournament.id);
    return sortResults(scoped, sortMode, matchNumbers);
  }, [allResults, tournament.id, sortMode, matchNumbers]);
  // Same reasoning as SchedulePanel's own hasMultipleVenues — the badge only
  // tells the operator something when results from two+ different venues
  // are actually mixed together here.
  const hasMultipleVenues = useMemo(
    () => new Set(results.map(r => r.venueLabel).filter(Boolean)).size > 1,
    [results]
  );

  // Manual "results only" sync — see pushResultsOnly/pullResultsOnly in
  // cloudSync.ts. Deliberately separate from the tournament-wide Push Now/
  // automatic sync: touches nothing but this tournament's saved results.
  const [resultsSyncState, setResultsSyncState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [resultsSyncMsg, setResultsSyncMsg] = useState('');
  const runResultsSync = async (kind: 'pull' | 'push') => {
    setResultsSyncState('busy');
    const result = kind === 'pull' ? await pullResultsOnly(tournament.id) : await pushResultsOnly(tournament.id);
    if (result.ok) {
      setResultsSyncState('done');
      setResultsSyncMsg(kind === 'pull' ? `Pulled ${result.count ?? 0}` : `Pushed ${result.count ?? 0}`);
    } else {
      setResultsSyncState('error');
      setResultsSyncMsg(result.error ?? 'Failed');
    }
    setTimeout(() => setResultsSyncState('idle'), 2500);
  };

  return (
    <div className="tm-win-content" style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <select className="tm-io-btn" value={sortMode} title="Sort order" onChange={e => setSortMode(e.target.value as ResultSortMode)}>
          {(Object.keys(RESULT_SORT_LABELS) as ResultSortMode[]).map(m => (
            <option key={m} value={m}>Sort: {RESULT_SORT_LABELS[m]}</option>
          ))}
        </select>
        {resultsSyncState !== 'idle' && (
          <span style={{ fontSize: 11, color: resultsSyncState === 'error' ? 'var(--red)' : 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {resultsSyncState === 'busy' ? '…' : resultsSyncState === 'error' ? <><AlertTriangle size={12} strokeWidth={2} /> {resultsSyncMsg}</> : <><Check size={12} strokeWidth={2} /> {resultsSyncMsg}</>}
          </span>
        )}
        <button className="tm-io-btn" disabled={resultsSyncState === 'busy'} title="Pull just this tournament's results from the cloud (doesn't touch fixtures/teams)"
          onClick={() => runResultsSync('pull')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ArrowDown size={14} strokeWidth={2} /> Pull Results
        </button>
        <button className="tm-io-btn" disabled={resultsSyncState === 'busy'} title="Push just this tournament's results to the cloud (doesn't touch fixtures/teams)"
          onClick={() => runResultsSync('push')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ArrowUp size={14} strokeWidth={2} /> Push Results
        </button>
        {results.length > 0 && (
          <>
            <button className={`tm-io-btn${editMode ? ' tm-io-btn--ok' : ''}`} onClick={() => setEditMode(v => !v)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {editMode ? <><Check size={14} strokeWidth={2} /> Done Editing</> : <><Pencil size={14} strokeWidth={2} /> Edit</>}
            </button>
            <button className="tm-io-btn" title="Export results as CSV (Excel compatible)"
              onClick={() => exportResultsCSV(results, tournament.name)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ArrowDown size={14} strokeWidth={2} /> Export CSV
            </button>
          </>
        )}
      </div>
      {results.length === 0 ? (
        <div className="tm-win-placeholder">
          <span>No saved results yet for this tournament — use "Save Result" on a linked scoreboard widget.</span>
        </div>
      ) : (
      <div className="tm-sched-rows">
        {results.map(r => (
          <div key={r.id} className="tm-sched-row-wrap">
          <div className="tm-sched-row">
            <button
              className={`tm-result-expand-btn${expandedIds.has(r.id) ? ' tm-result-expand-btn--open' : ''}`}
              title={expandedIds.has(r.id) ? 'Hide details' : 'Show details (score breakdown, shootout, cards)'}
              onClick={() => toggleExpanded(r.id)}
            ><ChevronRight size={14} strokeWidth={2} /></button>
            {r.sourceScheduleId && matchNumbers.get(r.sourceScheduleId) && (
              <span className="tm-sched-matchnum-badge" title="Auto match number (Match # Prefix + venue letter + running sequence) — same as the Schedule tab">
                {matchNumbers.get(r.sourceScheduleId)}
              </span>
            )}
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
                {hasMultipleVenues && r.venueLabel && (
                  <span className="tm-sched-venue-badge" title={`Synced from venue: ${r.venueLabel}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><MapPin size={11} strokeWidth={2} /> {r.venueLabel}</span>
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

            {editMode && <button className="tm-sched-del" title="Delete result" onClick={() => setDeleteResultTarget(r)}>×</button>}
          </div>
          {expandedIds.has(r.id) && <ResultDetail r={r} editMode={editMode} onUpdate={patch => updateResult(r.id, patch)} periodsTotal={periodsTotal} sport={tournament.sport} />}
          </div>
        ))}
      </div>
      )}
      {deleteResultTarget && (
        <ConfirmModal
          title="Delete result?"
          message={`This permanently removes the saved result for "${deleteResultTarget.teamAName} vs ${deleteResultTarget.teamBName}" (${deleteResultTarget.scoreA}–${deleteResultTarget.scoreB}), including its score log and cards. This can't be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { deleteResult(deleteResultTarget.id); setDeleteResultTarget(null); }}
          onCancel={() => setDeleteResultTarget(null)}
        />
      )}
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
  // Seeded in Draw order (groupPosition, same convention the Schedule
  // generator's own groupMembers() uses) rather than whatever order the
  // Team Database happens to list them in — the final sort below is stable,
  // so before a ball's kicked (every row still tied at 0 pts/diff/PF) this
  // is what the table actually shows; once real results come in, points
  // take over and decide the order for real, same as always.
  const seeded = [...teams].sort((a, b) => (a.groupPosition ?? Infinity) - (b.groupPosition ?? Infinity) || a.name.localeCompare(b.name));
  const rows = new Map<string, StandingRow>();
  for (const t of seeded) {
    rows.set(t.id, { teamId: t.id, name: t.name, shortName: t.shortName, logo: t.logo, color: t.color, played: 0, won: 0, drawn: 0, lost: 0, pf: 0, pa: 0, pts: 0 });
  }
  // Matched by id when the result carries one (unambiguous — see
  // ScheduledMatch.teamAId/SavedMatchResult.teamAId), else by name AND
  // category — `results` passed in is only ever filtered by tournament (see
  // StandingsPanel/StandingsWidget), never by category, so without the
  // category check a result from a completely different category's match
  // gets attributed here purely because a team of the same name (e.g. a
  // state fielding both "Boys" and "Girls" squads, both named "PERAK")
  // happens to also sit in this pool — inflating played/won/pf counts with
  // matches this pool's team never actually played.
  const findRow = (id: string | undefined, name: string, shortName: string | undefined, category: string | undefined) => {
    if (id && rows.has(id)) return rows.get(id);
    const key = name.trim().toLowerCase();
    const shortKey = (shortName ?? '').trim().toLowerCase();
    const catKey = (category ?? '').trim().toLowerCase();
    const t = teams.find(t2 =>
      (t2.category ?? '').trim().toLowerCase() === catKey &&
      (t2.name.trim().toLowerCase() === key || (!!shortKey && (t2.shortName ?? '').trim().toLowerCase() === shortKey))
    );
    return t ? rows.get(t.id) : undefined;
  };
  for (const r of results) {
    if (r.matchType === 'bye') continue; // nothing was actually played
    const rowA = findRow(r.teamAId, r.teamAName, r.teamAShortName, r.category);
    const rowB = findRow(r.teamBId, r.teamBName, r.teamBShortName, r.category);
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

// A result whose originating fixture was a knockout-stage/bracket match
// (Semifinal, Final, 3rd Place Playoff, a ranked-placement decider, etc.)
// must never count toward GROUP standings — otherwise two group-mates who
// happen to meet again later in the bracket (or a wildcard placement match)
// would have that later result silently double as a group-stage result too.
// Reuses extractKnockoutStage's own group/round parsing rather than
// duplicating it — SavedMatchResult carries the same group/round shape as
// ScheduledMatch. A result with no group/tier at all (saved before those
// fields existed, or never linked to a fixture) falls through to
// extractKnockoutStage's round-text fallback, which already recognizes
// most knockout stages by their round text alone; the one residual gap is a
// legacy 3rd-place result with no round-text equivalent for that marker,
// which stays (incorrectly) classified as pool-stage.
export function isPoolStageResult(r: SavedMatchResult): boolean {
  return !extractKnockoutStage(r) && r.group !== '3rd Place';
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
    // Only pool-stage results count toward this team's standing row — see isPoolStageResult.
    return computeStandings(scopeTeams, results.filter(isPoolStageResult), settings).find(row => row.teamId === team.id) ?? null;
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

        <div className="tm-team-info-section-title" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={14} strokeWidth={2} /> Match History{history.length > 0 ? ` (${history.length})` : ''}</div>
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
            <div className="tm-team-info-section-title" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><CalendarDays size={14} strokeWidth={2} /> Upcoming ({upcoming.length})</div>
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
// there's no id link back for a manually-saved scoreboard result (still the
// fallback below when either side lacks one). Shared by the bracket viewer
// (to bold the winner) and the auto-advance effect below (to know who
// advances).
//
// Prefers matching by id (ScheduledMatch.teamAId/SavedMatchResult.teamAId)
// when both the fixture and a candidate result have one on both sides —
// unambiguous even across categories that reuse a team name. Falls back to
// name+category pair matching otherwise — some team names are reused across
// categories (e.g. a state's Boys and Girls squads both named "PERAK"), and
// without the category check a category's bracket match could pick up an
// unrelated result from the other category that happens to have the exact
// same two team names.
function fixturePairOrientation(res: SavedMatchResult, m: ScheduledMatch): 'straight' | 'swapped' | null {
  if (m.teamAId && m.teamBId && res.teamAId && res.teamBId) {
    if (res.teamAId === m.teamAId && res.teamBId === m.teamBId) return 'straight';
    if (res.teamAId === m.teamBId && res.teamBId === m.teamAId) return 'swapped';
    return null; // both sides have ids and neither pairing matches — definitely not this fixture
  }
  if ((res.category ?? '').trim().toLowerCase() !== (m.category ?? '').trim().toLowerCase()) return null;
  if (res.teamAName === m.teamAName && res.teamBName === m.teamBName) return 'straight';
  if (res.teamAName === m.teamBName && res.teamBName === m.teamAName) return 'swapped';
  return null;
}
export function findMatchScore(m: ScheduledMatch, results: SavedMatchResult[], tournamentId: string): { a: number; b: number } | null {
  // A bye/walkover only counts once actually confirmed via the scoreboard
  // popup (which sets completedAt) — before that it's just flagged, not
  // decided, so it must not read as a winner/score anywhere (bracket
  // auto-advance, group-stage completion checks, the bracket viewer's bold).
  if (m.matchType) return m.completedAt ? { a: m.scoreA ?? 0, b: m.scoreB ?? 0 } : null;
  if (!m.completedAt) return null;
  const r = results.find(res => res.tournamentId === tournamentId && fixturePairOrientation(res, m) !== null);
  if (!r) return null;
  return fixturePairOrientation(r, m) === 'straight' ? { a: r.scoreA, b: r.scoreB } : { a: r.scoreB, b: r.scoreA };
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
  const r = results.find(res => res.tournamentId === tournamentId && fixturePairOrientation(res, m) !== null);
  if (!r?.shootout) return null; // a genuine round-robin draw with no decider
  const straight = fixturePairOrientation(r, m) === 'straight';
  const side: 'A' | 'B' = straight ? r.shootout.winner : (r.shootout.winner === 'A' ? 'B' : 'A');
  const shootout = straight ? { scoreA: r.shootout.scoreA, scoreB: r.shootout.scoreB } : { scoreA: r.shootout.scoreB, scoreB: r.shootout.scoreA };
  return { side, shootout };
}

// Placeholder entrant names generated by the schedule generator for
// not-yet-known bracket slots — "Winner of Quarterfinal 2", "1st Group A",
// "2nd Best 3rd" (a cross-pool "Best Nth-place" wildcard — see
// buildBestNthWildcardSlots). A slot only auto-fills while it still holds
// one of these; once an operator manually picks a real team, it's left alone.
export function isPlaceholderTeamName(name: string): boolean {
  return /^(Winner|Loser) of /.test(name) || /^\d+(st|nd|rd|th) /.test(name) ||
    /^(?:\d+(?:st|nd|rd|th) )?Best \d+(?:st|nd|rd|th)$/.test(name);
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
  if (m) return parseInt(m[1], 10);
  const p = placementRoundRange(stage);
  if (p) return p.hi - p.lo + 1;
  return Number.MAX_SAFE_INTEGER;
}
function isKnockoutStage(group?: string): boolean {
  return !!group && (group === 'Final' || group === 'Semifinal' || group === 'Quarterfinal' || /^Round of \d+$/.test(group) || isPlacementRoundLabel(group));
}

// A knockout fixture's stage normally lives on `group` (auto-tagged at
// generation time). Fall back to parsing `round` — "[Category · ]Stage[
// N]" — so fixtures from a "Groups + Knockout" run generated before that
// tagging existed (or any hand-typed knockout fixture) still show up.
export function extractKnockoutStage(m: { group?: string; round?: string }): string | null {
  if (m.group && isKnockoutStage(m.group)) return m.group;
  if (m.round) {
    const afterCategory = m.round.includes(' · ') ? m.round.split(' · ').pop()! : m.round;
    const stageOnly = afterCategory.replace(/\s+\d+$/, '').trim();
    if (isKnockoutStage(stageOnly)) return stageOnly;
  }
  return null;
}

// Recovers the bare, numbered stage label ("Quarterfinal 2") a fixture's
// `round` was built from (see GenerateScheduleModal), reversing whichever
// convention produced it: the current "{stage} {tier}" suffix format (e.g.
// "Quarterfinal 2 Cup/Plate"), or the older "[Category ·] [Tier ·] Stage"
// prefix format still sitting on fixtures generated before that changed.
// Needed anywhere the bracket auto-advance below has to line matches up by
// their trailing match number — `tier`'s own value can itself contain
// digits/spaces (e.g. "Tier 5"), so this can't just regex-strip blindly.
export function bareStageLabel(m: ScheduledMatch): string {
  const round = m.round ?? '';
  if (m.tier && round.endsWith(` ${m.tier}`)) return round.slice(0, -(m.tier.length + 1));
  if (round.includes(' · ')) return round.split(' · ').pop()!;
  return round;
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
  const [selectedTeamName, setSelectedTeamName] = useState<string | null>(null);
  const [activeTier, setActiveTier] = useState<string | undefined>(undefined);
  const matchNumbers = useMatchNumbers();
  const fixTierMismatch = (id: string, tier: string | undefined) => updateMatch(id, { tier });
  // Same detector the Schedule tab's banner uses (see findTierMismatches) —
  // a fixture tagged with the wrong tier shows up under the wrong tier tab
  // here (or is missing from the right one), so this needs the same
  // visibility from the Bracket tab too, not just the Schedule tab. Scoped
  // to the whole tournament (findTierMismatches groups by category
  // internally) then filtered down to this tab's active category, same as
  // categoryMatches below — shown regardless of which tier chip is active,
  // since the mismatch itself may be exactly why a fixture isn't showing
  // under the tier the operator is currently looking at.
  const tierMismatches = useMemo(
    () => findTierMismatches(allMatches.filter(m => m.tournamentId === tournament.id))
      .filter(tm => categories.length === 0 || (tm.match.category ?? (tm.match.round?.includes(' · ') ? tm.match.round.split(' · ')[0] : undefined)) === category),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament.id, category, categories.length]
  );

  // A fixture's category may only live in the `round` prefix ("Men ·
  // Quarterfinal 2") on data generated before the dedicated category field
  // existed — fall back to that so old Groups + Knockout schedules still
  // scope correctly to the picked category.
  const effectiveCategory = (m: ScheduledMatch): string | undefined =>
    m.category ?? (m.round?.includes(' · ') ? m.round.split(' · ')[0] : undefined);

  const categoryMatches = useMemo(
    () => allMatches.filter(m =>
      m.tournamentId === tournament.id &&
      (categories.length === 0 || effectiveCategory(m) === category) &&
      !!extractKnockoutStage(m)
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament.id, category, categories.length]
  );

  // Tier is local to this tab (unlike category, which every tab shares via
  // the top TournamentScopeHeader bar) — it's meaningless to Players/
  // Standings/Draw, and a plain tournament with no Cup/Plate/Bowl/Shield
  // split never has any tier values at all, so this chip row simply never
  // renders and the bracket below is exactly what it always was. A shared
  // Quarterfinal's combined label ("Cup/Plate") is excluded from the
  // selectable chips themselves — only the pure tier names are — but its
  // matches are still picked up below whenever either paired tier is active.
  const tiers = useMemo(() => {
    const set = new Set(categoryMatches.map(m => m.tier).filter((t): t is string => !!t && !t.includes('/')));
    return Array.from(set).sort((a, b) => tierRank(a) - tierRank(b));
  }, [categoryMatches]);

  useEffect(() => {
    if (tiers.length === 0) { setActiveTier(undefined); return; }
    if (!activeTier || !tiers.includes(activeTier)) setActiveTier(tiers[0]);
  }, [tiers, activeTier]);

  const matches = useMemo(
    () => tiers.length > 0
      ? categoryMatches.filter(m => m.tier === activeTier || (!!m.tier?.includes('/') && m.tier.split('/').includes(activeTier ?? '')))
      : categoryMatches,
    [categoryMatches, tiers.length, activeTier]
  );

  const thirdPlaceMatch = useMemo(
    () => allMatches.find(m =>
      m.tournamentId === tournament.id &&
      (categories.length === 0 || effectiveCategory(m) === category) &&
      (tiers.length === 0 || m.tier === activeTier) &&
      m.group === '3rd Place'
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMatches, tournament.id, category, categories.length, tiers.length, activeTier]
  );

  // Retro-fit for a bracket generated without "Play 3rd/4th place" checked —
  // adds the same fixture the generator would have, scheduled alongside the
  // Final, using Semifinal-loser placeholders the bracket auto-advance
  // effect then fills in as each Semifinal is decided. Scoped to the current
  // tier (both the source date/time reference and the new fixture's own
  // `tier`), so on a Cup/Plate/Bowl/Shield tournament this only ever
  // retro-fits the tier currently being viewed.
  const addThirdPlacePlayoff = () => {
    const refMatch = matches.find(m => extractKnockoutStage(m) === 'Final') ?? matches.find(m => extractKnockoutStage(m) === 'Semifinal');
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    addMatch({
      tournamentId: tournament.id,
      competition: tournament.name,
      date: refMatch?.date ?? todayStr,
      time: refMatch?.time,
      round: activeTier ? `3rd Place Playoff ${activeTier}` : '3rd Place Playoff',
      category: categories.length > 0 ? category : undefined,
      group: '3rd Place',
      tier: activeTier,
      teamAName: 'Loser of Semifinal 1', teamAColor: PLACEHOLDER_COLOR,
      teamBName: 'Loser of Semifinal 2', teamBColor: PLACEHOLDER_COLOR,
    });
  };

  return (
    <div className="tm-win-content" style={{ padding: 16, overflow: 'auto' }}>
      <TierMismatchBanner mismatches={tierMismatches} matchNumbers={matchNumbers} onFix={fixTierMismatch} />
      {tiers.length > 1 && (
        <div className="tm-scope-cat-bar" style={{ marginBottom: 12 }}>
          {tiers.map(t => (
            <button
              key={t}
              className={`tm-scope-cat-btn${activeTier === t ? ' tm-scope-cat-btn--active' : ''}`}
              onClick={() => setActiveTier(t)}
            >{t}</button>
          ))}
        </div>
      )}

      {categories.length > 0 && !activeCategory ? (
        <div className="tm-win-placeholder">
          Pick a category from the top bar to view its bracket — each category generates its own separate bracket.
        </div>
      ) : matches.length === 0 ? (
        <div className="tm-win-placeholder">
          No knockout-stage fixtures found{categories.length > 0 ? ' for this category' : ''} — generate one via Generate Schedule (Knockout, Groups + Knockout, or Groups + Tiered Knockout) in the Schedule tab.
        </div>
      ) : (
        <BracketView
          matches={matches}
          thirdPlaceMatch={thirdPlaceMatch}
          results={allResults}
          tournamentId={tournament.id}
          editable
          onSelectTeam={setSelectedTeamName}
          onAddThirdPlace={addThirdPlacePlayoff}
        />
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
  );
}

function StandingsPanel({ tournament, activeCategory }: { tournament: Tournament; activeCategory: string }) {
  const { teams: allTeams } = useTeamDbStore();
  const { results: allResults } = useMatchResultsStore();
  const settings = tournament.settings ?? SPORT_DEFAULTS[tournament.sport];
  const teams = useMemo(() => allTeams.filter(t => t.tournamentId === tournament.id), [allTeams, tournament.id]);
  const allTournamentResults = useMemo(() => allResults.filter(r => r.tournamentId === tournament.id), [allResults, tournament.id]);
  // Group standings must only count pool-stage results — see isPoolStageResult.
  const results = useMemo(() => allTournamentResults.filter(isPoolStageResult), [allTournamentResults]);
  const groups = normalizeGroups(tournament.groups);
  const categories = tournament.categories ?? [];
  const [selectedTeam, setSelectedTeam] = useState<{ name: string; category?: string } | null>(null);

  if (teams.length === 0) {
    return (
      <div className="tm-win-content" style={{ padding: 16 }}>
        <div className="tm-win-placeholder">
          <span>Add teams in the Teams tab to see standings.</span>
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
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            title="Auto-push every draw change to the host as it happens, instead of needing a manual Save to Host"
            onClick={() => setLiveSyncDraw(!liveSyncDraw)}
          >{liveSyncDraw ? <><Circle size={9} fill="currentColor" stroke="none" /> Live Sync: On</> : <><Circle size={9} fill="none" /> Live Sync: Off</>}</button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {liveSyncDraw ? 'Every draw change is pushed to the host automatically.' : 'Turn on to auto-push draw changes to the host as you make them.'}
          </span>
        </div>
      )}

      <div className="tm-draw-group-tabs">
        <button
          className={`tm-draw-group-tab${drawSubTab === 'live' ? ' tm-draw-group-tab--active' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setDrawSubTab('live')}
        ><Clapperboard size={14} strokeWidth={2} /> Live Draw</button>
        <button
          className={`tm-draw-group-tab${drawSubTab === 'settings' ? ' tm-draw-group-tab--active' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setDrawSubTab('settings')}
        ><Settings size={14} strokeWidth={2} /> Settings</button>
      </div>

      {drawSubTab === 'settings' && (
      <>
      <div className="tm-draw-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="tm-draw-section-title" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Settings size={14} strokeWidth={2} /> Setup — Groups &amp; Pots</div>
        <button
          className={`tm-io-btn${setupEditMode ? ' tm-io-btn--active' : ''}`}
          style={{ flex: 'none' }}
          title="Unlock renaming group/pot names"
          onClick={() => setSetupEditMode(e => !e)}
        >{setupEditMode ? <><Unlock size={14} strokeWidth={2} /> Editing</> : <><Pencil size={14} strokeWidth={2} /> Edit</>}</button>
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
          <div className="tm-draw-section-title" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><ClipboardList size={14} strokeWidth={2} /> Assignments</div>

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
          <div className="tm-draw-section-title" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><FlagTriangleRight size={14} strokeWidth={2} /> Final Group List</div>
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
          <span>Add at least one Group and one Pot in the Settings tab, then assign each team to a pot there.</span>
        </div>
      ) : (
      <div className="tm-draw-section">
      <div className="tm-draw-section-title" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clapperboard size={14} strokeWidth={2} /> Live Draw</div>
      <div className="tm-draw-vmix-cfg">
        <span className="tm-groups-label" title="'Manual' lets you click a team chip in the current pot to draw it yourself, instead of the system picking blindly">Team Draw:</span>
        <div className="tm-timer-mode-toggle">
          <button
            className={`tm-timer-mode-btn ${drawTeamMode === 'random' ? 'tm-timer-mode-btn--active' : ''}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => updateTournament(tournament.id, { drawTeamMode: 'random' })}
          ><Dices size={14} strokeWidth={2} /> Random</button>
          <button
            className={`tm-timer-mode-btn ${drawTeamMode === 'manual' ? 'tm-timer-mode-btn--active' : ''}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => updateTournament(tournament.id, { drawTeamMode: 'manual' })}
          ><Hand size={14} strokeWidth={2} /> Manual (click team)</button>
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
              <span className="tm-draw-hero-detail" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Hourglass size={12} strokeWidth={2} /> Pick a group below…</span>
            </div>
          </>
        ) : armedSlot ? (
          <div className="tm-draw-hero-info">
            <span className="tm-draw-hero-name">{armedSlot.group} — {(groups.find(g => g.name === armedSlot.group)?.prefix || armedSlot.group.charAt(0).toUpperCase())}{armedSlot.position}</span>
            <span className="tm-draw-hero-detail" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Hourglass size={12} strokeWidth={2} /> Pick a team below…</span>
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
          <div className="tm-draw-manual-hint" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
            {armedTeam ? <><Hourglass size={12} strokeWidth={2} /> Pick a slot below</> : armedSlot ? <><Hourglass size={12} strokeWidth={2} /> Pick a team below for {armedSlot.group}</> : <><MousePointerClick size={12} strokeWidth={2} /> Click any team or empty slot to pair them — pick either first, click again to cancel</>}
          </div>
        ) : (
          <button className="tm-sidebar-new-btn" onClick={drawNext} disabled={!canDraw && !armedSlot} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            {armedSlot ? <><Dices size={14} strokeWidth={2} /> Draw Next → {armedSlot.group}</> : canDraw ? <><Dices size={14} strokeWidth={2} /> Draw Next ({currentPot})</> : <><PartyPopper size={14} strokeWidth={2} /> Draw Complete</>}
          </button>
        )}
        <button
          className={`tm-io-btn${editMode ? ' tm-io-btn--active' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title="Unlock filled slots so a mistake can be cleared with a click"
          onClick={() => setEditMode(e => !e)}
        >{editMode ? <><Unlock size={14} strokeWidth={2} /> Editing</> : <><Pencil size={14} strokeWidth={2} /> Edit</>}</button>
        <button
          className={`tm-io-btn${hideAssignedTeams ? ' tm-io-btn--active' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title="Hide already-placed teams from the pot lists below, instead of leaving them pickable to re-draw/move"
          onClick={() => setHideAssignedTeams(v => !v)}
        >{hideAssignedTeams ? <><EyeOff size={14} strokeWidth={2} /> Hiding Placed</> : <><Eye size={14} strokeWidth={2} /> Show All</>}</button>
        <ConfirmButton
          className="tm-io-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          label={<><RotateCcw size={14} strokeWidth={2} /> Reset Draw</>}
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
          <span className="tm-draw-section-title" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{vmixCfgOpen ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />} <Radio size={14} strokeWidth={2} /> vMix Output</span>
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
                    <button className="tm-io-btn" onClick={() => pushGroupListToVmix(target)} disabled={!target.group || !target.inputKey} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Radio size={14} strokeWidth={2} /> Push List</button>
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
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Trophy size={14} strokeWidth={2} /> Tournament:</span>
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

// A push always fully overwrites the cloud's copy of every fixture/result
// with this device's local version — this lists exactly what that would
// change (new items the cloud doesn't have yet, and items where the score/
// teams/round differ from what's currently on the cloud) so the operator
// can see it before it happens, rather than silently clobbering whatever
// another venue may have pushed since this device last synced.
function PushDiffModal({ items, onConfirm, onCancel }: {
  items: PushDiffItem[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const newItems = items.filter(i => i.status === 'new');
  const updatedItems = items.filter(i => i.status === 'updated');
  const removedItems = items.filter(i => i.status === 'removed');
  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 className="modal-title">Replace cloud data with this device's copy?</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
          The cloud has data that differs from what's on this device. Pushing will make the cloud match this device exactly, as shown below.
        </p>
        <div style={{ maxHeight: 280, overflowY: 'auto', margin: '12px 0', border: '1px solid var(--border)', borderRadius: 8 }}>
          {updatedItems.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', padding: '8px 12px 4px' }}>
                Will be updated ({updatedItems.length})
              </div>
              {updatedItems.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 12px', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-primary)' }}>{it.label}</span>
                  {it.detail && <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{it.detail}</span>}
                </div>
              ))}
            </div>
          )}
          {newItems.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', padding: '8px 12px 4px' }}>
                New on this device ({newItems.length})
              </div>
              {newItems.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 12px', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-primary)' }}>{it.label}</span>
                  {it.detail && <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{it.detail}</span>}
                </div>
              ))}
            </div>
          )}
          {removedItems.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--danger, #e74c3c)', textTransform: 'uppercase', padding: '8px 12px 4px' }}>
                Will be removed from cloud ({removedItems.length})
              </div>
              {removedItems.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 12px', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-primary)', textDecoration: 'line-through' }}>{it.label}</span>
                  {it.detail && <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{it.detail}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn--ghost btn--small" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary btn--small" onClick={onConfirm}>Push & Replace</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function DiffItemGroup({ heading, items, danger }: { heading: string; items: PushDiffItem[]; danger?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: danger ? 'var(--danger, #e74c3c)' : 'var(--text-muted)', textTransform: 'uppercase', padding: '6px 12px 3px' }}>
        {heading} ({items.length})
      </div>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 12px', fontSize: 12 }}>
          <span style={{ color: 'var(--text-primary)', textDecoration: danger ? 'line-through' : undefined }}>{it.label}</span>
          {it.detail && <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{it.detail}</span>}
        </div>
      ))}
    </div>
  );
}

// Shown every time "Load Shared Event"/"Enter Sharing Key" is used, before
// actually linking — compares this tournament's local fixtures/results
// against whatever the cloud already has stored for this exact tournament id
// (see computePushDiff), so linking (which turns on ongoing two-way sync)
// never silently surprises the operator. Results are broken out into their
// own section rather than gating the confirmation — they're always meant to
// flow in from the shared event, this is purely informational for them.
function LoadEventDiffModal({ eventName, items, checking, onConfirm, onCancel }: {
  eventName: string;
  /** null = couldn't reach the cloud to check (offline), or still checking
   *  (see `checking`) — confirming still proceeds with the link either way,
   *  just without a comparison. */
  items: PushDiffItem[] | null;
  checking: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const matchItems = items?.filter(i => i.kind === 'match') ?? [];
  const resultItems = items?.filter(i => i.kind === 'result') ?? [];
  // Cloud has nothing at all yet for this tournament (every item "new", none
  // "updated"/"removed") — an itemized wall of "new" for every single
  // fixture isn't useful there, a one-line summary is.
  const isFreshLink = items !== null && items.length > 0 && items.every(i => i.status === 'new');
  const scheduleClean = items !== null && matchItems.length === 0;

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 className="modal-title">Link to "{eventName}"?</h3>

        {checking ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Search size={13} strokeWidth={2} /> Checking for differences against the cloud…
          </p>
        ) : items === null ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
            Couldn't reach the cloud to compare data right now (offline?). Confirming will link anyway, without checking for differences.
          </p>
        ) : isFreshLink ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
            This tournament hasn't been synced to the cloud yet — linking will push all of your local data
            ({matchItems.length} fixture{matchItems.length !== 1 ? 's' : ''}{resultItems.length > 0 ? `, ${resultItems.length} result${resultItems.length !== 1 ? 's' : ''}` : ''}) to the shared event.
          </p>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
            {scheduleClean
              ? 'Your schedule matches the cloud exactly — nothing will change there.'
              : "Your schedule differs from what's already on the cloud for this tournament — review below before linking."}
          </p>
        )}

        {items !== null && !isFreshLink && (matchItems.length > 0 || resultItems.length > 0) && (
          <div style={{ maxHeight: 280, overflowY: 'auto', margin: '12px 0', border: '1px solid var(--border)', borderRadius: 8 }}>
            {matchItems.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', padding: '8px 12px 2px', borderBottom: '1px solid var(--border)' }}>Schedule</div>
                <DiffItemGroup heading="Different from the cloud" items={matchItems.filter(i => i.status === 'updated')} />
                <DiffItemGroup heading="Only on this device" items={matchItems.filter(i => i.status === 'new')} />
                <DiffItemGroup heading="Only on the shared event" items={matchItems.filter(i => i.status === 'removed')} danger />
              </div>
            )}
            {resultItems.length > 0 && (
              <div style={{ borderTop: matchItems.length > 0 ? '1px solid var(--border)' : undefined }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', padding: '8px 12px 2px' }}>
                  Results — informational only, always loaded from the shared event
                </div>
                <DiffItemGroup heading="Different from the cloud" items={resultItems.filter(i => i.status === 'updated')} />
                <DiffItemGroup heading="Only on this device" items={resultItems.filter(i => i.status === 'new')} />
                <DiffItemGroup heading="Only on the shared event" items={resultItems.filter(i => i.status === 'removed')} />
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn--ghost btn--small" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary btn--small" onClick={onConfirm} disabled={checking}>Link Event</button>
        </div>
      </div>
    </div>,
    document.body
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
  const winRef = useRef<HTMLDivElement>(null);
  // .tm-window has `resize: both` (the corner drag-handle) — the browser
  // implements that by writing width/height directly onto the DOM node's
  // inline style, completely outside React's own style prop (which only
  // ever sets left/top here). An inline style always beats a class rule, so
  // once the panel has been manually resized even once, that leftover
  // inline width/height would silently pin it at that size forever — even
  // after adding tm-window--maximized, which sets width/height in CSS.
  // Cached here so "Restore" can bring back that same manual size instead of
  // snapping to the CSS default every time.
  const preMaximizeSizeRef = useRef<{ width: string; height: string } | null>(null);

  const toggleMaximize = () => {
    const el = winRef.current;
    if (!isMaximized) {
      if (el) {
        preMaximizeSizeRef.current = { width: el.style.width, height: el.style.height };
        el.style.width = '';
        el.style.height = '';
      }
      setIsMaximized(true);
    } else {
      setIsMaximized(false);
      if (el && preMaximizeSizeRef.current) {
        el.style.width = preMaximizeSizeRef.current.width;
        el.style.height = preMaximizeSizeRef.current.height;
      }
    }
  };

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
  // The window's own × close button used to confirm in place (ConfirmButton)
  // right next to the maximize button in a tight 4px-gap row — the
  // confirm text + Close/Cancel buttons it expands into there don't fit
  // that tiny space and visually overlap the maximize button. A full
  // ConfirmModal (same pattern as every other destructive action in this
  // window) pops up centered instead, so the close button stays exactly where it
  // belongs and never expands in place.
  const [confirmCloseWindow, setConfirmCloseWindow] = useState(false);
  const [applyStatus, setApplyStatus] = useState<React.ReactNode>('');
  // Manual "push now" feedback — separate from the automatic debounced sync
  // in cloudSync.ts, which runs silently with no UI at all.
  const [pushNowState, setPushNowState] = useState<'idle' | 'checking' | 'pushing' | 'done' | 'error'>('idle');
  const [pushNowError, setPushNowError] = useState('');
  const [pushDiff, setPushDiff] = useState<PushDiffItem[] | null>(null);
  const [pushDiffTournamentId, setPushDiffTournamentId] = useState<string | null>(null);
  // "Localize Logos" — downloads any cloud-hosted logo this tournament's
  // teams/fixtures/results still point at back to this device's own local
  // image server, for teams pinned to the cloud URL from before the push
  // overwrite bug was fixed (see cloudSync.ts's localizeTournamentLogos).
  const [localizeLogosState, setLocalizeLogosState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [localizeLogosMsg, setLocalizeLogosMsg] = useState('');
  const handleLocalizeLogos = async (tournamentId: string) => {
    setLocalizeLogosState('running');
    const result = await localizeTournamentLogos(tournamentId);
    if (result.ok) {
      setLocalizeLogosState('done');
      setLocalizeLogosMsg(result.count ? `Localized ${result.count} logo${result.count === 1 ? '' : 's'}` : 'Nothing to localize — already local');
      setTimeout(() => setLocalizeLogosState('idle'), 2500);
    } else {
      setLocalizeLogosState('error');
      setLocalizeLogosMsg(result.error ?? 'Failed');
      setTimeout(() => setLocalizeLogosState('idle'), 3000);
    }
  };

  const doPush = async (tournamentId: string) => {
    setPushNowState('pushing');
    setPushNowError('');
    const result = await pushTournamentNow(tournamentId);
    if (result.ok) {
      setPushNowState('done');
      setTimeout(() => setPushNowState('idle'), 1500);
    } else {
      setPushNowState('error');
      setPushNowError(result.error ?? 'Push failed');
      setTimeout(() => setPushNowState('idle'), 3000);
    }
  };
  // A push always fully overwrites the cloud's copy of every fixture/result
  // with whatever's local — before doing that, check whether the cloud
  // actually differs from local (another venue may have pushed something
  // since this device last synced) and let the operator see exactly what's
  // about to be replaced rather than silently clobbering it.
  const handlePushNow = async (tournamentId: string) => {
    setPushNowState('checking');
    const diff = await computePushDiff(tournamentId);
    if (diff && diff.length > 0) {
      setPushNowState('idle');
      setPushDiff(diff);
      setPushDiffTournamentId(tournamentId);
      return;
    }
    await doPush(tournamentId);
  };
  const confirmPushDiff = async () => {
    const id = pushDiffTournamentId;
    setPushDiff(null);
    setPushDiffTournamentId(null);
    if (id) await doPush(id);
  };

  // "Load Shared Event"/"Enter Sharing Key" confirmation — see
  // LoadEventDiffModal. Always shown (unlike handlePushNow above, which
  // skips its own dialog when there's nothing to show) since the whole point
  // here is confirming the link itself, not just flagging conflicts.
  const [pendingEventLink, setPendingEventLink] = useState<{ tournamentId: string; event: RemoteEvent; shareKey?: string } | null>(null);
  const [eventLinkDiff, setEventLinkDiff] = useState<PushDiffItem[] | null>(null);
  const [checkingEventLink, setCheckingEventLink] = useState(false);
  const handleLoadEvent = async (tournamentId: string, event: RemoteEvent, shareKey?: string) => {
    setPendingEventLink({ tournamentId, event, shareKey });
    setEventLinkDiff(null);
    setCheckingEventLink(true);
    const diff = await computePushDiff(tournamentId);
    setEventLinkDiff(diff);
    setCheckingEventLink(false);
  };
  const confirmEventLink = () => {
    if (pendingEventLink) {
      updateTournament(pendingEventLink.tournamentId, {
        eventId: pendingEventLink.event.id, eventName: pendingEventLink.event.name,
        cloudSyncEnabled: true, eventShareKey: pendingEventLink.shareKey,
      });
    }
    setPendingEventLink(null);
    setEventLinkDiff(null);
  };
  const cancelEventLink = () => { setPendingEventLink(null); setEventLinkDiff(null); };
  const [tab, setTab] = useState<'tournaments' | 'teams' | 'players' | 'schedule' | 'results' | 'rundown' | 'standings' | 'bracket' | 'draw'>('tournaments');
  // Single category selector shared by every tournament-scoped tab (Schedule,
  // Standings, Bracket, Draw) — lives here instead of each tab having its own,
  // so switching category in one place scopes the whole window consistently.
  const [activeCategory, setActiveCategory] = useState('');
  // Schedule tab's edit-mode toggle lives here too — its button sits in the
  // shared TournamentScopeHeader bar (far right), not inside SchedulePanel
  // itself, so it reads as scoped to "this tournament view" the same way the
  // tournament/category pickers next to it do. Reset whenever the operator
  // leaves the Schedule tab, matching the old behavior where SchedulePanel
  // unmounting (switching tabs) reset its own local edit-mode state for free.
  const [scheduleEditMode, setScheduleEditMode] = useState(false);
  useEffect(() => { if (tab !== 'schedule') setScheduleEditMode(false); }, [tab]);
  const { teams } = useTeamDbStore();
  const { matches: scheduledMatches, updateMatch } = useMatchScheduleStore();
  const { results: savedResults, addResult, updateResult, deleteResult } = useMatchResultsStore();
  const { segments: rundownSegments } = useRundownStore();

  // Apply-to-Canvas now only resets a linked TIMER's period/duration/mode —
  // team/roster population for scoreboards and player-lists happens per-fixture
  // (Schedule tab's "Send to Scoreboard", and each widget's own team picker)
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
      ? <><Check size={12} strokeWidth={2} /> Applied to {count} widget{count !== 1 ? 's' : ''}</>
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

  // Bye/walkover flagging, bracket auto-advance, and groups-knockout
  // auto-fill now run in the always-on background process (see
  // src/lib/tournamentAutoAdvance.ts, started from App.tsx) instead of
  // as effects here, so they keep working even while this window is
  // closed — not just regardless of which tab is open within it.

  return (
    <>
      {/* Subtle backdrop — no longer closes on click (that bypassed
          confirmation); the × button is the only way to close now. */}
      <div className="tm-backdrop" />

      {/* Floating window */}
      <div
        ref={winRef}
        className={`tm-window${isMaximized ? ' tm-window--maximized' : ''}`}
        style={isMaximized ? undefined : { left: pos.x, top: pos.y }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="tm-titlebar" onMouseDown={startDrag} onDoubleClick={toggleMaximize}>
          <span className="tm-titlebar-icon" style={{ display: 'inline-flex' }}><Trophy size={15} strokeWidth={2} /></span>
          <span className="tm-titlebar-title">Tournament Database</span>
          <div className="tm-win-ctrls">
            <button
              className="tm-win-ctrl"
              onClick={toggleMaximize}
              title={isMaximized ? 'Restore' : 'Maximize'}
            >{isMaximized ? <Minimize2 size={14} strokeWidth={2} /> : <Maximize2 size={14} strokeWidth={2} />}</button>
            <button
              className="tm-win-ctrl tm-win-ctrl--close"
              onClick={e => { e.stopPropagation(); setConfirmCloseWindow(true); }}
              title="Close"
            >×</button>
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
          ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Trophy size={14} strokeWidth={2} /> Tournaments</span></button>
          <button
            onClick={() => setTab('teams')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'teams' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'teams' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Users size={14} strokeWidth={2} /> Teams{scopedTeams.length > 0 ? ` (${scopedTeams.length})` : ''}</span></button>
          <button
            onClick={() => setTab('players')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'players' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'players' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Shirt size={14} strokeWidth={2} /> Players{scopedPlayerCount > 0 ? ` (${scopedPlayerCount})` : ''}</span></button>
          <button
            onClick={() => setTab('schedule')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'schedule' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'schedule' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CalendarDays size={14} strokeWidth={2} /> Schedule{scopedMatches.length > 0 ? ` (${scopedMatches.length})` : ''}</span></button>
          <button
            onClick={() => setTab('results')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'results' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'results' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FlagTriangleRight size={14} strokeWidth={2} /> Results{scopedResults.length > 0 ? ` (${scopedResults.length})` : ''}</span></button>
          <button
            onClick={() => setTab('rundown')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'rundown' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'rundown' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
            title="A running order for the whole event day — spans every tournament, not just this one"
          ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ListChecks size={14} strokeWidth={2} /> Rundown{rundownSegments.length > 0 ? ` (${rundownSegments.length})` : ''}</span></button>
          <button
            onClick={() => setTab('standings')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'standings' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'standings' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Award size={14} strokeWidth={2} /> Standings</span></button>
          <button
            onClick={() => setTab('bracket')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'bracket' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'bracket' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Trophy size={14} strokeWidth={2} /> Bracket</span></button>
          <button
            onClick={() => setTab('draw')}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: 'transparent', color: tab === 'draw' ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === 'draw' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Dices size={14} strokeWidth={2} /> Draw</span></button>
        </div>

        {/* Remote-only (not host, not the deliberately view-only readonly client):
            local edits don't sync live — must be explicitly pushed */}
        {!isHostClient && !syncClient.isReadOnly && (
          <div className="tm-remote-edit-bar">
            {remoteEditMode ? (
              <>
                <span className="tm-remote-edit-status tm-remote-edit-status--editing" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Pencil size={12} strokeWidth={2} /> Editing locally — not synced to host yet</span>
                <button className="tm-io-btn tm-io-btn--ok" onClick={handleSaveToHost} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Save size={14} strokeWidth={2} /> Save to Host</button>
                <button className="tm-io-btn" onClick={handleDiscardAndResync} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Undo2 size={14} strokeWidth={2} /> Discard &amp; Resync</button>
              </>
            ) : (
              <>
                <span className="tm-remote-edit-status" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Lock size={12} strokeWidth={2} /> Live view — synced from host</span>
                <button className="tm-io-btn" onClick={() => setRemoteEditMode(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Pencil size={14} strokeWidth={2} /> Edit</button>
              </>
            )}
          </div>
        )}

        {/* Main area */}
        {tab === 'rundown' ? (
          <div className="tm-win-body--scoped">
            <RundownPanel />
          </div>
        ) : tab === 'teams' || tab === 'players' || tab === 'schedule' || tab === 'results' || tab === 'standings' || tab === 'bracket' || tab === 'draw' ? (
          <div className="tm-win-body--scoped">
            <TournamentScopeHeader
              tournaments={tournaments} selectedId={selectedId} onSelect={selectTournament}
              categories={selected?.categories ?? []} activeCategory={activeCategory} onSelectCategory={setActiveCategory}
            >
              {tab === 'schedule' && selected && (
                <button
                  className={`tm-io-btn${scheduleEditMode ? ' tm-io-btn--ok' : ''}`}
                  style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onClick={() => setScheduleEditMode(v => !v)}
                >
                  {scheduleEditMode ? <><Check size={14} strokeWidth={2} /> Done Editing</> : <><Pencil size={14} strokeWidth={2} /> Edit</>}
                </button>
              )}
            </TournamentScopeHeader>
            {!selected ? (
              <div className="tm-win-placeholder">
                <span>Create a tournament first in the Tournaments tab.</span>
              </div>
            ) : tab === 'teams' ? (
              <TeamsPanel tournament={selected} />
            ) : tab === 'players' ? (
              <PlayersPanel tournament={selected} activeCategory={activeCategory} />
            ) : tab === 'schedule' ? (
              <SchedulePanel tournament={selected} activeCategory={activeCategory} editMode={scheduleEditMode} />
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
              ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ArrowDown size={14} strokeWidth={2} /> Export Project</span></button>
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
                  {t.foreignVendor && (
                    <span className="tm-tourn-foreign-badge" title="Shared by another organisation via a cross-venue event link — read-only, never pushed from here" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Link2 size={11} strokeWidth={2} /> shared
                    </span>
                  )}
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
                  ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Cloud size={14} strokeWidth={2} /> {selected.cloudSyncEnabled ? 'Cloud Sync On' : 'Cloud Sync Off'}</span></button>
                  <button
                    className="tm-btn"
                    disabled={pushNowState === 'checking' || pushNowState === 'pushing'}
                    title={pushNowState === 'error' ? pushNowError : "Push this tournament's fixtures, results and settings to the cloud right now, instead of waiting for the next automatic sync"}
                    onClick={() => handlePushNow(selected.id)}
                  ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{
                    pushNowState === 'checking' ? <><Search size={14} strokeWidth={2} /> Checking…</>
                    : pushNowState === 'pushing' ? <><Hourglass size={14} strokeWidth={2} /> Pushing…</>
                    : pushNowState === 'done' ? <><Check size={14} strokeWidth={2} /> Pushed</>
                    : pushNowState === 'error' ? <><AlertTriangle size={14} strokeWidth={2} /> Push Failed</>
                    : <><ArrowUp size={14} strokeWidth={2} /> Push Now</>
                  }</span></button>
                  <button
                    className="tm-btn"
                    disabled={localizeLogosState === 'running'}
                    title={localizeLogosState === 'error' || localizeLogosState === 'done'
                      ? localizeLogosMsg
                      : "Download any cloud-hosted team logo this tournament still points at back to this device, and switch back to using it locally — fixes logos left pointing at the cloud from before local URLs were no longer overwritten by a push"}
                    onClick={() => handleLocalizeLogos(selected.id)}
                  ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{
                    localizeLogosState === 'running' ? <><Hourglass size={14} strokeWidth={2} /> Localizing…</>
                    : localizeLogosState === 'done' ? <><Check size={14} strokeWidth={2} /> Done</>
                    : localizeLogosState === 'error' ? <><AlertTriangle size={14} strokeWidth={2} /> Failed</>
                    : <><ArrowDown size={14} strokeWidth={2} /> Localize Logos</>
                  }</span></button>
                  <EventPicker
                    defaultName={selected.name}
                    defaultDateRange={scopedDateRange}
                    onPick={(ev, shareKey) => handleLoadEvent(selected.id, ev, shareKey)}
                  />
                  {selected.eventId && (
                    <span className="tm-event-linked-badge" title={`Linked to event: ${selected.eventName ?? selected.eventId}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Link2 size={11} strokeWidth={2} /> {selected.eventName ?? 'Linked event'}
                    </span>
                  )}
                  <button
                    className="tm-btn"
                    title={defaultTournamentId === selected.id ? 'Unset as default (Tournament Database will open to the first tournament instead)' : 'Set as default — the Tournament Database opens to this tournament automatically'}
                    onClick={() => setDefaultTournament(selected.id)}
                  ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{defaultTournamentId === selected.id ? <><Star size={14} strokeWidth={2} fill="currentColor" /> Default</> : <><Star size={14} strokeWidth={2} /> Set Default</>}</span></button>
                  <button
                    className="tm-btn"
                    title="Export this tournament and everything related to it (teams, rosters, schedule, results) as a JSON file"
                    onClick={() => exportTournamentJSON(selected, scopedTeams, scopedMatches, scopedResults)}
                  ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ArrowDown size={14} strokeWidth={2} /> Export Tournament</span></button>
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
                    ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Trash2 size={14} strokeWidth={2} /> Delete</span></button>
                  )}
                </div>

                {pushDiff && pushDiffTournamentId && (
                  <PushDiffModal
                    items={pushDiff}
                    onConfirm={confirmPushDiff}
                    onCancel={() => { setPushDiff(null); setPushDiffTournamentId(null); }}
                  />
                )}

                {pendingEventLink && (
                  <LoadEventDiffModal
                    eventName={pendingEventLink.event.name}
                    items={eventLinkDiff}
                    checking={checkingEventLink}
                    onConfirm={confirmEventLink}
                    onCancel={cancelEventLink}
                  />
                )}

                {/* Period / time settings */}
                <SettingsBar tournament={selected} onApply={applyToCanvas} />

                {/* Quick summary + jump-to links for this tournament's related data */}
                <div style={{ display: 'flex', gap: 8, padding: '12px 16px', flexWrap: 'wrap' }}>
                  <button className="tm-sidebar-new-btn" onClick={() => setTab('teams')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Users size={14} strokeWidth={2} /> {scopedTeams.length} team{scopedTeams.length !== 1 ? 's' : ''}
                  </button>
                  <button className="tm-sidebar-new-btn" onClick={() => setTab('players')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Shirt size={14} strokeWidth={2} /> {scopedPlayerCount} player{scopedPlayerCount !== 1 ? 's' : ''}
                  </button>
                  <button className="tm-sidebar-new-btn" onClick={() => setTab('schedule')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <CalendarDays size={14} strokeWidth={2} /> {scopedMatches.length} fixture{scopedMatches.length !== 1 ? 's' : ''}
                  </button>
                  <button className="tm-sidebar-new-btn" onClick={() => setTab('results')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <FlagTriangleRight size={14} strokeWidth={2} /> {scopedResults.length} result{scopedResults.length !== 1 ? 's' : ''}
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
              {applyStatus && <span className="tm-apply-status" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{applyStatus}</span>}
              <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 10 }}>double-click row to edit</span>
            </>
          )}
        </div>
      </div>
      {confirmCloseWindow && (
        <ConfirmModal
          title="Close window?"
          message="Close the Tournament Database window?"
          confirmLabel="Close"
          onConfirm={() => { setConfirmCloseWindow(false); onClose(); }}
          onCancel={() => setConfirmCloseWindow(false)}
        />
      )}
    </>
  );
}
