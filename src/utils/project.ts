export const PROJECT_VERSION = '3';

/** A logo/image library file, embedded as a base64 data URL so "export
 *  project" is a single self-contained file — no separate folder of images
 *  to keep track of, and it round-trips onto a different machine intact. */
export interface ProjectImage {
  name: string;
  dataUrl: string;
}

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
  teamDb?: { teams: unknown[] };
  matchSchedule?: { matches: unknown[] };
  matchResults?: { results: unknown[] };
  images?: ProjectImage[];
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
  teamDb?: { teams: unknown[] },
  matchSchedule?: { matches: unknown[] },
  matchResults?: { results: unknown[] },
  images?: ProjectImage[],
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
    teamDb,
    matchSchedule,
    matchResults,
    images,
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

// ── Logo library (images) ───────────────────────────────────────────────────
// The library lives as files on disk (Tauri) or on the local Axum server
// (browser/remote mode), not in any zustand store — so it's collected /
// restored separately from the rest of the snapshot, as base64 data URLs.

const isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function collectImages(): Promise<ProjectImage[]> {
  let list: { name: string; url: string }[] = [];
  try {
    if (isTauriApp) {
      const { invoke } = await import('@tauri-apps/api/core');
      list = await invoke<{ name: string; url: string }[]>('list_images');
    } else {
      const res = await fetch(`http://${window.location.host}/api/images`);
      list = await res.json();
    }
  } catch {
    return [];
  }
  const images: ProjectImage[] = [];
  for (const img of list) {
    try {
      const res = await fetch(img.url);
      const dataUrl = await blobToDataURL(await res.blob());
      images.push({ name: img.name, dataUrl });
    } catch { /* skip images that fail to fetch, keep exporting the rest */ }
  }
  return images;
}

export async function restoreImages(images: ProjectImage[]): Promise<void> {
  for (const img of images) {
    try {
      if (isTauriApp) {
        const { invoke } = await import('@tauri-apps/api/core');
        const base64 = img.dataUrl.split(',')[1] ?? '';
        await invoke('import_image', { name: img.name, dataBase64: base64 });
      } else {
        // Browser mode: convert the data URL back into a File and reuse the
        // existing multipart upload endpoint.
        const blob = await (await fetch(img.dataUrl)).blob();
        const form = new FormData();
        form.append('file', blob, img.name);
        await fetch(`http://${window.location.host}/api/images`, { method: 'POST', body: form });
      }
    } catch { /* skip images that fail to restore, keep importing the rest */ }
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
