import { useEffect, useState } from 'react';
import { Sun, Moon, Mic } from 'lucide-react';
import { useVmixStore } from './stores/vmixStore';
import { useAppSettings } from './stores/appSettingsStore';
import { Sidebar } from './components/Sidebar';
import { Canvas } from './components/Canvas';
import { SplashScreen } from './components/SplashScreen';
import { SignInGate } from './components/SignInGate';
import { UndoToast } from './components/UndoToast';
import { useAuthStore } from './stores/authStore';
import { syncClient } from './lib/syncClient';
import { startCloudSync } from './lib/cloudSync';
import { startHotkeyRegistry } from './lib/hotkeyRegistry';
import { useMatchResultsStore } from './stores/matchResultsStore';
import { backfillTeamIds } from './lib/backfillTeamIds';
import { backfillResultStageData } from './lib/backfillResultStageData';
import { backfillTierMismatches } from './lib/backfillTierMismatches';
import { startTournamentAutoAdvance } from './lib/tournamentAutoAdvance';
import { startCountdownVmixSync } from './lib/countdownVmixSync';
import { startCompanionBridge } from './lib/companionBridge';

function CommentatorApp() {
  const { theme, setTheme } = useAppSettings();
  return (
    <div className="app-layout" style={{ background: '#111' }}>
      <button
        className="commentator-theme-btn"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >{theme === 'dark' ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}</button>
      <Canvas mode="commentator" />
    </div>
  );
}

export function App() {
  const { connect, connectionStatus, savedConnections } = useVmixStore();
  const { theme } = useAppSettings();
  const [canvasMode, setCanvasMode] = useState<'main' | 'commentator'>('main');
  const isDesktopHost = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const [splashDone, setSplashDone] = useState(!isDesktopHost);
  const authStatus = useAuthStore(s => s.status);
  const offlineBypass = useAuthStore(s => s.offlineBypass);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!isDesktopHost) return;
    if (connectionStatus === 'disconnected' && savedConnections.length > 0) {
      const last = [...savedConnections].sort((a, b) => (b.lastConnected ?? 0) - (a.lastConnected ?? 0))[0];
      connect({ host: last.host, port: last.port });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Multi-venue cloud sync — only the desktop host itself runs this (LAN
  // remote/commentator clients mirror the host's state instead, and never
  // hold a sign-in token of their own). Push/pull both silently no-op until
  // signed in, so this is safe to start before that happens — and stays a
  // no-op for the lifetime of an offline-bypass session too, since bypass
  // never involves a token at all.
  useEffect(() => {
    if (!isDesktopHost) return;
    // Backfills teamAId/teamBId onto fixtures/results saved before those
    // fields existed, so old data gets promoted to unambiguous id matching
    // too (see backfillTeamIds.ts), not just new data going forward.
    const backfilled = backfillTeamIds();
    if (backfilled.matches > 0 || backfilled.results > 0) {
      console.log(`[teams] backfilled ids on ${backfilled.matches} fixture(s), ${backfilled.results} result(s)`);
    }
    // Backfills group/tier onto results saved before those fields existed,
    // by joining back to their originating fixture (see
    // backfillResultStageData.ts) — needed so group standings computed from
    // old data can already tell pool-stage results apart from bracket ones.
    const stageBackfilled = backfillResultStageData();
    if (stageBackfilled > 0) {
      console.log(`[results] backfilled group/tier on ${stageBackfilled} result(s)`);
    }
    // Silently corrects any fixture whose tier doesn't match its own round
    // text/references (see backfillTierMismatches.ts) — a drag/swap-left-
    // the-wrong-tier-behind fixture gets fixed automatically instead of
    // needing the operator to click through the Schedule/Bracket tab's
    // repair banner; only genuinely ambiguous ones stay there.
    const tierBackfilled = backfillTierMismatches();
    if (tierBackfilled > 0) {
      console.log(`[matches] backfilled tier on ${tierBackfilled} fixture(s)`);
    }
    // One-time cleanup of any results left duplicated by the old
    // random-id scheme before results got a deterministic id per fixture
    // (see matchResultsStore's addResult) — collapses them and queues the
    // extras for cloud deletion, so standings stop double-counting.
    const removed = useMatchResultsStore.getState().dedupeBySourceSchedule();
    if (removed > 0) console.log(`[results] collapsed ${removed} duplicate saved result(s)`);
    startCloudSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global OS-level hotkeys (Button widgets + any widget's Hotkeys section)
  // — registered once at launch, re-synced internally whenever canvas state
  // changes. Desktop-host only; fires even while minimized/unfocused.
  useEffect(() => {
    if (!isDesktopHost) return;
    startHotkeyRegistry();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bracket auto-advance, groups-knockout auto-fill, and bye/walkover sync —
  // always running now, not just while the 🏆 Tournament Database window is
  // open (see tournamentAutoAdvance.ts for why). Desktop-host only, same as
  // every other write-owning background process here.
  useEffect(() => {
    if (!isDesktopHost) return;
    startTournamentAutoAdvance();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown widget → vMix text push, every second, regardless of which
  // canvas tab is currently active (see countdownVmixSync.ts — a widget on
  // an inactive tab isn't mounted at all, so its own per-render push effect
  // alone can't cover this). Desktop-host only, same as the above.
  useEffect(() => {
    if (!isDesktopHost) return;
    startCountdownVmixSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stream Deck / Companion bridge — lets a Bitfocus Companion module
  // connected as a plain read-only sync client trigger any hotkey-bound
  // action and receive REC/STR/FTB/toggle feedback (see companionBridge.ts).
  useEffect(() => {
    if (!isDesktopHost) return;
    startCompanionBridge();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-verify once at launch for an already-signed-in device — the only
  // other verify() call is right after completing sign-in itself, so a
  // long-lived 30-day token would otherwise never pick up an offline bypass
  // PIN an admin grants later. Silently no-ops offline (verify() already
  // tolerates network failure without forcing a sign-out).
  useEffect(() => {
    if (!isDesktopHost) return;
    if (authStatus === 'signed-in') useAuthStore.getState().verify();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (syncClient.isCommentator) {
    return <CommentatorApp />;
  }

  // Remote/commentator browser clients connecting to an already-running,
  // already-signed-in host are never gated here — isDesktopHost is only ever
  // true for the actual packaged app.
  if (isDesktopHost && splashDone && authStatus !== 'signed-in' && !offlineBypass) {
    return (
      <div className="app-layout">
        <SignInGate />
      </div>
    );
  }

  return (
    <div className="app-layout">
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
      <div className="app-shell">
        <Sidebar />
        <div className="app-main">
          <UndoToast />
          {isDesktopHost && (
            <div className="canvas-mode-bar">
              <button
                className={`canvas-mode-btn ${canvasMode === 'main' ? 'canvas-mode-btn--active' : ''}`}
                onClick={() => setCanvasMode('main')}
              >Main Canvas</button>
              <button
                className={`canvas-mode-btn ${canvasMode === 'commentator' ? 'canvas-mode-btn--active' : ''}`}
                onClick={() => setCanvasMode('commentator')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              ><Mic size={12} strokeWidth={2} /> Commentator</button>
            </div>
          )}
          <Canvas mode={canvasMode} />
        </div>
      </div>
    </div>
  );
}
