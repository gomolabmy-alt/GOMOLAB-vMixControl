const SYNC_PORT = 9877;
const READONLY_PORT = 9878;
export const COMMENTATOR_PORT = 9879;

export type SyncAction = {
  type: 'ACTION';
  store: 'canvas' | 'tournament';
  fn: string;
  args: any[];
};

export type SyncFullState = {
  type: 'FULL_STATE';
  canvas?: { pages: any[]; activePageId: string };
  tournament?: { tournaments: any[]; activeTournamentId: string };
  // Team database / schedule / results — remote clients previously never
  // received these at all (only canvas + tournament were included), so the
  // Tournament Database window showed empty/stale local data over a remote
  // IP connection instead of the host's actual data.
  teamDb?: { teams: any[] };
  matchSchedule?: { matches: any[] };
  matchResults?: { results: any[] };
  rundown?: { segments: any[] };
};

export type SyncCommentatorFullState = {
  type: 'COMMENTATOR_FULL_STATE';
  canvas: { pages: any[]; activePageId: string };
};

// Sent by a remote client (port 9877) pressing "Save to Host" to explicitly
// push its locally-edited Team DB / Schedule / Results / Tournament data —
// unlike FULL_STATE (host → everyone), this only takes effect on the host,
// which then adopts it and re-broadcasts via its own next FULL_STATE heartbeat.
export type SyncPushTournamentData = {
  type: 'PUSH_TOURNAMENT_DATA';
  teamDb: { teams: any[] };
  matchSchedule: { matches: any[] };
  matchResults: { results: any[] };
  rundown?: { segments: any[] };
  tournament: { tournaments: any[]; activeTournamentId: string };
};

export type SyncRequestState = { type: 'REQUEST_STATE' };

export interface RemoteVmixConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error: string | null;
  edition?: string;
  version?: string;
  inputCount?: number;
}

export type SyncVmixStatus = {
  type: 'VMIX_STATUS';
  connections: RemoteVmixConnection[];
};

export interface BrowserClient {
  ip: string;
  kind: 'readonly' | 'commentator';
}

export type SyncClientList = {
  type: 'CLIENT_LIST';
  clients: BrowserClient[];
};

export type SyncVmixData = {
  type: 'VMIX_STATE';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any | null;
};

export type SyncVmixCommand = {
  type: 'VMIX_COMMAND';
  cmd: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
};

// ── Companion (Stream Deck) bridge ──────────────────────────────────────────
// A Companion module connects as a plain read-only (or commentator) sync
// client — no new port, no auth beyond what those already don't have. It can
// ask for the current list of triggerable buttons and trigger one by its
// stable id, reusing the exact same runButtonPress/runButtonRelease path a
// real OS hotkey uses (see src/lib/companionBridge.ts) — a Stream Deck button
// behaves identically to clicking the button in the app, including
// toggle-mode buttons. Every Button widget (and side button) in the app is
// listed regardless of whether it also has a keyboard shortcut assigned.
export interface CompanionBindingInfo {
  /** Stable id for this trigger target — see CompanionButtonTarget in
   *  hotkeyBindings.ts (a widget id, `${widgetId}:side:${id}`, or
   *  `${widgetId}:hotkey:${id}`). */
  id: string;
  /** Human-friendly label for Companion's own action/feedback pickers. */
  label: string;
  mode?: string;
  /** The keyboard shortcut assigned to this target, if any — informational
   *  only; not required to trigger it from Companion. */
  accelerator?: string;
}
// A Scoreboard widget's score buttons (Try/Conversion/etc, for either team)
// are also Companion trigger targets, one per team+increment — see
// CompanionScoreTarget in companionScoreTargets.ts. Unlike a plain button,
// triggering one can optionally carry a scorer's jersey number, mirroring
// the app's own on-screen "quick scorer picker" that appears when you press
// a score button with a roster loaded.
export interface CompanionScorerChoice {
  jerseyNo: string;
  name: string;
}
export interface CompanionScoreTargetInfo {
  id: string;
  label: string;
  /** Carried alongside `id` so the module can regroup targets by board+type
   *  or by board+team without parsing `id`'s internal format itself — used
   *  by the "arm score type, then press any player" flow (see the
   *  module's `Arm score type`/`Score armed type` actions). */
  widgetId: string;
  /** The Scoreboard widget's own label (or "Board N") — for labeling a
   *  score type by which board it belongs to, not which team, since a type
   *  like "Try" isn't owned by either team. */
  widgetLabel: string;
  team: 'A' | 'B';
  teamName: string;
  scoreLabel: string;
  /** The linked team's current roster, for a jersey-number dropdown —
   *  empty if no Player List widget is linked/auto-paired to this
   *  Scoreboard, in which case scoring still works, just with no scorer. */
  scorers: CompanionScorerChoice[];
  /** Every starter/sub slot of that same linked Player List, in position
   *  order (including empty ones) — lets Companion target a *position*
   *  rather than a specific player, so whoever currently holds that slot
   *  scores, automatically following any substitution. */
  slots: CompanionScoreSlotInfo[];
}
export interface CompanionScoreSlotInfo {
  section: 'starter' | 'sub';
  index: number;
  /** Empty when the slot currently has no player assigned. */
  jerseyNo: string;
  name: string;
}
// Any widget with its own "pick a player to show" UI (a team-side toggle +
// player dropdown, or a fixed-team player dropdown — Player Stats, Head to
// Head, ...) gets the same two-step Companion flow: team (skipped when the
// slot's team is already fixed), then jersey number — see
// CompanionPlayerSelectorTarget in companionPlayerSelectors.ts.
export interface CompanionPlayerChoiceInfo {
  playerId: string;
  jerseyNo: string;
  name: string;
  side?: 'A' | 'B';
}
export interface CompanionPlayerSelectorTargetInfo {
  id: string;
  label: string;
  needsTeamPick: boolean;
  choices: CompanionPlayerChoiceInfo[];
}
// Player List's slot/card/highlight actions — the write side of the
// Player List / Player Lower Third read-only appText fields — see
// companionPlayerListActions.ts.
export interface CompanionRosterChoiceInfo {
  playerId: string;
  jerseyNo: string;
  name: string;
}
export interface CompanionSlotTargetInfo {
  id: string;
  label: string;
  roster: CompanionRosterChoiceInfo[];
}
export interface CompanionCardTargetInfo {
  id: string;
  label: string;
  roster: CompanionRosterChoiceInfo[];
}
export interface CompanionHighlightTargetInfo {
  id: string;
  label: string;
  roster: CompanionRosterChoiceInfo[];
}
export type SyncCompanionList = {
  type: 'COMPANION_LIST';
  bindings: CompanionBindingInfo[];
  scoreTargets: CompanionScoreTargetInfo[];
  playerSelectors: CompanionPlayerSelectorTargetInfo[];
  slotTargets: CompanionSlotTargetInfo[];
  cardTargets: CompanionCardTargetInfo[];
  highlightTargets: CompanionHighlightTargetInfo[];
};
export type SyncCompanionRequestList = { type: 'COMPANION_REQUEST_LIST' };
export type SyncCompanionTrigger = {
  type: 'COMPANION_TRIGGER';
  id: string;
  state: 'press' | 'release';
  /** Only meaningful when id refers to a score target: the jersey number of
   *  whoever scored. Omitted/blank scores with no scorer recorded — exactly
   *  like clicking "Skip" in the app's own scorer picker. */
  jerseyNo?: string;
  /** Only meaningful when id refers to a player-selector, slot, card, or
   *  highlight target: the SavedTeam player id involved. Empty string for a
   *  slot target means "clear this slot". */
  playerId?: string;
  /** Only meaningful when id refers to a card target: which card to give. */
  cardType?: 'yellow' | 'orange' | 'red';
};
export interface CompanionLastScorer {
  scorer: string;
  jerseyNo: string;
  action: string;
}
export interface CompanionScoreboardInfo {
  widgetId: string;
  teamAName: string;
  teamBName: string;
  scoreA: number;
  scoreB: number;
  lastA?: CompanionLastScorer;
  lastB?: CompanionLastScorer;
  /** Raw stored logo URL, LAN-reachable (same one vMix itself fetches) —
   *  empty string if no logo is set for that team. */
  teamALogo: string;
  teamBLogo: string;
}
export interface CompanionAppTextFieldInfo {
  widgetId: string;
  widgetType: string;
  typeIndex: number;
  widgetLabel: string;
  fieldName: string;
  value: string;
}
export interface CompanionNextFixture {
  teamAName: string;
  teamBName: string;
  date: string;
  time: string;
  venue: string;
  round: string;
  competition: string;
}
export interface CompanionMatchInfo {
  tournamentName: string;
  venue: string;
  nextFixture?: CompanionNextFixture;
}
export interface CompanionTimerStageInfo {
  widgetId: string;
  widgetLabel: string;
  periods: number;
  currentPeriod: number;
  inBreak: boolean;
  inExtraTime: boolean;
  etCurrentPeriod: number;
  etPeriods: number;
  etInBreak: boolean;
  inAfterEt: boolean;
  inFinalPlay: boolean;
  running: boolean;
}
export type SyncCompanionFeedback = {
  type: 'COMPANION_FEEDBACK';
  recording: boolean;
  streaming: boolean;
  fadeToBlack: boolean;
  /** target id -> current on/off state, for toggle-mode targets only. */
  toggles: Record<string, boolean>;
  /** Live score + last-scorer info per Scoreboard widget — feeds Companion
   *  Variables so a Stream Deck button's text can show who scored without
   *  Companion needing to poll for it. */
  scoreboards: CompanionScoreboardInfo[];
  /** What the controller app itself is currently displaying — Timer
   *  time/period/status, Label text, File Path, etc (see
   *  companionAppText.ts) — NOT vMix's own input state. Also feeds
   *  Companion Variables + a "Show app display text" feedback. */
  appText: CompanionAppTextFieldInfo[];
  /** General match-context data from the database, not tied to any one
   *  widget — current tournament/venue scope and the next unsent fixture
   *  (see companionMatchInfo.ts). Feeds its own group of Variables. */
  matchInfo: CompanionMatchInfo;
  /** Per-Timer-widget stage state (which period, or Extra Time/After ET/
   *  Final Play) — feeds a "Timer stage active" feedback. */
  timerStages: CompanionTimerStageInfo[];
};

export type SyncMessage = SyncAction | SyncFullState | SyncCommentatorFullState | SyncRequestState | SyncVmixStatus | SyncClientList | SyncVmixData | SyncVmixCommand | SyncPushTournamentData | SyncCompanionList | SyncCompanionRequestList | SyncCompanionTrigger | SyncCompanionFeedback;

type MessageListener = (msg: SyncMessage) => void;
type StatusListener = (status: 'connecting' | 'connected' | 'disconnected') => void;

class SyncClient {
  private ws: WebSocket | null = null;
  private listeners: MessageListener[] = [];
  private statusListeners: StatusListener[] = [];
  private _applying = false;
  private _url = '';
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _getFullState: (() => SyncFullState) | null = null;
  private _status: 'connecting' | 'connected' | 'disconnected' = 'disconnected';

  get status() { return this._status; }

  private _setStatus(s: 'connecting' | 'connected' | 'disconnected') {
    if (this._status === s) return;
    this._status = s;
    for (const l of this.statusListeners) l(s);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.push(listener);
    return () => { this.statusListeners = this.statusListeners.filter(l => l !== listener); };
  }

  get isReadOnly(): boolean {
    return parseInt(window.location.port || '80', 10) === READONLY_PORT;
  }

  get isCommentator(): boolean {
    return parseInt(window.location.port || '80', 10) === COMMENTATOR_PORT;
  }

  /** True when this instance is the sync host (Tauri desktop app) */
  get isHost(): boolean {
    return this._getFullState !== null;
  }

  connect(getFullState?: () => SyncFullState) {
    this._getFullState = getFullState ?? null;
    const host = window.location.hostname || 'localhost';
    const pagePort = parseInt(window.location.port || '80', 10);
    const wsPort = pagePort === READONLY_PORT ? READONLY_PORT
                 : pagePort === COMMENTATOR_PORT ? COMMENTATOR_PORT
                 : SYNC_PORT;
    this._url = `ws://${host}:${wsPort}`;
    this._open();
  }

  private _open() {
    this._setStatus('connecting');
    try {
      this.ws = new WebSocket(this._url);

      this.ws.onopen = () => {
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this._setStatus('connected');
        if (this._getFullState) {
          // Host: push our full state so server can cache it for new joiners
          this._sendRaw(JSON.stringify(this._getFullState()));
        } else {
          // Remote client: ask host for current state
          this._sendRaw(JSON.stringify({ type: 'REQUEST_STATE' } satisfies SyncRequestState));
        }
      };

      this.ws.onmessage = (e) => {
        try {
          const msg: SyncMessage = JSON.parse(e.data);
          this._applying = true;
          for (const l of this.listeners) l(msg);
          this._applying = false;
        } catch { /* ignore malformed */ }
      };

      this.ws.onclose = () => {
        this._setStatus('disconnected');
        this._reconnectTimer = setTimeout(() => this._open(), 2000);
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this._setStatus('disconnected');
      this._reconnectTimer = setTimeout(() => this._open(), 2000);
    }
  }

  private _sendRaw(json: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(json);
  }

  /** Send an action — no-op while applying a received message (prevents echo loops) */
  send(msg: SyncMessage) {
    if (this._applying) return;
    this._sendRaw(JSON.stringify(msg));
  }

  /** Send full state unconditionally — used to respond to REQUEST_STATE */
  sendFullState() {
    if (this._getFullState) this._sendRaw(JSON.stringify(this._getFullState()));
  }

  /** Register a handler; returns an unsubscribe function */
  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  /** True while dispatching a received message */
  get applying() { return this._applying; }
}

export const syncClient = new SyncClient();
