// Legacy type stub — kept for backwards compatibility with Electron build.
// Active builds use Tauri; check for window.__TAURI_INTERNALS__ at runtime.
declare interface Window {
  electronAPI?: {
    platform: string;
    isElectron: boolean;
    scanNDI: () => Promise<string[]>;
  };
}
