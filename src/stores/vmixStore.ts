import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { VmixApiClient } from '../api/vmixApi';
import type {
  VmixState, ConnectionConfig, ConnectionStatus,
  SavedConnection, Shortcut, Scoreboard, VmixTimer,
  DataBinding, GlobalVariable, ScoreboardStyle,
  VmixConnectionEntry,
} from '../types/vmix';

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
  // Multi-connection
  connections: VmixConnectionEntry[];
  clients: Record<string, VmixApiClient>; // id → client (not persisted)
  connectNew: (config: ConnectionConfig, name?: string) => Promise<void>;
  disconnectById: (id: string) => void;
  getClientById: (id?: string) => VmixApiClient | null;
  updateConnectionName: (id: string, name: string) => void;

  // Connection (primary — mirrors connections[0])
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  activeConnection: ConnectionConfig | null;
  savedConnections: SavedConnection[];
  client: VmixApiClient | null;

  // vMix state
  vmixState: VmixState | null;
  lastUpdated: number | null;

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

// ─── Store ─────────────────────────────────────────────────────────────────

export const useVmixStore = create<VmixStore>()(
  persist(
    (set, get) => ({
      // ── Init ──
      connections: [],
      clients: {},
      connectionStatus: 'disconnected',
      connectionError: null,
      activeConnection: null,
      savedConnections: [],
      client: null,
      vmixState: null,
      lastUpdated: null,
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
        // Replaces the primary (first) connection
        const { connections, clients } = get();
        const primaryId = connections[0]?.id;
        if (primaryId && clients[primaryId]) clients[primaryId].stopPolling();

        const id = primaryId ?? crypto.randomUUID();
        const entry: VmixConnectionEntry = {
          id, name: `${config.host}:${config.port}`,
          host: config.host, port: config.port,
          status: 'connecting', error: null, vmixState: null, lastUpdated: null,
        };
        const newConnections = primaryId
          ? connections.map((c, i) => (i === 0 ? entry : c))
          : [entry, ...connections];
        set({ connections: newConnections, connectionStatus: 'connecting', connectionError: null });

        const client = new VmixApiClient(config.host, config.port);
        let initialState;
        try {
          initialState = await client.fetchState();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const errEntry = { ...entry, status: 'error' as ConnectionStatus, error: `Cannot reach ${config.host}:${config.port} — ${detail}` };
          set({
            connections: get().connections.map((c) => c.id === id ? errEntry : c),
            connectionStatus: 'error', connectionError: errEntry.error!, client: null,
          });
          return;
        }
        // Mark connected immediately using the initial HTTP state — don't wait
        // for the first TCP push (which may never arrive if TCP is blocked).
        const newClients = { ...get().clients, [id]: client };
        const connectedEntry = { ...entry, status: 'connected' as ConnectionStatus, error: null, vmixState: initialState, lastUpdated: Date.now() };
        set({
          connections: get().connections.map((c) => c.id === id ? connectedEntry : c),
          clients: newClients, client, activeConnection: config,
          connectionStatus: 'connected', connectionError: null,
          vmixState: initialState, lastUpdated: Date.now(),
        });

        client.startPolling(
          (state) => {
            const connEntry = { ...get().connections.find(c => c.id === id)!, vmixState: state, lastUpdated: Date.now(), status: 'connected' as ConnectionStatus };
            set({
              connections: get().connections.map((c) => c.id === id ? connEntry : c),
              ...(get().connections[0]?.id === id ? { vmixState: state, lastUpdated: Date.now() } : {}),
            });
          },
          (error) => {
            const errEntry = { ...get().connections.find(c => c.id === id)!, status: 'error' as ConnectionStatus, error };
            set({
              connections: get().connections.map((c) => c.id === id ? errEntry : c),
              ...(get().connections[0]?.id === id ? { connectionStatus: 'error', connectionError: error } : {}),
            });
            client.stopPolling();
          },
        );
      },

      connectNew: async (config, name) => {
        const id = crypto.randomUUID();
        const entry: VmixConnectionEntry = {
          id, name: name ?? `${config.host}:${config.port}`,
          host: config.host, port: config.port,
          status: 'connecting', error: null, vmixState: null, lastUpdated: null,
        };
        set({ connections: [...get().connections, entry] });

        const client = new VmixApiClient(config.host, config.port);
        try {
          await client.fetchState();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const errEntry = { ...entry, status: 'error' as ConnectionStatus, error: `Cannot reach ${config.host}:${config.port} — ${detail}` };
          set({ connections: get().connections.map((c) => c.id === id ? errEntry : c) });
          return;
        }
        set({ clients: { ...get().clients, [id]: client } });

        client.startPolling(
          (state) => {
            const connEntry = { ...get().connections.find(c => c.id === id)!, vmixState: state, lastUpdated: Date.now(), status: 'connected' as ConnectionStatus };
            set({ connections: get().connections.map((c) => c.id === id ? connEntry : c) });
          },
          (error) => {
            const errEntry = { ...get().connections.find(c => c.id === id)!, status: 'error' as ConnectionStatus, error };
            set({ connections: get().connections.map((c) => c.id === id ? errEntry : c) });
            client.stopPolling();
          },
        );
      },

      disconnectById: (id) => {
        const { connections, clients } = get();
        clients[id]?.stopPolling();
        const newClients = { ...clients };
        delete newClients[id];
        const newConnections = connections.filter(c => c.id !== id);
        const isPrimary = connections[0]?.id === id;
        set({
          connections: newConnections,
          clients: newClients,
          ...(isPrimary ? {
            client: newConnections[0]?.id ? newClients[newConnections[0].id] ?? null : null,
            connectionStatus: newConnections[0]?.status ?? 'disconnected',
            connectionError: newConnections[0]?.error ?? null,
            activeConnection: newConnections[0] ? { host: newConnections[0].host, port: newConnections[0].port } : null,
            vmixState: newConnections[0]?.vmixState ?? null,
          } : {}),
        });
      },

      getClientById: (id) => {
        const { clients, connections } = get();
        if (id && clients[id]) return clients[id];
        const primaryId = connections[0]?.id;
        return primaryId ? (clients[primaryId] ?? null) : null;
      },

      updateConnectionName: (id, name) =>
        set({ connections: get().connections.map(c => c.id === id ? { ...c, name } : c) }),

      disconnect: () => {
        const { clients } = get();
        Object.values(clients).forEach(c => c.stopPolling());
        // Stop all timers
        Object.values(get().timerIntervals).forEach(clearInterval);
        set({
          connections: [],
          clients: {},
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

      sendFunction: async (fn, params = {}) => { await get().client?.sendFunction(fn, params); },
      setTextField: async (k, f, v) => { await get().client?.setTextField(k, f, v); },
      setPreview:   async (k) => { await get().client?.setPreview(k); },
      setActive:    async (k) => { await get().client?.setActive(k); },
      toggleRecord:      async () => { await get().client?.toggleRecord(); },
      toggleStream:      async () => { await get().client?.toggleStream(); },
      toggleFadeToBlack: async () => { await get().client?.toggleFadeToBlack(); },
      toggleExternal:    async () => { await get().client?.toggleExternal(); },
      toggleMultiCorder: async () => { await get().client?.toggleMultiCorder(); },
      toggleFullscreen:  async () => { await get().client?.toggleFullscreen(); },

      // ── T-Bar ────────────────────────────────────────────────────────────

      setTBar: async (value) => {
        set({ tBarValue: value });
        await get().client?.setTBar(value);
      },

      // ── Audio ─────────────────────────────────────────────────────────────

      setMasterVolume:  async (v) => { await get().client?.setMasterVolume(v); },
      toggleMasterMute: async ()  => { await get().client?.toggleMasterMute(); },
      setHeadphones:    async (v) => { await get().client?.setHeadphones(v); },
      setInputVolume:   async (k, v) => { await get().client?.setInputVolume(k, v); },
      muteInput:   async (k) => { await get().client?.muteInput(k); },
      unmuteInput: async (k) => { await get().client?.unmuteInput(k); },
      soloInput:   async (k) => { await get().client?.soloInput(k); },
      setBusVolume: async (bus, v) => { await get().client?.setBusVolume(bus, v); },
      muteBus:      async (bus) => { await get().client?.muteBus(bus); },
      setBusRouting: async (inputKey, bus, on) => {
        if (on) await get().client?.setBusOn(inputKey, bus);
        else    await get().client?.setBusOff(inputKey, bus);
      },

      // ── Overlays ──────────────────────────────────────────────────────────

      overlayIn:  async (ch, key) => { await get().client?.overlayIn(ch, key); },
      overlayOut: async (ch)      => { await get().client?.overlayOut(ch); },

      // ── Replay ───────────────────────────────────────────────────────────

      replayMarkIn:  async () => { await get().client?.replayMarkIn(); },
      replayMarkOut: async () => { await get().client?.replayMarkOut(); },
      replayPlay:    async () => { await get().client?.replayPlay(); },
      replayPause:   async () => { await get().client?.replayPause(); },
      replayNow:     async () => { await get().client?.replayNow(); },
      replayLive:    async () => { await get().client?.replayLive(); },

      // ── Playlist/DDR ─────────────────────────────────────────────────────

      playInput:  async (k) => { await get().client?.playInput(k); },
      pauseInput: async (k) => { await get().client?.pauseInput(k); },
      stopInput:  async (k) => { await get().client?.stopInput(k); },

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
        // connections and clients are runtime-only, not persisted
      }),
    },
  ),
);

// Exported helper so components can format timer display
export { formatTime };
