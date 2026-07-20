import './polyfill'; // must be first — patches crypto.randomUUID for older browsers
import { StrictMode, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { syncClient } from './lib/syncClient';
import { useCanvasStore, initCanvasSync, initCommentatorSync } from './stores/canvasStore';
import { useTournamentStore, initTournamentSync } from './stores/tournamentStore';
import { useTeamDbStore } from './stores/teamDbStore';
import { useMatchScheduleStore } from './stores/matchScheduleStore';
import { useMatchResultsStore } from './stores/matchResultsStore';
import { useAuthStore } from './stores/authStore';

class RootErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null };
  static getDerivedStateFromError(e: unknown) {
    return { error: String((e as any)?.message ?? e) };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ position: 'fixed', inset: 0, background: '#1a1a2e', color: '#ff6b6b',
          fontFamily: 'monospace', fontSize: 13, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>App Error</div>
          <div style={{ maxWidth: 600, textAlign: 'center', wordBreak: 'break-all',
            background: 'rgba(255,0,0,0.1)', padding: '10px 16px', borderRadius: 6 }}>
            {this.state.error}
          </div>
          <button onClick={() => window.location.reload()}
            style={{ marginTop: 8, padding: '8px 20px', background: '#ff6b6b', color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Wire store handlers so incoming WS messages update local state
initCanvasSync();
initTournamentSync();
initCommentatorSync();

// Connect to sync server; desktop host sends full state on connect for new joiners
// Also treat localhost in Vite dev mode as host so UI preview works without the Tauri app
const isDesktopHost = typeof window !== 'undefined' && (
  '__TAURI_INTERNALS__' in window ||
  ((import.meta as any).env?.DEV && window.location.hostname === 'localhost')
);

// Sign-in gate only applies to the actual packaged app — a plain Tauri
// runtime check, not the broader dev/localhost fallback above (the deep-link
// plugin only exists inside a real Tauri process).
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  import('./lib/deepLink').then(({ initDeepLink }) => initDeepLink());
  useAuthStore.getState().verify();
  // Re-checks periodically (not just at launch) so a remote "Force Sign Out"
  // from the Desktop Sessions admin page actually takes effect without the
  // user needing to relaunch the app.
  setInterval(() => useAuthStore.getState().verify(), 120_000);
}

syncClient.connect(isDesktopHost ? () => ({
  type: 'FULL_STATE' as const,
  canvas: (() => {
    const s = useCanvasStore.getState();
    return { pages: s.pages, activePageId: s.activePageId };
  })(),
  tournament: (() => {
    const s = useTournamentStore.getState();
    return { tournaments: s.tournaments, activeTournamentId: s.activeTournamentId };
  })(),
  teamDb: { teams: useTeamDbStore.getState().teams },
  matchSchedule: { matches: useMatchScheduleStore.getState().matches },
  matchResults: { results: useMatchResultsStore.getState().results },
}) : undefined);

function sendCommentatorHeartbeat() {
  if (!isDesktopHost) return;
  const s = useCanvasStore.getState();
  syncClient.send({
    type: 'COMMENTATOR_FULL_STATE' as const,
    canvas: { pages: s.commentatorPages, activePageId: s.commentatorActivePageId },
  });
}

// Heartbeat: re-push FULL_STATE every 5 seconds so the Rust server's cache
// never gets stale. Without this, browsers that connect after a score change or
// timer update receive the original on-connect snapshot and miss those changes.
// Also push COMMENTATOR_FULL_STATE so new commentator clients get fresh state.
if (isDesktopHost) {
  setInterval(() => {
    syncClient.sendFullState();
    sendCommentatorHeartbeat();
  }, 5000);
}

const rootEl = document.getElementById('root')!;
const fallbackEl = document.getElementById('boot-fallback');

createRoot(rootEl).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);

// Hide the "Loading…" overlay once React has taken over
if (fallbackEl) {
  requestAnimationFrame(() => { fallbackEl.style.display = 'none'; });
}
