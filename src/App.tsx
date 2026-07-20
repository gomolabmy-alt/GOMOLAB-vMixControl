import { useEffect, useState } from 'react';
import { useVmixStore } from './stores/vmixStore';
import { useAppSettings } from './stores/appSettingsStore';
import { TitleBar } from './components/TitleBar';
import { StatusBar } from './components/StatusBar';
import { Canvas } from './components/Canvas';
import { SplashScreen } from './components/SplashScreen';
import { SignInGate } from './components/SignInGate';
import { UndoToast } from './components/UndoToast';
import { useAuthStore } from './stores/authStore';
import { syncClient } from './lib/syncClient';
import { startCloudSync } from './lib/cloudSync';

function CommentatorApp() {
  const { theme, setTheme } = useAppSettings();
  return (
    <div className="app-layout" style={{ background: '#111' }}>
      <button
        className="commentator-theme-btn"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >{theme === 'dark' ? '☀' : '🌙'}</button>
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
  // signed in, so this is safe to start before that happens.
  useEffect(() => {
    if (!isDesktopHost) return;
    startCloudSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (syncClient.isCommentator) {
    return <CommentatorApp />;
  }

  // Remote/commentator browser clients connecting to an already-running,
  // already-signed-in host are never gated here — isDesktopHost is only ever
  // true for the actual packaged app.
  if (isDesktopHost && splashDone && authStatus !== 'signed-in') {
    return (
      <div className="app-layout">
        <SignInGate />
      </div>
    );
  }

  return (
    <div className="app-layout">
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
      <TitleBar />
      <StatusBar />
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
          >🎙 Commentator</button>
        </div>
      )}
      <Canvas mode={canvasMode} />
    </div>
  );
}
