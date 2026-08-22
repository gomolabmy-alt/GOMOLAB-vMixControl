import { useState, useRef, useEffect, useMemo, useCallback, useContext } from 'react';
import { createPortal } from 'react-dom';
import { Check, GripVertical, X, ArrowUp, Users, Hand } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useMatchScheduleStore } from '../../stores/matchScheduleStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { SPORT_DEFAULTS } from '../../types/tournament';
import type { Player } from '../../types/tournament';
import { CanvasActionContext } from '../../lib/canvasContext';
import { autoLinkedWidget, autoLinkedWidgetPair } from '../../lib/autoLink';
import { resolvePlayerListRoster, isDualPlayerList } from '../../lib/playerListSquad';
import { findTeamRecord, resolveNextFixtureTeams } from '../../lib/teamForm';
import { simplifyPlayerName } from '../../lib/simpleName';
import { ConfirmModal } from '../ConfirmModal';

const STAT_FIELDS: { key: 'tries' | 'conversions' | 'penalties' | 'dropGoals' | 'yellowCards' | 'redCards' | 'appearances'; label: string }[] = [
  { key: 'appearances', label: 'APP' },
  { key: 'tries', label: 'T' },
  { key: 'conversions', label: 'C' },
  { key: 'penalties', label: 'P' },
  { key: 'dropGoals', label: 'DG' },
  { key: 'yellowCards', label: 'YC' },
  { key: 'redCards', label: 'RC' },
];

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

type PositionMeta = { number: number; position: string; x: number; y: number };

// One curated pitch layout per rugby format, keyed by the tournament's own
// Starters count (see the "Format" quick-fill buttons in Tournament
// Settings, which just set maxOnField/maxSubs — there's no separate stored
// "format" field, so the lineup here is derived straight from that number).
const FIFTEENS_POSITIONS: PositionMeta[] = [
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

const TENS_POSITIONS: PositionMeta[] = [
  { number: 1,  position: 'Prop',        x: 30, y: 13 },
  { number: 2,  position: 'Hooker',      x: 50, y: 13 },
  { number: 3,  position: 'Prop',        x: 70, y: 13 },
  { number: 4,  position: 'Flanker',     x: 20, y: 32 },
  { number: 5,  position: 'Number 8',    x: 50, y: 32 },
  { number: 6,  position: 'Scrum Half',  x: 80, y: 32 },
  { number: 7,  position: 'Fly Half',    x: 50, y: 50 },
  { number: 8,  position: 'Centre',      x: 30, y: 68 },
  { number: 9,  position: 'Wing',        x: 70, y: 68 },
  { number: 10, position: 'Full Back',   x: 50, y: 82 },
];

const SEVENS_POSITIONS: PositionMeta[] = [
  { number: 1, position: 'Prop',       x: 30, y: 15 },
  { number: 2, position: 'Hooker',     x: 50, y: 15 },
  { number: 3, position: 'Prop',       x: 70, y: 15 },
  { number: 4, position: 'Scrum Half', x: 50, y: 38 },
  { number: 5, position: 'Fly Half',   x: 50, y: 56 },
  { number: 6, position: 'Centre',     x: 28, y: 74 },
  { number: 7, position: 'Wing',       x: 72, y: 74 },
];

const POSITIONS_BY_COUNT: Record<number, PositionMeta[]> = {
  7: SEVENS_POSITIONS,
  10: TENS_POSITIONS,
  15: FIFTEENS_POSITIONS,
};

// Fallback for any Starters count that isn't 7/10/15 (e.g. rugby league's
// own 13-a-side default, or a custom count) — spreads N generic numbered
// slots evenly down the pitch in rows rather than forcing the fixed
// fifteens layout on a different-sized squad.
function buildGenericPositions(n: number): PositionMeta[] {
  if (n <= 0) return [];
  const rows = n <= 6 ? 2 : n <= 10 ? 3 : n <= 14 ? 4 : 5;
  const base = Math.floor(n / rows);
  const extra = n % rows;
  const result: PositionMeta[] = [];
  let num = 1;
  for (let r = 0; r < rows; r++) {
    const countInRow = base + (r < extra ? 1 : 0);
    const y = 12 + r * (68 / Math.max(1, rows - 1));
    for (let c = 0; c < countInRow; c++) {
      const x = countInRow === 1 ? 50 : 12 + c * (76 / (countInRow - 1));
      result.push({ number: num, position: `Position ${num}`, x, y });
      num++;
    }
  }
  return result;
}

// Classified by keyword against the actual position names used above (all
// three curated layouts share the same canonical rugby position words), not
// by jersey number range — robust regardless of format (7s/10s/15s) or a
// custom Starters count using buildGenericPositions' plain "Position N"
// labels, which simply won't match either pattern and fall through to 'Back'
// (harmless — those labels carry no real forward/back meaning to begin with).
function simplifyRugbyPosition(position: string): string {
  return /prop|hooker|lock|flanker|number\s*8|no\.?\s*8/i.test(position) ? 'Forward' : 'Back';
}

// Auto-shrinks a player name to fit its pitch-slot box instead of letting
// CSS's 2-line clamp cut it off with a trailing "…" — measured via an
// offscreen canvas (fast, no DOM layout thrash) against the same width the
// name pill actually renders at (nameWidth), assuming up to 2 lines' worth
// of horizontal capacity.
let _measureCtx: CanvasRenderingContext2D | null = null;
function fitNameFontSize(name: string, baseSize: number, maxWidthPerLine: number, minSize: number): number {
  if (!name) return baseSize;
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  if (!_measureCtx) return baseSize;
  _measureCtx.font = `700 ${baseSize}px sans-serif`;
  const fullWidth = _measureCtx.measureText(name).width;
  const capacity = maxWidthPerLine * 2;
  if (fullWidth <= capacity) return baseSize;
  return Math.max(minSize, Math.floor(baseSize * (capacity / fullWidth)));
}

const JERSEY_PRESETS = [
  '#ffffff', '#f0f0f0', '#222222', '#e74c3c', '#c0392b',
  '#3498db', '#2980b9', '#2ecc71', '#27ae60', '#f39c12',
  '#e67e22', '#9b59b6', '#1abc9c', '#e91e63', '#ff5722', '#607d8b',
];

const NUM_PRESETS = ['#222222', '#ffffff', '#e74c3c', '#3498db', '#f39c12', '#2ecc71'];

function buildDefaultPlayers(teamColor: string, positions: PositionMeta[]): RPlayer[] {
  return positions.map(p => ({ ...p, name: '', jerseyColor: teamColor, textColor: '#222222' }));
}

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
  /** Renders as the "Next Match" variant — teams resolved from the soonest
   *  not-yet-sent fixture instead of a linked scoreboard, so a lineup can be
   *  built ahead of kickoff. Set by the 'rugby-lineup-next' widget type (see
   *  components/widgets/index.tsx) — same idea as PlayerListWidget's own
   *  nextMatchMode, and it follows a 'player-list-next' widget instead of a
   *  'player-list' for exactly that reason: that's the one already resolving
   *  starters/subs against the same next-fixture teams. */
  nextMatchMode?: boolean;
}

export function RugbyLineupWidget({ widgetId, config: cfg, w, h, nextMatchMode }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const pages = store.pages; // always use main canvas pages for player data lookups
  const { teams: teamDbTeams } = useTeamDbStore();
  const { tournaments } = useTournamentStore();
  const { matches } = useMatchScheduleStore();
  // Simple Names (App Settings) — applied to read-only name display only,
  // never to the editable name input (see src/lib/simpleName.ts).
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

  const fieldColor: string = cfg.fieldColor ?? '#2d7a3a';
  const owningPage = pages.find(p => p.widgets.some(w => w.id === widgetId));
  const side: 'A' | 'B' = cfg.teamSide === 'B' ? 'B' : 'A';

  // Next Match: soonest not-yet-sent fixture (scoped by the same
  // Tournament/Venue/Category filters as the paired 'player-list-next'
  // widget) — used for the opponent/date header line below. Team + roster
  // resolution itself doesn't need this directly: it flows through
  // linkedPlw's own cached a_/b_resolvedTeamId (see resolvePlayerListRoster),
  // exactly like every other consumer of a Next Match Player List.
  const nextFixture = nextMatchMode
    ? resolveNextFixtureTeams(matches, teamDbTeams, {
        tournamentId: cfg.linkedTournamentId || owningPage?.tournamentId,
        venue: cfg.filterVenue, category: cfg.filterCategory,
      })
    : undefined;

  // Falls back to the sole Scoreboard widget on this page when nothing's
  // been explicitly linked in settings — an explicit pick always wins.
  // Which side this widget instance represents ('A'/'B') decides which of
  // the scoreboard's two teams — and which side of its paired Player List
  // widgets — it follows. Next Match never follows a scoreboard — there
  // isn't a live one yet, that's the whole point.
  const linkedScoreboard = nextMatchMode ? undefined : autoLinkedWidget(pages, widgetId, cfg.linkedScoreboardId, 'scoreboard');
  const dc = linkedScoreboard?.config ?? {};
  // '|| undefined' (not just the raw field) so a scoreboard whose name field
  // is blank but whose id IS set (e.g. loaded from a fixture whose own name
  // field was empty) doesn't win an empty string over a real resolved name
  // further down every ?? chain these two feed into.
  const scoreboardTeamId: string | undefined = linkedScoreboard ? (side === 'A' ? dc.teamAId : dc.teamBId) : undefined;
  const scoreboardTeamName: string | undefined = linkedScoreboard ? ((side === 'A' ? dc.teamAName : dc.teamBName) || undefined) : undefined;
  const scoreboardTeamColor: string | undefined = linkedScoreboard ? (side === 'A' ? dc.teamAColor : dc.teamBColor) : undefined;

  // Player List link: explicit pick wins, else whichever side of the linked
  // Scoreboard's own paired Player Lists matches this widget's side (same
  // pairing every other side-aware widget — Card/Sin Bin/Score Lower Third,
  // Timeline — already resolves through), else the sole Player List (or, in
  // Next Match mode, Player List — Next Match) widget on the page (old
  // single-team behavior, for a standalone Rugby Lineup with no Scoreboard
  // linked).
  const { a: sbPlA, b: sbPlB } = linkedScoreboard
    ? autoLinkedWidgetPair(pages, linkedScoreboard.id, dc.linkedPlayerListA, dc.linkedPlayerListB, 'player-list')
    : { a: undefined, b: undefined };
  const linkedPlw = cfg.linkedPlayerListId
    ? pages.flatMap(p => p.widgets).find(w => w.id === cfg.linkedPlayerListId)
    : (side === 'A' ? sbPlA : sbPlB) ?? autoLinkedWidget(pages, widgetId, undefined, nextMatchMode ? 'player-list-next' : 'player-list');
  const roster = resolvePlayerListRoster(linkedPlw, side, teamDbTeams);

  // Team roster (SavedTeam, for the Roster/Bench strips + stats popovers):
  // explicit pick wins, else whichever team the linked Player List already
  // resolved for this side (most authoritative — it's the exact team that
  // widget is itself showing), else look the Scoreboard's own team name up
  // in the Team DB directly (works even with no Player List widget on the
  // page at all).
  const tournamentIdForLookup: string | undefined = dc.linkedTournamentId || owningPage?.tournamentId;
  const linkedTeam = cfg.linkedTeamId
    ? teamDbTeams.find(t => t.id === cfg.linkedTeamId)
    : roster.team
      ?? (scoreboardTeamId ? teamDbTeams.find(t => t.id === scoreboardTeamId) : undefined)
      ?? (scoreboardTeamName ? findTeamRecord(teamDbTeams, scoreboardTeamName, dc.category, tournamentIdForLookup) : undefined);
  const teamName: string = scoreboardTeamName ?? linkedTeam?.name ?? cfg.teamName ?? 'Team Name';
  const teamColor: string = cfg.teamColor ?? scoreboardTeamColor ?? '#3498db';

  // Pitch layout follows the tournament's own Starters count (see the
  // Format quick-fill buttons in Tournament Settings) — same tournament
  // resolution priority as the config panel's own team-scoping (explicit
  // Tournament picker first, then the linked Scoreboard's tournament, then
  // whichever tournament the linked team belongs to, then whatever
  // tournament this page is bound to).
  const effTournamentId = cfg.linkedTournamentId || dc.linkedTournamentId || linkedTeam?.tournamentId || owningPage?.tournamentId;
  const tournament = tournaments.find(t => t.id === effTournamentId) ?? null;
  const maxOnField: number = tournament
    ? (tournament.settings?.maxOnField ?? SPORT_DEFAULTS[tournament.sport]?.maxOnField ?? 15)
    : 15;
  const positionsMeta: PositionMeta[] = useMemo(() =>
    POSITIONS_BY_COUNT[maxOnField] ?? buildGenericPositions(maxOnField),
    [maxOnField]
  );

  const players: RPlayer[] = (cfg.players?.length === positionsMeta.length) ? cfg.players : buildDefaultPlayers(teamColor, positionsMeta);

  const [layoutEdit, setLayoutEdit]     = useState(false);
  // Roster drag-to-assign is opt-in via this header toggle (same idea as
  // "Move" below) — off by default so a plain click on a roster/bench
  // player always just opens their stats popup with zero chance of being
  // swallowed by an armed drag.
  const [dragMode, setDragMode]         = useState(false);
  const [colorPicking, setColorPicking] = useState<number | null>(null);
  const [dragPos, setDragPos]           = useState<{ num: number; x: number; y: number } | null>(null);

  const dragging    = useRef<{ num: number; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const dragPosRef  = useRef<{ num: number; x: number; y: number } | null>(null);

  // Roster/Bench list height — drag the handle at the bottom of either
  // strip to resize it (persisted per-widget); unset means "natural,
  // content-driven height" (the original behavior), same idea as the
  // pitch-position drag: a local live value while dragging, committed to
  // config only on release.
  const [listResizeLive, setListResizeLive] = useState<{ key: 'rosterListHeight' | 'benchListHeight'; height: number } | null>(null);
  const listResizeRef = useRef<{ key: 'rosterListHeight' | 'benchListHeight'; sy: number; oh: number } | null>(null);
  const rosterListRef = useRef<HTMLDivElement>(null);
  const benchListRef  = useRef<HTMLDivElement>(null);
  const startListResize = (key: 'rosterListHeight' | 'benchListHeight', listEl: HTMLDivElement | null) => (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const startHeight = cfg[key] ?? listEl?.getBoundingClientRect().height ?? 60;
    listResizeRef.current = { key, sy: e.clientY, oh: startHeight };
    const onMove = (ev: MouseEvent) => {
      const r = listResizeRef.current;
      if (!r) return;
      const height = Math.max(32, Math.min(280, r.oh + (ev.clientY - r.sy)));
      setListResizeLive({ key: r.key, height });
    };
    const onUp = () => {
      const r = listResizeRef.current;
      listResizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setListResizeLive(cur => {
        if (r && cur) updateWidgetConfig(widgetId, { [r.key]: cur.height });
        return null;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const rosterListHeight = listResizeLive?.key === 'rosterListHeight' ? listResizeLive.height : cfg.rosterListHeight;
  const benchListHeight  = listResizeLive?.key === 'benchListHeight'  ? listResizeLive.height  : cfg.benchListHeight;
  const fieldRef    = useRef<HTMLDivElement>(null);

  const getPlayer = (num: number): RPlayer =>
    players.find(p => p.number === num) ??
    { ...(positionsMeta.find(p => p.number === num)!), name: '', jerseyColor: teamColor, textColor: '#222222' };

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

  // Live substitution overrides: read the linked Player List's starters
  // array (via resolvePlayerListRoster, which already knows whether that
  // widget is single-team or side-by-side/Next Match and reads the
  // correctly-prefixed fields either way) so that after a sub the incoming
  // player's name appears at the right position on field.
  type SlotOverride = { playerId: string; name: string; jerseyNo?: string; isSub: boolean };
  const subOverrides = useMemo(() => {
    if (!linkedTeam) return {} as Record<number, SlotOverride>;
    const subbedOn = new Set(roster.subbedOnPlayers);
    const playerById = Object.fromEntries((linkedTeam.players ?? []).map((p: Player) => [p.id, p]));
    const overrides: Record<number, SlotOverride> = {};
    positionsMeta.forEach((pm, i) => {
      const id = roster.starters[i];
      if (!id) return;
      const p = playerById[id];
      if (!p) return;
      overrides[pm.number] = { playerId: id, name: p.name, jerseyNo: p.jerseyNo || undefined, isSub: subbedOn.has(id) };
    });
    return overrides;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedTeam, roster.starters, roster.subbedOnPlayers, positionsMeta]);

  // Available players: from the linked saved team, then fall back to any player-list widget
  const availablePlayers = useMemo((): Player[] => {
    if (linkedTeam?.players?.length) return linkedTeam.players;
    const seen = new Set<string>();
    const result: Player[] = [];
    for (const page of pages) {
      for (const widget of page.widgets) {
        if (widget.type !== 'player-list') continue;
        const team = teamDbTeams.find(t => t.id === widget.config.linkedTeamId);
        for (const p of team?.players ?? []) {
          if (!seen.has(p.id)) { seen.add(p.id); result.push(p); }
        }
      }
    }
    return result;
  }, [linkedTeam, pages, teamDbTeams]);

  // Full roster strip — every player on the linked team, so an operator can
  // drag anyone straight onto a pitch slot or the separate Bench strip
  // below. Falls back to availablePlayers (any player-list widget on the
  // page) when there's no direct team link. Empty (hidden) when no
  // team/roster is resolvable at all.
  const rosterPlayers: Player[] = linkedTeam?.players?.length ? linkedTeam.players : availablePlayers;

  // Bench strip — kept as its own separate list/drop-zone (not folded into
  // the roster above) so "which player goes to the bench" is a deliberate
  // choice, same as picking a pitch slot, not just an implicit side-effect
  // of the roster list itself being droppable.
  const benchPlayers = useMemo((): Player[] => {
    if (!linkedTeam) return [];
    const playerById = Object.fromEntries((linkedTeam.players ?? []).map((p: Player) => [p.id, p]));
    return roster.subs.map(id => playerById[id]).filter((p): p is Player => !!p);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedTeam, roster.subs]);

  // Writes straight to the LINKED PLAYER LIST WIDGET's own starters/subs
  // arrays (index-aligned with positionsMeta), same field-prefix convention
  // as PlayerListWidget's own assignToSlot — so a drag here shows up
  // everywhere else that reads that widget's roster too (substitutions,
  // stats, timeline), not just as a local label on this widget.
  const rosterKeyPrefix = linkedPlw ? (isDualPlayerList(linkedPlw) ? (side === 'A' ? 'a_' : 'b_') : '') : '';
  const assignPlayerToSlot = useCallback((playerId: string, section: 'starter' | 'sub', idx: number) => {
    if (!linkedPlw) return;
    const starters = [...roster.starters];
    const subs = [...roster.subs];
    if (section === 'starter') {
      const subIdx = subs.indexOf(playerId);
      if (subIdx >= 0) subs[subIdx] = '';
      while (starters.length <= idx) starters.push('');
      const starterIdx = starters.indexOf(playerId);
      if (starterIdx >= 0) starters[starterIdx] = '';
      starters[idx] = playerId;
    } else {
      const starterIdx = starters.indexOf(playerId);
      if (starterIdx >= 0) starters[starterIdx] = '';
      const existingSubIdx = subs.indexOf(playerId);
      if (existingSubIdx >= 0) subs[existingSubIdx] = '';
      const emptyIdx = subs.indexOf('');
      if (emptyIdx >= 0) subs[emptyIdx] = playerId; else subs.push(playerId);
    }
    updateWidgetConfig(linkedPlw.id, { [`${rosterKeyPrefix}starters`]: starters, [`${rosterKeyPrefix}subs`]: subs });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedPlw, rosterKeyPrefix, roster.starters, roster.subs, updateWidgetConfig]);

  // Clears a player off the pitch/bench entirely, back to the (unassigned)
  // roster list — blanks their slot rather than shrinking the array, same
  // convention as PlayerListWidget's own removeFromSlot, so every other
  // slot's index stays aligned with positionsMeta.
  const unassignPlayer = useCallback((playerId: string) => {
    if (!linkedPlw) return;
    const starters = roster.starters.map(id => id === playerId ? '' : id);
    const subs = roster.subs.map(id => id === playerId ? '' : id);
    updateWidgetConfig(linkedPlw.id, { [`${rosterKeyPrefix}starters`]: starters, [`${rosterKeyPrefix}subs`]: subs });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedPlw, rosterKeyPrefix, roster.starters, roster.subs, updateWidgetConfig]);

  // Bringing a bench player onto the pitch is a real substitution — unlike
  // assigning straight from the (unassigned) roster, which is just routine
  // team-sheet building — so it's confirmed before it actually happens.
  const [pendingBenchToPitch, setPendingBenchToPitch] = useState<{ playerId: string; slotIdx: number; slotNum: number } | null>(null);

  // Drag a roster player onto a pitch slot or the bench strip — plain
  // mouse-event drag (native HTML5 DnD doesn't fire reliably in this app's
  // WebView, see MergeFieldComposer/TournamentManager for the same pattern),
  // with a small movement threshold so a plain click still opens stats.
  const [draggingRosterId, setDraggingRosterId] = useState<string | null>(null);
  const [rosterDropTarget, setRosterDropTarget] = useState<{ type: 'slot'; num: number } | { type: 'bench' } | null>(null);
  const [dragGhostPos, setDragGhostPos] = useState<{ x: number; y: number } | null>(null);
  const rosterDragRef = useRef<{ playerId: string; armed: boolean; sx: number; sy: number } | null>(null);
  const startRosterDrag = (playerId: string) => (e: React.MouseEvent) => {
    if (!dragMode || e.button !== 0) return;
    rosterDragRef.current = { playerId, armed: false, sx: e.clientX, sy: e.clientY };
    const resolveTarget = (clientX: number, clientY: number) => {
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const slotEl = el?.closest('[data-rugby-slot]') as HTMLElement | null;
      if (slotEl) return { type: 'slot' as const, num: parseInt(slotEl.dataset.rugbySlot!, 10) };
      if (el?.closest('[data-rugby-bench]')) return { type: 'bench' as const };
      return null;
    };
    const onMove = (ev: MouseEvent) => {
      const drag = rosterDragRef.current;
      if (!drag) return;
      if (!drag.armed) {
        if (Math.abs(ev.clientX - drag.sx) < 6 && Math.abs(ev.clientY - drag.sy) < 6) return;
        drag.armed = true;
        setDraggingRosterId(drag.playerId);
      }
      setDragGhostPos({ x: ev.clientX, y: ev.clientY });
      setRosterDropTarget(resolveTarget(ev.clientX, ev.clientY));
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const drag = rosterDragRef.current;
      rosterDragRef.current = null;
      if (drag?.armed) {
        const target = resolveTarget(ev.clientX, ev.clientY);
        if (target?.type === 'slot') {
          const idx = positionsMeta.findIndex(p => p.number === target.num);
          if (idx >= 0) {
            if (roster.subs.includes(drag.playerId)) {
              // Coming off the bench onto the pitch — confirm first.
              setPendingBenchToPitch({ playerId: drag.playerId, slotIdx: idx, slotNum: target.num });
            } else {
              assignPlayerToSlot(drag.playerId, 'starter', idx);
            }
          }
        } else if (target?.type === 'bench') {
          assignPlayerToSlot(drag.playerId, 'sub', 0);
        }
      }
      setDraggingRosterId(null);
      setRosterDropTarget(null);
      setDragGhostPos(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Player stats popover — tap/click a linked player (on the pitch or in
  // the roster strip) to see their cumulative stats. Only ever available
  // for players actually resolved from a linked roster (they need a real
  // id to look stats up by) — a manually-typed pitch name has no id to
  // attach stats to.
  const [statsForId, setStatsForId] = useState<string | null>(null);
  const statsPlayer: Player | undefined = statsForId ? (linkedTeam?.players ?? []).find(p => p.id === statsForId) : undefined;
  const toggleStats = (id: string) => setStatsForId(cur => cur === id ? null : id);

  const setTeamColorAll = (color: string) => {
    const updated = players.map(p => ({ ...p, jerseyColor: color }));
    updateWidgetConfig(widgetId, { teamColor: color, players: updated });
  };

  // Player name (and position label) size is otherwise auto-derived from
  // the widget's own box size — nameScale is a manual multiplier on top of
  // that auto value, for when the auto size doesn't match what this
  // particular graphic needs.
  const nameScale: number = cfg.nameScale ?? 1;
  // Off (default): shrink the font just enough to always show the whole
  // name (fitNameFontSize below). On: skip that and hold every name pill at
  // the same size, letting CSS's 2-line clamp cut long ones off with an
  // ellipsis instead — a simpler, more uniform-looking pitch at the cost of
  // not always showing the full name.
  const truncateNames: boolean = cfg.truncateNames ?? false;
  const jerseySize = Math.max(18, Math.min(38, Math.round(Math.min(w, h * 0.85) / 14)));
  const nameSize   = Math.max(7,  Math.round(jerseySize * 0.45 * nameScale));
  const posSize    = Math.max(6,  Math.round(jerseySize * 0.28 * nameScale));
  // Name pill width: ~23% of widget width, let names wrap to 2 lines instead of truncating
  const nameWidth  = Math.min(Math.floor(w * 0.23), 115);

  function renderStatsCard(p: Player) {
    return (
      <div className="rugby-stats-card" onClick={e => e.stopPropagation()}>
        <div className="rugby-stats-card-hdr">
          <span className="rugby-stats-card-name">{disp(p.name)}</span>
          <button className="rugby-stats-card-close" onClick={() => setStatsForId(null)}><X size={11} strokeWidth={2} /></button>
        </div>
        <div className="rugby-stats-card-grid">
          {STAT_FIELDS.map(f => (
            <div key={f.key} className="rugby-stats-card-stat">
              <span className="rugby-stats-card-val">{p[f.key] ?? 0}</span>
              <span className="rugby-stats-card-lbl">{f.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

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

        <span className="rugby-lineup-team-name">{teamName}</span>
        {nextMatchMode && (
          <span className="rugby-lineup-next-badge">
            {nextFixture
              ? `Next vs ${disp((side === 'A' ? nextFixture.teamB : nextFixture.teamA)?.name ?? '?')} · ${nextFixture.match.date}${nextFixture.match.time ? ' ' + nextFixture.match.time : ''}`
              : 'No upcoming fixture'}
          </span>
        )}

        <div className="rugby-namesize-ctl" onClick={e => e.stopPropagation()} title="Player name size">
          <button
            className="rugby-namesize-btn"
            onClick={() => updateWidgetConfig(widgetId, { nameScale: Math.max(0.6, Math.round((nameScale - 0.1) * 10) / 10) })}
            title="Smaller player name"
          >A-</button>
          <button
            className="rugby-namesize-btn"
            onClick={() => updateWidgetConfig(widgetId, { nameScale: Math.min(1.8, Math.round((nameScale + 0.1) * 10) / 10) })}
            title="Bigger player name"
          >A+</button>
        </div>

        {linkedPlw && (
          <button
            className={`rugby-layout-btn${dragMode ? ' rugby-layout-btn--active' : ''}`}
            onClick={e => { e.stopPropagation(); setDragMode(v => !v); }}
            title={dragMode ? 'Drag mode on — roster/bench players can be dragged; tap still opens stats' : 'Turn on to drag roster/bench players onto the pitch or bench'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >{dragMode ? <><Check size={11} strokeWidth={2} /> Done</> : <><Hand size={11} strokeWidth={2} /> Assign</>}</button>
        )}
        <button
          className={`rugby-layout-btn${layoutEdit ? ' rugby-layout-btn--active' : ''}`}
          onClick={e => { e.stopPropagation(); setLayoutEdit(v => !v); }}
          title="Drag player positions"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >{layoutEdit ? <><Check size={11} strokeWidth={2} /> Done</> : <><GripVertical size={11} strokeWidth={2} /> Move</>}</button>
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
        {positionsMeta.map(({ number: num }) => {
          const p = getPlayer(num);
          const override = subOverrides[num];
          const displayName = disp(override ? override.name : p.name);
          const displayJerseyNo = override?.jerseyNo ?? (p.jerseyNo ?? num);
          const isSub = !!override?.isSub;
          const pos = getDisplayPos(num);
          const displayPosLabel = cfg.simplePositions ? simplifyRugbyPosition(p.position) : p.position;
          const fittedNameSize = truncateNames ? nameSize : fitNameFontSize(displayName, nameSize, nameWidth, Math.max(7, Math.round(nameSize * 0.55)));
          const isColorPicking = colorPicking === num;
          const isDraggingThis = dragging.current?.num === num;

          const isRosterDropHover = rosterDropTarget?.type === 'slot' && rosterDropTarget.num === num;

          return (
            <div
              key={num}
              data-rugby-slot={num}
              className={`rugby-player-slot${layoutEdit ? ' rugby-player-slot--moveable' : ''}${isDraggingThis ? ' rugby-player-slot--dragging' : ''}${isRosterDropHover ? ' rugby-player-slot--drop-hover' : ''}`}
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
              onMouseDown={e => {
                if (!layoutEdit) return;
                e.preventDefault(); e.stopPropagation();
                dragging.current = { num, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y };
              }}
              onClick={e => {
                e.stopPropagation();
                if (layoutEdit || dragMode || !override?.playerId) return;
                toggleStats(override.playerId);
              }}
            >
              {/* Jersey — right-click for color */}
              <div
                className="rugby-jersey-wrap"
                title={layoutEdit ? 'Drag to reposition' : override?.playerId ? 'Click player for stats · Right-click jersey for colors' : 'Right-click jersey for colors · Drag a player here from Roster/Bench'}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setColorPicking(num); }}
              >
                <svg viewBox="0 0 40 36" width={jerseySize * 1.6} height={jerseySize * 1.4}>
                  <path d="M8 2 L0 10 L8 14 L8 34 L32 34 L32 14 L40 10 L32 2 L26 6 Q20 10 14 6 Z"
                    fill={p.jerseyColor} stroke="rgba(0,0,0,0.3)" strokeWidth="1" />
                  <text x="20" y="24" textAnchor="middle" dominantBaseline="middle"
                    fontSize={jerseySize * 0.5} fontWeight="bold" fill={p.textColor}
                    fontFamily="sans-serif">{displayJerseyNo}</text>
                </svg>
              </div>

              {/* Remove — always available (regardless of Assign mode) once
                  a slot is filled from a linked roster; sends this starter
                  back to the (unassigned) Roster strip. Assigning a slot is
                  drag-and-drop only (see startRosterDrag), but clearing one
                  shouldn't require first toggling into Assign mode. */}
              {override?.playerId && !layoutEdit && (
                <button
                  className="rugby-pitch-remove"
                  title="Remove from pitch — back to Roster"
                  onClick={e => { e.stopPropagation(); unassignPlayer(override.playerId); }}
                ><X size={10} strokeWidth={2.5} /></button>
              )}
              {override?.playerId && statsForId === override.playerId && statsPlayer && renderStatsCard(statsPlayer)}

              {/* Name — read-only; a pitch slot is filled only by dragging a
                  player from the Roster/Bench (see startRosterDrag), never
                  by clicking/typing directly on the pitch. */}
              <span className={`rugby-player-name${truncateNames ? ' rugby-player-name--clamped' : ''}`} style={{ fontSize: fittedNameSize }}>
                {displayName
                  ? <>{displayName}{isSub && <span className="rugby-sub-badge"><ArrowUp size={9} strokeWidth={2.5} /></span>}</>
                  : <span style={{ opacity: 0.4 }}>—</span>}
              </span>

              <span className="rugby-player-pos" style={{ fontSize: posSize }}>{displayPosLabel}</span>

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
                  <button className="rugby-color-close" onClick={() => setColorPicking(null)}><X size={11} strokeWidth={2} /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Bench — its own separate list/drop-zone, above the Roster: drag a
          roster player here to bench them, or drag a bench player straight
          onto a pitch slot to bring them on (confirmed first — see
          pendingBenchToPitch). The × sends a player back to the
          (unassigned) Roster below. */}
      {linkedPlw && (
        <div
          className={`rugby-subs-strip rugby-bench-strip${rosterDropTarget?.type === 'bench' ? ' rugby-subs-strip--drop-hover' : ''}`}
          data-rugby-bench=""
          onClick={e => e.stopPropagation()}
        >
          <span className="rugby-subs-hdr" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Users size={11} strokeWidth={2} /> Bench
          </span>
          <div className="rugby-subs-list" ref={benchListRef}
            style={benchListHeight ? { height: benchListHeight, overflowY: 'auto' } : undefined}>
            {benchPlayers.length === 0 && <span className="rugby-bench-empty">{dragMode ? 'Drag a player here' : 'No one on the bench'}</span>}
            {benchPlayers.map(bp => (
              <div key={bp.id} className="rugby-subs-item-wrap">
                <button
                  className={`rugby-subs-item rugby-subs-item--bench${statsForId === bp.id ? ' rugby-subs-item--active' : ''}${draggingRosterId === bp.id ? ' rugby-subs-item--dragging' : ''}`}
                  onMouseDown={startRosterDrag(bp.id)}
                  onClick={() => { if (!dragMode) toggleStats(bp.id); }}
                  title={dragMode ? 'On bench — drag onto a pitch slot to bring on' : 'On bench'}
                >
                  {bp.jerseyNo && <span className="rugby-subs-no">{bp.jerseyNo}</span>}
                  <span className="rugby-subs-name">{disp(bp.name)}</span>
                </button>
                {dragMode && (
                  <button className="rugby-subs-remove" title="Remove from bench — back to Roster"
                    onClick={() => unassignPlayer(bp.id)}
                  ><X size={9} strokeWidth={2.5} /></button>
                )}
                {statsForId === bp.id && renderStatsCard(bp)}
              </div>
            ))}
          </div>
          <div className="rugby-list-resize-handle" onMouseDown={startListResize('benchListHeight', benchListRef.current)} title="Drag to resize Bench list" />
        </div>
      )}

      {/* Roster — unassigned players only (once dragged onto the pitch or
          bench, a player leaves this list — Roster/Pitch/Bench are three
          mutually exclusive places, not a label on top of the same list).
          Drag anyone straight onto a pitch slot to start them there, or the
          Bench above; tap (without dragging) for their stats. */}
      {(() => {
        const unassignedPlayers = rosterPlayers.filter(rp => !roster.starters.includes(rp.id) && !roster.subs.includes(rp.id));
        if (unassignedPlayers.length === 0) return null;
        return (
          <div className="rugby-subs-strip" onClick={e => e.stopPropagation()}>
            <span className="rugby-subs-hdr" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Users size={11} strokeWidth={2} /> {dragMode ? 'Roster — drag to pitch or the Bench above' : 'Roster — tap a player for stats'}
            </span>
            <div className="rugby-subs-list" ref={rosterListRef}
              style={rosterListHeight ? { height: rosterListHeight, overflowY: 'auto' } : undefined}>
              {unassignedPlayers.map(rp => (
                <div key={rp.id} className="rugby-subs-item-wrap">
                  <button
                    className={`rugby-subs-item${statsForId === rp.id ? ' rugby-subs-item--active' : ''}${draggingRosterId === rp.id ? ' rugby-subs-item--dragging' : ''}`}
                    onMouseDown={startRosterDrag(rp.id)}
                    onClick={() => { if (!dragMode) toggleStats(rp.id); }}
                    title={dragMode ? 'Not in squad — drag to pitch or bench' : 'Not in squad'}
                  >
                    {rp.jerseyNo && <span className="rugby-subs-no">{rp.jerseyNo}</span>}
                    <span className="rugby-subs-name">{disp(rp.name)}</span>
                  </button>
                  {statsForId === rp.id && renderStatsCard(rp)}
                </div>
              ))}
            </div>
            <div className="rugby-list-resize-handle" onMouseDown={startListResize('rosterListHeight', rosterListRef.current)} title="Drag to resize Roster list" />
          </div>
        );
      })()}

      {/* Drag ghost — a small shadowed box that follows the cursor while
          dragging, since the dragged element itself never actually moves
          (only dims in place); pointer-events:none keeps it out of the way
          of elementFromPoint's own drop-target hit-testing. Rendered via a
          portal straight onto <body> — the canvas view is itself scaled
          with a CSS transform (see Canvas.tsx), and position:fixed inside a
          transformed ancestor is scoped to THAT ancestor instead of the
          real viewport, which is why the ghost wasn't visibly tracking the
          cursor at all before. */}
      {draggingRosterId && dragGhostPos && (() => {
        const dp = rosterPlayers.find(p => p.id === draggingRosterId);
        if (!dp) return null;
        return createPortal(
          <div className="rugby-drag-ghost" style={{ left: dragGhostPos.x, top: dragGhostPos.y }}>
            {dp.jerseyNo && <span className="rugby-subs-no">{dp.jerseyNo}</span>}
            <span className="rugby-subs-name">{disp(dp.name)}</span>
          </div>,
          document.body
        );
      })()}

      {/* Confirm bench -> pitch — this is a real substitution, not routine
          team-sheet building, so it's confirmed before it happens. */}
      {pendingBenchToPitch && (() => {
        const incoming = rosterPlayers.find(p => p.id === pendingBenchToPitch.playerId);
        const incomingName = incoming ? disp(incoming.name) : 'this player';
        const outgoingOverride = subOverrides[pendingBenchToPitch.slotNum];
        const outgoingName = outgoingOverride ? disp(outgoingOverride.name) : null;
        return (
          <ConfirmModal
            title="Bring on substitute?"
            message={outgoingName ? `Bring on ${incomingName} for ${outgoingName}?` : `Bring on ${incomingName}?`}
            confirmLabel="Bring On"
            onConfirm={() => {
              assignPlayerToSlot(pendingBenchToPitch.playerId, 'starter', pendingBenchToPitch.slotIdx);
              setPendingBenchToPitch(null);
            }}
            onCancel={() => setPendingBenchToPitch(null)}
          />
        );
      })()}
    </div>
  );
}
