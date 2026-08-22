import { useState, useMemo, useCallback, useEffect, useRef, useContext } from 'react';
import {
  Award, Star, ArrowDown, ArrowUp, X, Plus, UserCheck, Users, Briefcase,
  Play, ArrowLeftRight, ArrowUpRight, Send, RotateCcw, Shirt,
} from 'lucide-react';
import { useCanvasStore, formatTime } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useTeamDbStore, type SavedTeam, type JerseySet } from '../../stores/teamDbStore';
import { useMatchScheduleStore } from '../../stores/matchScheduleStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useUndoStore } from '../../stores/undoStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { SPORT_DEFAULTS, DEFAULT_STAFF_ROLES } from '../../types/tournament';
import type { Player, StaffMember, Tournament } from '../../types/tournament';
import type { CanvasPage } from '../../types/canvas';
import { findTeamRecord, resolveNextFixtureTeams } from '../../lib/teamForm';
import { autoLinkedWidget, autoLinkedWidgetPair } from '../../lib/autoLink';
import { isDualPlayerList } from '../../lib/playerListSquad';
import { effectiveJerseyNo } from '../../lib/jerseySets';
import { simplifyPlayerName } from '../../lib/simpleName';
import { ConfirmModal } from '../ConfirmModal';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  /** Renders as the "Next Match" variant — always side-by-side, teams
   *  resolved from the soonest not-yet-sent fixture instead of a linked
   *  scoreboard/direct team pick. Set by the 'player-list-next' widget type
   *  (see components/widgets/index.tsx). */
  nextMatchMode?: boolean;
}

function wallClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}


// ── Outer component: resolves team(s) + layout, delegates rendering ────────
// Single/direct-team-link and single/scoreboard-follow both render one
// PlayerListTeamPanel with an empty key prefix — identical config field
// names to before this widget supported more than one team, so an existing
// widget on canvas keeps working with zero migration. Side-by-side and
// Next Match render two panels with 'a_'/'b_'-prefixed field names instead,
// so each side's squad/session/vMix-target state stays fully independent.
export function PlayerListWidget({ widgetId, config: cfg, nextMatchMode }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const { pages, addTimelineEvent } = store;
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { tournaments } = useTournamentStore();
  const { teams: teamDbTeams } = useTeamDbStore();
  const { matches } = useMatchScheduleStore();

  const pageTournamentId = pages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const effTournamentId: string | undefined = cfg.linkedTournamentId || pageTournamentId;
  const tournament = tournaments.find(t => t.id === effTournamentId) ?? null;

  // Auto-linking only kicks in for a genuinely untouched widget — if
  // linkedTeamId is already set, that's a deliberate "pick a team directly"
  // choice (linkedScoreboardId being empty is meaningful there, not just
  // unconfigured), so it's never overridden by auto-detecting a scoreboard.
  const linkedScoreboard = cfg.linkedTeamId && !cfg.linkedScoreboardId
    ? undefined
    : autoLinkedWidget(pages, widgetId, cfg.linkedScoreboardId, 'scoreboard');
  const dc = linkedScoreboard?.config;

  let teamA: SavedTeam | undefined;
  let teamB: SavedTeam | undefined;
  let dual = false;
  // Identifies WHICH fixture teamA/teamB came from, independent of team
  // identity — needed because a round-robin team can face the "next" slot
  // again later, and by keyPrefix + this id (not just team id) the auto
  // Next Match -> Live promotion below can tell that rematch apart from
  // the fixture it already promoted.
  let nextFixtureId: string | undefined;

  if (nextMatchMode) {
    dual = true;
    const next = resolveNextFixtureTeams(matches, teamDbTeams, {
      tournamentId: effTournamentId, venue: cfg.filterVenue, category: cfg.filterCategory,
    });
    teamA = next?.teamA;
    teamB = next?.teamB;
    nextFixtureId = next?.match.id;
  } else if (cfg.layout === 'side-by-side' && dc) {
    dual = true;
    // Id first, name as a fallback for a scoreboard that was never linked to
    // a real Team DB entry (manual/typed team, or data from before teamAId/
    // teamBId existed) — a scoreboard can end up with the id set but its own
    // name fields blank (e.g. loaded from a fixture whose own name field
    // was empty), which a name-only lookup can never recover from.
    teamA = (dc.teamAId && teamDbTeams.find(t => t.id === dc.teamAId)) || findTeamRecord(teamDbTeams, dc.teamAName ?? '', dc.category, dc.linkedTournamentId);
    teamB = (dc.teamBId && teamDbTeams.find(t => t.id === dc.teamBId)) || findTeamRecord(teamDbTeams, dc.teamBName ?? '', dc.category, dc.linkedTournamentId);
  } else if (dc) {
    const side: 'A' | 'B' = cfg.teamSide ?? 'A';
    const name = side === 'A' ? dc.teamAName : dc.teamBName;
    const id = side === 'A' ? dc.teamAId : dc.teamBId;
    teamA = (id && teamDbTeams.find(t => t.id === id)) || findTeamRecord(teamDbTeams, name ?? '', dc.category, dc.linkedTournamentId);
  } else {
    teamA = teamDbTeams.find(t => t.id === cfg.linkedTeamId);
  }

  // Caches the resolved team id(s) back onto this widget's own config — the
  // one thing every OTHER widget that reads a linked Player List's roster
  // (Scoreboard's scorer picker, Card Display, Timeline highlight, etc.)
  // can rely on regardless of HOW this widget resolved its team this time
  // (direct pick, following a scoreboard, or the next unsent fixture) —
  // those consumers have no way to replicate that resolution themselves.
  // Same keyPrefix convention as every other per-side field: unprefixed for
  // single mode, a_/b_ for side-by-side or Next Match.
  const resolvedAId = teamA?.id ?? '';
  const resolvedBId = dual ? (teamB?.id ?? '') : '';
  useEffect(() => {
    const fieldA = dual ? 'a_resolvedTeamId' : 'resolvedTeamId';
    const patch: Record<string, any> = {};
    if ((cfg[fieldA] ?? '') !== resolvedAId) patch[fieldA] = resolvedAId;
    if (dual && (cfg.b_resolvedTeamId ?? '') !== resolvedBId) patch.b_resolvedTeamId = resolvedBId;
    if (Object.keys(patch).length > 0) updateWidgetConfig(widgetId, patch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dual, resolvedAId, resolvedBId, cfg.resolvedTeamId, cfg.a_resolvedTeamId, cfg.b_resolvedTeamId, widgetId]);

  const panelShared = { widgetId, cfg, updateWidgetConfig, addTimelineEvent, pages, tournament, nextMatchMode, nextFixtureId };

  if (dual) {
    return (
      <div className="wgt-players-dual">
        <PlayerListTeamPanel {...panelShared} keyPrefix="a_" side="A" team={teamA} />
        <PlayerListTeamPanel {...panelShared} keyPrefix="b_" side="B" team={teamB} />
      </div>
    );
  }
  return <PlayerListTeamPanel {...panelShared} keyPrefix="" side={cfg.teamSide ?? 'A'} team={teamA} />;
}

// ── One team's full squad panel — everything this widget used to be ────────
interface PanelProps {
  widgetId: string;
  cfg: Record<string, any>;
  keyPrefix: string;
  side: 'A' | 'B';
  team: SavedTeam | undefined;
  updateWidgetConfig: (id: string, patch: Record<string, any>) => void;
  addTimelineEvent: (id: string, event: any) => void;
  pages: CanvasPage[];
  tournament: Tournament | null;
  nextMatchMode?: boolean;
  nextFixtureId?: string;
}

function PlayerListTeamPanel({ widgetId, cfg, keyPrefix, side, team, updateWidgetConfig, addTimelineEvent, pages, tournament, nextMatchMode, nextFixtureId }: PanelProps) {
  const { updatePlayer, updateTeam, updateStaffMember, setJerseySetNumber } = useTeamDbStore();
  const { getClient, vmixState, vmixSyncVersion } = useVmixStore();
  // Simple Names (App Settings) — applied to every READ-ONLY name display
  // and vMix push in this widget, never to an editable name input (see
  // src/lib/simpleName.ts for why).
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

  // Every per-side field (squad/session state + this side's own vMix
  // targets) is namespaced by keyPrefix ('' for a single-team widget, 'a_'/
  // 'b_' for side-by-side or Next Match) — k() builds the actual config key,
  // patch() builds an update patch with every one of its keys namespaced the
  // same way, so call sites read exactly like the original single-team code
  // did. Shared display settings (showTime, viewSize, etc.) are read
  // straight off cfg with no prefix — one setting for the whole widget.
  const k = (key: string) => keyPrefix + key;
  const patch = (p: Record<string, any>) => {
    const prefixed: Record<string, any> = {};
    for (const key of Object.keys(p)) prefixed[k(key)] = p[key];
    updateWidgetConfig(widgetId, prefixed);
  };

  const highlightPlayer = (player: Player) => {
    const targetId = linkedPlayerHighlightId;
    if (!targetId) return;
    updateWidgetConfig(targetId, {
      highlightedPlayerId:   player.id,
      highlightedName:       disp(player.name),
      highlightedJersey:     effectiveJerseyNo(player, team, activeJerseySetId),
      highlightedPosition:   player.position,
      highlightedTeam:       team?.name ?? '',
      highlightedTeamColor:  team?.color ?? '',
      highlightedSide:       side,
    });
  };

  // Slot assignment picker
  const [picking, setPicking] = useState<{ section: 'starter' | 'sub'; idx: number } | null>(null);
  // Sub swap: ID of bench player staged to enter
  const [pendingSubIn, setPendingSubIn] = useState<string | null>(null);
  // Card picker: which card type is being assigned
  const [cardPicker, setCardPicker] = useState<'yellow' | 'orange' | 'red' | null>(null);
  // Next Match -> live handoff: which live Player List widget (and its own
  // keyPrefix) this side's starters/subs would be sent to, staged for
  // confirmation before actually overwriting it.
  const [pendingSendLive, setPendingSendLive] = useState<{ liveWidgetId: string; livePrefix: string } | null>(null);

  const players: Player[] = team?.players ?? [];

  // Falls back to the sole Timer/Timeline widget on this page when nothing's
  // been explicitly linked in settings — an explicit pick always wins.
  const timerWidget = autoLinkedWidget(pages, widgetId, cfg.linkedTimerWidgetId, 'timer') ?? null;
  const linkedTimelineId = autoLinkedWidget(pages, widgetId, cfg.linkedTimelineId, 'timeline')?.id;
  const linkedPlayerHighlightId = autoLinkedWidget(pages, widgetId, cfg.linkedPlayerHighlightId, 'player-lower-third')?.id;
  const timerCfg = timerWidget?.config ?? null;
  const currentMs: number = timerCfg?.currentMs ?? 0;
  const timeFormat: string = timerCfg?.format ?? 'mm:ss';
  const timerDown = timerCfg?.mode === 'countdown';

  // Returns ms elapsed since entryMs, regardless of timer direction
  const elapsed = (entryMs: number) =>
    timerDown ? Math.max(0, entryMs - currentMs) : Math.max(0, currentMs - entryMs);

  const settings = tournament ? (tournament.settings ?? SPORT_DEFAULTS[tournament.sport]) : null;
  const maxOnField: number = settings?.maxOnField ?? 11;
  const maxSubs: number = settings?.maxSubs ?? 7;

  // Slot arrays (always padded to exact length with '' for empty slots)
  const starterSlots: string[] = useMemo(() =>
    Array.from({ length: maxOnField }, (_, i) => (cfg[k('starters')] ?? [])[i] ?? ''),
    [cfg[k('starters')], maxOnField]
  );
  const subSlots: string[] = useMemo(() =>
    Array.from({ length: maxSubs }, (_, i) => (cfg[k('subs')] ?? [])[i] ?? ''),
    [cfg[k('subs')], maxSubs]
  );

  const onField: string[] = cfg[k('onField')] ?? [];
  const entries: Record<string, number> = cfg[k('entries')] ?? {};
  const accumulated: Record<string, number> = cfg[k('accumulated')] ?? {};
  const subbedOnPlayers: string[] = cfg[k('subbedOnPlayers')] ?? [];

  const playerById = useMemo(() =>
    Object.fromEntries(players.map(p => [p.id, p])),
    [players]
  );

  const SPECIAL_JERSEY_ROLES: Record<string, string> = {
    MNG: 'Manager',
    HC: 'Head Coach',
  };
  const specialRole = (jerseyNo: string) => SPECIAL_JERSEY_ROLES[jerseyNo.toUpperCase()] ?? null;

  // ── Active jersey set (multi-kit numbering) ───────────────────────────
  // A team with 2+ named sets (e.g. Home/Away — see teamDbStore.ts) needs
  // the operator to pick which one is active for this match; a lone set
  // has nothing to choose between so it just applies silently, and no
  // sets at all leaves effectiveJerseyNo() a no-op passthrough to each
  // player's own base jerseyNo — exactly today's behavior.
  const teamJerseySets: JerseySet[] = team?.jerseySets ?? [];
  const jerseySetChoices: Record<string, string> = cfg[k('jerseySetChoices')] ?? {};
  const recordedChoiceId = team ? jerseySetChoices[team.id] : undefined;
  const recordedChoiceValid = !!recordedChoiceId && teamJerseySets.some(js => js.id === recordedChoiceId);
  const activeJerseySetId: string | undefined =
    teamJerseySets.length === 1 ? teamJerseySets[0].id
    : recordedChoiceValid ? recordedChoiceId
    : undefined;
  const needsJerseyPrompt = teamJerseySets.length > 1 && !recordedChoiceValid;

  const [jerseyPickerOpen, setJerseyPickerOpen] = useState(false);
  useEffect(() => { setJerseyPickerOpen(false); }, [team?.id]);

  const pickJerseySet = (setId: string) => {
    if (!team) return;
    patch({ jerseySetChoices: { ...jerseySetChoices, [team.id]: setId } });
    setJerseyPickerOpen(false);
  };

  // Commits a jersey-number edit from the widget's own inline input: role
  // markers (MNG/HC) are roster metadata, always written to the player's
  // base field; a real number, while a jersey set is active, is written
  // into that set's override instead of the base field.
  const commitJerseyEdit = (player: Player, raw: string) => {
    if (!team) return;
    const jersey = raw.trim();
    const role = specialRole(jersey);
    if (role) {
      updatePlayer(team.id, player.id, { jerseyNo: jersey, ...(!player.position ? { position: role } : {}) });
    } else if (activeJerseySetId) {
      setJerseySetNumber(team.id, activeJerseySetId, player.id, jersey);
    } else {
      updatePlayer(team.id, player.id, { jerseyNo: jersey });
    }
  };

  // Cumulative-stat columns (same short labels used in the Team Database's
  // Players tab), pulled straight from the player's own record (normally
  // populated via the external roster API, see src/lib/externalRoster.ts).
  // Rendered as a fixed-width column per stat, sharing widths with the one
  // shared header row (renderStatHeader) so every player's numbers line up
  // under their label — same convention as a real stats table, which means
  // every column always shows (0 included) rather than only non-zero ones.
  const STAT_FIELDS: { key: 'tries' | 'conversions' | 'penalties' | 'dropGoals' | 'yellowCards' | 'redCards' | 'appearances'; short: string }[] = [
    { key: 'appearances', short: 'APP' },
    { key: 'tries', short: 'T' }, { key: 'conversions', short: 'C' }, { key: 'penalties', short: 'P' },
    { key: 'dropGoals', short: 'DG' }, { key: 'yellowCards', short: 'YC' }, { key: 'redCards', short: 'RC' },
  ];

  // Standard scoring values per code (rugby league awards fewer points per
  // try/penalty/drop goal than union) — same numbers as the Scoreboard's own
  // increment buttons (see RUGBY_UNION_INCS/RUGBY_LEAGUE_INCS in
  // WidgetConfigPanel.tsx), just applied to a player's cumulative stats
  // instead of a single live score event.
  const playerPoints = (p: Player): number => {
    const isLeague = tournament?.sport === 'rugby_league';
    return (p.tries ?? 0) * (isLeague ? 4 : 5)
      + (p.conversions ?? 0) * 2
      + (p.penalties ?? 0) * (isLeague ? 2 : 3)
      + (p.dropGoals ?? 0) * (isLeague ? 1 : 3);
  };
  // Top try-scorer / top points-scorer badges — computed across the whole
  // roster (not just starters/subs) so they still show on a bench or
  // unassigned player; ties all get the badge rather than picking one
  // arbitrarily. Zero doesn't count as "most" when nobody has scored yet.
  const maxTries = Math.max(0, ...players.map(p => p.tries ?? 0));
  const maxPoints = Math.max(0, ...players.map(playerPoints));
  const isTopTries = (p: Player) => maxTries > 0 && (p.tries ?? 0) === maxTries;
  const isTopPoints = (p: Player) => maxPoints > 0 && playerPoints(p) === maxPoints;
  function renderTopBadges(p: Player) {
    if (!showStats) return null;
    const topTries = isTopTries(p);
    const topPoints = isTopPoints(p);
    if (!topTries && !topPoints) return null;
    return (
      <>
        {topTries && <span className="wgt-pl-top-badge wgt-pl-top-badge--tries" title={`Most tries (${maxTries})`}><Award size={11} strokeWidth={2} /></span>}
        {topPoints && <span className="wgt-pl-top-badge wgt-pl-top-badge--points" title={`Most points (${maxPoints})`}><Award size={11} strokeWidth={2} /></span>}
      </>
    );
  }
  // .wgt-pl-info now has a fixed width per view size (not flex-grow) — a
  // row's own stats always start right after it, at the same offset no
  // matter how many action buttons or badges a given row happens to have
  // (that variability lives entirely after the stats now, absorbed by
  // .wgt-pl-flex-spacer before the time/action cluster). So the header only
  // needs to reproduce what comes BEFORE the stats — real ghost copies of
  // the highlight button, jersey, and info block, using the exact same
  // classes so the widths always match — nothing needs to guess at the
  // variable trailing content anymore. The stat cells themselves must also
  // be wrapped in the same .wgt-pl-stats container a row uses (not placed
  // directly in .wgt-pl-stats-header) — that inner wrapper has its own
  // tighter gap between cells, so without it the header's 7 columns drift
  // further apart from the row's on each successive column.
  function renderStatHeader() {
    return (
      <div className="wgt-pl-stats-header">
        {linkedPlayerHighlightId && (
          <span className="wgt-pl-btn wgt-pl-btn--highlight wgt-pl-btn--highlight-left wgt-pl-ghost" aria-hidden="true" />
        )}
        <span className="wgt-pl-jersey wgt-pl-ghost" aria-hidden="true" />
        <span className="wgt-pl-info wgt-pl-ghost" aria-hidden="true" />
        <span className="wgt-pl-stats">
          {STAT_FIELDS.map(f => (
            <span key={f.key} className={`wgt-pl-stats-cell wgt-pl-stats-cell--head${f.key === 'tries' ? ' wgt-pl-stats-cell--tries' : ''}`} title={f.key}>{f.short}</span>
          ))}
        </span>
      </div>
    );
  }
  function renderStatCells(player: Player) {
    return (
      <span className="wgt-pl-stats">
        {STAT_FIELDS.map(f => (
          <span key={f.key} className={`wgt-pl-stats-cell${f.key === 'tries' ? ' wgt-pl-stats-cell--tries' : ''}`}>{player[f.key] ?? 0}</span>
        ))}
      </span>
    );
  }

  const sortedPlayers = useMemo(() =>
    [...players].sort((a, b) => {
      const n1 = parseInt(effectiveJerseyNo(a, team, activeJerseySetId)) || 999;
      const n2 = parseInt(effectiveJerseyNo(b, team, activeJerseySetId)) || 999;
      return n1 !== n2 ? n1 - n2 : a.name.localeCompare(b.name);
    }),
    [players, team, activeJerseySetId]
  );

  const assignedIds = useMemo(() =>
    new Set([
      ...starterSlots.filter(id => id && playerById[id]),
      ...subSlots.filter(id => id && playerById[id]),
    ]),
    [starterSlots, subSlots, playerById]
  );

  const unassigned = useMemo(() =>
    sortedPlayers.filter(p => !assignedIds.has(p.id)),
    [sortedPlayers, assignedIds]
  );

  const teamColor = team?.color ?? '#3498db';
  const showTime = cfg.showTime !== false && timerCfg !== null;
  // On by default, matching how the sin bin countdown always showed before
  // this toggle existed — only gates the in-widget countdown UI, not
  // sinBinEntries tracking itself, so SinBinLowerThirdWidget/CardDisplayWidget
  // keep working (badges, lower-third countdown) even with this off.
  const showSinBin = cfg.showSinBinTimer !== false;
  const showPos = cfg.showPosition !== false;
  // Off by default — a full stat line on every row is a lot of extra text
  // for a widget that's mostly about live squad/substitution management,
  // so it's opt-in rather than always shown.
  const showStats = cfg.showStats === true;
  const viewSize: 'compact' | 'normal' | 'large' = cfg.viewSize ?? 'normal';

  const highlightWidget = linkedPlayerHighlightId
    ? pages.flatMap(p => p.widgets).find(w => w.id === linkedPlayerHighlightId)
    : null;
  const highlightedPlayerId: string = highlightWidget?.config.highlightedPlayerId ?? '';

  // Resolve all vMix name-sync targets (multi-input or legacy single) — the
  // Name field itself is Simple-Name-aware (see disp() above), driven by
  // the global App Settings toggle, not a per-target option.
  const plVmixTargets: Array<{inputKey:string;vmixNamePrefix?:string;vmixJerseyPrefix?:string;vmixAutoSync?:boolean}> =
    cfg[k('vmixInputs')]?.length
      ? cfg[k('vmixInputs')]
      : cfg[k('vmixInputKey')]
        ? [{ inputKey: cfg[k('vmixInputKey')], vmixNamePrefix: cfg[k('vmixNamePrefix')], vmixJerseyPrefix: cfg[k('vmixJerseyPrefix')], vmixAutoSync: cfg[k('vmixAutoSync')] }]
        : [];

  // vMix name sync: slotIdx is 1-based; overrides let callers pass fresh values before store update propagates
  const syncName = useCallback((slotIdx: number, playerId: string | null, overrides?: { name?: string; jerseyNo?: string }) => {
    const c = getClient();
    for (const t of plVmixTargets) {
      if (!t.inputKey || !t.vmixAutoSync) continue;
      const p = playerId ? playerById[playerId] : null;
      const name     = overrides?.name     ?? p?.name     ?? '';
      const jerseyNo = overrides?.jerseyNo ?? (p ? effectiveJerseyNo(p, team, activeJerseySetId) : '');
      if (t.vmixNamePrefix && c)   c.setTextField(t.inputKey, `${t.vmixNamePrefix}${slotIdx}.Text`, disp(name));
      if (t.vmixJerseyPrefix && c) c.setTextField(t.inputKey, `${t.vmixJerseyPrefix}${slotIdx}.Text`, jerseyNo);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg[k('vmixInputs')], cfg[k('vmixInputKey')], cfg[k('vmixAutoSync')], cfg[k('vmixNamePrefix')], cfg[k('vmixJerseyPrefix')], playerById, getClient, team, activeJerseySetId, simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker]);

  const syncAllNames = useCallback(() => {
    if (!plVmixTargets.length) return;
    const lastUsedIdx = maxOnField + subSlots.length;
    const c = getClient();
    if (!c) return;
    for (const t of plVmixTargets) {
      if (!t.inputKey) continue;
      starterSlots.forEach((id, i) => {
        const p = id ? playerById[id] : null;
        if (t.vmixNamePrefix)   c.setTextField(t.inputKey, `${t.vmixNamePrefix}${i + 1}.Text`,              p ? disp(p.name) : '');
        if (t.vmixJerseyPrefix) c.setTextField(t.inputKey, `${t.vmixJerseyPrefix}${i + 1}.Text`,            p ? effectiveJerseyNo(p, team, activeJerseySetId) : '');
      });
      subSlots.forEach((id, i) => {
        const p = id ? playerById[id] : null;
        if (t.vmixNamePrefix)   c.setTextField(t.inputKey, `${t.vmixNamePrefix}${maxOnField + i + 1}.Text`,   p ? disp(p.name) : '');
        if (t.vmixJerseyPrefix) c.setTextField(t.inputKey, `${t.vmixJerseyPrefix}${maxOnField + i + 1}.Text`, p ? effectiveJerseyNo(p, team, activeJerseySetId) : '');
      });
      // Clear any extra same-prefix fields in the vMix input beyond the last used slot
      const vmixInput = vmixState?.inputs?.find(inp => inp.key === t.inputKey);
      if (vmixInput) {
        const clearExtras = (prefix: string) => {
          if (!prefix) return;
          const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`^${esc}(\\d+)\\.Text$`, 'i');
          for (const field of vmixInput.textFields) {
            const m = field.name.match(re);
            if (m && parseInt(m[1]) > lastUsedIdx) c.setTextField(t.inputKey, field.name, '');
          }
        };
        clearExtras(t.vmixNamePrefix ?? '');
        clearExtras(t.vmixJerseyPrefix ?? '');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg[k('vmixInputs')], cfg[k('vmixInputKey')], cfg[k('vmixNamePrefix')], cfg[k('vmixJerseyPrefix')], starterSlots, subSlots, playerById, maxOnField, getClient, vmixState, team, activeJerseySetId, simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker]);

  // vMix staff names sync (MNG → Manager field, HC → Head Coach field) —
  // same resolution the Staff section's own display already uses (see
  // staffName() below, in the Staff section render): a roster player
  // tagged with the MNG/HC jersey code wins if one exists, else fall back
  // to the dedicated Staff name field (team.staff). This used to only ever
  // check the jersey-coded roster entry, so a Manager/HC typed the normal
  // way — into the Staff section's own name inputs, with no matching
  // jersey-coded player — silently never sent.
  const staffByRole = useCallback((role: string, jerseyCode: string): string => {
    const p = players.find(pl => pl.jerseyNo?.toUpperCase() === jerseyCode);
    if (p?.name) return disp(p.name);
    const stored = team?.staff?.find(s => s.role.toLowerCase() === role.toLowerCase())?.name;
    return stored ? disp(stored) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, team?.staff, simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker]);

  const sendStaffToVmix = useCallback(() => {
    const key = cfg[k('vmixStaffInputKey')];
    if (!key) return;
    const c = getClient();
    if (!c) return;
    const managerName = staffByRole('Manager', 'MNG');
    const hcName = staffByRole('Head Coach', 'HC');
    if (cfg[k('vmixManagerField')]) c.setTextField(key, cfg[k('vmixManagerField')], managerName);
    if (cfg[k('vmixHCField')])      c.setTextField(key, cfg[k('vmixHCField')],      hcName);
    const mergedParts: string[] | undefined = cfg[k('vmixStaffMergedParts')];
    if (cfg[k('vmixStaffMergedPrefix')] && mergedParts?.length) {
      const src: Record<string, string> = { manager: managerName, headCoach: hcName };
      c.setTextField(key, cfg[k('vmixStaffMergedPrefix')], mergedParts.map(p => src[p] ?? '').join(cfg[k('vmixStaffMergedSeparator')] ?? ' '));
    }
  }, [cfg[k('vmixStaffInputKey')], cfg[k('vmixManagerField')], cfg[k('vmixHCField')], cfg[k('vmixStaffMergedPrefix')], cfg[k('vmixStaffMergedParts')], cfg[k('vmixStaffMergedSeparator')], staffByRole, getClient]);

  useEffect(() => {
    if (cfg[k('vmixStaffAutoSync')]) sendStaffToVmix();
  }, [
    players.find(p => p.jerseyNo?.toUpperCase() === 'MNG')?.name,
    players.find(p => p.jerseyNo?.toUpperCase() === 'HC')?.name,
    team?.staff,
    cfg[k('vmixStaffAutoSync')],
    sendStaffToVmix,
    vmixSyncVersion,
  ]);

  // vMix team title sync
  const sendTeamToVmix = useCallback(() => {
    const key = cfg[k('vmixTeamInputKey')];
    if (!key || !team) return;
    const c = getClient();
    if (!c) return;
    if (cfg[k('vmixTeamFieldName')]) c.setTextField(key, cfg[k('vmixTeamFieldName')], team.name ?? '');
    if (cfg[k('vmixTeamFieldShort')]) c.setTextField(key, cfg[k('vmixTeamFieldShort')], team.shortName ?? team.name ?? '');
    const mergedParts: string[] | undefined = cfg[k('vmixTeamMergedParts')];
    if (cfg[k('vmixTeamMergedPrefix')] && mergedParts?.length) {
      const src: Record<string, string> = { name: team.name ?? '', short: team.shortName ?? team.name ?? '' };
      c.setTextField(key, cfg[k('vmixTeamMergedPrefix')], mergedParts.map(p => src[p] ?? '').join(cfg[k('vmixTeamMergedSeparator')] ?? ' '));
    }
  }, [cfg[k('vmixTeamInputKey')], cfg[k('vmixTeamFieldName')], cfg[k('vmixTeamFieldShort')], cfg[k('vmixTeamMergedPrefix')], cfg[k('vmixTeamMergedParts')], cfg[k('vmixTeamMergedSeparator')], team, getClient]);

  useEffect(() => {
    if (cfg[k('vmixTeamAutoSync')]) sendTeamToVmix();
  }, [team?.name, team?.shortName, cfg[k('vmixTeamAutoSync')], sendTeamToVmix, vmixSyncVersion]);

  // Next Match -> live handoff: a Next Match Player List has no scoreboard
  // of its own (it's not tied to one — that's the whole point, it's built
  // ahead of the match going live), so there's nothing to auto-detect a
  // target from except matching team identity. Finds whichever live
  // Scoreboard currently has THIS team loaded (either side — the operator
  // may not load it onto the same A/B side this widget resolved it as),
  // then that scoreboard's own paired Player List for that side — same
  // auto-link pairing every other side-aware widget already resolves
  // through (Card/Sin Bin/Score Lower Third, Timeline, Rugby Lineup).
  const findLiveTarget = useCallback((forTeamName?: string): { liveWidgetId: string; livePrefix: string } | null => {
    const name = forTeamName ?? team?.name;
    if (!name) return null;
    const allWidgets = pages.flatMap(p => p.widgets);
    const scoreboards = allWidgets.filter(w => w.type === 'scoreboard');
    const teamNameLc = name.trim().toLowerCase();
    for (const sb of scoreboards) {
      const dc = sb.config;
      const liveSide: 'A' | 'B' | null =
        (dc.teamAName ?? '').trim().toLowerCase() === teamNameLc ? 'A'
        : (dc.teamBName ?? '').trim().toLowerCase() === teamNameLc ? 'B'
        : null;
      if (!liveSide) continue;
      const { a, b } = autoLinkedWidgetPair(pages, sb.id, dc.linkedPlayerListA, dc.linkedPlayerListB, 'player-list');
      const liveList = liveSide === 'A' ? a : b;
      if (!liveList) continue;
      return { liveWidgetId: liveList.id, livePrefix: isDualPlayerList(liveList) ? `${liveSide.toLowerCase()}_` : '' };
    }
    return null;
  }, [team, pages]);

  const requestSendLive = () => {
    const target = findLiveTarget();
    if (!target) {
      alert(team
        ? `No live scoreboard currently has "${team.name}" loaded (with a linked Player List) — load this match onto a scoreboard first, then send.`
        : 'No team resolved yet for the next match.');
      return;
    }
    setPendingSendLive(target);
  };

  // Only the roster selection itself (starters/subs) — never onField/
  // entries/accumulated/playerCards/sinBinEntries, which are live in-match
  // session state on the target widget; overwriting those on a re-send
  // mid-match would erase real playtime/card data already recorded there.
  const confirmSendLive = () => {
    if (!pendingSendLive) return;
    const { liveWidgetId, livePrefix } = pendingSendLive;
    updateWidgetConfig(liveWidgetId, {
      [`${livePrefix}starters`]: cfg[k('starters')] ?? [],
      [`${livePrefix}subs`]: cfg[k('subs')] ?? [],
    });
    setPendingSendLive(null);
  };

  // ── Auto-promote: Next Match -> Live, no button needed ──────────────
  // The moment this side's prepped fixture is loaded onto a live scoreboard
  // (operator action, e.g. via the schedule picker), silently copy its
  // starters/subs onto that scoreboard's own Player List — same payload
  // confirmSendLive() sends manually, just fired automatically. This also
  // covers a Rugby Lineup "Next Match" widget: it has no squad state of its
  // own, it only ever writes through to whichever player-list-next widget
  // it's linked to (see RugbyLineupWidget.tsx), so promoting it here is
  // enough for both widget types.
  //
  // `team` can't be compared directly at the moment it goes live: loading a
  // match marks it sentAt in the same store update that sets the
  // scoreboard's name fields, so resolveNextFixtureTeams() has already
  // advanced `team` to the fixture after next by the time this effect sees
  // the scoreboard go live. So the last-prepped roster is remembered in a
  // ref, keyed by fixture id (not team id, so a round-robin rematch on the
  // same court is treated as a new promotion, not a repeat).
  const preppedRef = useRef<{ fixtureId: string; teamName: string; starters: string[]; subs: string[] } | null>(null);
  const autoSentRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!nextMatchMode) return;
    if (team && nextFixtureId) {
      const starters: string[] = cfg[k('starters')] ?? [];
      const subs: string[] = cfg[k('subs')] ?? [];
      // Ids must actually belong to THIS team's roster, not just be
      // non-empty strings — the moment resolveNextFixtureTeams() rotates to
      // a new fixture, `team` changes but starters/subs still hold whatever
      // was last written (the PREVIOUS team's player ids, now stale — they
      // just render as blank slots since playerById can't resolve them
      // against the new roster). Without this check, that leftover data
      // gets captured here under the new team's name/fixture id, and the
      // snapshot that actually needs to fire — the outgoing team's real
      // prepped roster — gets silently clobbered before it's ever promoted.
      const rosterIds = new Set(players.map(p => p.id));
      if (starters.some(id => id && rosterIds.has(id)) || subs.some(id => id && rosterIds.has(id))) {
        preppedRef.current = { fixtureId: nextFixtureId, teamName: team.name, starters, subs };
      }
    }
    const snap = preppedRef.current;
    if (!snap) return;
    const target = findLiveTarget(snap.teamName);
    if (!target) return;
    const sentKey = `${snap.fixtureId}:${target.liveWidgetId}:${target.livePrefix}`;
    if (autoSentRef.current.has(sentKey)) return;
    autoSentRef.current.add(sentKey);
    const liveCfg = pages.flatMap(p => p.widgets).find(w => w.id === target.liveWidgetId)?.config ?? {};
    const targetHasSquad =
      (liveCfg[`${target.livePrefix}starters`] ?? []).some((id: string) => !!id) ||
      (liveCfg[`${target.livePrefix}subs`] ?? []).some((id: string) => !!id);
    // Never overwrite a squad the operator already set directly on the live
    // widget — same guardrail confirmSendLive relies on the confirmation
    // modal for, just automatic here since there's no modal to ask.
    if (targetHasSquad) return;
    updateWidgetConfig(target.liveWidgetId, {
      [`${target.livePrefix}starters`]: snap.starters,
      [`${target.livePrefix}subs`]: snap.subs,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextMatchMode, team?.id, nextFixtureId, cfg[k('starters')], cfg[k('subs')], pages]);

  // Auto-send full list whenever slots change and any target has auto-sync on
  // (also re-fires on vmixSyncVersion so a reconnect re-pushes the current
  // roster instead of leaving vMix stale until the next actual slot change).
  const anyAutoSync = plVmixTargets.some(t => t.inputKey && t.vmixAutoSync && (t.vmixNamePrefix || t.vmixJerseyPrefix));
  useEffect(() => {
    if (anyAutoSync) syncAllNames();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starterSlots.join(','), subSlots.join(','), anyAutoSync, vmixSyncVersion]);

  // ── Rugby card tracking ───────────────────────────────────────────
  type RugbyCard = 'yellow' | 'orange' | 'red';
  const playerCards: Record<string, RugbyCard[]> = cfg[k('playerCards')] ?? {};

  // Effective disciplinary status (most severe)
  const effectiveCard = (playerId: string): 'none' | 'yellow' | 'orange' | 'red' => {
    const cards = playerCards[playerId] ?? [];
    const yellows = cards.filter(c => c === 'yellow').length;
    if (cards.includes('red') || yellows >= 2) return 'red';
    if (yellows === 1) return 'yellow';
    if (cards.includes('orange')) return 'orange';
    return 'none';
  };

  const CARD_LABELS: Record<RugbyCard, string> = {
    yellow: 'Yellow card — sin bin (10 min)',
    orange: 'Orange card — HIA (player off for assessment)',
    red: 'Red card — permanent dismissal',
  };

  // Timeline event type for each card
  const CARD_TIMELINE: Record<RugbyCard, 'yellow-card' | 'orange-card' | 'red-card'> = {
    yellow: 'yellow-card',
    orange: 'orange-card',
    red: 'red-card',
  };

  // Sin bin timer tracking: maps playerId → timer currentMs at the moment they were binned
  const sinBinEntries: Record<string, number> = cfg[k('sinBinEntries')] ?? {};
  const sinBinDuration: number = cfg.sinBinDuration ?? 600000; // 10 min default

  // HIA (orange card) tracking: maps playerId → currentMs when they went off for assessment
  const orangeCardEntries: Record<string, number> = cfg[k('orangeCardEntries')] ?? {};

  const getSinBinRemaining = (playerId: string): number => {
    const startMs = sinBinEntries[playerId];
    if (startMs === undefined) return sinBinDuration;
    const timerMode: string = timerCfg?.mode ?? 'countup';
    const elapsed = timerMode === 'countdown' ? startMs - currentMs : currentMs - startMs;
    return Math.max(0, sinBinDuration - elapsed);
  };

  const returnFromSinBin = (playerId: string) => {
    const player = playerById[playerId];
    if (!player) return;
    const nextSinBinEntries = { ...sinBinEntries };
    delete nextSinBinEntries[playerId];
    patch({
      onField: [...onField, playerId],
      entries: { ...entries, [playerId]: currentMs },
      sinBinEntries: nextSinBinEntries,
    });
    if (linkedTimelineId) {
      addTimelineEvent(linkedTimelineId, {
        type: 'substitution', team: side, timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: disp(player.name),
        jerseyNo: effectiveJerseyNo(player, team, activeJerseySetId) || undefined,
      });
    }
  };

  const returnFromHIA = (playerId: string) => {
    const player = playerById[playerId];
    if (!player) return;
    const nextOrangeEntries = { ...orangeCardEntries };
    delete nextOrangeEntries[playerId];
    patch({
      onField: [...onField, playerId],
      entries: { ...entries, [playerId]: currentMs },
      orangeCardEntries: nextOrangeEntries,
    });
    if (linkedTimelineId) {
      addTimelineEvent(linkedTimelineId, {
        type: 'substitution', team: side, timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: disp(player.name),
        jerseyNo: effectiveJerseyNo(player, team, activeJerseySetId) || undefined,
      });
    }
  };

  const giveCard = (playerId: string, type: RugbyCard) => {
    const player = playerById[playerId];
    if (!player) return;

    const existingCards = playerCards[playerId] ?? [];
    const newCards: RugbyCard[] = [...existingCards, type];
    const yellows = newCards.filter(c => c === 'yellow').length;
    const isEffectiveRed = type === 'red' || yellows >= 2;

    const p: Record<string, any> = { playerCards: { ...playerCards, [playerId]: newCards } };

    // All cards remove player from field (yellow=sin bin, orange=HIA off, red=dismissed)
    if (onField.includes(playerId)) {
      const timePlayed = (accumulated[playerId] ?? 0) + elapsed(entries[playerId] ?? currentMs);
      p.onField = onField.filter(id => id !== playerId);
      p.accumulated = { ...accumulated, [playerId]: timePlayed };
    }

    // Record sin bin start time for yellow cards (not 2nd yellow which is a red)
    if (type === 'yellow' && !isEffectiveRed) {
      p.sinBinEntries = { ...sinBinEntries, [playerId]: currentMs };
    } else {
      // Red or 2nd yellow: clear any existing sin bin entry
      const nextSinBinEntries = { ...sinBinEntries };
      delete nextSinBinEntries[playerId];
      p.sinBinEntries = nextSinBinEntries;
    }

    // Record HIA entry for orange cards
    if (type === 'orange') {
      p.orangeCardEntries = { ...orangeCardEntries, [playerId]: currentMs };
    } else {
      const nextOrangeEntries = { ...orangeCardEntries };
      delete nextOrangeEntries[playerId];
      p.orangeCardEntries = nextOrangeEntries;
    }

    patch(p);

    // Local stat counting: unlike tries/kicks (recomputed from this team's
    // saved match history, see localPlayerStats.ts), the app doesn't
    // persist a per-player card record into a saved match result — this is
    // the one live moment a card is unambiguously "given", so it's counted
    // right here instead, directly onto the player's cumulative total.
    // Orange (HIA) has no stat field, so only yellow/red increment anything.
    if (team && team.statsSource === 'local' && (type === 'yellow' || type === 'red')) {
      const statKey = type === 'yellow' ? 'yellowCards' : 'redCards';
      updatePlayer(team.id, playerId, { [statKey]: (player[statKey] ?? 0) + 1 });
    }

    if (linkedTimelineId) {
      addTimelineEvent(linkedTimelineId, {
        type: isEffectiveRed ? 'red-card' : CARD_TIMELINE[type],
        team: side,
        timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: disp(player.name),
        jerseyNo: effectiveJerseyNo(player, team, activeJerseySetId) || undefined,
      });
    }
    setCardPicker(null);
  };

  // Squad players eligible to receive a card (exclude permanently dismissed)
  const cardPickerOptions = useMemo(() =>
    [...starterSlots, ...subSlots]
      .filter((id, i, arr) => id && arr.indexOf(id) === i)
      .map(id => playerById[id])
      .filter((p): p is Player => !!p && effectiveCard(p.id) !== 'red'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [starterSlots, subSlots, playerById, playerCards]
  );

  const getTimePlayed = (playerId: string): number => {
    const acc = accumulated[playerId] ?? 0;
    if (onField.includes(playerId) && entries[playerId] !== undefined) {
      return acc + elapsed(entries[playerId]);
    }
    return acc;
  };

  // ── Squad management ──────────────────────────────────────────────

  const assignToSlot = (playerId: string, section: 'starter' | 'sub', idx: number) => {
    if (section === 'starter') {
      const next = [...starterSlots];
      // If player already in subs, remove from there
      const subIdx = subSlots.indexOf(playerId);
      const nextSubs = [...subSlots];
      if (subIdx >= 0) nextSubs[subIdx] = '';
      next[idx] = playerId;
      patch({ starters: next, subs: nextSubs });
    } else {
      const next = [...subSlots];
      const starterIdx = starterSlots.indexOf(playerId);
      const nextStarters = [...starterSlots];
      if (starterIdx >= 0) nextStarters[starterIdx] = '';
      next[idx] = playerId;
      patch({ starters: nextStarters, subs: next });
    }
    setPicking(null);
  };

  const removeFromSlot = (section: 'starter' | 'sub', idx: number) => {
    if (section === 'starter') {
      const next = [...starterSlots];
      const removed = next[idx];
      next[idx] = '';
      // also remove from onField if active
      patch({
        starters: next,
        onField: onField.filter(id => id !== removed),
      });
    } else {
      const next = [...subSlots];
      const removed = next[idx];
      next[idx] = '';
      patch({
        subs: next,
        onField: onField.filter(id => id !== removed),
      });
    }
  };

  const moveToSection = (playerId: string, to: 'starter' | 'sub') => {
    const nextStarters = [...starterSlots];
    const nextSubs = [...subSlots];
    // Remove from current position
    const si = nextStarters.indexOf(playerId);
    if (si >= 0) nextStarters[si] = '';
    const bi = nextSubs.indexOf(playerId);
    if (bi >= 0) nextSubs[bi] = '';
    // Add to first empty slot in target
    if (to === 'starter') {
      const emptyIdx = nextStarters.indexOf('');
      if (emptyIdx >= 0) nextStarters[emptyIdx] = playerId;
    } else {
      const emptyIdx = nextSubs.indexOf('');
      if (emptyIdx >= 0) nextSubs[emptyIdx] = playerId;
    }
    patch({ starters: nextStarters, subs: nextSubs });
  };

  const addUnassignedToSection = (playerId: string, section: 'starter' | 'sub') => {
    if (section === 'starter') {
      const next = [...starterSlots];
      let idx = next.indexOf('');
      if (idx < 0) idx = next.findIndex(id => id && !playerById[id]); // replace stale slot
      if (idx >= 0) next[idx] = playerId;
      else next.push(playerId);
      patch({ starters: next });
    } else {
      const next = [...subSlots];
      let idx = next.indexOf('');
      if (idx < 0) idx = next.findIndex(id => id && !playerById[id]); // replace stale slot
      if (idx >= 0) next[idx] = playerId;
      else next.push(playerId);
      patch({ subs: next });
    }
  };

  const autoFill = () => {
    const sorted = [...sortedPlayers];
    patch({
      starters: Array.from({ length: maxOnField }, (_, i) => sorted[i]?.id ?? ''),
      subs: Array.from({ length: maxSubs }, (_, i) => sorted[maxOnField + i]?.id ?? ''),
    });
  };

  // ── Substitution swap ─────────────────────────────────────────────

  const executeSwap = (outgoingId: string, incomingId: string) => {
    const outgoing = playerById[outgoingId];
    const incoming = playerById[incomingId];
    if (!outgoing || !incoming) return;

    // Time-tracking: record outgoing player's accumulated time
    const timePlayed = (accumulated[outgoingId] ?? 0) +
      elapsed(entries[outgoingId] ?? currentMs);

    // Swap positions in the starter/sub arrays
    const nextStarters = [...starterSlots];
    const nextSubs = [...subSlots];
    const starterIdx = nextStarters.indexOf(outgoingId);
    const subIdx = nextSubs.indexOf(incomingId);
    if (starterIdx >= 0) nextStarters[starterIdx] = incomingId;
    if (subIdx >= 0) nextSubs[subIdx] = outgoingId;

    patch({
      starters: nextStarters,
      subs: nextSubs,
      onField: [...onField.filter(id => id !== outgoingId), incomingId],
      entries: { ...entries, [incomingId]: currentMs },
      accumulated: { ...accumulated, [outgoingId]: timePlayed },
      subbedOnPlayers: [...new Set([...subbedOnPlayers, incomingId])],
    });

    if (linkedTimelineId) {
      addTimelineEvent(linkedTimelineId, {
        type: 'substitution', team: side, timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: disp(incoming.name),
        playerOff: disp(outgoing.name),
        jerseyNo: effectiveJerseyNo(incoming, team, activeJerseySetId) || undefined,
        jerseyNoOff: effectiveJerseyNo(outgoing, team, activeJerseySetId) || undefined,
      });
    }
    setPendingSubIn(null);
  };

  // ── On-field tracking ─────────────────────────────────────────────

  const toggleOnField = (player: Player) => {
    const active = onField.includes(player.id);
    if (active) {
      const timePlayed = (accumulated[player.id] ?? 0) + elapsed(entries[player.id] ?? currentMs);
      patch({
        onField: onField.filter(id => id !== player.id),
        accumulated: { ...accumulated, [player.id]: timePlayed },
      });
      if (linkedTimelineId) {
        addTimelineEvent(linkedTimelineId, {
          type: 'substitution', team: side, timeMs: Date.now(),
          timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
          playerOff: disp(player.name),
          jerseyNoOff: effectiveJerseyNo(player, team, activeJerseySetId) || undefined,
        });
      }
    } else {
      const fromBench = subSlots.includes(player.id);
      patch({
        onField: [...onField, player.id],
        entries: { ...entries, [player.id]: currentMs },
        ...(fromBench ? { subbedOnPlayers: [...new Set([...subbedOnPlayers, player.id])] } : {}),
      });
      if (linkedTimelineId) {
        addTimelineEvent(linkedTimelineId, {
          type: 'substitution', team: side, timeMs: Date.now(),
          timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
          player: disp(player.name),
          jerseyNo: effectiveJerseyNo(player, team, activeJerseySetId) || undefined,
        });
      }
    }
  };

  const kickoff = () => {
    const ids = starterSlots.filter(id => id && playerById[id]);
    const newEntries = { ...entries };
    ids.forEach(id => { if (!onField.includes(id)) newEntries[id] = currentMs; });
    patch({
      onField: [...new Set([...onField, ...ids])],
      entries: newEntries,
    });
  };

  // Auto-kickoff when linked timer starts (false → true transition)
  const prevTimerRunning = useRef<boolean>(false);
  useEffect(() => {
    const running = timerCfg?.running ?? false;
    if (running && !prevTimerRunning.current) {
      const ids = starterSlots.filter(id => id && playerById[id]);
      const alreadyOnField = onField.filter(id => ids.includes(id)).length;
      if (ids.length > 0 && alreadyOnField === 0) {
        const newEntries = { ...entries };
        ids.forEach(id => { if (!onField.includes(id)) newEntries[id] = currentMs; });
        patch({
          onField: [...new Set([...onField, ...ids])],
          entries: newEntries,
        });
      }
    }
    prevTimerRunning.current = running;
  }, [timerCfg?.running]);

  const resetSession = () => {
    if (!confirm('Reset all playtime data and cards?')) return;
    const before = {
      onField: cfg[k('onField')], entries: cfg[k('entries')], accumulated: cfg[k('accumulated')],
      playerCards: cfg[k('playerCards')], sinBinEntries: cfg[k('sinBinEntries')], orangeCardEntries: cfg[k('orangeCardEntries')],
      subbedOnPlayers: cfg[k('subbedOnPlayers')],
    };
    patch({ onField: [], entries: {}, accumulated: {}, playerCards: {}, sinBinEntries: {}, orangeCardEntries: {}, subbedOnPlayers: [] });
    useUndoStore.getState().pushUndo('Reset playtime & cards', () => updateWidgetConfig(widgetId, before));
  };

  // ── Render helpers ────────────────────────────────────────────────

  const starsOnField = starterSlots.filter(id => id && playerById[id] && onField.includes(id)).length;
  const subsOnField  = subSlots.filter(id => id && playerById[id] && onField.includes(id)).length;
  const totalOnField = starsOnField + subsOnField;

  // Available players for slot picker
  const pickOptions = useMemo(() => {
    if (!picking) return [];
    return sortedPlayers.filter(p => {
      if (picking.section === 'starter') return !starterSlots.includes(p.id);
      return !subSlots.includes(p.id);
    });
  }, [picking, sortedPlayers, starterSlots, subSlots]);

  function renderPlayerRow(
    playerId: string,
    section: 'starter' | 'sub',
    slotIdx: number,
  ) {
    const player = playerById[playerId];
    if (!player) return null;
    const effNo = effectiveJerseyNo(player, team, activeJerseySetId);
    const dispName = disp(player.name);
    const active = onField.includes(player.id);
    const timePlayed = getTimePlayed(player.id);
    const isStarter = section === 'starter';
    const isSwapping = pendingSubIn !== null;
    const subbedOff = !active && (accumulated[player.id] ?? 0) > 0;
    const subbedOn  = !subbedOff && subbedOnPlayers.includes(player.id);
    const card = effectiveCard(player.id);
    const dismissed = card === 'red';

    // Swap-mode roles
    const isPendingIn  = pendingSubIn === player.id;
    const isSwapTarget = isSwapping && active && isStarter;
    const isDimmed     = isSwapping && !isPendingIn && !isSwapTarget;

    let rowClass = 'wgt-pl-row';
    if (active)          rowClass += ' wgt-pl-row--active';
    else if (!isStarter) rowClass += ' wgt-pl-row--bench';
    if (isPendingIn)     rowClass += ' wgt-pl-row--pending-in';
    if (isSwapTarget)    rowClass += ' wgt-pl-row--swap-target';
    if (isDimmed)        rowClass += ' wgt-pl-row--dimmed';
    if (card === 'yellow') rowClass += ' wgt-pl-row--sinbin';
    if (card === 'orange') rowClass += ' wgt-pl-row--hia';
    if (dismissed)         rowClass += ' wgt-pl-row--dismissed';

    const canEdit = !!team;

    return (
      <div key={player.id} className={rowClass}>
        {linkedPlayerHighlightId && (
          <button
            className={`wgt-pl-btn wgt-pl-btn--highlight wgt-pl-btn--highlight-left${highlightedPlayerId === player.id ? ' wgt-pl-btn--highlight--active' : ''}`}
            title="Highlight player"
            onClick={() => highlightPlayer(player)}
          >
            <Star size={11} strokeWidth={2} fill={highlightedPlayerId === player.id ? 'currentColor' : 'none'} />
          </button>
        )}
        {specialRole(player.jerseyNo) ? (
          <span className="wgt-pl-jersey wgt-pl-role-badge" title={specialRole(player.jerseyNo)!}>
            {player.jerseyNo.toUpperCase()}
          </span>
        ) : (
          <input
            key={`j-${player.id}-${activeJerseySetId ?? ''}-${effNo}`}
            className="wgt-pl-jersey wgt-pl-jersey--inp"
            style={{ borderColor: active ? teamColor : undefined, color: active ? teamColor : undefined }}
            defaultValue={effNo}
            placeholder="#"
            maxLength={3}
            onBlur={e => { if (canEdit) commitJerseyEdit(player, e.target.value); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onClick={e => e.stopPropagation()}
          />
        )}

        <div className="wgt-pl-info">
          {showPos && player.position && (
            <span className="wgt-pl-pos">{player.position}</span>
          )}
          <input
            key={`n-${player.id}-${dispName}`}
            className="wgt-pl-name wgt-pl-name--inp"
            defaultValue={dispName}
            placeholder="Name"
            readOnly={!canEdit}
            onBlur={e => {
              const typed = e.target.value.trim();
              const vmixIdx = isStarter ? slotIdx + 1 : maxOnField + slotIdx + 1;
              // Still showing the Simple Name display, untouched — don't
              // overwrite the player's real stored name with the shortened
              // text, just re-sync vMix (which resolves + simplifies the
              // real name itself).
              if (typed === dispName) { syncName(vmixIdx, player.id); return; }
              if (canEdit) updatePlayer(team!.id, player.id, { name: typed });
              syncName(vmixIdx, player.id, { name: typed });
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onClick={e => e.stopPropagation()}
          />
          {renderTopBadges(player)}
        </div>
        {showStats && renderStatCells(player)}

        {(subbedOn || subbedOff) && (
          <span
            className={`wgt-pl-sub-ind wgt-pl-sub-ind--${subbedOn ? 'on' : 'off'}`}
            title={subbedOn ? 'Substituted on' : 'Substituted off'}
          >
            {subbedOn ? <ArrowUp size={9} strokeWidth={2.5} /> : <ArrowDown size={9} strokeWidth={2.5} />}
          </span>
        )}

        {card !== 'none' && (
          <span className={`wgt-pl-card-badge wgt-pl-card-badge--${card}`} title={dismissed ? 'Red card — dismissed' : card === 'orange' ? 'Orange card — HIA' : 'Yellow card — sin bin'}>
            {(playerCards[player.id] ?? []).map((c, i) => (
              <span key={i} className={`wgt-pl-card-pip wgt-pl-card-pip--${c}`} />
            ))}
          </span>
        )}

        {/* Sin bin countdown + return button */}
        {showSinBin && card === 'yellow' && sinBinEntries[player.id] !== undefined && (
          (() => {
            const remaining = getSinBinRemaining(player.id);
            const done = remaining === 0;
            return (
              <div className={`wgt-pl-sinbin${done ? ' wgt-pl-sinbin--done' : ''}`} onClick={e => e.stopPropagation()}>
                <span className="wgt-pl-sinbin-timer">{formatTime(remaining, 'mm:ss')}</span>
                <button
                  className="wgt-pl-sinbin-return"
                  title="Return player to field"
                  onClick={() => returnFromSinBin(player.id)}
                ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Play size={10} strokeWidth={2} /> Return</span></button>
              </div>
            );
          })()
        )}

        {/* HIA return button (orange card) */}
        {card === 'orange' && orangeCardEntries[player.id] !== undefined && (
          <div className="wgt-pl-hia" onClick={e => e.stopPropagation()}>
            <span className="wgt-pl-hia-label">HIA</span>
            <button
              className="wgt-pl-hia-return"
              title="Player cleared — return to field"
              onClick={() => returnFromHIA(player.id)}
            ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Play size={10} strokeWidth={2} /> Return</span></button>
          </div>
        )}

        <span className="wgt-pl-flex-spacer" />

        {showTime && (
          <span className={`wgt-pl-time ${active ? 'wgt-pl-time--live' : ''}`}>
            {formatTime(timePlayed, 'mm:ss')}
          </span>
        )}

        <div className="wgt-pl-actions">
          {/* ── Swap-mode: active starters show the confirm-swap button ── */}
          {isSwapTarget && (
            <button
              className="wgt-pl-btn wgt-pl-btn--swap"
              title={`Swap in ${playerById[pendingSubIn!] ? disp(playerById[pendingSubIn!].name) : 'player'}`}
              onClick={() => executeSwap(player.id, pendingSubIn!)}
            >
              <ArrowLeftRight size={11} strokeWidth={2} />
            </button>
          )}

          {/* ── Normal mode OR bench/off-field players during swap ── */}
          {!isSwapTarget && (
            <>
              {/* Sub in (bench) / Sub out (active non-starter can still toggle off) */}
              {(!isStarter || active) && !isSwapping && (
                <button
                  className={`wgt-pl-btn ${active ? 'wgt-pl-btn--out' : 'wgt-pl-btn--in'}`}
                  title={active ? 'Sub off' : 'Stage for substitution'}
                  onClick={() => toggleOnField(player)}
                >
                  {active ? <ArrowDown size={11} strokeWidth={2} /> : <ArrowUp size={11} strokeWidth={2} />}
                </button>
              )}

              {/* Bench player: ArrowUp stages the swap / X cancels it */}
              {!isStarter && !active && (
                <button
                  className={`wgt-pl-btn ${isPendingIn ? 'wgt-pl-btn--cancel-swap' : 'wgt-pl-btn--in'}`}
                  title={isPendingIn ? 'Cancel substitution' : 'Substitute into game'}
                  onClick={() => {
                    setPicking(null);
                    setPendingSubIn(isPendingIn ? null : player.id);
                  }}
                >
                  {isPendingIn ? <X size={11} strokeWidth={2} /> : <ArrowUp size={11} strokeWidth={2} />}
                </button>
              )}

              {/* Move / Remove — hidden during swap flow */}
              {!isSwapping && (
                <>
                  <button
                    className="wgt-pl-btn wgt-pl-btn--move"
                    title={isStarter ? 'Move to bench' : 'Move to starters'}
                    onClick={() => moveToSection(player.id, isStarter ? 'sub' : 'starter')}
                  >
                    {isStarter ? <ArrowDown size={11} strokeWidth={2} /> : <ArrowUp size={11} strokeWidth={2} />}
                  </button>
                  <button
                    className="wgt-pl-btn wgt-pl-btn--remove"
                    title="Remove from squad"
                    onClick={() => removeFromSlot(section, slotIdx)}
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  function renderEmptySlot(section: 'starter' | 'sub', idx: number) {
    const isOpen = picking?.section === section && picking?.idx === idx;
    return (
      <div key={`empty-${section}-${idx}`} className="wgt-pl-row wgt-pl-row--empty">
        {isOpen ? (
          <div className="wgt-pl-picker">
            {pickOptions.length === 0 ? (
              <span className="wgt-pl-picker-none">No available players</span>
            ) : pickOptions.map(p => (
              <button
                key={p.id}
                className="wgt-pl-picker-opt"
                onClick={() => assignToSlot(p.id, section, idx)}
              >
                <span className="wgt-pl-picker-no">{effectiveJerseyNo(p, team, activeJerseySetId)}</span>
                <span className="wgt-pl-picker-name">{disp(p.name)}</span>
                {p.position && <span className="wgt-pl-picker-pos">{p.position}</span>}
              </button>
            ))}
            <button className="wgt-pl-picker-cancel" onClick={() => setPicking(null)}>Cancel</button>
          </div>
        ) : (
          <>
            <span className="wgt-pl-empty-label">— open slot —</span>
            <button
              className="wgt-pl-btn wgt-pl-btn--assign"
              onClick={() => setPicking({ section, idx })}
            >+</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={`wgt-players${viewSize !== 'normal' ? ` wgt-players--${viewSize}` : ''}`} onClick={() => { picking && setPicking(null); pendingSubIn && setPendingSubIn(null); cardPicker && setCardPicker(null); }}>

      {/* Header */}
      <div className="wgt-pl-header" style={{ '--tc': teamColor } as React.CSSProperties}>
        {team?.logo
          ? <img className="wgt-pl-team-logo" src={team.logo} alt="" />
          : <span className="wgt-pl-team-dot" style={{ background: teamColor }} />
        }
        <span className="wgt-pl-team-name">{team?.name ?? '—'}</span>
        {cfg[k('vmixTeamInputKey')] && (
          <button
            className="wgt-pl-team-vmix-btn"
            title="Send team name to vMix"
            onClick={e => { e.stopPropagation(); sendTeamToVmix(); }}
          ><ArrowUpRight size={11} strokeWidth={2} /></button>
        )}
        {nextMatchMode && team && (
          <button
            className="wgt-pl-team-vmix-btn"
            title={`Send this prepped starters/bench to "${team.name}"'s live Player List, once that match is loaded on a scoreboard`}
            onClick={e => { e.stopPropagation(); requestSendLive(); }}
          ><Send size={11} strokeWidth={2} /></button>
        )}
        {team && teamJerseySets.length > 1 && (
          <button
            className="wgt-pl-team-vmix-btn"
            title={`Jersey set: ${activeJerseySetId ? teamJerseySets.find(js => js.id === activeJerseySetId)?.name : 'not chosen'} — click to change`}
            onClick={e => { e.stopPropagation(); setJerseyPickerOpen(v => !v); }}
          ><Shirt size={11} strokeWidth={2} /></button>
        )}
        <span className="wgt-pl-field-count">
          <span className={`wgt-pl-on-num ${totalOnField >= maxOnField ? 'wgt-pl-on-num--full' : ''}`}>
            {totalOnField}
          </span>
          <span className="wgt-pl-max-num">/{maxOnField}</span>
        </span>
        {team && (
          <div className="wgt-pl-card-btns" onClick={e => e.stopPropagation()}>
            <button
              className={`wgt-pl-card-btn wgt-pl-card-btn--yellow${cardPicker === 'yellow' ? ' wgt-pl-card-btn--active' : ''}`}
              title="Yellow card — sin bin (10 min)"
              onClick={() => setCardPicker(cardPicker === 'yellow' ? null : 'yellow')}
            />
            <button
              className={`wgt-pl-card-btn wgt-pl-card-btn--orange${cardPicker === 'orange' ? ' wgt-pl-card-btn--active' : ''}`}
              title="Orange card — HIA assessment"
              onClick={() => setCardPicker(cardPicker === 'orange' ? null : 'orange')}
            />
            <button
              className={`wgt-pl-card-btn wgt-pl-card-btn--red${cardPicker === 'red' ? ' wgt-pl-card-btn--active' : ''}`}
              title="Red card — permanent dismissal"
              onClick={() => setCardPicker(cardPicker === 'red' ? null : 'red')}
            />
          </div>
        )}
      </div>

      {/* Card picker panel */}
      {cardPicker && (
        <div className="wgt-pl-card-picker" onClick={e => e.stopPropagation()}>
          <div className="wgt-pl-card-picker-hdr">
            <span className={`wgt-pl-card-picker-ico wgt-pl-card-picker-ico--${cardPicker}`} />
            <span className="wgt-pl-card-picker-label">
              {cardPicker ? CARD_LABELS[cardPicker] : ''}
            </span>
            <button className="wgt-pl-card-picker-close" onClick={() => setCardPicker(null)}><X size={12} strokeWidth={2} /></button>
          </div>
          <div className="wgt-pl-card-picker-list">
            {cardPickerOptions.length === 0
              ? <span className="wgt-pl-card-picker-empty">No eligible players</span>
              : cardPickerOptions.map(p => (
                  <button
                    key={p.id}
                    className="wgt-pl-card-picker-opt"
                    onClick={() => giveCard(p.id, cardPicker!)}
                  >
                    <span className="wgt-pl-card-picker-no">{effectiveJerseyNo(p, team, activeJerseySetId) || '—'}</span>
                    <span className="wgt-pl-card-picker-name">{disp(p.name)}</span>
                    {(playerCards[p.id] ?? []).map((c, i) => (
                      <span key={i} className={`wgt-pl-card-pip wgt-pl-card-pip--${c}`} />
                    ))}
                  </button>
                ))
            }
          </div>
        </div>
      )}

      {!team ? (
        <div className="wgt-pl-empty">Link a team in config</div>
      ) : (
        <div className="wgt-pl-body">

          {showStats && renderStatHeader()}

          {/* Jersey set prompt — shown for a genuinely new/unresolved choice
              (needsJerseyPrompt) or when manually reopened via the header
              button (jerseyPickerOpen) */}
          {team && teamJerseySets.length > 1 && (needsJerseyPrompt || jerseyPickerOpen) && (
            <div className="wgt-pl-autofill" onClick={e => e.stopPropagation()}>
              <span className="wgt-pl-autofill-hint">Which jersey set is {team.name} wearing this match?</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {teamJerseySets.map(js => (
                  <button key={js.id} className="wgt-pl-autofill-btn" onClick={() => pickJerseySet(js.id)}>
                    {js.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Auto-fill prompt when both lists are empty */}
          {starterSlots.every(s => !s) && subSlots.every(s => !s) && sortedPlayers.length > 0 && (
            <div className="wgt-pl-autofill">
              <span className="wgt-pl-autofill-hint">Squad not set up yet</span>
              <button className="wgt-pl-autofill-btn" onClick={autoFill}>
                Auto-fill from roster
              </button>
            </div>
          )}

          {/* Starters section */}
          <div className="wgt-pl-section">
            <div className="wgt-pl-section-hdr wgt-pl-section-hdr--starters">
              <span className="wgt-pl-section-icon"><UserCheck size={12} strokeWidth={2} /></span>
              <span className="wgt-pl-section-title">Starting {maxOnField}</span>
              <span className="wgt-pl-section-count">
                {starterSlots.filter(id => id && playerById[id]).length}/{maxOnField}
              </span>
              {/* Kickoff button: only show when starters assigned but not yet on field */}
              {starterSlots.some(id => id && playerById[id]) && starsOnField === 0 && (
                <button className="wgt-pl-kickoff-btn" onClick={kickoff} title="Put all starters on field">
                  Kickoff
                </button>
              )}
            </div>

            <div className="wgt-pl-list" onClick={e => e.stopPropagation()}>
              {starterSlots.map((id, i) =>
                id && playerById[id]
                  ? renderPlayerRow(id, 'starter', i)
                  : renderEmptySlot('starter', i)
              )}
            </div>
          </div>

          {/* Swap banner — shown when a bench player is staged */}
          {pendingSubIn && (
            <div className="wgt-pl-swap-banner" onClick={e => e.stopPropagation()}>
              <span className="wgt-pl-swap-banner-ico"><ArrowLeftRight size={14} strokeWidth={2} /></span>
              <span className="wgt-pl-swap-banner-txt">
                Tap a starter to substitute
                <strong> {playerById[pendingSubIn] ? disp(playerById[pendingSubIn].name) : '—'}</strong>
              </span>
              <button
                className="wgt-pl-swap-banner-cancel"
                onClick={() => setPendingSubIn(null)}
              ><X size={12} strokeWidth={2} /></button>
            </div>
          )}

          {/* Substitutes section */}
          <div className="wgt-pl-section">
            <div className="wgt-pl-section-hdr wgt-pl-section-hdr--subs">
              <span className="wgt-pl-section-icon"><Users size={12} strokeWidth={2} /></span>
              <span className="wgt-pl-section-title">Substitutes</span>
              <span className="wgt-pl-section-count">
                {subSlots.filter(id => id && playerById[id]).length}/{maxSubs}
              </span>
            </div>

            <div className="wgt-pl-list" onClick={e => e.stopPropagation()}>
              {subSlots.map((id, i) =>
                id && playerById[id]
                  ? renderPlayerRow(id, 'sub', i)
                  : renderEmptySlot('sub', i)
              )}
            </div>
          </div>

          {/* Unassigned players */}
          {unassigned.length > 0 && (
            <div className="wgt-pl-section wgt-pl-section--unassigned">
              <div className="wgt-pl-section-hdr wgt-pl-section-hdr--unassigned">
                <span className="wgt-pl-section-title">Not in squad</span>
                <span className="wgt-pl-section-count">{unassigned.length}</span>
              </div>
              <div className="wgt-pl-list" onClick={e => e.stopPropagation()}>
                {unassigned.map(player => {
                  const uAcc = (accumulated[player.id] ?? 0) > 0;
                  const uSubbedOff = !onField.includes(player.id) && uAcc;
                  const uEffNo = effectiveJerseyNo(player, team, activeJerseySetId);
                  const uDispName = disp(player.name);
                  return (
                  <div key={player.id} className="wgt-pl-row wgt-pl-row--unassigned">
                    {specialRole(player.jerseyNo) ? (
                      <span className="wgt-pl-jersey wgt-pl-role-badge" title={specialRole(player.jerseyNo)!}>
                        {player.jerseyNo.toUpperCase()}
                      </span>
                    ) : (
                      <input
                        key={`j-${player.id}-${activeJerseySetId ?? ''}-${uEffNo}`}
                        className="wgt-pl-jersey wgt-pl-jersey--inp"
                        defaultValue={uEffNo}
                        placeholder="#"
                        maxLength={3}
                        onBlur={e => commitJerseyEdit(player, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        onClick={e => e.stopPropagation()}
                      />
                    )}
                    <div className="wgt-pl-info">
                      {showPos && player.position && <span className="wgt-pl-pos">{player.position}</span>}
                      <input
                        key={`n-${player.id}-${uDispName}`}
                        className="wgt-pl-name wgt-pl-name--inp"
                        defaultValue={uDispName}
                        placeholder="Name"
                        onBlur={e => {
                          const typed = e.target.value.trim();
                          if (typed === uDispName) return;
                          updatePlayer(team!.id, player.id, { name: typed });
                        }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        onClick={e => e.stopPropagation()}
                      />
                      {renderTopBadges(player)}
                    </div>
                    {showStats && renderStatCells(player)}
                    {uSubbedOff && (
                      <span className="wgt-pl-sub-ind wgt-pl-sub-ind--off" title="Substituted off"><ArrowDown size={9} strokeWidth={2.5} /></span>
                    )}
                    <span className="wgt-pl-flex-spacer" />
                    <div className="wgt-pl-actions">
                      {!specialRole(player.jerseyNo) && (
                        <>
                          <button
                            className="wgt-pl-btn wgt-pl-btn--assign"
                            title="Add to bench"
                            onClick={() => addUnassignedToSection(player.id, 'sub')}
                          >{viewSize === 'large'
                              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}><Plus size={10} strokeWidth={2} /><ArrowDown size={10} strokeWidth={2} /></span>
                              : '+bench'}</button>
                          <button
                            className="wgt-pl-btn wgt-pl-btn--assign"
                            title="Add to starters"
                            onClick={() => addUnassignedToSection(player.id, 'starter')}
                          >{viewSize === 'large'
                              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}><Plus size={10} strokeWidth={2} /><ArrowUp size={10} strokeWidth={2} /></span>
                              : '+start'}</button>
                        </>
                      )}
                      {!player.jerseyNo && (
                        <>
                          <button
                            className="wgt-pl-btn wgt-pl-btn--role"
                            title="Set as Manager"
                            onClick={() => updatePlayer(team!.id, player.id, { jerseyNo: 'MNG', position: 'Manager' })}
                          >+MNG</button>
                          <button
                            className="wgt-pl-btn wgt-pl-btn--role"
                            title="Set as Head Coach"
                            onClick={() => updatePlayer(team!.id, player.id, { jerseyNo: 'HC', position: 'Head Coach' })}
                          >+HC</button>
                        </>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Staff section */}
          {team && (() => {
            const defaultStaff: StaffMember[] = DEFAULT_STAFF_ROLES.map(role => ({
              id: role.toLowerCase().replace(/\s+/g, '-'), role, name: '',
            }));
            const rawStaff: StaffMember[] = team?.staff?.length ? team.staff : defaultStaff;
            // Only show roles defined in DEFAULT_STAFF_ROLES — filters out stale roles like "Assistant Manager"
            const staffList: StaffMember[] = DEFAULT_STAFF_ROLES.map(role => {
              const existing = rawStaff.find(s => s.role.toLowerCase() === role.toLowerCase());
              return existing ?? { id: role.toLowerCase().replace(/\s+/g, '-'), role, name: '' };
            });
            const initialized = !!team?.staff?.length;

            // Map role → special jersey code so we can auto-fill from player roster
            const ROLE_TO_JERSEY: Record<string, string> = { 'Manager': 'MNG', 'Head Coach': 'HC' };
            const staffName = (role: string, stored: string): string => {
              const code = ROLE_TO_JERSEY[role];
              if (code) {
                const p = players.find(pl => pl.jerseyNo?.toUpperCase() === code);
                if (p?.name) return p.name;
              }
              return stored;
            };

            // Players with no jersey or non-numeric jersey (MNG, HC, etc.)
            const nonJerseyPlayers = players.filter(p => !p.jerseyNo || isNaN(parseInt(p.jerseyNo)));

            const handleStaffBlur = (memberId: string, name: string) => {
              if (!initialized) {
                const full = defaultStaff.map(s => s.id === memberId ? { ...s, name } : s);
                updateTeam(team.id, { staff: full });
              } else {
                updateStaffMember(team.id, memberId, name);
              }
            };

            return (
              <div className="wgt-pl-section wgt-pl-section--staff">
                <div className="wgt-pl-section-hdr wgt-pl-section-hdr--staff">
                  <span className="wgt-pl-section-icon"><Briefcase size={12} strokeWidth={2} /></span>
                  <span className="wgt-pl-section-title">Team Staff</span>
                </div>
                <div className="wgt-pl-list" onClick={e => e.stopPropagation()}>
                  {staffList.map(member => (
                    <div key={member.id} className="wgt-pl-row wgt-pl-row--staff">
                      {linkedPlayerHighlightId && (
                        <button
                          className={`wgt-pl-btn wgt-pl-btn--highlight wgt-pl-btn--highlight-left${highlightedPlayerId === member.id ? ' wgt-pl-btn--highlight--active' : ''}`}
                          title="Highlight staff member"
                          onClick={() => updateWidgetConfig(linkedPlayerHighlightId, {
                            highlightedPlayerId:  member.id,
                            highlightedName:      disp(member.name),
                            highlightedJersey:    '',
                            highlightedPosition:  member.role,
                            highlightedTeam:      team?.name ?? '',
                            highlightedTeamColor: team?.color ?? '',
                            highlightedSide:      side,
                          })}
                        >
                          <Star size={11} strokeWidth={2} fill={highlightedPlayerId === member.id ? 'currentColor' : 'none'} />
                        </button>
                      )}
                      <span className="wgt-pl-staff-role">{member.role}</span>
                      {(() => {
                        const effective = staffName(member.role, member.name);
                        return (
                          <input
                            key={`staff-${member.id}-${effective}`}
                            className="wgt-pl-name wgt-pl-name--inp wgt-pl-staff-name"
                            defaultValue={effective}
                            placeholder="Enter name…"
                            onBlur={e => handleStaffBlur(member.id, e.target.value.trim())}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                            onClick={e => e.stopPropagation()}
                          />
                        );
                      })()}
                      {nonJerseyPlayers.length > 0 && (
                        <select
                          className="wgt-pl-staff-picker"
                          value=""
                          onChange={e => {
                            const name = e.target.value;
                            if (name) handleStaffBlur(member.id, name);
                            e.target.value = '';
                          }}
                          onClick={e => e.stopPropagation()}
                          title="Pick from player list"
                        >
                          <option value="">▾</option>
                          {nonJerseyPlayers.map(p => (
                            <option key={p.id} value={p.name}>{disp(p.name)}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Footer */}
          {(onField.length > 0 || Object.keys(cfg[k('playerCards')] ?? {}).length > 0 || cfg[k('vmixInputKey')] || cfg[k('vmixStaffInputKey')]) && (
            <div className="wgt-pl-footer">
              {(onField.length > 0 || Object.keys(cfg[k('playerCards')] ?? {}).length > 0) && (
                <button className="wgt-pl-reset" onClick={resetSession}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><RotateCcw size={11} strokeWidth={2} /> Reset time &amp; cards</span>
                </button>
              )}
              {cfg[k('vmixInputKey')] && (
                <button className="wgt-pl-reset" onClick={syncAllNames} title="Push all player names to vMix">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Send size={11} strokeWidth={2} /> Sync Names</span>
                </button>
              )}
              {cfg[k('vmixStaffInputKey')] && (
                <button className="wgt-pl-reset" onClick={sendStaffToVmix} title="Push Manager and Head Coach names to vMix">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Send size={11} strokeWidth={2} /> Sync Staff</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {pendingSendLive && (
        <ConfirmModal
          title="Send to live Player List?"
          message={`Replaces "${team?.name ?? 'this team'}"'s current starters and bench on the live Player List with what's prepped here. This can't be undone.`}
          confirmLabel="Send"
          onConfirm={confirmSendLive}
          onCancel={() => setPendingSendLive(null)}
        />
      )}
    </div>
  );
}
