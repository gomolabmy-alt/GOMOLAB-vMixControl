import { useRef, useState } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { useCloudSyncStatus } from '../stores/cloudSyncStatusStore';
import { ProjectMenu } from './ProjectMenu';
import { CanvasTournamentPicker } from './CanvasTournamentPicker';
import { TournamentManager } from './TournamentManager';
import { AppSettingsModal } from './AppSettingsModal';
import { VmixStatsPanel } from './VmixStatsPanel';
import { UndoControl } from './UndoControl';
import { syncClient } from '../lib/syncClient';

export function StatusBar() {
  const {
    vmixState,
    lastUpdated,
    connection,
    connectionLog,
    resyncAll,
    remoteVmixConnections,
    browserClients,
  } = useVmixStore();
  // Kept as a 0-or-1-element array so the rest of this component (built for
  // a connection list) doesn't need to change shape.
  const connections = connection ? [connection] : [];

  const { resetMatchData, editMode, setEditMode } = useCanvasStore();
  const { theme, setTheme } = useAppSettings();
  const { pushing, pulling, lastError } = useCloudSyncStatus();
  const isSyncingCloud = pushing || pulling;
  const isReadOnly = syncClient.isReadOnly;
  const [showTournamentDb, setShowTournamentDb] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const statsAnchorRef = useRef<HTMLButtonElement>(null);

  const handleSyncNow = () => {
    resyncAll();
    setSyncFlash(true);
    setTimeout(() => setSyncFlash(false), 800);
  };

  const secondsAgo = lastUpdated ? Math.floor((Date.now() - lastUpdated) / 1000) : null;
  const isStale = secondsAgo !== null && secondsAgo > 10;

  const midTrunc = (name: string, max = 22) => {
    if (name.length <= max) return name;
    const half = Math.floor((max - 1) / 2);
    return `${name.slice(0, half)}…${name.slice(-half)}`;
  };

  const isBrowserClient = !syncClient.isHost;

  // On browser clients, show connections from the host via VMIX_STATUS broadcast
  const displayConns = isBrowserClient ? remoteVmixConnections : connections;
  const connectedCount = displayConns.filter(c => c.status === 'connected').length;
  const errorCount = displayConns.filter(c => c.status === 'error').length;
  const hasNewErrors = !isBrowserClient && connectionLog.some(e => e.event === 'error');

  const overallDot =
    errorCount > 0 ? 'error' :
    connectedCount > 0 ? 'connected' :
    displayConns.some(c => c.status === 'connecting') ? 'connecting' :
    'disconnected';

  return (
    <header className="status-bar" style={{ position: 'relative' }}>
      {isSyncingCloud && (
        <div className="sync-progress-bar" title={pushing ? 'Pushing changes to the cloud…' : 'Pulling updates from the cloud…'}>
          <div className="sync-progress-bar__fill" />
        </div>
      )}
      <div className="status-bar-left">
        {isBrowserClient ? (
          // Browser client: non-interactive chip showing remote vMix connections with host IP
          <div
            className="vmix-conn-chip"
            title={remoteVmixConnections.map(c => `${c.name}  ${c.host}:${c.port}  ${c.status}${c.edition ? `  (${c.edition})` : ''}`).join('\n') || 'No vMix connection on host'}
          >
            <span className={`status-dot status-dot--${overallDot}`} />
            <span className="vmix-conn-label">vMix</span>
            {remoteVmixConnections.length > 0 && (
              <span className="vmix-conn-count">{connectedCount}/{remoteVmixConnections.length}</span>
            )}
            {remoteVmixConnections.map(c => (
              <span key={c.id} className="vmix-stats-chip vmix-stats-chip--host" title={`${c.name}: ${c.host}:${c.port}`}>
                {c.host}
              </span>
            ))}
          </div>
        ) : (
          <>
            <button
              ref={statsAnchorRef}
              className={`vmix-conn-chip${showStats ? ' vmix-conn-chip--open' : ''}`}
              onClick={() => setShowStats(v => !v)}
              title="vMix connection stats & log"
            >
              <span className={`status-dot status-dot--${overallDot}`} />
              <span className="vmix-conn-label">vMix</span>
              {connections.length > 0 && (
                <span className="vmix-conn-count">{connectedCount}/{connections.length}</span>
              )}
              {hasNewErrors && <span className="vmix-conn-alert">!</span>}
            </button>
            {browserClients.length > 0 && (
              <div
                className="vmix-conn-chip vmix-browser-clients"
                title={browserClients.map(c => `${c.ip}  (${c.kind})`).join('\n')}
              >
                <span className="status-dot status-dot--connected" />
                <span className="vmix-conn-label">Clients</span>
                <span className="vmix-conn-count">{browserClients.length}</span>
                <span className="vmix-browser-ips">
                  {[...new Set(browserClients.map(c => c.ip))].join(', ')}
                </span>
              </div>
            )}
          </>
        )}
        {!isBrowserClient && connections.some(c => c.status === 'connected') && (
          <button
            className={`vmix-sync-btn${syncFlash ? ' vmix-sync-btn--flash' : ''}`}
            onClick={handleSyncNow}
            title="Force push all app data to vMix now"
          >⟳ Sync</button>
        )}
        {!isBrowserClient && vmixState && (
          <span className="status-edition" title={`vMix ${vmixState.version}`}>
            {vmixState.edition}
          </span>
        )}
        {!isBrowserClient && isStale && <span className="status-stale">⚠ stale</span>}
      </div>

      <div className="status-bar-center">
        {vmixState && (
          <>
            <div className="tally-block">
              <span className="tally-label">PRV</span>
              <span className="tally-number tally-number--preview" title={vmixState.inputs.find(i => i.number === vmixState.preview)?.title}>
                {midTrunc(vmixState.inputs.find(i => i.number === vmixState.preview)?.title ?? String(vmixState.preview))}
              </span>
            </div>
            <div className="tally-block">
              <span className="tally-label">PGM</span>
              <span className="tally-number tally-number--active" title={vmixState.inputs.find(i => i.number === vmixState.active)?.title}>
                {midTrunc(vmixState.inputs.find(i => i.number === vmixState.active)?.title ?? String(vmixState.active))}
              </span>
            </div>
            {vmixState.overlays.filter(o => o.key !== '' || o.inputNumber > 0).map(o => {
              const stripBraces = (k: string) => k.toLowerCase().replace(/^\{|\}$/g, '').trim();
              const ovlKey = stripBraces(o.key);
              const ovlInput =
                (ovlKey ? vmixState.inputs.find(i => stripBraces(i.key) === ovlKey) : null)
                ?? (o.inputNumber > 0 ? vmixState.inputs.find(i => i.number === o.inputNumber) : null);
              const ovlTitle = ovlInput?.title ?? (o.inputNumber > 0 ? `Input ${o.inputNumber}` : `OVL ${o.number}`);
              return (
                <div key={o.number} className="tally-block">
                  <span className="tally-label tally-label--overlay">OVL{o.number}</span>
                  <span className="tally-number tally-number--overlay" title={ovlTitle}>
                    {midTrunc(ovlTitle)}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="status-bar-right">
        {isSyncingCloud && (
          <span className="sync-status-chip" title={pushing ? 'Pushing changes to the cloud…' : 'Pulling updates from the cloud…'}>
            <span className="sync-status-spinner" />
            {pushing ? 'Saving…' : 'Syncing…'}
          </span>
        )}
        {!isSyncingCloud && lastError && (
          <span className="sync-status-chip sync-status-chip--error" title={lastError}>⚠ Sync failed</span>
        )}
        <button
          className="status-btn status-btn--db"
          onClick={() => setShowTournamentDb(true)}
          title="Tournament Database"
        >🏆 DB</button>
        <CanvasTournamentPicker />
        <UndoControl />
        {confirmReset ? (
          <span className="status-reset-confirm">
            <span className="status-reset-confirm-label">Reset match?</span>
            <button className="status-btn status-btn--danger" onClick={() => { resetMatchData(); setConfirmReset(false); }}>Yes</button>
            <button className="status-btn" onClick={() => setConfirmReset(false)}>No</button>
          </span>
        ) : (
          <button
            className="status-btn status-btn--reset"
            onClick={() => setConfirmReset(true)}
            title="Reset all match data (scores, timers, player tracking, timeline)"
          >↺ Reset</button>
        )}
        <ProjectMenu />
        <button
          className={`status-btn status-btn--theme`}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >{theme === 'dark' ? '☀' : '🌙'}</button>
        <button
          className="status-btn status-btn--settings"
          onClick={() => setShowSettings(true)}
          title="App settings"
        >⚙</button>
        {isReadOnly ? (
          <span className="canvas-readonly-badge">View Only</span>
        ) : (
          <button
            className={`status-btn status-btn--edit ${editMode ? 'status-btn--edit-active' : ''}`}
            onClick={() => setEditMode(!editMode)}
            title={editMode ? 'Exit edit mode' : 'Enter edit mode'}
          >
            {editMode ? '✓ Done' : '✏ Edit'}
          </button>
        )}
      </div>

      {showTournamentDb && <TournamentManager onClose={() => setShowTournamentDb(false)} />}
      {showSettings && <AppSettingsModal onClose={() => setShowSettings(false)} />}
      {!isBrowserClient && showStats && (
        <VmixStatsPanel
          anchorRef={statsAnchorRef}
          onClose={() => setShowStats(false)}
        />
      )}
    </header>
  );
}
