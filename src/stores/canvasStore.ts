import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CanvasPage, CanvasWidget, WidgetType } from '../types/canvas';
import { WIDGET_DEFAULTS } from '../types/canvas';
import { useVmixStore } from './vmixStore';
import { syncClient } from '../lib/syncClient';
import TimerWorkerClass from '../workers/timerWorker?worker&inline';

// Web Worker — used only in browser mode (not Tauri).
// In browsers setInterval in a worker is not throttled by tab visibility.
const timerWorker: Worker = new TimerWorkerClass();

// Tick handlers keyed by widgetId — called when a tick fires (worker OR Rust event).
const timerTickHandlers: Record<string, () => void> = {};

timerWorker.onmessage = (e) => {
  const { type, widgetId } = e.data;
  if (type === 'tick') {
    timerTickHandlers[widgetId]?.();
  }
};

// ── Rust-backed timer (Tauri only) ───────────────────────────────────────────
// True if running inside the Tauri desktop app.
const _isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Per-widget wall-clock anchor for the current running segment.
// Cleared when the timer stops; set/reset when it starts or crosses a boundary.
// The tick handler computes game time as (Date.now() - _runWallStart) + _runGameMs,
// so even if ticks are delayed or skipped the displayed value stays accurate.
const _runWallStart: Record<string, number> = {};   // epoch ms when segment started
const _runGameMs: Record<string, number> = {};      // game ms at that moment

// Separate anchor for the half-time/break countdown. Previously break shared
// _runWallStart/_runGameMs with the main game clock, which meant every
// transition (and every consumer — pause, adjust, resume) had to correctly
// know which phase it was re-anchoring; missing one produced corrupted
// values (e.g. pausing during a break wrote a bogus number into the main
// clock's currentMs instead of breakCurrentMs). Now break has its own slot
// that can never collide with the main clock's.
const _breakWallStart: Record<string, number> = {};
const _breakGameMs: Record<string, number> = {};

// Per-widget metadata for the Rust tick driver.
const _tickMsMap: Record<string, number> = {};      // nominal tick interval
const _lastTickAt: Record<string, number> = {};     // epoch ms of last tick fire

// In Tauri: Rust emits "timer-tick" every 100 ms from a tokio::time::interval.
// This runs on a native thread and cannot be throttled by WKWebView — it is the
// single reliable tick source for all active timer widgets.
// In browsers: Web Worker setInterval is kept as the tick source.
if (_isTauriApp) {
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen<void>('timer-tick', () => {
      const now = Date.now();
      for (const widgetId of Object.keys(timerTickHandlers)) {
        const tickMs = _tickMsMap[widgetId] ?? 1000;
        const last = _lastTickAt[widgetId] ?? 0;
        // Down-sample: 1000 ms timers should only fire once per second even
        // though Rust ticks every 100 ms.
        if (now - last >= tickMs - 60) {
          _lastTickAt[widgetId] = now;
          timerTickHandlers[widgetId]?.();
        }
      }
    });
  });
}

function stopWorkerInterval(widgetId: string) {
  if (!_isTauriApp) timerWorker.postMessage({ type: 'stop', widgetId });
  delete timerTickHandlers[widgetId];
  // Clear wall-clock anchor and tick driver state
  delete _runWallStart[widgetId];
  delete _runGameMs[widgetId];
  delete _breakWallStart[widgetId];
  delete _breakGameMs[widgetId];
  delete _lastTickAt[widgetId];
  delete _tickMsMap[widgetId];
}

// Tell the Electron main process to block/unblock system sleep.
// Called whenever the set of active timer intervals changes.
function syncSleepBlock(intervals: Record<string, boolean>) {
  const anyRunning = Object.keys(intervals).length > 0;
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_sleep_block', { block: anyRunning })).catch(() => {});
  }
}

const GRID = 10;
const CANVAS_W = 2000;
const CANVAS_H = 1400;

function snap(v: number) { return Math.round(v / GRID) * GRID; }

function hexToVmixColor(hex: string): string {
  return 'FF' + hex.replace('#', '').toUpperCase().padStart(6, '0');
}

function computeTimerStateKey(cfg: Record<string, any>): string {
  const periods = cfg.periods ?? 1;
  const currentPeriod = cfg.currentPeriod ?? 1;
  if (cfg.inExtraTime) {
    if (cfg.etInBreak) return 'etBreak';
    return `et${cfg.etCurrentPeriod ?? 1}`;
  }
  if (cfg.inAfterEt) return cfg.afterEtMode === 'goldenPoint' ? 'gp' : 'sd';
  if (cfg.inBreak) return 'break';
  if (currentPeriod > periods) return 'done';
  return `p${currentPeriod}`;
}

function computeTimerPeriodLabel(cfg: Record<string, any>): string {
  const periods = cfg.periods ?? 1;
  const currentPeriod = cfg.currentPeriod ?? 1;
  const inBreak = cfg.inBreak ?? false;
  if (cfg.inExtraTime) {
    const etPeriods = cfg.extraTimePeriods ?? 1;
    if ((cfg.etCurrentPeriod ?? 1) > etPeriods && !cfg.etInBreak) return 'AET';
    if (cfg.etInBreak) return 'ET Half Time';
    if (etPeriods === 2) return (cfg.etCurrentPeriod ?? 1) === 1 ? 'ET 1st Half' : 'ET 2nd Half';
    return 'Extra Time';
  }
  if (cfg.inAfterEt) return cfg.afterEtMode === 'goldenPoint' ? 'Golden Point' : 'Sudden Death';
  if (periods <= 1) return '';
  if (inBreak) return periods === 2 ? 'Half Time' : 'Break';
  if (currentPeriod > periods) return 'Done';
  if (periods === 2) return currentPeriod === 1 ? '1st Half' : '2nd Half';
  if (periods === 4) return `Q${currentPeriod}`;
  return `P${currentPeriod}/${periods}`;
}

function timerSendAll(primaryClient: any, cfg: Record<string, any>, value: string) {
  const targets: Array<{ inputKey: string; fieldName?: string; fieldTimerName?: string; fieldPeriodLabel?: string; fieldPeriodImage?: string }> = cfg.vmixInputs?.length
    ? cfg.vmixInputs
    : cfg.vmixInputKey
      ? [{ inputKey: cfg.vmixInputKey, fieldName: cfg.fieldName }]
      : [];
  const stateKey = computeTimerStateKey(cfg);
  const override = (cfg.periodOverrides ?? {})[stateKey] as { customText?: string; imagePath?: string } | undefined;
  const autoLabel = computeTimerPeriodLabel(cfg);
  const periodText = override?.customText ?? autoLabel;
  const periodImage = override?.imagePath ?? '';
  if (!primaryClient) return;
  for (const t of targets) {
    if (!t.inputKey) continue;
    if (t.fieldName) primaryClient.setTextField(t.inputKey, t.fieldName, value);
    if (t.fieldTimerName && cfg.name) primaryClient.setTextField(t.inputKey, t.fieldTimerName, cfg.name);
    if (t.fieldPeriodLabel && periodText) primaryClient.setTextField(t.inputKey, t.fieldPeriodLabel, periodText);
    if (t.fieldPeriodImage && periodImage) primaryClient.setTextField(t.inputKey, t.fieldPeriodImage, periodImage);
  }
}

function sendMiniTimer(client: any, cfg: Record<string, any>, ms: number) {
  if (!client || !cfg.miniVmixInputKey || !cfg.miniFieldName) return;
  client.setTextField(cfg.miniVmixInputKey, cfg.miniFieldName, formatTime(ms, cfg.format));
}

function sendFinalPlayTimer(client: any, cfg: Record<string, any>, ms: number) {
  if (!client || !cfg.finalPlayVmixInputKey || !cfg.finalPlayFieldName) return;
  client.setTextField(cfg.finalPlayVmixInputKey, cfg.finalPlayFieldName, formatTime(ms, cfg.format));
}

function firePeriodEndTrigger(cfg: Record<string, any>, client: any) {
  if (!client || !cfg.periodEndTriggerEnabled || !cfg.periodEndTriggerFn) return;
  const params: Record<string, string> = {};
  if (cfg.periodEndTriggerInput) params.Input = cfg.periodEndTriggerInput;
  if (cfg.periodEndTriggerSelectedName) params.SelectedName = cfg.periodEndTriggerSelectedName;
  if (cfg.periodEndTriggerValue) params.Value = cfg.periodEndTriggerValue;
  client.fn(cfg.periodEndTriggerFn, params).catch(() => {});
}

function fireFinalPlayEndTrigger(cfg: Record<string, any>, client: any) {
  if (!client || !cfg.finalPlayEndTriggerEnabled || !cfg.finalPlayEndTriggerFn) return;
  const params: Record<string, string> = {};
  if (cfg.finalPlayEndTriggerInput) params.Input = cfg.finalPlayEndTriggerInput;
  if (cfg.finalPlayEndTriggerSelectedName) params.SelectedName = cfg.finalPlayEndTriggerSelectedName;
  if (cfg.finalPlayEndTriggerValue) params.Value = cfg.finalPlayEndTriggerValue;
  client.fn(cfg.finalPlayEndTriggerFn, params).catch(() => {});
}

function sendOverrunColor(cfg: Record<string, any>, client: any, active: boolean) {
  if (!client || !cfg.overrunColorEnabled) return;
  // Support both the newer vmixInputs[] array and the legacy vmixInputKey scalar
  const inputKey = cfg.vmixInputs?.[0]?.inputKey ?? cfg.vmixInputKey;
  if (!inputKey) return;
  const field = cfg.overrunColorField || cfg.fieldName;
  if (!field) return;
  const color = hexToVmixColor(active ? (cfg.overrunColor || '#ff0000') : (cfg.normalColor || '#ffffff'));
  // Configurable vMix function (defaults to SetColor) — SetColor only takes
  // effect on a title object that has that exact name assigned to a Colour
  // property in the GT template; if the template exposes a plain text field
  // instead, the operator can pick a different function (e.g. SetText) here.
  const fn = cfg.overrunColorFn || 'SetColor';
  client.fn(fn, { Input: inputKey, SelectedName: field, Value: color }).catch(() => {});
}

function formatTime(ms: number, fmt: string): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);  // minutes within current hour (for hh:mm:ss)
  const totalMin = Math.floor(s / 60);     // total minutes (for mm:ss — never wraps at 60)
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (fmt) {
    case 'hh:mm:ss': return `${pad(h)}:${pad(m)}:${pad(sec)}`;
    case 'h:mm:ss':  return `${h}:${pad(m)}:${pad(sec)}`;
    case 'mm:ss':    return `${pad(totalMin)}:${pad(sec)}`;
    case 'ss':       return String(s);
    default:         return `${pad(totalMin)}:${pad(sec)}`;
  }
}

function makePage(name = 'Page 1'): CanvasPage {
  return { id: crypto.randomUUID(), name, widgets: [] };
}

interface CanvasStore {
  pages: CanvasPage[];
  activePageId: string;
  editMode: boolean;
  selectedWidgetId: string | null;
  timerIntervals: Record<string, boolean>;
  matchDataSnapshot: Record<string, Record<string, any>> | null;
  // true once the desktop app is running OR a browser has received FULL_STATE
  syncReady: boolean;

  // ── Commentator canvas (separate from main canvas) ──────────────────
  commentatorPages: CanvasPage[];
  commentatorActivePageId: string;
  commentatorSelectedWidgetId: string | null;

  // Commentator pages
  addCommentatorPage: () => void;
  deleteCommentatorPage: (id: string) => void;
  renameCommentatorPage: (id: string, name: string) => void;
  setCommentatorActivePage: (id: string) => void;

  // Commentator widget selection
  selectCommentatorWidget: (id: string | null) => void;

  // Commentator widgets
  addCommentatorWidget: (type: WidgetType) => void;
  deleteCommentatorWidget: (widgetId: string) => void;
  moveCommentatorWidget: (widgetId: string, x: number, y: number) => void;
  resizeCommentatorWidget: (widgetId: string, w: number, h: number) => void;
  updateCommentatorWidget: (widgetId: string, patch: Partial<CanvasWidget>) => void;
  updateCommentatorWidgetConfig: (widgetId: string, patch: Record<string, any>) => void;
  duplicateCommentatorWidget: (widgetId: string) => void;
  transferCommentatorWidgetToPage: (widgetId: string, targetPageId: string, copy: boolean) => void;

  // Restore commentator canvas from incoming sync
  restoreCommentatorCanvas: (pages: unknown[], activePageId: string) => void;

  // Pages
  addPage: () => void;
  deletePage: (id: string) => void;
  renamePage: (id: string, name: string) => void;
  setActivePage: (id: string) => void;

  // Edit mode
  setEditMode: (on: boolean) => void;
  selectWidget: (id: string | null) => void;

  // Widgets
  addWidget: (type: WidgetType) => void;
  deleteWidget: (widgetId: string) => void;
  updateWidget: (widgetId: string, patch: Partial<CanvasWidget>) => void;
  updateWidgetConfig: (widgetId: string, patch: Record<string, any>) => void;
  moveWidget: (widgetId: string, x: number, y: number) => void;
  resizeWidget: (widgetId: string, w: number, h: number) => void;
  duplicateWidget: (widgetId: string) => void;
  transferWidgetToPage: (widgetId: string, targetPageId: string, copy: boolean) => void;

  // App function dispatcher
  executeAppFunction: (fn: string, params: Record<string, string>) => void;

  // Timer widget actions
  startWidgetTimer: (widgetId: string) => void;
  pauseWidgetTimer: (widgetId: string) => void;
  resetWidgetTimer: (widgetId: string) => void;
  adjustWidgetTimer: (widgetId: string, deltaMs: number) => void;
  skipWidgetBreak: (widgetId: string) => void;
  endWidgetPeriod: (widgetId: string) => void;
  jumpToPeriod: (widgetId: string, period: number) => void;
  startFinalPlay: (widgetId: string) => void;
  startExtraTime: (widgetId: string) => void;
  startAfterEt: (widgetId: string) => void;

  // Scoreboard widget actions
  scoreWidgetAction: (widgetId: string, team: 'A' | 'B', delta: number, label?: string, scorer?: string, scorerJerseyNo?: string) => Promise<void>;
  resetWidgetScore: (widgetId: string) => Promise<void>;
  clearWidgetScoreLog: (widgetId: string) => void;
  patchScoreLogEntry: (widgetId: string, entryId: string, patch: { scorer?: string; jerseyNo?: string }) => void;
  returnPlayerFromSinBin: (playerListWidgetId: string, playerId: string) => void;

  // Timeline widget
  addTimelineEvent: (widgetId: string, event: Omit<import('../types/canvas').TimelineEvent, 'id'>) => void;
  deleteTimelineEvent: (widgetId: string, eventId: string) => void;

  // Scoreboard cards
  addScoreboardCard: (widgetId: string, team: 'A' | 'B', cardType: 'yellow' | 'red', player: string, timeStr: string) => void;
  removeScoreboardCard: (widgetId: string, team: 'A' | 'B', cardId: string) => void;

  // Push all widget states to vMix
  syncAllToVmix: () => void;

  // Match reset / restore
  resetMatchData: () => void;
  restoreMatchData: () => void;

  // Project save/load
  restoreCanvas: (pages: unknown[], activePageId: string) => void;

  setSyncReady: () => void;
}

const initialPage = makePage('Page 1');

export const useCanvasStore = create<CanvasStore>()(
  persist(
    (set, get) => {
      function findWidgetConfig(widgetId: string): Record<string, any> | null {
        for (const page of get().pages) {
          const w = page.widgets.find((w) => w.id === widgetId);
          if (w) return w.config;
        }
        return null;
      }

      function getPeriodEndLabel(periods: number, currentPeriod: number): string {
        if (currentPeriod >= periods) return 'Full Time';
        if (periods === 2 && currentPeriod === 1) return 'Half Time';
        if (periods === 4) return currentPeriod === 2 ? 'Half Time' : `End of Q${currentPeriod}`;
        return `End of Period ${currentPeriod}`;
      }

      function getPeriodStartLabel(periods: number, nextPeriod: number): string {
        if (periods === 2 && nextPeriod === 2) return '2nd Half';
        if (periods === 4 && nextPeriod === 3) return '2nd Half';
        if (periods === 4) return `Q${nextPeriod}`;
        return `Period ${nextPeriod}`;
      }

      function logToLinkedTimelines(timerWidgetId: string, label: string, timeStr: string) {
        const allWidgets = get().pages.flatMap((p: any) => p.widgets);
        for (const tlw of allWidgets) {
          if (tlw.type === 'timeline' && tlw.config.linkedTimerWidgetId === timerWidgetId) {
            get().addTimelineEvent(tlw.id, { type: 'period', timeStr, timeMs: Date.now(), detail: label });
          }
        }
      }

      const updateWidgetConfig = (widgetId: string, patch: Record<string, any>) => {
        set({
          pages: get().pages.map((p) => ({
            ...p,
            widgets: p.widgets.map((w) =>
              w.id === widgetId ? { ...w, config: { ...w.config, ...patch } } : w
            ),
          })),
        });
        syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'updateWidgetConfig', args: [widgetId, patch] });
      };

      const initialCommentatorPage = makePage('Page 1');

      // Helper: send full commentator canvas state to the server so commentator
      // clients receive the update. Only the desktop host sends this.
      function sendCommentatorFullState() {
        const { commentatorPages, commentatorActivePageId } = get();
        syncClient.send({
          type: 'COMMENTATOR_FULL_STATE' as const,
          canvas: { pages: commentatorPages, activePageId: commentatorActivePageId },
        });
      }

      return {
        pages: [initialPage],
        activePageId: initialPage.id,
        editMode: false,
        selectedWidgetId: null,
        timerIntervals: {},
        matchDataSnapshot: null,
        // Desktop app is always ready; browsers wait until FULL_STATE arrives from the app
        syncReady: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,

        // ── Commentator canvas ──────────────────────────────────────────────
        commentatorPages: [initialCommentatorPage],
        commentatorActivePageId: initialCommentatorPage.id,
        commentatorSelectedWidgetId: null,

        addCommentatorPage: () => {
          const page = makePage(`Page ${get().commentatorPages.length + 1}`);
          set({ commentatorPages: [...get().commentatorPages, page], commentatorActivePageId: page.id });
          sendCommentatorFullState();
        },

        deleteCommentatorPage: (id) => {
          const pages = get().commentatorPages.filter((p) => p.id !== id);
          if (pages.length === 0) {
            const page = makePage('Page 1');
            set({ commentatorPages: [page], commentatorActivePageId: page.id });
          } else {
            const stillActive = pages.some((p) => p.id === get().commentatorActivePageId);
            set({ commentatorPages: pages, commentatorActivePageId: stillActive ? get().commentatorActivePageId : pages[0].id });
          }
          sendCommentatorFullState();
        },

        renameCommentatorPage: (id, name) => {
          set({ commentatorPages: get().commentatorPages.map((p) => p.id === id ? { ...p, name } : p) });
          sendCommentatorFullState();
        },

        setCommentatorActivePage: (id) => {
          set({ commentatorActivePageId: id, commentatorSelectedWidgetId: null });
          sendCommentatorFullState();
        },

        selectCommentatorWidget: (id) => set({ commentatorSelectedWidgetId: id }),

        addCommentatorWidget: (type) => {
          const def = WIDGET_DEFAULTS[type];
          const widget: CanvasWidget = {
            id: crypto.randomUUID(),
            type,
            x: snap(Math.random() * (CANVAS_W / 2)),
            y: snap(Math.random() * 200 + 20),
            w: def.w,
            h: def.h,
            config: { ...def.config },
          };
          const pageId = get().commentatorActivePageId;
          set({
            commentatorPages: get().commentatorPages.map((p) =>
              p.id === pageId ? { ...p, widgets: [...p.widgets, widget] } : p
            ),
            commentatorSelectedWidgetId: widget.id,
          });
          sendCommentatorFullState();
        },

        deleteCommentatorWidget: (widgetId) => {
          set({
            commentatorPages: get().commentatorPages.map((p) => ({
              ...p,
              widgets: p.widgets.filter((w) => w.id !== widgetId),
            })),
            commentatorSelectedWidgetId: null,
          });
          sendCommentatorFullState();
        },

        moveCommentatorWidget: (widgetId, x, y) => {
          set({
            commentatorPages: get().commentatorPages.map((p) => ({
              ...p,
              widgets: p.widgets.map((w) =>
                w.id === widgetId
                  ? { ...w, x: Math.max(0, Math.min(x, CANVAS_W - w.w)), y: Math.max(0, Math.min(y, CANVAS_H - w.h)) }
                  : w
              ),
            })),
          });
          sendCommentatorFullState();
        },

        resizeCommentatorWidget: (widgetId, w, h) => {
          set({
            commentatorPages: get().commentatorPages.map((p) => ({
              ...p,
              widgets: p.widgets.map((ww) =>
                ww.id === widgetId ? { ...ww, w: Math.max(60, w), h: Math.max(40, h) } : ww
              ),
            })),
          });
          sendCommentatorFullState();
        },

        updateCommentatorWidget: (widgetId, patch) => {
          set({
            commentatorPages: get().commentatorPages.map((p) => ({
              ...p,
              widgets: p.widgets.map((w) => w.id === widgetId ? { ...w, ...patch } : w),
            })),
          });
          sendCommentatorFullState();
        },

        updateCommentatorWidgetConfig: (widgetId, patch) => {
          set({
            commentatorPages: get().commentatorPages.map((p) => ({
              ...p,
              widgets: p.widgets.map((w) =>
                w.id === widgetId ? { ...w, config: { ...w.config, ...patch } } : w
              ),
            })),
          });
          sendCommentatorFullState();
        },

        duplicateCommentatorWidget: (widgetId) => {
          const pageId = get().commentatorActivePageId;
          let cloned: CanvasWidget | null = null;
          for (const page of get().commentatorPages) {
            const found = page.widgets.find((w) => w.id === widgetId);
            if (found) { cloned = { ...found, id: crypto.randomUUID(), x: found.x + 20, y: found.y + 20 }; break; }
          }
          if (!cloned) return;
          set({
            commentatorPages: get().commentatorPages.map((p) =>
              p.id === pageId ? { ...p, widgets: [...p.widgets, cloned!] } : p
            ),
            commentatorSelectedWidgetId: cloned.id,
          });
          sendCommentatorFullState();
        },

        transferCommentatorWidgetToPage: (widgetId, targetPageId, copy) => {
          let widget: CanvasWidget | null = null;
          const pages = get().commentatorPages.map((p) => {
            const idx = p.widgets.findIndex((w) => w.id === widgetId);
            if (idx === -1) return p;
            widget = p.widgets[idx];
            return copy ? p : { ...p, widgets: p.widgets.filter((_, i) => i !== idx) };
          });
          if (!widget) return;
          const w = widget as CanvasWidget;
          const cloned: CanvasWidget = copy ? { ...w, id: crypto.randomUUID() } : w;
          const final = pages.map((p) =>
            p.id === targetPageId ? { ...p, widgets: [...p.widgets, cloned] } : p
          );
          set({ commentatorPages: final, commentatorActivePageId: targetPageId, commentatorSelectedWidgetId: cloned.id });
          sendCommentatorFullState();
        },

        restoreCommentatorCanvas: (pages, activePageId) => {
          const newPages = pages as CanvasPage[];
          const currentId = get().commentatorActivePageId;
          const resolvedId = newPages.some((p) => p.id === currentId)
            ? currentId
            : activePageId as string;
          set({ commentatorPages: newPages, commentatorActivePageId: resolvedId });
        },

        // ── Pages ──────────────────────────────────────────────────────────

        addPage: () => {
          const page = makePage(`Page ${get().pages.length + 1}`);
          set({ pages: [...get().pages, page], activePageId: page.id });
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'addPage', args: [page] });
        },

        deletePage: (id) => {
          const pages = get().pages.filter((p) => p.id !== id);
          if (pages.length === 0) {
            const page = makePage('Page 1');
            set({ pages: [page], activePageId: page.id });
            syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'deletePage', args: [id] });
            return;
          }
          const stillActive = pages.some((p) => p.id === get().activePageId);
          set({ pages, activePageId: stillActive ? get().activePageId : pages[0].id });
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'deletePage', args: [id] });
        },

        renamePage: (id, name) => {
          set({ pages: get().pages.map((p) => p.id === id ? { ...p, name } : p) });
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'renamePage', args: [id, name] });
        },

        setActivePage: (id) => {
          set({ activePageId: id, selectedWidgetId: null });
        },

        // ── Edit mode ──────────────────────────────────────────────────────

        setEditMode: (on) => set({ editMode: on, selectedWidgetId: null }),

        selectWidget: (id) => set({ selectedWidgetId: id }),

        // ── Widgets ────────────────────────────────────────────────────────

        addWidget: (type) => {
          const def = WIDGET_DEFAULTS[type];
          const widget: CanvasWidget = {
            id: crypto.randomUUID(),
            type,
            x: snap(Math.random() * (CANVAS_W / 2)),
            y: snap(Math.random() * 200 + 20),
            w: def.w,
            h: def.h,
            config: { ...def.config },
          };
          const pageId = get().activePageId;
          set({
            pages: get().pages.map((p) =>
              p.id === pageId
                ? { ...p, widgets: [...p.widgets, widget] }
                : p
            ),
            selectedWidgetId: widget.id,
          });
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'addWidget', args: [pageId, widget] });
        },

        deleteWidget: (widgetId) => {
          const { timerIntervals } = get();
          if (timerIntervals[widgetId]) {
            if (!_isTauriApp) timerWorker.postMessage({ type: 'stop', widgetId });
            delete timerTickHandlers[widgetId];
            delete _runWallStart[widgetId];
            delete _runGameMs[widgetId];
            delete _lastTickAt[widgetId];
            delete _tickMsMap[widgetId];
            const ints = { ...timerIntervals };
            delete ints[widgetId];
            set({ timerIntervals: ints });
            syncSleepBlock(ints);
          }
          set({
            pages: get().pages.map((p) => ({
              ...p,
              widgets: p.widgets.filter((w) => w.id !== widgetId),
            })),
            selectedWidgetId: get().selectedWidgetId === widgetId ? null : get().selectedWidgetId,
          });
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'deleteWidget', args: [widgetId] });
        },

        updateWidget: (widgetId, patch) =>
          set({
            pages: get().pages.map((p) => ({
              ...p,
              widgets: p.widgets.map((w) => w.id === widgetId ? { ...w, ...patch } : w),
            })),
          }),

        updateWidgetConfig,

        moveWidget: (widgetId, x, y) => {
          set({
            pages: get().pages.map((p) => ({
              ...p,
              widgets: p.widgets.map((w) =>
                w.id === widgetId
                  ? { ...w, x: Math.max(0, Math.min(x, CANVAS_W - w.w)), y: Math.max(0, Math.min(y, CANVAS_H - w.h)) }
                  : w
              ),
            })),
          });
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'moveWidget', args: [widgetId, x, y] });
        },

        resizeWidget: (widgetId, w, h) => {
          set({
            pages: get().pages.map((p) => ({
              ...p,
              widgets: p.widgets.map((wid) =>
                wid.id === widgetId ? { ...wid, w: Math.max(60, w), h: Math.max(40, h) } : wid
              ),
            })),
          });
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'resizeWidget', args: [widgetId, w, h] });
        },

        duplicateWidget: (widgetId) => {
          for (const page of get().pages) {
            const w = page.widgets.find((w) => w.id === widgetId);
            if (w) {
              const copy: CanvasWidget = { ...w, id: crypto.randomUUID(), x: w.x + 20, y: w.y + 20, config: { ...w.config } };
              set({
                pages: get().pages.map((p) =>
                  p.id === page.id ? { ...p, widgets: [...p.widgets, copy] } : p
                ),
                selectedWidgetId: copy.id,
              });
              syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'addWidget', args: [page.id, copy] });
              return;
            }
          }
        },

        transferWidgetToPage: (widgetId, targetPageId, copy) => {
          let widget: CanvasWidget | null = null;
          let srcPageId = '';
          for (const page of get().pages) {
            const w = page.widgets.find((w) => w.id === widgetId);
            if (w) { widget = w; srcPageId = page.id; break; }
          }
          if (!widget || srcPageId === targetPageId) return;
          const transferred: CanvasWidget = copy
            ? { ...widget, id: crypto.randomUUID(), config: { ...widget.config } }
            : widget;
          set({
            pages: get().pages.map((p) => {
              if (!copy && p.id === srcPageId) return { ...p, widgets: p.widgets.filter((w) => w.id !== widgetId) };
              if (p.id === targetPageId) return { ...p, widgets: [...p.widgets, transferred] };
              return p;
            }),
            selectedWidgetId: transferred.id,
            activePageId: targetPageId,
          });
        },

        // ── App function dispatcher ────────────────────────────────────────────

        executeAppFunction: (fn, params) => {
          const store = get();
          switch (fn) {
            case 'App.GoToPage': {
              const target = params.Page ?? '';
              const page = store.pages.find(p => p.name === target || p.id === target)
                ?? store.pages[parseInt(target, 10) - 1];
              if (page) store.setActivePage(page.id);
              break;
            }
            case 'App.TimerStart':     store.startWidgetTimer(params.Input); break;
            case 'App.TimerPause':     store.pauseWidgetTimer(params.Input); break;
            case 'App.TimerReset':     store.resetWidgetTimer(params.Input); break;
            case 'App.TimerEndPeriod': store.endWidgetPeriod(params.Input); break;
            case 'App.TimerSkipBreak': store.skipWidgetBreak(params.Input); break;
            case 'App.TimerToggle': {
              const cfg = findWidgetConfig(params.Input);
              if (cfg?.running) store.pauseWidgetTimer(params.Input);
              else store.startWidgetTimer(params.Input);
              break;
            }
            case 'App.ScoreA':
              store.scoreWidgetAction(params.Input, 'A', parseInt(params.Value ?? '1', 10), params.Label);
              break;
            case 'App.ScoreB':
              store.scoreWidgetAction(params.Input, 'B', parseInt(params.Value ?? '1', 10), params.Label);
              break;
            case 'App.ScoreReset':
              store.resetWidgetScore(params.Input);
              break;
            case 'App.SetVariable': {
              const { globalVariables, setVariable } = useVmixStore.getState();
              const v = globalVariables.find(g => g.name === params.Variable);
              if (v) setVariable(v.id, params.Value ?? '');
              break;
            }
            case 'App.ToggleEditMode':
              store.setEditMode(!store.editMode);
              break;
          }
        },

        // ── Timer widget ───────────────────────────────────────────────────

        startWidgetTimer: (widgetId) => {
          if (get().timerIntervals[widgetId]) return;
          const config = findWidgetConfig(widgetId);
          if (!config) return;

          // Pressing Play directly (bypassing the end-of-period confirm
          // prompt) means "keep this period going" — clear the pending flag
          // so it doesn't reappear stale after the interval restarts.
          if (config.awaitingEndConfirm) updateWidgetConfig(widgetId, { awaitingEndConfirm: false });

          // If a previous period ended and froze the display, now advance to the next period
          if (config.resumeMs !== undefined && config.resumeMs !== null && !config.inBreak && !config.inFinalPlay) {
            updateWidgetConfig(widgetId, {
              currentMs: config.resumeMs,
              periodStartMs: config.resumePeriodStartMs ?? 0,
              resumeMs: null,
              resumePeriodStartMs: null,
            });
          }

          const tickMs = config.highPrecision ? 100 : 1000;

          // Broadcast so other connected clients also start their interval
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'startWidgetTimer', args: [widgetId] });

          function stopInterval() {
            if (!_isTauriApp) timerWorker.postMessage({ type: 'stop', widgetId });
            delete timerTickHandlers[widgetId];
            // Clear wall-clock anchor so no stale data remains
            delete _runWallStart[widgetId];
            delete _runGameMs[widgetId];
            delete _breakWallStart[widgetId];
            delete _breakGameMs[widgetId];
            delete _lastTickAt[widgetId];
            delete _tickMsMap[widgetId];
            const ints = { ...get().timerIntervals };
            delete ints[widgetId];
            set({ timerIntervals: ints });
            syncSleepBlock(ints);
          }

          function bankPlayerTime(nextEntryMs: number, periodEndMs: number) {
            const timerMode: string = findWidgetConfig(widgetId)?.mode ?? 'countup';
            const allWidgets = get().pages.flatMap((p: any) => p.widgets);
            const linkedLists = allWidgets.filter(
              (w: any) => w.type === 'player-list' && w.config.linkedTimerWidgetId === widgetId
            );
            for (const plw of linkedLists) {
              const plCfg = plw.config;
              const onField: string[] = plCfg.onField ?? [];
              const entries: Record<string, number> = plCfg.entries ?? {};
              const accumulated: Record<string, number> = plCfg.accumulated ?? {};
              const newAcc = { ...accumulated };
              const newEntries = { ...entries };
              for (const id of onField) {
                if (entries[id] !== undefined) {
                  const played = timerMode === 'countdown'
                    ? Math.max(0, entries[id] - periodEndMs)
                    : Math.max(0, periodEndMs - entries[id]);
                  newAcc[id] = (accumulated[id] ?? 0) + played;
                  newEntries[id] = nextEntryMs;
                }
              }
              updateWidgetConfig(plw.id, { accumulated: newAcc, entries: newEntries });
            }
          }

          function periodDone(cfg: Record<string, any>) {
            const periods = cfg.periods ?? 1;
            const currentPeriod = cfg.currentPeriod ?? 1;
            const carryOver = cfg.periodMode === 'continue' && cfg.mode !== 'countdown';
            const periodEnd = (cfg.periodStartMs ?? 0) + cfg.durationMs;
            const nextCurrentMs = cfg.mode === 'countdown' ? cfg.durationMs : (carryOver ? periodEnd : 0);
            const nextPeriodStartMs = carryOver ? periodEnd : 0;
            const periodEndMs = cfg.mode === 'countdown' ? 0 : periodEnd;

            // Bank on-field player time before currentMs resets
            bankPlayerTime(nextCurrentMs, periodEndMs);

            // Auto-insert period-end marker into linked timeline widgets
            {
              let label: string;
              if (currentPeriod >= periods) {
                label = 'Full Time';
              } else if (periods === 2 && currentPeriod === 1) {
                label = 'Half Time';
              } else if (periods === 4) {
                label = currentPeriod === 2 ? 'Half Time' : `End of Q${currentPeriod}`;
              } else {
                label = `End of Period ${currentPeriod}`;
              }
              const endTimeStr = formatTime(periodEndMs, cfg.format ?? 'mm:ss');
              const allWidgets = get().pages.flatMap((p: any) => p.widgets);
              for (const tlw of allWidgets) {
                if (tlw.type === 'timeline' && tlw.config.linkedTimerWidgetId === widgetId) {
                  get().addTimelineEvent(tlw.id, {
                    type: 'period', timeStr: endTimeStr, timeMs: Date.now(), detail: label,
                  });
                }
              }
            }

            const { client: triggerClient } = useVmixStore.getState();
            // Manual mode (no auto-advance, no Final Play) defers both the
            // label/period change AND this trigger until the operator
            // confirms — endWidgetPeriod (called on confirm) fires it then.
            const deferToConfirm = !cfg.finalPlayEnabled && !cfg.autoAdvance;
            if (!deferToConfirm) firePeriodEndTrigger(cfg, triggerClient);

            if (currentPeriod < periods) {
              const breakMs = cfg.breakDurationMs ?? 0;
              if (cfg.finalPlayEnabled) {
                // Reset wall-clock anchors so the FP tick computes from 0, not from
                // the period's running time (same re-anchor done for the last period below).
                _runWallStart[widgetId] = Date.now();
                _runGameMs[widgetId] = 0;
                // Keep interval running for Final Play; store break/next-period details for after
                updateWidgetConfig(widgetId, {
                  currentMs: periodEndMs,
                  resumeMs: nextCurrentMs,
                  resumePeriodStartMs: nextPeriodStartMs,
                  periodStartMs: nextPeriodStartMs,
                  running: true,
                  inFinalPlay: true, finalPlayMs: 0,
                  finalPlayPendingNext: true,
                });
              } else if (cfg.autoAdvance) {
                // Auto mode (opt-in, widget setting): keep the tick loop running
                // straight through the transition — period end doesn't stop the
                // timer or wait for a manual "Resume" click. Re-anchor the wall
                // clock to the new phase's starting value so the very next tick
                // computes correctly.
                if (breakMs > 0) {
                  // Break can count down to 0 (time remaining) or up from 0
                  // (elapsed break time) per cfg.breakCountMode — operator choice.
                  const breakStartMs = cfg.breakCountMode === 'up' ? 0 : breakMs;
                  _breakWallStart[widgetId] = Date.now();
                  _breakGameMs[widgetId] = breakStartMs;
                  updateWidgetConfig(widgetId, {
                    // Freeze display at official period end; store next-period start for skipWidgetBreak
                    currentMs: periodEndMs,
                    resumeMs: nextCurrentMs,
                    resumePeriodStartMs: nextPeriodStartMs,
                    periodStartMs: nextPeriodStartMs,
                    inBreak: true,
                    breakCurrentMs: breakStartMs,
                  });
                  // Push the "Half Time"/"Break" period label immediately —
                  // previously this only went out on the next main-period
                  // tick, which never happens while inBreak is true, so the
                  // label field stayed stuck on the last period's text.
                  timerSendAll(triggerClient, { ...cfg, inBreak: true }, formatTime(breakStartMs, cfg.format));
                } else {
                  _runWallStart[widgetId] = Date.now();
                  _runGameMs[widgetId] = nextCurrentMs;
                  updateWidgetConfig(widgetId, {
                    currentMs: nextCurrentMs,
                    resumeMs: null,
                    resumePeriodStartMs: null,
                    periodStartMs: nextPeriodStartMs,
                    currentPeriod: currentPeriod + 1,
                    inBreak: false,
                  });
                }
              } else {
                // Manual mode (default): freeze at the transition point and
                // wait for the operator to confirm before the label/period
                // actually advances — reaching the end on its own is treated
                // the same as pressing "End" manually (same confirm dialog).
                // periodStartMs/durationMs are left untouched so endWidgetPeriod
                // (called on confirm) recomputes the exact same transition.
                stopInterval();
                updateWidgetConfig(widgetId, {
                  currentMs: periodEndMs,
                  running: false,
                  awaitingEndConfirm: true,
                });
              }
            } else {
              const finalMs = cfg.mode === 'countdown' ? 0 : periods * cfg.durationMs;
              const { client } = useVmixStore.getState();
              timerSendAll(client, cfg, formatTime(finalMs, cfg.format));
              // The widget's own display recomputes total elapsed time as
              // (min(currentPeriod, periods) - 1) * durationMs + currentMs for
              // count-up + reset mode — i.e. currentMs is expected to hold only
              // the LAST period's local elapsed time, not the grand total, or
              // the total gets added on top of itself (e.g. 40 + 80 = 120
              // instead of 80). Continue mode and countdown mode don't do that
              // extra addition, so they store the real total/zero as-is.
              const currentMsAtFullTime = cfg.mode === 'countdown'
                ? 0
                : cfg.periodMode === 'continue' ? finalMs : cfg.durationMs;
              if (cfg.finalPlayEnabled) {
                // Keep worker running for Final Play count-up; re-anchor
                // wall-clock so the Final Play counter starts from 0, not
                // from the game period's anchor.
                _runWallStart[widgetId] = Date.now();
                _runGameMs[widgetId] = 0;
                updateWidgetConfig(widgetId, {
                  currentMs: currentMsAtFullTime, running: true,
                  currentPeriod: periods + 1,
                  inFinalPlay: true, finalPlayMs: 0,
                });
              } else {
                // Same confirm-before-advance treatment as the mid-tournament
                // branch above — currentPeriod is left at `periods` (not yet
                // periods+1) so endWidgetPeriod's Full Time branch fires on confirm.
                stopInterval();
                updateWidgetConfig(widgetId, {
                  currentMs: currentMsAtFullTime, running: false,
                  awaitingEndConfirm: true,
                });
              }
            }
          }

          // Only the real Tauri app instance drives the tick loop and sends to
          // vMix. Deliberately checking _isTauriApp here, not syncClient.isHost:
          // isHost is also true for a plain browser tab hitting localhost in
          // dev mode (so the UI can be previewed without the Tauri app), and a
          // stray dev-server tab left open was found still independently
          // ticking a stale in-memory timer, fighting the real app's state.
          // Other connected controllers (remote devices/tabs) broadcast
          // start/pause/adjust actions above but must not independently
          // re-drive the same timer — running a tick loop on every peer caused
          // competing sends and skipped vMix updates.
          if (_isTauriApp) {
          timerTickHandlers[widgetId] = () => {
            const cfg = findWidgetConfig(widgetId);
            if (!cfg || !cfg.running) return;
            const { client } = useVmixStore.getState();

            // ── Extra Time tick ─────────────────────────────────────────────
            if (cfg.inExtraTime) {
              const etPeriods = cfg.extraTimePeriods ?? 1;
              const etCurrentPeriod = cfg.etCurrentPeriod ?? 1;
              const etDurationMs = cfg.etDurationMs ?? 300000;

              if (cfg.etInBreak) {
                const etBreakDurationMs = cfg.etBreakDurationMs ?? 0;
                const etBreakUp = cfg.breakCountMode === 'up';
                const ebWallStart = _runWallStart[widgetId];
                const ebGameStart = _runGameMs[widgetId];
                const nextBreak = (ebWallStart !== undefined && ebGameStart !== undefined)
                  ? (etBreakUp
                      ? Math.min(etBreakDurationMs, ebGameStart + (Date.now() - ebWallStart))
                      : Math.max(0, ebGameStart - (Date.now() - ebWallStart)))
                  : (etBreakUp
                      ? Math.min(etBreakDurationMs, (cfg.etBreakCurrentMs ?? 0) + tickMs)
                      : Math.max(0, (cfg.etBreakCurrentMs ?? 0) - tickMs));
                const etBreakDone = etBreakUp ? nextBreak >= etBreakDurationMs : nextBreak <= 0;
                if (etBreakDone) {
                  // Auto-continue into the next ET period instead of stopping.
                  const startMs = cfg.mode === 'countdown' ? etDurationMs : 0;
                  _runWallStart[widgetId] = Date.now();
                  _runGameMs[widgetId] = startMs;
                  updateWidgetConfig(widgetId, {
                    etInBreak: false, etBreakCurrentMs: 0,
                    etCurrentPeriod: etCurrentPeriod + 1,
                    etCurrentMs: startMs,
                    etPeriodStartMs: 0,
                  });
                  sendMiniTimer(client, cfg, 0);
                } else {
                  updateWidgetConfig(widgetId, { etBreakCurrentMs: nextBreak });
                  sendMiniTimer(client, cfg, nextBreak);
                }
                return;
              }

              if (cfg.etOverrunning) {
                const next = (cfg.etCurrentMs ?? 0) + tickMs;
                updateWidgetConfig(widgetId, { etCurrentMs: next });
                timerSendAll(client, cfg, formatTime(next, cfg.format));
                sendMiniTimer(client, cfg, next);
                return;
              }

              const etPeriodStart = cfg.etPeriodStartMs ?? 0;

              // Wall-clock accurate ET position — mirrors normal timer approach
              const etWallStart = _runWallStart[widgetId];
              const etGameStart = _runGameMs[widgetId];
              let next: number;
              if (etWallStart !== undefined && etGameStart !== undefined) {
                const elapsed = Date.now() - etWallStart;
                next = cfg.mode === 'countdown'
                  ? Math.max(0, etGameStart - elapsed)
                  : etGameStart + elapsed;
              } else {
                next = cfg.mode === 'countdown'
                  ? Math.max(0, (cfg.etCurrentMs ?? 0) - tickMs)
                  : (cfg.etCurrentMs ?? 0) + tickMs;
              }

              const etDoneCondition = cfg.mode === 'countdown'
                ? next <= 0
                : etDurationMs > 0 && next >= etPeriodStart + etDurationMs;

              if (etDoneCondition) {
                if (cfg.overrun) {
                  const overrunStart = cfg.mode === 'countdown' ? 0 : (etPeriodStart + etDurationMs);
                  updateWidgetConfig(widgetId, { etCurrentMs: overrunStart, etOverrunning: true });
                  timerSendAll(client, cfg, formatTime(overrunStart, cfg.format));
                  sendMiniTimer(client, cfg, overrunStart);
                  sendOverrunColor(cfg, client, true);
                  return;
                }
                const carryOver = cfg.periodMode === 'continue' && cfg.mode !== 'countdown';
                const periodEnd = etPeriodStart + etDurationMs;
                const nextEtMs = cfg.mode === 'countdown' ? etDurationMs : (carryOver ? periodEnd : 0);
                const nextEtPeriodStartMs = carryOver ? periodEnd : 0;
                const etEndMs = cfg.mode === 'countdown' ? 0 : periodEnd;
                if (etCurrentPeriod < etPeriods) {
                  const etBreakMs = cfg.etBreakDurationMs ?? 0;
                  // Keep running straight through, same as the main-period
                  // break transition above — no manual restart required.
                  if (etBreakMs > 0) {
                    _runWallStart[widgetId] = Date.now();
                    _runGameMs[widgetId] = etBreakMs;
                    updateWidgetConfig(widgetId, {
                      etCurrentMs: nextEtMs, etPeriodStartMs: nextEtPeriodStartMs,
                      etInBreak: true, etBreakCurrentMs: etBreakMs,
                    });
                  } else {
                    _runWallStart[widgetId] = Date.now();
                    _runGameMs[widgetId] = nextEtMs;
                    updateWidgetConfig(widgetId, {
                      etCurrentMs: nextEtMs, etPeriodStartMs: nextEtPeriodStartMs,
                      etCurrentPeriod: etCurrentPeriod + 1, etInBreak: false,
                    });
                  }
                } else {
                  stopInterval();
                  updateWidgetConfig(widgetId, { etCurrentMs: etEndMs, running: false });
                  timerSendAll(client, cfg, formatTime(etEndMs, cfg.format));
                  sendMiniTimer(client, cfg, etEndMs);
                }
                return;
              }

              updateWidgetConfig(widgetId, { etCurrentMs: next });
              timerSendAll(client, cfg, formatTime(next, cfg.format));
              sendMiniTimer(client, cfg, next);
              return;
            }

            // ── After-ET (SD / GP) tick ─────────────────────────────────────
            if (cfg.inAfterEt) {
              if (cfg.afterEtOverrunning) {
                const next = (cfg.afterEtCurrentMs ?? 0) + tickMs;
                updateWidgetConfig(widgetId, { afterEtCurrentMs: next });
                timerSendAll(client, cfg, formatTime(next, cfg.format));
                sendMiniTimer(client, cfg, next);
                return;
              }
              const maxMs = cfg.afterEtDurationMs ?? 0;
              if (cfg.mode === 'countdown' && maxMs > 0) {
                const next = Math.max(0, (cfg.afterEtCurrentMs ?? 0) - tickMs);
                if (next <= 0) {
                  if (cfg.overrun) {
                    updateWidgetConfig(widgetId, { afterEtCurrentMs: 0, afterEtOverrunning: true });
                    sendOverrunColor(cfg, client, true);
                  } else {
                    stopInterval();
                    updateWidgetConfig(widgetId, { afterEtCurrentMs: 0, running: false });
                  }
                  sendMiniTimer(client, cfg, 0);
                } else {
                  updateWidgetConfig(widgetId, { afterEtCurrentMs: next });
                  timerSendAll(client, cfg, formatTime(next, cfg.format));
                  sendMiniTimer(client, cfg, next);
                }
              } else if (cfg.mode !== 'countdown' && maxMs > 0) {
                const next = (cfg.afterEtCurrentMs ?? 0) + tickMs;
                if (next >= maxMs) {
                  if (cfg.overrun) {
                    updateWidgetConfig(widgetId, { afterEtCurrentMs: maxMs, afterEtOverrunning: true });
                    sendOverrunColor(cfg, client, true);
                  } else {
                    stopInterval();
                    updateWidgetConfig(widgetId, { afterEtCurrentMs: maxMs, running: false });
                  }
                  sendMiniTimer(client, cfg, maxMs);
                } else {
                  updateWidgetConfig(widgetId, { afterEtCurrentMs: next });
                  timerSendAll(client, cfg, formatTime(next, cfg.format));
                  sendMiniTimer(client, cfg, next);
                }
              } else {
                // unlimited countup
                const next = (cfg.afterEtCurrentMs ?? 0) + tickMs;
                updateWidgetConfig(widgetId, { afterEtCurrentMs: next });
                timerSendAll(client, cfg, formatTime(next, cfg.format));
                sendMiniTimer(client, cfg, next);
              }
              return;
            }

            // ── Final Play tick ──────────────────────────────────────────────
            if (cfg.inFinalPlay) {
              const fpWallStart = _runWallStart[widgetId];
              const fpGameStart = _runGameMs[widgetId];
              const next = (fpWallStart !== undefined && fpGameStart !== undefined)
                ? fpGameStart + (Date.now() - fpWallStart)
                : (cfg.finalPlayMs ?? 0) + tickMs;
              const fpDur = cfg.finalPlayDurationMs ?? 0;
              if (fpDur > 0 && next >= fpDur) {
                // Auto-end Final Play when duration expires
                fireFinalPlayEndTrigger(cfg, client);
                const pendingNext = cfg.finalPlayPendingNext ?? false;
                const base = { inFinalPlay: false, finalPlayMs: fpDur, finalPlayPendingNext: false, running: false };
                if (pendingNext) {
                  const breakMs2 = cfg.breakDurationMs ?? 0;
                  if (breakMs2 > 0) {
                    stopInterval();
                    updateWidgetConfig(widgetId, { ...base, inBreak: true, breakCurrentMs: cfg.breakCountMode === 'up' ? 0 : breakMs2 });
                  } else {
                    stopInterval();
                    updateWidgetConfig(widgetId, {
                      ...base,
                      currentMs: cfg.resumeMs ?? (cfg.mode === 'countdown' ? cfg.durationMs : 0),
                      periodStartMs: cfg.resumePeriodStartMs ?? 0,
                      currentPeriod: (cfg.currentPeriod ?? 1) + 1,
                      resumeMs: null, resumePeriodStartMs: null,
                    });
                  }
                } else {
                  stopInterval();
                  updateWidgetConfig(widgetId, base);
                }
                timerSendAll(client, cfg, formatTime(cfg.currentMs ?? 0, cfg.format));
                return;
              }
              updateWidgetConfig(widgetId, { finalPlayMs: next });
              sendMiniTimer(client, cfg, next);
              sendFinalPlayTimer(client, cfg, next);
              return;
            }

            // ── Normal tick ─────────────────────────────────────────────────
            if (cfg.inBreak) {
              const breakDurationMs = cfg.breakDurationMs ?? 0;
              const breakUp = cfg.breakCountMode === 'up';
              const bWallStart = _breakWallStart[widgetId];
              const bGameStart = _breakGameMs[widgetId];
              const nextBreak = (bWallStart !== undefined && bGameStart !== undefined)
                ? (breakUp
                    ? Math.min(breakDurationMs, bGameStart + (Date.now() - bWallStart))
                    : Math.max(0, bGameStart - (Date.now() - bWallStart)))
                : (breakUp
                    ? Math.min(breakDurationMs, (cfg.breakCurrentMs ?? 0) + tickMs)
                    : Math.max(0, (cfg.breakCurrentMs ?? 0) - tickMs));
              const breakDone = breakUp ? nextBreak >= breakDurationMs : nextBreak <= 0;
              if (breakDone) {
                const nextPeriod = (cfg.currentPeriod ?? 1) + 1;
                logToLinkedTimelines(widgetId, getPeriodStartLabel(cfg.periods ?? 1, nextPeriod), '');
                const startMs = cfg.resumeMs ?? (cfg.mode === 'countdown' ? cfg.durationMs : 0);
                delete _breakWallStart[widgetId];
                delete _breakGameMs[widgetId];
                if (cfg.autoAdvance) {
                  // Auto mode: continue straight into the next period.
                  _runWallStart[widgetId] = Date.now();
                  _runGameMs[widgetId] = startMs;
                  updateWidgetConfig(widgetId, {
                    inBreak: false, breakCurrentMs: 0, currentPeriod: nextPeriod, currentMs: startMs,
                    periodStartMs: cfg.resumePeriodStartMs ?? 0, resumeMs: null, resumePeriodStartMs: null,
                  });
                } else {
                  // Manual mode (default): break has ended — freeze at the next
                  // period's starting value and stop; the operator presses
                  // Play/Resume to actually start the next period.
                  stopInterval();
                  updateWidgetConfig(widgetId, {
                    inBreak: false, breakCurrentMs: 0, currentPeriod: nextPeriod, currentMs: startMs,
                    periodStartMs: cfg.resumePeriodStartMs ?? 0, resumeMs: null, resumePeriodStartMs: null,
                    running: false,
                  });
                }
                if (client && cfg.breakVmixInputKey && cfg.breakFieldName) {
                  client.setTextField(cfg.breakVmixInputKey, cfg.breakFieldName, formatTime(0, cfg.format));
                }
                timerSendAll(client, { ...cfg, inBreak: false, currentPeriod: nextPeriod }, formatTime(startMs, cfg.format));
                sendMiniTimer(client, cfg, 0);
              } else {
                updateWidgetConfig(widgetId, { breakCurrentMs: nextBreak });
                if (client && cfg.breakVmixInputKey && cfg.breakFieldName) {
                  client.setTextField(cfg.breakVmixInputKey, cfg.breakFieldName, formatTime(nextBreak, cfg.format));
                }
                // Also push through the main vmixInputs targets so the period
                // label field ("Half Time") stays live-refreshed during the
                // break, not just at the moment the break started.
                timerSendAll(client, cfg, formatTime(nextBreak, cfg.format));
                sendMiniTimer(client, cfg, nextBreak);
              }
              return;
            }

            if (cfg.overrunning) {
              // Wall-clock: compute from when overrun began (anchored at overrun start)
              const wallStart = _runWallStart[widgetId];
              const gameStart = _runGameMs[widgetId];
              const overrunNext = (wallStart !== undefined && gameStart !== undefined)
                ? gameStart + (Date.now() - wallStart)
                : (cfg.currentMs ?? 0) + tickMs;
              updateWidgetConfig(widgetId, { currentMs: overrunNext });
              timerSendAll(client, cfg, formatTime(overrunNext, cfg.format));
              return;
            }

            let next: number;
            const periodStart = cfg.periodStartMs ?? 0;

            // Wall-clock accurate: derive game time from real elapsed time so that
            // missed or delayed ticks (WKWebView throttled, display sleep) never
            // cause the timer to fall behind.
            const wallStart = _runWallStart[widgetId];
            const gameStart = _runGameMs[widgetId];
            if (wallStart !== undefined && gameStart !== undefined) {
              const elapsed = Date.now() - wallStart;
              next = cfg.mode === 'countdown'
                ? Math.max(0, gameStart - elapsed)
                : gameStart + elapsed;
            } else {
              next = cfg.mode === 'countdown'
                ? Math.max(0, cfg.currentMs - tickMs)
                : cfg.currentMs + tickMs;
            }

            const periodDoneCondition =
              cfg.mode === 'countdown'
                ? next <= 0
                : cfg.durationMs > 0 && next >= periodStart + cfg.durationMs;

            if (periodDoneCondition) {
              if (cfg.overrun) {
                const overrunStartMs = cfg.mode === 'countdown' ? 0 : (periodStart + cfg.durationMs);
                // Reset wall-clock anchor at the start of overrun
                _runWallStart[widgetId] = Date.now();
                _runGameMs[widgetId] = overrunStartMs;
                updateWidgetConfig(widgetId, { currentMs: overrunStartMs, overrunning: true });
                timerSendAll(client, cfg, formatTime(overrunStartMs, cfg.format));
                sendOverrunColor(cfg, client, true);
                return;
              }
              periodDone(cfg);
              return;
            }

            updateWidgetConfig(widgetId, { currentMs: next });
            timerSendAll(client, cfg, formatTime(next, cfg.format));
          };

          // Register tick source
          _tickMsMap[widgetId] = tickMs;
          if (_isTauriApp) {
            // Rust 100ms ticks drive this timer; set wall-clock anchor so the
            // tick handler can compute accurate game time even after sleep.
            // Break has its own anchor slot (_breakWallStart/_breakGameMs),
            // separate from the main clock's, so resuming a manually-paused
            // break can never clobber or be clobbered by the main timer's anchor.
            if (config.inBreak) {
              _breakWallStart[widgetId] = Date.now();
              _breakGameMs[widgetId] = config.breakCurrentMs ?? 0;
            } else {
              let startMs: number;
              if (config.inFinalPlay) {
                startMs = config.finalPlayMs ?? 0;
              } else if (config.inExtraTime && config.etInBreak) {
                startMs = config.etBreakCurrentMs ?? 0;
              } else if (config.inExtraTime) {
                startMs = config.etCurrentMs ?? 0;
              } else if (config.resumeMs !== undefined && config.resumeMs !== null) {
                startMs = config.resumeMs;
              } else {
                startMs = config.currentMs;
              }
              _runWallStart[widgetId] = Date.now();
              _runGameMs[widgetId] = startMs;
            }
            _lastTickAt[widgetId] = Date.now();
          } else {
            // Browser mode: keep using Web Worker
            timerWorker.postMessage({ type: 'start', widgetId, tickMs });
          }
          } // end syncClient.isHost
          const newInts = { ...get().timerIntervals, [widgetId]: true };
          set({ timerIntervals: newInts });
          syncSleepBlock(newInts);
          updateWidgetConfig(widgetId, { running: true });
        },

        pauseWidgetTimer: (widgetId) => {
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'pauseWidgetTimer', args: [widgetId] });
          // Snapshot accurate wall-clock time before stopping the tick source.
          // Each phase has its own anchor + config field to patch — using the
          // wrong one (e.g. always writing currentMs) previously corrupted
          // whichever phase wasn't the main clock when pausing mid-break/ET/etc.
          const cfg = findWidgetConfig(widgetId);
          let pausePatch: Record<string, any> = { running: false };
          if (cfg) {
            if (cfg.inBreak) {
              const wallStart = _breakWallStart[widgetId];
              const gameStart = _breakGameMs[widgetId];
              if (wallStart !== undefined && gameStart !== undefined) {
                const elapsed = Date.now() - wallStart;
                const breakDurationMs = cfg.breakDurationMs ?? 0;
                const pausedMs = cfg.breakCountMode === 'up'
                  ? Math.min(breakDurationMs, gameStart + elapsed)
                  : Math.max(0, gameStart - elapsed);
                pausePatch = { running: false, breakCurrentMs: pausedMs };
              }
            } else if (cfg.inFinalPlay) {
              const wallStart = _runWallStart[widgetId];
              const gameStart = _runGameMs[widgetId];
              if (wallStart !== undefined && gameStart !== undefined) {
                pausePatch = { running: false, finalPlayMs: gameStart + (Date.now() - wallStart) };
              }
            } else if (cfg.inAfterEt) {
              const wallStart = _runWallStart[widgetId];
              const gameStart = _runGameMs[widgetId];
              if (wallStart !== undefined && gameStart !== undefined) {
                const elapsed = Date.now() - wallStart;
                const pausedMs = cfg.mode === 'countdown' ? Math.max(0, gameStart - elapsed) : gameStart + elapsed;
                pausePatch = { running: false, afterEtCurrentMs: pausedMs };
              }
            } else if (cfg.inExtraTime && cfg.etInBreak) {
              const wallStart = _runWallStart[widgetId];
              const gameStart = _runGameMs[widgetId];
              if (wallStart !== undefined && gameStart !== undefined) {
                const elapsed = Date.now() - wallStart;
                const etBreakDurationMs = cfg.etBreakDurationMs ?? 0;
                const pausedMs = cfg.breakCountMode === 'up'
                  ? Math.min(etBreakDurationMs, gameStart + elapsed)
                  : Math.max(0, gameStart - elapsed);
                pausePatch = { running: false, etBreakCurrentMs: pausedMs };
              }
            } else if (cfg.inExtraTime) {
              const wallStart = _runWallStart[widgetId];
              const gameStart = _runGameMs[widgetId];
              if (wallStart !== undefined && gameStart !== undefined) {
                const elapsed = Date.now() - wallStart;
                const pausedMs = cfg.mode === 'countdown' ? Math.max(0, gameStart - elapsed) : gameStart + elapsed;
                pausePatch = { running: false, etCurrentMs: pausedMs };
              }
            } else {
              const wallStart = _runWallStart[widgetId];
              const gameStart = _runGameMs[widgetId];
              if (wallStart !== undefined && gameStart !== undefined) {
                const elapsed = Date.now() - wallStart;
                const pausedMs = cfg.mode === 'countdown' ? Math.max(0, gameStart - elapsed) : gameStart + elapsed;
                pausePatch = { running: false, currentMs: pausedMs };
              }
            }
          }
          // Stop tick source
          if (!_isTauriApp) timerWorker.postMessage({ type: 'stop', widgetId });
          delete timerTickHandlers[widgetId];
          delete _runWallStart[widgetId];
          delete _runGameMs[widgetId];
          delete _breakWallStart[widgetId];
          delete _breakGameMs[widgetId];
          delete _lastTickAt[widgetId];
          delete _tickMsMap[widgetId];
          const ints = { ...get().timerIntervals };
          delete ints[widgetId];
          set({ timerIntervals: ints });
          syncSleepBlock(ints);
          updateWidgetConfig(widgetId, pausePatch);
        },

        resetWidgetTimer: (widgetId) => {
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'resetWidgetTimer', args: [widgetId] });
          const { timerIntervals } = get();
          if (timerIntervals[widgetId]) stopWorkerInterval(widgetId);
          const ints = { ...timerIntervals };
          delete ints[widgetId];
          set({ timerIntervals: ints });
          syncSleepBlock(ints);
          const config = findWidgetConfig(widgetId);
          if (!config) return;
          const resetMs = config.mode === 'countdown' ? config.durationMs : 0;
          updateWidgetConfig(widgetId, {
            currentMs: resetMs, running: false,
            currentPeriod: 1, periodStartMs: 0,
            resumeMs: null, resumePeriodStartMs: null,
            overrunning: false, inBreak: false, breakCurrentMs: 0,
            inExtraTime: false, etCurrentPeriod: 1,
            etCurrentMs: config.mode === 'countdown' ? (config.etDurationMs ?? 300000) : 0,
            etPeriodStartMs: 0, etInBreak: false, etBreakCurrentMs: 0, etOverrunning: false,
            inAfterEt: false, afterEtCurrentMs: 0, afterEtOverrunning: false,
            inFinalPlay: false, finalPlayMs: 0, finalPlayPendingNext: false,
            awaitingEndConfirm: false,
          });
          const { client } = useVmixStore.getState();
          timerSendAll(client, config, formatTime(resetMs, config.format));
          sendOverrunColor(config, client, false);
        },

        // Jumps directly to the start of any regular period (e.g. picking "Q3"
        // from a dropdown) instead of only advancing one period at a time via
        // End/Skip. Always lands paused — the operator presses Play to start it,
        // matching the manual-by-default period/break flow.
        jumpToPeriod: (widgetId, period) => {
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'jumpToPeriod', args: [widgetId, period] });
          const { timerIntervals } = get();
          if (timerIntervals[widgetId]) stopWorkerInterval(widgetId);
          const ints = { ...timerIntervals };
          delete ints[widgetId];
          set({ timerIntervals: ints });
          syncSleepBlock(ints);
          const config = findWidgetConfig(widgetId);
          if (!config) return;
          const periods = config.periods ?? 1;
          const target = Math.max(1, Math.min(period, periods));
          const carryOver = config.periodMode === 'continue' && config.mode !== 'countdown';
          const periodStartMs = carryOver ? (target - 1) * config.durationMs : 0;
          const startMs = config.mode === 'countdown' ? config.durationMs : (carryOver ? periodStartMs : 0);
          updateWidgetConfig(widgetId, {
            currentPeriod: target,
            currentMs: startMs,
            periodStartMs,
            running: false,
            overrunning: false,
            resumeMs: null, resumePeriodStartMs: null,
            inBreak: false, breakCurrentMs: 0,
            inExtraTime: false, etCurrentPeriod: 1, etInBreak: false, etBreakCurrentMs: 0, etOverrunning: false,
            inAfterEt: false, afterEtOverrunning: false,
            inFinalPlay: false, finalPlayMs: 0, finalPlayPendingNext: false,
            awaitingEndConfirm: false,
          });
          const { client } = useVmixStore.getState();
          timerSendAll(client, config, formatTime(startMs, config.format));
          sendOverrunColor(config, client, false);
        },

        adjustWidgetTimer: (widgetId, deltaMs) => {
          const config = findWidgetConfig(widgetId);
          if (!config) return;

          // Re-anchor the wall-clock so the next Tauri tick doesn't overwrite
          // the jump. Break uses its own anchor slot (_breakWallStart/
          // _breakGameMs), separate from the main clock's — see pauseWidgetTimer.
          const reanchor = (next: number, useBreakAnchor = false) => {
            if (config.running && _isTauriApp) {
              if (useBreakAnchor) {
                _breakGameMs[widgetId] = next;
                _breakWallStart[widgetId] = Date.now();
              } else {
                _runGameMs[widgetId] = next;
                _runWallStart[widgetId] = Date.now();
              }
            }
          };

          if (config.inFinalPlay) {
            const next = Math.max(0, (config.finalPlayMs ?? 0) + deltaMs);
            updateWidgetConfig(widgetId, { finalPlayMs: next });
            reanchor(next);
          } else if (config.inAfterEt) {
            const next = Math.max(0, (config.afterEtCurrentMs ?? 0) + deltaMs);
            updateWidgetConfig(widgetId, { afterEtCurrentMs: next });
            reanchor(next);
          } else if (config.inExtraTime) {
            if (config.etInBreak) {
              const next = Math.max(0, (config.etBreakCurrentMs ?? 0) + deltaMs);
              updateWidgetConfig(widgetId, { etBreakCurrentMs: next });
              reanchor(next);
            } else {
              const next = Math.max(0, (config.etCurrentMs ?? 0) + deltaMs);
              updateWidgetConfig(widgetId, { etCurrentMs: next });
              reanchor(next);
            }
          } else if (config.inBreak) {
            const next = Math.max(0, (config.breakCurrentMs ?? 0) + deltaMs);
            updateWidgetConfig(widgetId, { breakCurrentMs: next });
            reanchor(next, true);
          } else {
            const next = Math.max(0, config.currentMs + deltaMs);
            updateWidgetConfig(widgetId, { currentMs: next });
            reanchor(next);
          }
        },

        startExtraTime: (widgetId) => {
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'startExtraTime', args: [widgetId] });
          const config = findWidgetConfig(widgetId);
          if (!config) return;
          const etDurationMs = config.etDurationMs ?? 300000;
          const etStartMs = config.mode === 'countdown' ? etDurationMs : 0;
          updateWidgetConfig(widgetId, {
            inExtraTime: true,
            etCurrentPeriod: 1,
            etCurrentMs: etStartMs,
            etPeriodStartMs: 0,
            etInBreak: false,
            etBreakCurrentMs: 0,
            etOverrunning: false,
          });
          get().startWidgetTimer(widgetId);
        },

        startAfterEt: (widgetId) => {
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'startAfterEt', args: [widgetId] });
          const config = findWidgetConfig(widgetId);
          if (!config) return;
          const maxMs = config.afterEtDurationMs ?? 0;
          const startMs = config.mode === 'countdown' && maxMs > 0 ? maxMs : 0;
          updateWidgetConfig(widgetId, {
            inAfterEt: true,
            afterEtCurrentMs: startMs,
            afterEtOverrunning: false,
          });
          get().startWidgetTimer(widgetId);
        },

        endWidgetPeriod: (widgetId) => {
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'endWidgetPeriod', args: [widgetId] });
          const { timerIntervals } = get();
          if (timerIntervals[widgetId]) {
            stopWorkerInterval(widgetId);
            const ints = { ...timerIntervals };
            delete ints[widgetId];
            set({ timerIntervals: ints });
            syncSleepBlock(ints);
          }
          const cfg = findWidgetConfig(widgetId);
          if (!cfg) return;

          const { client } = useVmixStore.getState();
          sendOverrunColor(cfg, client, false);

          // ── Final Play end ────────────────────────────────────────────────
          if (cfg.inFinalPlay) {
            fireFinalPlayEndTrigger(cfg, client);
            const pendingNext = cfg.finalPlayPendingNext ?? false;
            const base = { inFinalPlay: false, finalPlayMs: 0, finalPlayPendingNext: false, running: false };
            if (pendingNext) {
              const breakMs = cfg.breakDurationMs ?? 0;
              if (breakMs > 0) {
                updateWidgetConfig(widgetId, {
                  ...base, inBreak: true, breakCurrentMs: cfg.breakCountMode === 'up' ? 0 : breakMs,
                  running: !!cfg.autoStartBreak,
                });
                if (cfg.autoStartBreak) get().startWidgetTimer(widgetId);
              } else {
                updateWidgetConfig(widgetId, {
                  ...base,
                  currentMs: cfg.resumeMs ?? (cfg.mode === 'countdown' ? cfg.durationMs : 0),
                  periodStartMs: cfg.resumePeriodStartMs ?? 0,
                  currentPeriod: (cfg.currentPeriod ?? 1) + 1,
                  resumeMs: null, resumePeriodStartMs: null,
                });
              }
            } else {
              updateWidgetConfig(widgetId, base);
            }
            timerSendAll(client, cfg, formatTime(cfg.currentMs ?? 0, cfg.format));
            return;
          }

          // ── After-ET (SD/GP) end ─────────────────────────────────────────
          if (cfg.inAfterEt) {
            updateWidgetConfig(widgetId, { afterEtOverrunning: false, running: false });
            return;
          }

          // ── ET period end ────────────────────────────────────────────────
          if (cfg.inExtraTime) {
            const etPeriods = cfg.extraTimePeriods ?? 1;
            const etCurrentPeriod = cfg.etCurrentPeriod ?? 1;
            const etDurationMs = cfg.etDurationMs ?? 300000;
            const carryOver = cfg.periodMode === 'continue' && cfg.mode !== 'countdown';
            const scheduledEtEnd = (cfg.etPeriodStartMs ?? 0) + etDurationMs;
            const nextEtMs = cfg.mode === 'countdown' ? etDurationMs : (carryOver ? scheduledEtEnd : 0);
            const nextEtPeriodStartMs = carryOver ? scheduledEtEnd : 0;
            if (etCurrentPeriod < etPeriods) {
              const etBreakMs = cfg.etBreakDurationMs ?? 0;
              if (etBreakMs > 0) {
                updateWidgetConfig(widgetId, {
                  etOverrunning: false, running: !!cfg.autoStartBreak,
                  etCurrentMs: nextEtMs, etPeriodStartMs: nextEtPeriodStartMs,
                  etInBreak: true, etBreakCurrentMs: cfg.breakCountMode === 'up' ? 0 : etBreakMs,
                });
                if (cfg.autoStartBreak) get().startWidgetTimer(widgetId);
              } else {
                updateWidgetConfig(widgetId, {
                  etOverrunning: false, running: false,
                  etCurrentMs: nextEtMs, etPeriodStartMs: nextEtPeriodStartMs,
                  etCurrentPeriod: etCurrentPeriod + 1, etInBreak: false,
                });
              }
            } else {
              updateWidgetConfig(widgetId, { etOverrunning: false, running: false });
            }
            return;
          }

          // ── Regular period end ───────────────────────────────────────────
          const periods = cfg.periods ?? 1;
          const currentPeriod = cfg.currentPeriod ?? 1;
          const carryOver = cfg.periodMode === 'continue' && cfg.mode !== 'countdown';
          const scheduledEnd = (cfg.periodStartMs ?? 0) + cfg.durationMs;
          // Freeze display at the official period-end time, not at overrun currentMs
          const periodEndMs = cfg.mode === 'countdown' ? 0 : scheduledEnd;
          const nextCurrentMs = cfg.mode === 'countdown' ? cfg.durationMs : (carryOver ? scheduledEnd : 0);
          const nextPeriodStartMs = carryOver ? scheduledEnd : 0;

          firePeriodEndTrigger(cfg, client);

          if (currentPeriod < periods) {
            const endTimeStr = formatTime(periodEndMs, cfg.format ?? 'mm:ss');
            logToLinkedTimelines(widgetId, getPeriodEndLabel(periods, currentPeriod), endTimeStr);
            const breakMs = cfg.breakDurationMs ?? 0;
            if (breakMs > 0) {
              updateWidgetConfig(widgetId, {
                overrunning: false, running: !!cfg.autoStartBreak,
                currentMs: periodEndMs, resumeMs: nextCurrentMs,
                resumePeriodStartMs: nextPeriodStartMs,
                periodStartMs: nextPeriodStartMs,
                inBreak: true, breakCurrentMs: cfg.breakCountMode === 'up' ? 0 : breakMs,
              });
              if (cfg.autoStartBreak) get().startWidgetTimer(widgetId);
            } else {
              // No break — advance straight into the next period's actual
              // starting value, not the previous period's frozen end value
              // (which would double-count via (period-1)*duration + currentMs).
              updateWidgetConfig(widgetId, {
                overrunning: false, running: false,
                currentMs: nextCurrentMs, resumeMs: null,
                resumePeriodStartMs: null,
                periodStartMs: nextPeriodStartMs,
                currentPeriod: currentPeriod + 1, inBreak: false,
              });
              logToLinkedTimelines(widgetId, getPeriodStartLabel(periods, currentPeriod + 1), '');
            }
          } else {
            // Full time — freeze at total accumulated game time
            const fullTimeMs = cfg.mode === 'countdown' ? 0 : periods * cfg.durationMs;
            const fullTimeStr = formatTime(fullTimeMs, cfg.format ?? 'mm:ss');
            logToLinkedTimelines(widgetId, getPeriodEndLabel(periods, currentPeriod), fullTimeStr);
            // See the matching comment in periodDone(): for count-up + reset
            // mode the display re-adds (periods-1)*duration on top of
            // currentMs, so currentMs must hold only the last period's local
            // time here, not the grand total, or it double-counts (120
            // instead of 80).
            const currentMsAtFullTime = cfg.mode === 'countdown'
              ? 0
              : cfg.periodMode === 'continue' ? fullTimeMs : cfg.durationMs;
            updateWidgetConfig(widgetId, {
              overrunning: false, running: false,
              currentMs: currentMsAtFullTime,
              currentPeriod: periods + 1,
            });
          }
        },

        skipWidgetBreak: (widgetId) => {
          syncClient.send({ type: 'ACTION', store: 'canvas', fn: 'skipWidgetBreak', args: [widgetId] });
          const { timerIntervals } = get();
          if (timerIntervals[widgetId]) {
            stopWorkerInterval(widgetId);
            const ints = { ...timerIntervals };
            delete ints[widgetId];
            set({ timerIntervals: ints });
            syncSleepBlock(ints);
          }
          const config = findWidgetConfig(widgetId);
          if (!config) return;
          if (config.inExtraTime && config.etInBreak) {
            const nextEtPeriod = (config.etCurrentPeriod ?? 1) + 1;
            const etDurationMs = config.etDurationMs ?? 300000;
            updateWidgetConfig(widgetId, {
              etInBreak: false, etBreakCurrentMs: 0,
              etCurrentPeriod: nextEtPeriod, running: false,
              etCurrentMs: config.mode === 'countdown' ? etDurationMs : 0,
              etPeriodStartMs: 0,
            });
            return;
          }
          const nextPeriod = (config.currentPeriod ?? 1) + 1;
          const periods = config.periods ?? 1;
          logToLinkedTimelines(widgetId, getPeriodStartLabel(periods, nextPeriod), '');
          // currentMs was frozen at the PREVIOUS period's end value when break
          // started (to display "period ended at 40:00" during the break) —
          // it was never reset to the next period's actual starting value.
          // Left as-is, the display (currentPeriod-1)*duration + currentMs
          // double-counts the elapsed period (e.g. 1*40 + 40 = 80 instead of
          // 1*40 + 0 = 40). Apply the same startMs the auto-continue tick path
          // uses, instead of deferring it to whenever Play is next pressed.
          const startMs = config.resumeMs ?? (config.mode === 'countdown' ? config.durationMs : 0);
          updateWidgetConfig(widgetId, {
            inBreak: false,
            breakCurrentMs: 0,
            currentPeriod: nextPeriod,
            currentMs: startMs,
            periodStartMs: config.resumePeriodStartMs ?? 0,
            resumeMs: null,
            resumePeriodStartMs: null,
            running: false,
          });
          const { client } = useVmixStore.getState();
          timerSendAll(client, { ...config, inBreak: false, currentPeriod: nextPeriod }, formatTime(startMs, config.format));
        },

        startFinalPlay: (widgetId) => {
          // Stop any running interval, then enter Final Play mode
          const { timerIntervals } = get();
          if (timerIntervals[widgetId]) {
            stopWorkerInterval(widgetId);
            const ints = { ...timerIntervals };
            delete ints[widgetId];
            set({ timerIntervals: ints });
            syncSleepBlock(ints);
          }
          const config = findWidgetConfig(widgetId);
          if (!config || config.inFinalPlay) return;

          const periods = config.periods ?? 1;
          const currentPeriod = config.currentPeriod ?? 1;
          const pendingNext = currentPeriod < periods;
          const updates: Record<string, any> = {
            inFinalPlay: true, finalPlayMs: 0, finalPlayPendingNext: pendingNext,
            inBreak: false, overrunning: false,
          };
          if (pendingNext) {
            const carryOver = config.periodMode === 'continue' && config.mode !== 'countdown';
            const periodEnd = (config.periodStartMs ?? 0) + config.durationMs;
            updates.resumeMs = config.mode === 'countdown' ? config.durationMs : (carryOver ? periodEnd : 0);
            updates.resumePeriodStartMs = carryOver ? periodEnd : 0;
            updates.periodStartMs = updates.resumePeriodStartMs;
          }
          updateWidgetConfig(widgetId, updates);
          // Restart interval for Final Play count-up
          get().startWidgetTimer(widgetId);
        },

        // ── Scoreboard widget ──────────────────────────────────────────────

        scoreWidgetAction: async (widgetId, team, delta, label, scorer, scorerJerseyNo) => {
          const config = findWidgetConfig(widgetId);
          if (!config) return;
          const field = team === 'A' ? 'scoreA' : 'scoreB';
          const vmixField = team === 'A' ? config.fieldScoreA : config.fieldScoreB;
          const current = team === 'A' ? config.scoreA : config.scoreB;
          const next = Math.max(0, current + delta);

          const scorerName = scorer ?? '';

          // Build log entry with timer time if linked
          let timeStr = '';
          if (config.linkedTimerWidgetId) {
            const timerCfg = findWidgetConfig(config.linkedTimerWidgetId);
            if (timerCfg) timeStr = formatTime(timerCfg.currentMs ?? 0, timerCfg.format ?? 'mm:ss');
          }
          if (!timeStr) {
            const now = new Date();
            timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
          }
          const scoreA = team === 'A' ? next : (config.scoreA ?? 0);
          const scoreB = team === 'B' ? next : (config.scoreB ?? 0);
          const logEntry = {
            id: crypto.randomUUID(),
            timeStr,
            timeMs: Date.now(),
            team,
            teamName: team === 'A' ? (config.teamAName ?? 'Team A') : (config.teamBName ?? 'Team B'),
            scorer: scorerName,
            jerseyNo: scorerJerseyNo ?? '',
            action: label ?? `+${delta}`,
            points: delta,
            scoreA,
            scoreB,
          };

          updateWidgetConfig(widgetId, {
            [field]: next,
            scoreLog: [logEntry, ...(config.scoreLog ?? [])],
          });
          {
            const { client } = useVmixStore.getState();
            const targets = config.vmixInputs?.length
              ? config.vmixInputs
              : config.vmixInputKey
                ? [{ inputKey: config.vmixInputKey, fieldScoreA: config.fieldScoreA, fieldScoreB: config.fieldScoreB }]
                : [];
            for (const t of targets) {
              const f = team === 'A' ? t.fieldScoreA : t.fieldScoreB;
              if (t.inputKey && f && client) await client.setTextField(t.inputKey, f, String(next));
            }
          }
        },

        resetWidgetScore: async (widgetId) => {
          const config = findWidgetConfig(widgetId);
          if (!config) return;
          // Also clear scoreLog/cards — the center stat pill (tries/cards
          // tally) is derived from them, so leaving them behind after a
          // reset would show stale counts alongside a zeroed score.
          updateWidgetConfig(widgetId, { scoreA: 0, scoreB: 0, scoreLog: [], cardsA: [], cardsB: [] });
          {
            const { client } = useVmixStore.getState();
            const targets = config.vmixInputs?.length
              ? config.vmixInputs
              : config.vmixInputKey
                ? [{ inputKey: config.vmixInputKey, fieldScoreA: config.fieldScoreA, fieldScoreB: config.fieldScoreB }]
                : [];
            await Promise.all(targets.flatMap((t: { inputKey: string; fieldScoreA?: string; fieldScoreB?: string }) => [
              t.inputKey && t.fieldScoreA && client && client.setTextField(t.inputKey, t.fieldScoreA, '0'),
              t.inputKey && t.fieldScoreB && client && client.setTextField(t.inputKey, t.fieldScoreB, '0'),
            ].filter(Boolean)));
          }
        },

        clearWidgetScoreLog: (widgetId) => updateWidgetConfig(widgetId, { scoreLog: [] }),

        returnPlayerFromSinBin: (playerListWidgetId, playerId) => {
          const cfg = findWidgetConfig(playerListWidgetId);
          if (!cfg) return;
          const sinBinEntries = { ...(cfg.sinBinEntries ?? {}) };
          delete sinBinEntries[playerId];
          const onField: string[] = cfg.onField ?? [];
          const timerWidget = cfg.linkedTimerWidgetId
            ? get().pages.flatMap(p => p.widgets).find(w => w.id === cfg.linkedTimerWidgetId)
            : null;
          const currentMs: number = timerWidget?.config?.currentMs ?? 0;
          updateWidgetConfig(playerListWidgetId, {
            sinBinEntries,
            onField: onField.includes(playerId) ? onField : [...onField, playerId],
            entries: { ...(cfg.entries ?? {}), [playerId]: currentMs },
          });
        },

        patchScoreLogEntry: (widgetId, entryId, patch) => {
          const cfg = findWidgetConfig(widgetId);
          if (!cfg) return;
          const log: any[] = cfg.scoreLog ?? [];
          updateWidgetConfig(widgetId, {
            scoreLog: log.map(e => e.id === entryId ? { ...e, ...patch } : e),
          });
        },

        addTimelineEvent: (widgetId, event) => {
          const cfg = findWidgetConfig(widgetId);
          if (!cfg) return;
          const entry = { ...event, id: crypto.randomUUID() };
          updateWidgetConfig(widgetId, { events: [entry, ...(cfg.events ?? [])] });
        },

        deleteTimelineEvent: (widgetId, eventId) => {
          const cfg = findWidgetConfig(widgetId);
          if (!cfg) return;
          updateWidgetConfig(widgetId, { events: (cfg.events ?? []).filter((e: { id: string }) => e.id !== eventId) });
        },

        addScoreboardCard: (widgetId, team, cardType, player, timeStr) => {
          const cfg = findWidgetConfig(widgetId);
          if (!cfg) return;
          const field = team === 'A' ? 'cardsA' : 'cardsB';
          const entry = { id: crypto.randomUUID(), type: cardType, player, timeStr, timeMs: Date.now() };
          updateWidgetConfig(widgetId, { [field]: [entry, ...(cfg[field] ?? [])] });
        },

        removeScoreboardCard: (widgetId, team, cardId) => {
          const cfg = findWidgetConfig(widgetId);
          if (!cfg) return;
          const field = team === 'A' ? 'cardsA' : 'cardsB';
          updateWidgetConfig(widgetId, { [field]: (cfg[field] ?? []).filter((c: { id: string }) => c.id !== cardId) });
        },

        syncAllToVmix: () => {
          const { client } = useVmixStore.getState();
          if (!client) return;
          const widgets = get().pages.flatMap(p => p.widgets);
          for (const w of widgets) {
            const cfg = w.config;

            if (w.type === 'timer' && !cfg.linkedTimerSourceId) {
              let displayMs: number;
              if (cfg.inExtraTime) displayMs = cfg.etCurrentMs ?? 0;
              else if (cfg.inAfterEt) displayMs = cfg.afterEtCurrentMs ?? 0;
              else displayMs = cfg.currentMs ?? 0;
              timerSendAll(client, cfg, formatTime(displayMs, cfg.format ?? 'mm:ss'));
              if (cfg.inBreak && cfg.breakVmixInputKey && cfg.breakFieldName) {
                client.setTextField(cfg.breakVmixInputKey, cfg.breakFieldName, formatTime(cfg.breakCurrentMs ?? 0, cfg.format ?? 'mm:ss'));
              }
              if (cfg.miniVmixInputKey && cfg.miniFieldName) {
                let miniMs = 0;
                if (cfg.inFinalPlay) miniMs = cfg.finalPlayMs ?? 0;
                else if (cfg.inAfterEt) miniMs = cfg.afterEtCurrentMs ?? 0;
                else if (cfg.inExtraTime) miniMs = cfg.etInBreak ? (cfg.etBreakCurrentMs ?? 0) : (cfg.etCurrentMs ?? 0);
                else if (cfg.inBreak) miniMs = cfg.breakCurrentMs ?? 0;
                sendMiniTimer(client, cfg, miniMs);
              }
              if (cfg.inFinalPlay) sendFinalPlayTimer(client, cfg, cfg.finalPlayMs ?? 0);
              sendOverrunColor(cfg, client, cfg.overrunning ?? false);
            }

            if (w.type === 'scoreboard' && !cfg.linkedScoreboardSourceId) {
              const targets: any[] = cfg.vmixInputs?.length
                ? cfg.vmixInputs
                : cfg.vmixInputKey
                  ? [{
                      inputKey: cfg.vmixInputKey,
                      fieldScoreA: cfg.fieldScoreA, fieldScoreB: cfg.fieldScoreB,
                      fieldTeamA: cfg.fieldTeamA, fieldTeamB: cfg.fieldTeamB,
                      fieldShortA: cfg.fieldShortA, fieldShortB: cfg.fieldShortB,
                      fieldLogoA: cfg.fieldLogoA, fieldLogoB: cfg.fieldLogoB,
                      fieldCompetition: cfg.fieldCompetition, fieldRound: cfg.fieldRound,
                    }]
                  : [];
              for (const t of targets) {
                if (!t.inputKey) continue;
                if (t.fieldScoreA) client.setTextField(t.inputKey, t.fieldScoreA, String(cfg.scoreA ?? 0));
                if (t.fieldScoreB) client.setTextField(t.inputKey, t.fieldScoreB, String(cfg.scoreB ?? 0));
                if (t.fieldTeamA && cfg.teamAName) client.setTextField(t.inputKey, t.fieldTeamA, cfg.teamAName);
                if (t.fieldTeamB && cfg.teamBName) client.setTextField(t.inputKey, t.fieldTeamB, cfg.teamBName);
                if (t.fieldShortA && cfg.teamAShortName) client.setTextField(t.inputKey, t.fieldShortA, cfg.teamAShortName);
                if (t.fieldShortB && cfg.teamBShortName) client.setTextField(t.inputKey, t.fieldShortB, cfg.teamBShortName);
                if (t.fieldLogoA && cfg.teamALogo) client.setImageField(t.inputKey, t.fieldLogoA, cfg.teamALogo);
                if (t.fieldLogoB && cfg.teamBLogo) client.setImageField(t.inputKey, t.fieldLogoB, cfg.teamBLogo);
                if (t.fieldCompetition && cfg.competition) client.setTextField(t.inputKey, t.fieldCompetition, cfg.competition);
                if (t.fieldRound && cfg.subtitle) client.setTextField(t.inputKey, t.fieldRound, cfg.subtitle);
              }
            }
          }
        },

        resetMatchData: () => {
          const allWidgets = get().pages.flatMap((p) => p.widgets);
          const snapshot: Record<string, Record<string, any>> = {};

          const PLAYER_FIELDS = ['onField','entries','accumulated','subbedOnPlayers','playerCards','sinBinEntries','orangeCardEntries'];
          const TIMER_FIELDS  = [
            'currentMs','running','currentPeriod','periodStartMs','inBreak','breakCurrentMs','overrunning',
            'inExtraTime','etCurrentPeriod','etCurrentMs','etPeriodStartMs','etInBreak','etBreakCurrentMs','etOverrunning',
            'inAfterEt','afterEtCurrentMs','afterEtOverrunning',
          ];
          const SCORE_FIELDS  = ['scoreA','scoreB','scoreLog','cardsA','cardsB'];
          const TL_FIELDS     = ['events'];

          for (const w of allWidgets) {
            const c = w.config;
            if (w.type === 'player-list') {
              snapshot[w.id] = Object.fromEntries(PLAYER_FIELDS.map(k => [k, c[k]]));
              updateWidgetConfig(w.id, {
                onField: [], entries: {}, accumulated: {},
                subbedOnPlayers: [], playerCards: {}, sinBinEntries: {}, orangeCardEntries: {},
              });
            } else if (w.type === 'timer') {
              snapshot[w.id] = Object.fromEntries(TIMER_FIELDS.map(k => [k, c[k]]));
              const { timerIntervals } = get();
              if (timerIntervals[w.id]) { stopWorkerInterval(w.id); const i = { ...get().timerIntervals }; delete i[w.id]; set({ timerIntervals: i }); syncSleepBlock(i); }
              const resetMs = c.mode === 'countdown' ? (c.durationMs ?? 0) : 0;
              updateWidgetConfig(w.id, {
                currentMs: resetMs, running: false, currentPeriod: 1, periodStartMs: 0,
                inBreak: false, breakCurrentMs: 0, overrunning: false,
                inExtraTime: false, etCurrentPeriod: 1,
                etCurrentMs: c.mode === 'countdown' ? (c.etDurationMs ?? 300000) : 0,
                etPeriodStartMs: 0, etInBreak: false, etBreakCurrentMs: 0, etOverrunning: false,
                inAfterEt: false, afterEtCurrentMs: 0, afterEtOverrunning: false,
              });
            } else if (w.type === 'scoreboard') {
              snapshot[w.id] = Object.fromEntries(SCORE_FIELDS.map(k => [k, c[k]]));
              updateWidgetConfig(w.id, { scoreA: 0, scoreB: 0, scoreLog: [], cardsA: [], cardsB: [] });
            } else if (w.type === 'timeline') {
              snapshot[w.id] = Object.fromEntries(TL_FIELDS.map(k => [k, c[k]]));
              updateWidgetConfig(w.id, { events: [] });
            }
          }
          set({ matchDataSnapshot: snapshot });
        },

        restoreMatchData: () => {
          const snapshot = get().matchDataSnapshot;
          if (!snapshot) return;
          const allWidgets = get().pages.flatMap((p) => p.widgets);
          for (const w of allWidgets) {
            if (snapshot[w.id]) {
              if (w.type === 'timer') {
                const { timerIntervals } = get();
                if (timerIntervals[w.id]) { stopWorkerInterval(w.id); const i = { ...get().timerIntervals }; delete i[w.id]; set({ timerIntervals: i }); syncSleepBlock(i); }
                updateWidgetConfig(w.id, { ...snapshot[w.id], running: false });
              } else {
                updateWidgetConfig(w.id, snapshot[w.id]);
              }
            }
          }
          set({ matchDataSnapshot: null });
        },

        restoreCanvas: (pages, activePageId) => {
          const newPages = pages as CanvasPage[];
          const currentId = get().activePageId;
          // Preserve the client's current page if it still exists; otherwise fall back to server's page
          const resolvedId = newPages.some((p) => p.id === currentId)
            ? currentId
            : activePageId as string;
          set({ pages: newPages, activePageId: resolvedId });
        },

        setSyncReady: () => set({ syncReady: true }),
      };
    },
    {
      name: 'gomolab-canvas-v1',
      // Desktop app uses localStorage (survives restart).
      // Browsers use sessionStorage so each page load starts from the app's live
      // state via FULL_STATE rather than their own stale localStorage copy.
      storage: (() => {
        // Debounce writes so timer ticks (every ~1 s) don't thrash localStorage
        // on every update.  Reads and removes are always synchronous and immediate.
        const raw = () =>
          typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
            ? localStorage
            : sessionStorage;
        let _timer: ReturnType<typeof setTimeout> | null = null;
        let _pendingKey: string | null = null;
        let _pendingValue: string | null = null;
        return {
          getItem: (key: string) => {
            const v = raw().getItem(key);
            return v ? JSON.parse(v) : null;
          },
          setItem: (key: string, value: unknown) => {
            _pendingKey = key;
            _pendingValue = JSON.stringify(value);
            if (_timer) return;
            _timer = setTimeout(() => {
              _timer = null;
              if (_pendingKey !== null && _pendingValue !== null) {
                raw().setItem(_pendingKey, _pendingValue);
              }
              _pendingKey = null;
              _pendingValue = null;
            }, 2000);
          },
          removeItem: (key: string) => raw().removeItem(key),
        };
      })(),
      partialize: (s) => {
        // Browsers never persist pages — they always load live state from the server
        // via FULL_STATE. Persisting pages (which may contain multi-MB base64 logos)
        // causes QuotaExceededError in sessionStorage, which prevents setSyncReady()
        // from being called and leaves the canvas stuck on the loading overlay.
        if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) return {};
        return {
          pages: s.pages.map((p) => ({
            ...p,
            widgets: p.widgets.map((w) =>
              w.type === 'timer'
                ? { ...w, config: { ...w.config, running: false, overrunning: false, inBreak: false } }
                : w
            ),
          })),
          activePageId: s.activePageId,
          commentatorPages: s.commentatorPages,
          commentatorActivePageId: s.commentatorActivePageId,
        };
      },
    }
  )
);

export { formatTime };

export function initCanvasSync() {
  syncClient.onMessage((msg) => {
    if (msg.type === 'REQUEST_STATE') {
      // A remote client just connected and wants our state — only host responds
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) syncClient.sendFullState();
      return;
    }
    if (msg.type === 'FULL_STATE') {
      // Host never accepts FULL_STATE (it IS the source of truth).
      // Clients always apply it so any stale sessionStorage never wins over live host state.
      const isHost = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
      if (!isHost && msg.canvas) {
        const store = useCanvasStore.getState();
        try {
          store.restoreCanvas(msg.canvas.pages, msg.canvas.activePageId);
        } finally {
          // Always mark as ready — even if restoreCanvas hits a storage error,
          // the in-memory state was already updated so the canvas can render.
          store.setSyncReady();
        }
      }
      return;
    }
    if (msg.type !== 'ACTION' || msg.store !== 'canvas') return;
    const store = useCanvasStore.getState();
    switch (msg.fn) {
      case 'updateWidgetConfig': {
        const [wid, patch] = msg.args as [string, Record<string, any>];
        store.updateWidgetConfig(wid, patch);
        break;
      }
      case 'startWidgetTimer':
        store.startWidgetTimer(msg.args[0] as string);
        break;
      case 'pauseWidgetTimer':
        store.pauseWidgetTimer(msg.args[0] as string);
        break;
      case 'resetWidgetTimer':
        store.resetWidgetTimer(msg.args[0] as string);
        break;
      case 'endWidgetPeriod':
        store.endWidgetPeriod(msg.args[0] as string);
        break;
      case 'skipWidgetBreak':
        store.skipWidgetBreak(msg.args[0] as string);
        break;
      case 'jumpToPeriod':
        store.jumpToPeriod(msg.args[0] as string, msg.args[1] as number);
        break;
      case 'startExtraTime':
        store.startExtraTime(msg.args[0] as string);
        break;
      case 'startAfterEt':
        store.startAfterEt(msg.args[0] as string);
        break;
      case 'resetMatchData':
        store.resetMatchData();
        break;
      case 'restoreMatchData':
        store.restoreMatchData();
        break;
      // ── Structural changes (widget layout, pages) ──────────────────────
      case 'addWidget': {
        const [pageId, widget] = msg.args as [string, CanvasWidget];
        useCanvasStore.setState((s) => ({
          pages: s.pages.map((p) =>
            p.id === pageId ? { ...p, widgets: [...p.widgets, widget] } : p
          ),
        }));
        break;
      }
      case 'deleteWidget':
        store.deleteWidget(msg.args[0] as string);
        break;
      case 'moveWidget': {
        const [wid, x, y] = msg.args as [string, number, number];
        store.moveWidget(wid, x, y);
        break;
      }
      case 'resizeWidget': {
        const [wid, w, h] = msg.args as [string, number, number];
        store.resizeWidget(wid, w, h);
        break;
      }
      case 'addPage': {
        const [page] = msg.args as [CanvasPage];
        useCanvasStore.setState((s) => ({ pages: [...s.pages, page] }));
        break;
      }
      case 'deletePage':
        store.deletePage(msg.args[0] as string);
        break;
      case 'renamePage': {
        const [pid, name] = msg.args as [string, string];
        store.renamePage(pid, name);
        break;
      }
    }
  });
}

export function initCommentatorSync() {
  syncClient.onMessage((msg) => {
    if (msg.type !== 'COMMENTATOR_FULL_STATE') return;
    const store = useCanvasStore.getState();
    store.restoreCommentatorCanvas(msg.canvas.pages, msg.canvas.activePageId);
  });

  // Commentator browser clients push their canvas state back whenever it changes
  if (syncClient.isCommentator) {
    let _lastPages: unknown = null;
    useCanvasStore.subscribe((state) => {
      if (syncClient.applying) return;
      // Only sync when widget content changes, not when the client navigates pages
      if (state.commentatorPages === _lastPages) return;
      _lastPages = state.commentatorPages;
      syncClient.send({
        type: 'COMMENTATOR_FULL_STATE' as const,
        canvas: { pages: state.commentatorPages, activePageId: state.commentatorActivePageId },
      });
    });
  }
}
