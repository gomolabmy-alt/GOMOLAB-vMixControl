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
};

export type SyncCommentatorFullState = {
  type: 'COMMENTATOR_FULL_STATE';
  canvas: { pages: any[]; activePageId: string };
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

export type SyncMessage = SyncAction | SyncFullState | SyncCommentatorFullState | SyncRequestState | SyncVmixStatus | SyncClientList | SyncVmixData | SyncVmixCommand;

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
