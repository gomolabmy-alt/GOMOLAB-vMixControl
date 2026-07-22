import { create } from 'zustand';

// Purely a UI signal — lets StatusBar show a "syncing…" progress indicator
// while cloudSync.ts is actively pushing/pulling, without cloudSync.ts (a
// plain module, not a React component) needing to know anything about
// rendering. Distinct from cloudSync.ts's own internal pushInFlight/
// pullInFlight guards (those gate re-entrancy; this just mirrors them for
// display).
interface CloudSyncStatusState {
  pushing: boolean;
  pulling: boolean;
  lastError: string | null;
  setPushing: (v: boolean) => void;
  setPulling: (v: boolean) => void;
  setLastError: (e: string | null) => void;
}

export const useCloudSyncStatus = create<CloudSyncStatusState>((set) => ({
  pushing: false,
  pulling: false,
  lastError: null,
  setPushing: (v) => set({ pushing: v }),
  setPulling: (v) => set({ pulling: v }),
  setLastError: (e) => set({ lastError: e }),
}));
