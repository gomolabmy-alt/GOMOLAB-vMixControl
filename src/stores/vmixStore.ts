import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { VmixApiClient } from '../api/vmixApi';
import type { FieldStat } from '../api/vmixApi';
import type {
  VmixState, ConnectionConfig, ConnectionStatus,
  SavedConnection, Shortcut, Scoreboard, VmixTimer,
  DataBinding, GlobalVariable, ScoreboardStyle,
  VmixConnectionEntry, ConnectionLogEntry, ConnectionLogEvent,
} from '../types/vmix';
import { syncClient } from '../lib/syncClient';
import type { RemoteVmixConnection, BrowserClient } from '../lib/syncClient';

// ─── Default data ──────────────────────────────────────────────────────────

const DEFAULT_SHORTCUTS: Shortcut[] = [
  { id: '1', label: 'Cut',  function: 'Cut',         params: {}, mode: 'momentary', color: '#e74c3c' },
  { id: '2', label: 'Fade', function: 'Fade',        params: {}, mode: 'momentary', color: '#3498db' },
  { id: '3', label: 'Auto', function: 'Transition1', params: {}, mode: 'momentary', color: '#9b59b6' },
  { id: '4', label: 'FTB',  function: 'FadeToBlack', params: {}, mode: 'toggle',    color: '#1a1a1a' },
];

const makeScoreboard = (): Scoreboard => ({
  id: crypto.randomUUID(),
  name: 'Scoreboard 1',
  style: 'basic' as ScoreboardStyle,
  teamA: { name: 'Team A', score: 0, color: '#e74c3c' },
  teamB: { name: 'Team B', score: 0, color: '#3498db' },
  vmixInputKey: '',
  fieldTeamA: 'TeamA.Text',
  fieldTeamB: 'TeamB.Text',
  fieldScoreA: 'ScoreA.Text',
  fieldScoreB: 'ScoreB.Text',
});

const makeTimer = (): VmixTimer => ({
  id: crypto.randomUUID(),
  name: 'Timer 1',
  mode: 'countdown',
  format: 'mm:ss',
  durationMs: 5 * 60 * 1000,
  currentMs: 5 * 60 * 1000,
  running: false,
  highPrecision: false,
  vmixInputKey: '',
  fieldName: 'Timer.Text',
});

// ─── Store interface ───────────────────────────────────────────────────────

interface VmixStore {
  // Connection (single vMix instance)
  connection: VmixConnectionEntry | null;
  getClient: () => VmixApiClient | null;

  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  activeConnection: ConnectionConfig | null;
  savedConnections: SavedConnection[];
  client: VmixApiClient | null;

  // vMix state
  vmixState: VmixState | null;
  lastUpdated: number | null;

  // Connection event log
  connectionLog: ConnectionLogEntry[];
  pushConnectionLog: (entry: Omit<ConnectionLogEntry, 'id'>) => void;
  clearConnectionLog: () => void;

  // Force-push all registered field values to vMix
  resyncAll: () => void;
  // Incremented on every reconnect and on manual resyncAll — widgets subscribe
  // to this so their push effects re-fire with current state automatically
  vmixSyncVersion: number;

  // Live per-field delivery status
  vmixFieldStats: FieldStat[];
  refreshFieldStats: () => void;

  // vMix status received from the host (populated on browser clients)
  remoteVmixConnections: RemoteVmixConnection[];

  // Browser clients connected to this host's sync server (populated on host)
  browserClients: BrowserClient[];

  // UI navigation
  activeTab: number;
  selectedInputKey: string | null;

  // T-Bar
  tBarValue: number;

  // Widgets (persisted)
  shortcuts: Shortcut[];
  scoreboards: Scoreboard[];
  timers: VmixTimer[];
  dataBindings: DataBinding[];
  globalVariables: GlobalVariable[];

  // Timer intervals (not persisted)
  timerIntervals: Record<string, ReturnType<typeof setInterval>>;

  // ── Actions ──

  // Connection
  connect: (config: ConnectionConfig) => Promise<void>;
  disconnect: () => void;
  saveConnection: (config: ConnectionConfig, name: string) => void;
  deleteConnection: (id: string) => void;

  // Navigation
  setActiveTab: (tab: number) => void;
  selectInput: (key: string | null) => void;

  // vMix passthrough
  sendFunction: (fn: string, params?: Record<string, string>) => Promise<void>;
  setTextField: (inputKey: string, fieldName: string, value: string) => Promise<void>;
  setPreview: (inputKey: string) => Promise<void>;
  setActive: (inputKey: string) => Promise<void>;
  toggleRecord: () => Promise<void>;
  toggleStream: () => Promise<void>;
  toggleFadeToBlack: () => Promise<void>;
  toggleExternal: () => Promise<void>;
  toggleMultiCorder: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;

  // T-Bar
  setTBar: (value: number) => Promise<void>;

  // Audio
  setMasterVolume: (vol: number) => Promise<void>;
  toggleMasterMute: () => Promise<void>;
  setHeadphones: (vol: number) => Promise<void>;
  setInputVolume: (key: string, vol: number) => Promise<void>;
  muteInput: (key: string) => Promise<void>;
  unmuteInput: (key: string) => Promise<void>;
  soloInput: (key: string) => Promise<void>;
  setBusVolume: (bus: string, vol: number) => Promise<void>;
  muteBus: (bus: string) => Promise<void>;
  setBusRouting: (inputKey: string, bus: string, on: boolean) => Promise<void>;

  // Overlays
  overlayIn: (channel: number, inputKey?: string) => Promise<void>;
  overlayOut: (channel: number) => Promise<void>;

  // Replay
  replayMarkIn: () => Promise<void>;
  replayMarkOut: () => Promise<void>;
  replayPlay: () => Promise<void>;
  replayPause: () => Promise<void>;
  replayNow: () => Promise<void>;
  replayLive: () => Promise<void>;

  // Playlist/DDR
  playInput: (key: string) => Promise<void>;
  pauseInput: (key: string) => Promise<void>;
  stopInput: (key: string) => Promise<void>;

  // Shortcuts
  updateShortcuts: (shortcuts: Shortcut[]) => void;

  // Scoreboards
  addScoreboard: () => void;
  updateScoreboard: (id: string, patch: Partial<Scoreboard>) => void;
  deleteScoreboard: (id: string) => void;
  scoreAction: (id: string, team: 'A' | 'B', delta: number) => Promise<void>;
  resetScore: (id: string) => Promise<void>;

  // Timers
  addTimer: () => void;
  updateTimer: (id: string, patch: Partial<VmixTimer>) => void;
  deleteTimer: (id: string) => void;
  startTimer: (id: string) => void;
  pauseTimer: (id: string) => void;
  resetTimer: (id: string) => void;
  adjustTimer: (id: string, deltaMs: number) => void;

  // Data bindings
  addDataBinding: () => void;
  updateDataBinding: (id: string, patch: Partial<DataBinding>) => void;
  deleteDataBinding: (id: string) => void;
  pollDataBinding: (id: string) => Promise<void>;

  // Global variables
  setVariable: (id: string, value: string) => void;
  addVariable: (name: string) => void;
  deleteVariable: (id: string) => void;
  resolveLabel: (label: string) => string;

  // Project save/load
  restoreVmix: (data: { savedConnections: unknown[]; shortcuts: unknown[]; scoreboards: unknown[]; timers: unknown[]; dataBindings: unknown[]; globalVariables: unknown[] }) => void;
}

// ─── Timer tick helper ─────────────────────────────────────────────────────

function formatTime(ms: number, fmt: string): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (fmt) {
    case 'hh:mm:ss': return `${pad(h)}:${pad(m)}:${pad(s)}`;
    case 'h:mm:ss':  return `${h}:${pad(m)}:${pad(s)}`;
    case 'mm:ss':    return `${pad(m)}:${pad(s)}`;
    case 'ss':       return String(totalSec);
    default:         return `${pad(m)}:${pad(s)}`;
  }
}

// ─── JSON path resolver ────────────────────────────────────────────────────

function resolveJsonPath(obj: unknown, path: string): string {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur == null ? '' : String(cur);
}

// ─── Remote proxy ─────────────────────────────────────────────────────────
// On browser clients vMix is not directly reachable. This proxy intercepts
// calls that widgets make on a VmixApiClient and forwards them as
// VMIX_COMMAND messages to the host via the sync WebSocket, where they are
// executed against the host's single real connection.
class RemoteVmixProxy {
  setTextField(inputKey: string, fieldName: string, value: string) {
    syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setTextField', args: [inputKey, fieldName, value] });
  }
  setImageField(inputKey: string, fieldName: string, filePath: string) {
    syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setImageField', args: [inputKey, fieldName, filePath] });
  }
  sendFunction(fn: string, params: Record<string, string> = {}) {
    syncClient.send({ type: 'VMIX_COMMAND', cmd: 'sendFunction', args: [fn, params] });
  }
  setTBar(value: number) {
    syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setTBar', args: [value] });
  }
  overlayIn(ch: number, key?: string) {
    syncClient.send({ type: 'VMIX_COMMAND', cmd: 'overlayIn', args: [ch, key] });
  }
  overlayOut(ch: number) {
    syncClient.send({ type: 'VMIX_COMMAND', cmd: 'overlayOut', args: [ch] });
  }
}

// ─── Store ─────────────────────────────────────────────────────────────────

export const useVmixStore = create<VmixStore>()(
  persist(
    (set, get) => ({
      // ── Init ──
      connection: null,
      connectionStatus: 'disconnected',
      connectionError: null,
      activeConnection: null,
      savedConnections: [],
      client: null,
      vmixState: null,
      lastUpdated: null,
      connectionLog: [],
      pushConnectionLog: (entry) => set((s) => ({
        connectionLog: [
          { ...entry, id: crypto.randomUUID() },
          ...s.connectionLog,
        ].slice(0, 200),
      })),
      clearConnectionLog: () => set({ connectionLog: [] }),
      remoteVmixConnections: [],
      browserClients: [],
      vmixSyncVersion: 0,
      vmixFieldStats: [],
      refreshFieldStats: () => {
        set({ vmixFieldStats: get().client?.getFieldStats() ?? [] });
      },
      resyncAll: () => {
        get().client?.resync();
        // Push full current state — dynamic import avoids circular dep with canvasStore
        import('../stores/canvasStore').then(({ useCanvasStore }) => {
          useCanvasStore.getState().syncAllToVmix();
        });
        // Increment so widget useEffect hooks re-fire and push any remaining fields
        set(s => ({ vmixSyncVersion: s.vmixSyncVersion + 1 }));
      },
      activeTab: 0,
      selectedInputKey: null,
      tBarValue: 0,
      shortcuts: DEFAULT_SHORTCUTS,
      scoreboards: [makeScoreboard()],
      timers: [makeTimer()],
      dataBindings: [],
      globalVariables: [],
      timerIntervals: {},

      // ── Connection ────────────────────────────────────────────────────────

      connect: async (config) => {
        get().client?.stopPolling();

        const id = get().connection?.id ?? crypto.randomUUID();
        const entry: VmixConnectionEntry = {
          id, name: `${config.host}:${config.port}`,
          host: config.host, port: config.port,
          status: 'connecting', error: null, vmixState: null, lastUpdated: null,
        };
        set({ connection: entry, connectionStatus: 'connecting', connectionError: null });

        const client = new VmixApiClient(config.host, config.port);
        wireClientLogger(client, entry.name);
        let initialState: VmixState | null = null;
        try {
          initialState = await client.fetchState();
        } catch (err) {
          // Don't give up — register the client and start polling anyway.
          // Its HTTP loop retries forever, so once vMix becomes reachable the
          // startPolling() state callback below flips this to 'connected'
          // automatically (same self-healing path as a mid-session drop).
          const detail = err instanceof Error ? err.message : String(err);
          const errEntry = { ...entry, status: 'error' as ConnectionStatus, error: `Cannot reach ${config.host}:${config.port} — ${detail}` };
          set({ connection: errEntry, connectionStatus: 'error', connectionError: errEntry.error! });
          get().pushConnectionLog({ time: Date.now(), connectionName: `${config.host}:${config.port}`, event: 'error', detail });
        }

        if (initialState) {
          // Mark connected immediately using the initial HTTP state — don't wait
          // for the first TCP push (which may never arrive if TCP is blocked).
          const connectedEntry = { ...entry, status: 'connected' as ConnectionStatus, error: null, vmixState: initialState, lastUpdated: Date.now() };
          set({
            connection: connectedEntry, client, activeConnection: config,
            connectionStatus: 'connected', connectionError: null,
            vmixState: initialState, lastUpdated: Date.now(),
          });
          get().pushConnectionLog({ time: Date.now(), connectionName: `${config.host}:${config.port}`, event: 'connected' });
        } else {
          set({ client, activeConnection: config });
        }

        client.startPolling(
          (state) => {
            const existing = get().connection;
            const wasConnected = existing?.status === 'connected';
            const connEntry = { ...existing!, vmixState: state, lastUpdated: Date.now(), status: 'connected' as ConnectionStatus, error: null };
            set({
              connection: connEntry,
              vmixState: state, lastUpdated: Date.now(),
              connectionStatus: 'connected' as ConnectionStatus, connectionError: null,
            });
            // On transition from error/connecting to connected, push all registered
            // fields so vMix stays in sync without needing the manual Sync button.
            if (!wasConnected) setTimeout(() => useVmixStore.getState().resyncAll(), 500);
          },
          (error) => {
            const errEntry = { ...get().connection!, status: 'error' as ConnectionStatus, error };
            set({ connection: errEntry, connectionStatus: 'error', connectionError: error });
            get().pushConnectionLog({ time: Date.now(), connectionName: `${config.host}:${config.port}`, event: 'error', detail: error });
            // Do NOT call stopPolling() — let TCP reconnect and HTTP bridge continue
            // automatically so the connection self-heals when vMix comes back.
          },
        );
      },

      getClient: () => {
        const { client, remoteVmixConnections } = get();
        if (!syncClient.isHost) {
          // Remote browser client: vMix isn't directly reachable. Return a
          // proxy if the host's connection is known to be connected (based on
          // VMIX_STATUS broadcasts from the host).
          const rc = remoteVmixConnections.find(c => c.status === 'connected');
          if (!rc) return null;
          return new RemoteVmixProxy() as unknown as VmixApiClient;
        }
        return client;
      },

      disconnect: () => {
        get().client?.stopPolling();
        Object.values(get().timerIntervals).forEach(clearInterval);
        set({
          connection: null,
          client: null, connectionStatus: 'disconnected', connectionError: null,
          activeConnection: null, vmixState: null, selectedInputKey: null,
          timerIntervals: {},
          timers: get().timers.map((t) => ({ ...t, running: false })),
        });
      },

      saveConnection: (config, name) => {
        const existing = get().savedConnections;
        const dup = existing.find((c) => c.host === config.host && c.port === config.port);
        if (dup) {
          set({ savedConnections: existing.map((c) => c.id === dup.id ? { ...c, name, lastConnected: Date.now() } : c) });
          return;
        }
        set({ savedConnections: [{ id: crypto.randomUUID(), name, ...config, lastConnected: Date.now() }, ...existing].slice(0, 10) });
      },

      deleteConnection: (id) => set({ savedConnections: get().savedConnections.filter((c) => c.id !== id) }),

      // ── Navigation ────────────────────────────────────────────────────────

      setActiveTab: (tab) => set({ activeTab: tab }),
      selectInput: (key) => set({ selectedInputKey: key }),

      // ── vMix passthrough ──────────────────────────────────────────────────

      sendFunction: async (fn, params = {}) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'sendFunction', args: [fn, params] }); return; }
        await get().client?.sendFunction(fn, params);
      },
      setTextField: async (k, f, v) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setTextField', args: [k, f, v] }); return; }
        await get().client?.setTextField(k, f, v);
      },
      setPreview: async (k) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setPreview', args: [k] }); return; }
        await get().client?.setPreview(k);
      },
      setActive: async (k) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setActive', args: [k] }); return; }
        await get().client?.setActive(k);
      },
      toggleRecord: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'toggleRecord', args: [] }); return; }
        await get().client?.toggleRecord();
      },
      toggleStream: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'toggleStream', args: [] }); return; }
        await get().client?.toggleStream();
      },
      toggleFadeToBlack: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'toggleFadeToBlack', args: [] }); return; }
        await get().client?.toggleFadeToBlack();
      },
      toggleExternal: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'toggleExternal', args: [] }); return; }
        await get().client?.toggleExternal();
      },
      toggleMultiCorder: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'toggleMultiCorder', args: [] }); return; }
        await get().client?.toggleMultiCorder();
      },
      toggleFullscreen: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'toggleFullscreen', args: [] }); return; }
        await get().client?.toggleFullscreen();
      },

      // ── T-Bar ────────────────────────────────────────────────────────────

      setTBar: async (value) => {
        set({ tBarValue: value });
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setTBar', args: [value] }); return; }
        await get().client?.setTBar(value);
      },

      // ── Audio ─────────────────────────────────────────────────────────────

      setMasterVolume: async (v) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setMasterVolume', args: [v] }); return; }
        await get().client?.setMasterVolume(v);
      },
      toggleMasterMute: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'toggleMasterMute', args: [] }); return; }
        await get().client?.toggleMasterMute();
      },
      setHeadphones: async (v) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setHeadphones', args: [v] }); return; }
        await get().client?.setHeadphones(v);
      },
      setInputVolume: async (k, v) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setInputVolume', args: [k, v] }); return; }
        await get().client?.setInputVolume(k, v);
      },
      muteInput: async (k) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'muteInput', args: [k] }); return; }
        await get().client?.muteInput(k);
      },
      unmuteInput: async (k) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'unmuteInput', args: [k] }); return; }
        await get().client?.unmuteInput(k);
      },
      soloInput: async (k) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'soloInput', args: [k] }); return; }
        await get().client?.soloInput(k);
      },
      setBusVolume: async (bus, v) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'setBusVolume', args: [bus, v] }); return; }
        await get().client?.setBusVolume(bus, v);
      },
      muteBus: async (bus) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'muteBus', args: [bus] }); return; }
        await get().client?.muteBus(bus);
      },
      setBusRouting: async (inputKey, bus, on) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: on ? 'setBusOn' : 'setBusOff', args: [inputKey, bus] }); return; }
        if (on) await get().client?.setBusOn(inputKey, bus);
        else    await get().client?.setBusOff(inputKey, bus);
      },

      // ── Overlays ──────────────────────────────────────────────────────────

      overlayIn: async (ch, key) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'overlayIn', args: [ch, key] }); return; }
        await get().client?.overlayIn(ch, key);
      },
      overlayOut: async (ch) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'overlayOut', args: [ch] }); return; }
        await get().client?.overlayOut(ch);
      },

      // ── Replay ───────────────────────────────────────────────────────────

      replayMarkIn: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'replayMarkIn', args: [] }); return; }
        await get().client?.replayMarkIn();
      },
      replayMarkOut: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'replayMarkOut', args: [] }); return; }
        await get().client?.replayMarkOut();
      },
      replayPlay: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'replayPlay', args: [] }); return; }
        await get().client?.replayPlay();
      },
      replayPause: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'replayPause', args: [] }); return; }
        await get().client?.replayPause();
      },
      replayNow: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'replayNow', args: [] }); return; }
        await get().client?.replayNow();
      },
      replayLive: async () => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'replayLive', args: [] }); return; }
        await get().client?.replayLive();
      },

      // ── Playlist/DDR ─────────────────────────────────────────────────────

      playInput: async (k) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'playInput', args: [k] }); return; }
        await get().client?.playInput(k);
      },
      pauseInput: async (k) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'pauseInput', args: [k] }); return; }
        await get().client?.pauseInput(k);
      },
      stopInput: async (k) => {
        if (!syncClient.isHost) { syncClient.send({ type: 'VMIX_COMMAND', cmd: 'stopInput', args: [k] }); return; }
        await get().client?.stopInput(k);
      },

      // ── Shortcuts ─────────────────────────────────────────────────────────

      updateShortcuts: (shortcuts) => set({ shortcuts }),

      // ── Scoreboards ───────────────────────────────────────────────────────

      addScoreboard: () => set({ scoreboards: [...get().scoreboards, makeScoreboard()] }),

      updateScoreboard: (id, patch) =>
        set({ scoreboards: get().scoreboards.map((s) => s.id === id ? { ...s, ...patch } : s) }),

      deleteScoreboard: (id) => set({ scoreboards: get().scoreboards.filter((s) => s.id !== id) }),

      scoreAction: async (id, team, delta) => {
        const { scoreboards, client } = get();
        const sb = scoreboards.find((s) => s.id === id);
        if (!sb) return;
        const key = team === 'A' ? 'teamA' : 'teamB';
        const field = team === 'A' ? sb.fieldScoreA : sb.fieldScoreB;
        const newScore = Math.max(0, (team === 'A' ? sb.teamA.score : sb.teamB.score) + delta);
        const updated = { ...sb, [key]: { ...(team === 'A' ? sb.teamA : sb.teamB), score: newScore } };
        set({ scoreboards: scoreboards.map((s) => s.id === id ? updated : s) });
        if (client && sb.vmixInputKey && field) {
          await client.setTextField(sb.vmixInputKey, field, String(newScore));
        }
      },

      resetScore: async (id) => {
        const { scoreboards, client } = get();
        const sb = scoreboards.find((s) => s.id === id);
        if (!sb) return;
        const updated = { ...sb, teamA: { ...sb.teamA, score: 0 }, teamB: { ...sb.teamB, score: 0 } };
        set({ scoreboards: scoreboards.map((s) => s.id === id ? updated : s) });
        if (client && sb.vmixInputKey) {
          await Promise.all([
            sb.fieldScoreA && client.setTextField(sb.vmixInputKey, sb.fieldScoreA, '0'),
            sb.fieldScoreB && client.setTextField(sb.vmixInputKey, sb.fieldScoreB, '0'),
          ]);
        }
      },

      // ── Timers ────────────────────────────────────────────────────────────

      addTimer: () => set({ timers: [...get().timers, makeTimer()] }),

      updateTimer: (id, patch) =>
        set({ timers: get().timers.map((t) => t.id === id ? { ...t, ...patch } : t) }),

      deleteTimer: (id) => {
        const { timerIntervals } = get();
        if (timerIntervals[id]) { clearInterval(timerIntervals[id]); }
        const intervals = { ...timerIntervals };
        delete intervals[id];
        set({ timers: get().timers.filter((t) => t.id !== id), timerIntervals: intervals });
      },

      startTimer: (id) => {
        const { timerIntervals } = get();
        if (timerIntervals[id]) return; // already running

        const timer = get().timers.find((t) => t.id === id);
        if (!timer) return;

        const tick = timer.highPrecision ? 100 : 1000;
        const interval = setInterval(() => {
          const { timers, client } = get();
          const t = timers.find((x) => x.id === id);
          if (!t || !t.running) return;

          let next = t.mode === 'countup'
            ? t.currentMs + tick
            : Math.max(0, t.currentMs - tick);

          if (t.mode === 'countdown' && next <= 0) {
            clearInterval(interval);
            const ints = { ...get().timerIntervals };
            delete ints[id];
            set({ timerIntervals: ints, timers: get().timers.map((x) => x.id === id ? { ...x, currentMs: 0, running: false } : x) });
            if (client && t.vmixInputKey && t.fieldName) {
              client.setTextField(t.vmixInputKey, t.fieldName, formatTime(0, t.format));
            }
            return;
          }
          if (t.mode === 'countup' && t.durationMs > 0 && next >= t.durationMs) {
            next = t.durationMs;
          }

          set({ timers: get().timers.map((x) => x.id === id ? { ...x, currentMs: next } : x) });
          if (client && t.vmixInputKey && t.fieldName) {
            client.setTextField(t.vmixInputKey, t.fieldName, formatTime(next, t.format));
          }
        }, tick);

        set({
          timerIntervals: { ...timerIntervals, [id]: interval },
          timers: get().timers.map((t) => t.id === id ? { ...t, running: true } : t),
        });
      },

      pauseTimer: (id) => {
        const { timerIntervals } = get();
        if (timerIntervals[id]) { clearInterval(timerIntervals[id]); }
        const intervals = { ...timerIntervals };
        delete intervals[id];
        set({ timerIntervals: intervals, timers: get().timers.map((t) => t.id === id ? { ...t, running: false } : t) });
      },

      resetTimer: (id) => {
        const { timerIntervals } = get();
        if (timerIntervals[id]) { clearInterval(timerIntervals[id]); }
        const intervals = { ...timerIntervals };
        delete intervals[id];
        const timer = get().timers.find((t) => t.id === id);
        if (!timer) return;
        const resetMs = timer.mode === 'countdown' ? timer.durationMs : 0;
        set({
          timerIntervals: intervals,
          timers: get().timers.map((t) => t.id === id ? { ...t, running: false, currentMs: resetMs } : t),
        });
        const { client } = get();
        if (client && timer.vmixInputKey && timer.fieldName) {
          client.setTextField(timer.vmixInputKey, timer.fieldName, formatTime(resetMs, timer.format));
        }
      },

      adjustTimer: (id, deltaMs) => {
        set({
          timers: get().timers.map((t) =>
            t.id === id ? { ...t, currentMs: Math.max(0, t.currentMs + deltaMs) } : t,
          ),
        });
      },

      // ── Data Bindings ─────────────────────────────────────────────────────

      addDataBinding: () =>
        set({
          dataBindings: [
            ...get().dataBindings,
            {
              id: crypto.randomUUID(), name: 'Data Source 1', sourceType: 'json',
              sourceUrl: '', selector: '', pollIntervalMs: 5000, enabled: false,
              vmixInputKey: '', fieldName: '', lastValue: '', lastFetched: null, lastError: null,
            },
          ],
        }),

      updateDataBinding: (id, patch) =>
        set({ dataBindings: get().dataBindings.map((d) => d.id === id ? { ...d, ...patch } : d) }),

      deleteDataBinding: (id) => set({ dataBindings: get().dataBindings.filter((d) => d.id !== id) }),

      pollDataBinding: async (id) => {
        const db = get().dataBindings.find((d) => d.id === id);
        if (!db || !db.sourceUrl) return;
        try {
          const text = await (await fetch(db.sourceUrl)).text();
          let value = text;
          if (db.sourceType === 'json' && db.selector) {
            value = resolveJsonPath(JSON.parse(text), db.selector);
          } else if (db.sourceType === 'xml' && db.selector) {
            const doc = new DOMParser().parseFromString(text, 'application/xml');
            value = doc.querySelector(db.selector)?.textContent ?? '';
          }
          get().updateDataBinding(id, { lastValue: value, lastFetched: Date.now(), lastError: null });
          const { client } = get();
          if (client && db.vmixInputKey && db.fieldName) {
            await client.setTextField(db.vmixInputKey, db.fieldName, value);
          }
        } catch (err) {
          get().updateDataBinding(id, { lastError: String(err) });
        }
      },

      // ── Global Variables ──────────────────────────────────────────────────

      setVariable: (id, value) =>
        set({ globalVariables: get().globalVariables.map((v) => v.id === id ? { ...v, value } : v) }),

      addVariable: (name) =>
        set({ globalVariables: [...get().globalVariables, { id: crypto.randomUUID(), name, value: '' }] }),

      deleteVariable: (id) =>
        set({ globalVariables: get().globalVariables.filter((v) => v.id !== id) }),

      resolveLabel: (label) => {
        const { globalVariables } = get();
        return label.replace(/\{(\w+)\}/g, (_, name) => {
          return globalVariables.find((v) => v.name === name)?.value ?? `{${name}}`;
        });
      },

      restoreVmix: (data) => set({
        savedConnections: data.savedConnections as VmixStore['savedConnections'],
        shortcuts: data.shortcuts as VmixStore['shortcuts'],
        scoreboards: data.scoreboards as VmixStore['scoreboards'],
        timers: (data.timers as VmixStore['timers']).map((t) => ({ ...t, running: false })),
        dataBindings: data.dataBindings as VmixStore['dataBindings'],
        globalVariables: data.globalVariables as VmixStore['globalVariables'],
      }),
    }),
    {
      name: 'gomolab-vmix-v2',
      partialize: (s) => ({
        savedConnections: s.savedConnections,
        shortcuts: s.shortcuts,
        scoreboards: s.scoreboards,
        timers: s.timers.map((t) => ({ ...t, running: false })),
        dataBindings: s.dataBindings,
        globalVariables: s.globalVariables,
        activeTab: s.activeTab,
        // connection/client are runtime-only, not persisted
      }),
    },
  ),
);

// ── Stale monitor ─────────────────────────────────────────────────────────
// Runs every 2s; logs 'stale' when the connection stops updating, and
// 'recovered' when updates resume.
let _wasStale = false;
setInterval(() => {
  const { connection, pushConnectionLog } = useVmixStore.getState();
  if (!connection || connection.status !== 'connected' || connection.lastUpdated === null) {
    _wasStale = false;
    return;
  }
  const now = Date.now();
  const isStale = now - connection.lastUpdated > 10000;
  if (isStale && !_wasStale) {
    _wasStale = true;
    pushConnectionLog({
      time: now, connectionName: connection.name, event: 'stale',
      detail: `No update for ${Math.round((now - connection.lastUpdated) / 1000)}s`,
    });
  } else if (!isStale && _wasStale) {
    _wasStale = false;
    pushConnectionLog({ time: now, connectionName: connection.name, event: 'recovered' });
  }
}, 2000);

// ── Periodic resync ────────────────────────────────────────────────────────
// Every 5 seconds, re-push all registered field values to vMix so the app
// is always the source of truth (e.g. if someone edits vMix directly, the
// app overrides it within 5 seconds).
setInterval(() => {
  useVmixStore.getState().resyncAll();
}, 5_000);

// ── Logger + stats wiring helper ──────────────────────────────────────────
// Called after creating a VmixApiClient so events flow into the log and field
// status changes update the vmixFieldStats reactive slice.
function wireClientLogger(client: VmixApiClient, connectionName: string) {
  client.setConnectionName(connectionName);
  client.setLogger((event: string, detail?: string) => {
    useVmixStore.getState().pushConnectionLog({
      time: Date.now(),
      connectionName,
      event: event as ConnectionLogEvent,
      detail,
    });
  });
  client.setStatsChangeHandler(() => {
    useVmixStore.getState().refreshFieldStats();
  });
}

// ── vMix status broadcast ──────────────────────────────────────────────────
// Host: push connection status to all sync clients whenever it changes.
// Client: receive VMIX_STATUS and store it in remoteVmixConnections.
useVmixStore.subscribe((state) => {
  if (!syncClient.isHost) return;
  const c = state.connection;
  const conns: RemoteVmixConnection[] = c ? [{
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    status: c.status,
    error: c.error,
    edition: c.vmixState?.edition,
    version: c.vmixState?.version,
    inputCount: c.vmixState?.inputs?.length,
  }] : [];
  syncClient.send({ type: 'VMIX_STATUS', connections: conns });
});

// ── vMix live state broadcast ──────────────────────────────────────────────
// Host: push the full VmixState object whenever it changes so browser clients
// share the same inputs/tally/preview/program data.
let _lastBroadcastVmixState: VmixState | null = null;
useVmixStore.subscribe((state) => {
  if (!syncClient.isHost) return;
  if (state.vmixState === _lastBroadcastVmixState) return;
  _lastBroadcastVmixState = state.vmixState;
  syncClient.send({ type: 'VMIX_STATE', state: state.vmixState });
});

syncClient.onMessage((msg) => {
  if (msg.type === 'VMIX_STATUS') {
    useVmixStore.setState({ remoteVmixConnections: msg.connections });
  } else if (msg.type === 'CLIENT_LIST') {
    useVmixStore.setState({ browserClients: msg.clients });
  } else if (msg.type === 'VMIX_STATE') {
    useVmixStore.setState({
      vmixState: msg.state,
      lastUpdated: msg.state ? Date.now() : null,
    });
  } else if (msg.type === 'VMIX_COMMAND' && syncClient.isHost) {
    const c = useVmixStore.getState().client;
    if (!c) return;
    const { cmd, args } = msg;
    switch (cmd) {
      case 'sendFunction':    c.sendFunction(args[0], args[1]); break;
      case 'setTextField':    c.setTextField(args[0], args[1], args[2]); break;
      case 'setImageField':   c.setImageField(args[0], args[1], args[2]); break;
      case 'setPreview':      c.setPreview(args[0]); break;
      case 'setActive':       c.setActive(args[0]); break;
      case 'toggleRecord':    c.toggleRecord(); break;
      case 'toggleStream':    c.toggleStream(); break;
      case 'toggleFadeToBlack': c.toggleFadeToBlack(); break;
      case 'toggleExternal':  c.toggleExternal(); break;
      case 'toggleMultiCorder': c.toggleMultiCorder(); break;
      case 'toggleFullscreen': c.toggleFullscreen(); break;
      case 'setTBar':         c.setTBar(args[0]); break;
      case 'setMasterVolume': c.setMasterVolume(args[0]); break;
      case 'toggleMasterMute': c.toggleMasterMute(); break;
      case 'setHeadphones':   c.setHeadphones(args[0]); break;
      case 'setInputVolume':  c.setInputVolume(args[0], args[1]); break;
      case 'muteInput':       c.muteInput(args[0]); break;
      case 'unmuteInput':     c.unmuteInput(args[0]); break;
      case 'soloInput':       c.soloInput(args[0]); break;
      case 'setBusVolume':    c.setBusVolume(args[0], args[1]); break;
      case 'muteBus':         c.muteBus(args[0]); break;
      case 'setBusOn':        c.setBusOn(args[0], args[1]); break;
      case 'setBusOff':       c.setBusOff(args[0], args[1]); break;
      case 'overlayIn':       c.overlayIn(args[0], args[1]); break;
      case 'overlayOut':      c.overlayOut(args[0]); break;
      case 'replayMarkIn':    c.replayMarkIn(); break;
      case 'replayMarkOut':   c.replayMarkOut(); break;
      case 'replayPlay':      c.replayPlay(); break;
      case 'replayPause':     c.replayPause(); break;
      case 'replayNow':       c.replayNow(); break;
      case 'replayLive':      c.replayLive(); break;
      case 'playInput':       c.playInput(args[0]); break;
      case 'pauseInput':      c.pauseInput(args[0]); break;
      case 'stopInput':       c.stopInput(args[0]); break;
    }
  }
});

// Exported helper so components can format timer display
export { formatTime };
