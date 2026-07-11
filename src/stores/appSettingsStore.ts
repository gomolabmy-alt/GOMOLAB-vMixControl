import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AppTheme = 'dark' | 'light';

interface AppSettingsState {
  canvasWidth: number;
  canvasHeight: number;
  canvasScale: number;
  setCanvasSize: (w: number, h: number) => void;
  setCanvasScale: (s: number) => void;
  // Theme
  theme: AppTheme;
  setTheme: (t: AppTheme) => void;
  // Read-only notification popups
  notifyGoal: boolean;
  notifyCard: boolean;
  notifySub: boolean;
  notifyTimePause: boolean;
  notifyDurationMs: number;
  setNotifyGoal: (v: boolean) => void;
  setNotifyCard: (v: boolean) => void;
  setNotifySub: (v: boolean) => void;
  setNotifyTimePause: (v: boolean) => void;
  setNotifyDurationMs: (v: number) => void;
  // Remote-client-only: while true, incoming host sync for the Team DB /
  // Schedule / Results / Tournament stores is paused so local edits aren't
  // clobbered by the host's periodic re-broadcast — the operator explicitly
  // pushes changes back with "Save to Host" instead of continuous mirroring.
  remoteEditMode: boolean;
  setRemoteEditMode: (v: boolean) => void;
}

export const useAppSettings = create<AppSettingsState>()(
  persist(
    (set) => ({
      canvasWidth: 2000,
      canvasHeight: 1400,
      canvasScale: 1.0,

      setCanvasSize: (w, h) => set({ canvasWidth: Math.max(400, w), canvasHeight: Math.max(300, h) }),
      setCanvasScale: (s) => set({ canvasScale: Math.min(3, Math.max(0.1, s)) }),

      theme: 'dark',
      setTheme: (t) => set({ theme: t }),

      notifyGoal: true,
      notifyCard: true,
      notifySub: true,
      notifyTimePause: true,
      notifyDurationMs: 5000,
      setNotifyGoal: (v) => set({ notifyGoal: v }),
      setNotifyCard: (v) => set({ notifyCard: v }),
      setNotifySub: (v) => set({ notifySub: v }),
      setNotifyTimePause: (v) => set({ notifyTimePause: v }),
      setNotifyDurationMs: (v) => set({ notifyDurationMs: Math.max(1000, Math.min(30000, v)) }),

      remoteEditMode: false,
      setRemoteEditMode: (v) => set({ remoteEditMode: v }),
    }),
    { name: 'gomolab-app-settings' },
  ),
);

export const SCALE_PRESETS = [0.25, 0.33, 0.5, 0.67, 0.75, 1.0, 1.25, 1.5, 2.0];

export function nearestScalePreset(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    const next = SCALE_PRESETS.find(s => s > current + 0.01);
    return next ?? SCALE_PRESETS[SCALE_PRESETS.length - 1];
  } else {
    const prev = [...SCALE_PRESETS].reverse().find(s => s < current - 0.01);
    return prev ?? SCALE_PRESETS[0];
  }
}
