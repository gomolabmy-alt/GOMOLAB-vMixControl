export const PROJECT_VERSION = '2';

export interface ProjectSnapshot {
  version: string;
  appVersion: string;
  savedAt: string;
  canvas: {
    pages: unknown[];
    activePageId: string;
  };
  vmix: {
    savedConnections: unknown[];
    shortcuts: unknown[];
    scoreboards: unknown[];
    timers: unknown[];
    dataBindings: unknown[];
    globalVariables: unknown[];
  };
  tournament?: {
    tournaments: unknown[];
    activeTournamentId: string;
  };
}

export function buildSnapshot(
  canvas: { pages: unknown[]; activePageId: string },
  vmix: {
    savedConnections: unknown[];
    shortcuts: unknown[];
    scoreboards: unknown[];
    timers: { running?: boolean; [k: string]: unknown }[];
    dataBindings: unknown[];
    globalVariables: unknown[];
  },
  tournament?: { tournaments: unknown[]; activeTournamentId: string },
): ProjectSnapshot {
  return {
    version: PROJECT_VERSION,
    appVersion: '1.0.0',
    savedAt: new Date().toISOString(),
    canvas: {
      pages: canvas.pages,
      activePageId: canvas.activePageId,
    },
    vmix: {
      savedConnections: vmix.savedConnections,
      shortcuts: vmix.shortcuts,
      scoreboards: vmix.scoreboards,
      timers: vmix.timers.map((t) => ({ ...t, running: false })),
      dataBindings: vmix.dataBindings,
      globalVariables: vmix.globalVariables,
    },
    tournament,
  };
}

export function exportToFile(snapshot: ProjectSnapshot): void {
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gomolab-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function parseSnapshot(json: string): ProjectSnapshot | null {
  try {
    const data = JSON.parse(json);
    if (!data.version || !data.canvas || !data.vmix) return null;
    return data as ProjectSnapshot;
  } catch {
    return null;
  }
}

// ── Cloud save interface ───────────────────────────────────────────────────
// Implement this interface to add cloud sync. The UI calls save/load through
// this abstraction, so swapping backends requires no UI changes.

export interface SaveBackend {
  name: string;
  save(snapshot: ProjectSnapshot): Promise<void>;
  load(): Promise<ProjectSnapshot | null>;
}

export const localFileBackend: SaveBackend = {
  name: 'local',
  async save(snapshot) { exportToFile(snapshot); },
  async load() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const text = await file.text();
        resolve(parseSnapshot(text));
      };
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  },
};

// Future cloud backend stub:
// export function makeCloudBackend(apiUrl: string, token: string): SaveBackend { ... }
