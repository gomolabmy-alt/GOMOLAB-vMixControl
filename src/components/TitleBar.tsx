import { useState, useRef, useEffect, useCallback } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import { useCanvasStore } from '../stores/canvasStore';
import type { VmixConnectionEntry } from '../types/vmix';
import type { SavedConnection } from '../types/vmix';

function VmixConnectDropdown({
  onClose,
  mode,
}: {
  onClose: () => void;
  mode: 'primary' | 'new';
}) {
  const { connect, connectNew, savedConnections, deleteConnection, connectionError } = useVmixStore();
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8088');
  const [name, setName] = useState('');
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleDiagnose = async () => {
    if (!host.trim()) return;
    setDiagRunning(true);
    setDiagResult(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<string>('diagnose_vmix', {
        host: host.trim(),
        port: parseInt(port, 10) || 8088,
      });
      setDiagResult(result);
    } catch (e) {
      setDiagResult(String(e));
    }
    setDiagRunning(false);
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!host.trim()) return;
    const cfg = { host: host.trim(), port: parseInt(port, 10) || 8088 };
    if (mode === 'primary') {
      await connect(cfg);
    } else {
      await connectNew(cfg, name.trim() || `${cfg.host}:${cfg.port}`);
    }
    onClose();
  };

  const handleSaved = (conn: SavedConnection) => {
    const cfg = { host: conn.host, port: conn.port };
    if (mode === 'primary') connect(cfg);
    else connectNew(cfg, conn.name);
    onClose();
  };

  return (
    <div className="titlebar-dropdown" ref={ref}>
      <div className="titlebar-dropdown-heading">
        {mode === 'new' ? 'Add vMix Connection' : 'Connect to vMix'}
      </div>
      <form onSubmit={handleConnect} className="titlebar-dropdown-form">
        <input
          className="titlebar-dropdown-host"
          type="text"
          placeholder="192.168.1.100"
          value={host}
          onChange={e => setHost(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />
        <input
          className="titlebar-dropdown-port"
          type="number"
          value={port}
          onChange={e => setPort(e.target.value)}
          min={1}
          max={65535}
        />
        <button className="titlebar-dropdown-btn" type="submit" disabled={!host.trim()}>
          Connect
        </button>
        <button
          className="titlebar-dropdown-btn"
          type="button"
          style={{ marginLeft: 4, background: '#444' }}
          disabled={!host.trim() || diagRunning}
          onClick={handleDiagnose}
        >
          {diagRunning ? '…' : 'Test'}
        </button>
      </form>
      {diagResult && (
        <pre style={{
          margin: '6px 0 0', padding: '6px 8px', background: '#111',
          color: '#ccc', fontSize: 10, borderRadius: 4,
          maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          {diagResult}
        </pre>
      )}
      {mode === 'new' && (
        <input
          className="titlebar-dropdown-host"
          style={{ marginTop: 6 }}
          type="text"
          placeholder="Label (e.g. Studio B)"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      )}
      {connectionError && mode === 'primary' && (
        <div className="titlebar-dropdown-error">{connectionError}</div>
      )}
      {savedConnections.length > 0 && (
        <ul className="titlebar-dropdown-list">
          {savedConnections.map(conn => (
            <li key={conn.id} className="titlebar-dropdown-item">
              <button className="titlebar-dropdown-item-btn" onClick={() => handleSaved(conn)}>
                <span className="titlebar-dropdown-item-name">{conn.name}</span>
                <span className="titlebar-dropdown-item-addr">{conn.host}:{conn.port}</span>
              </button>
              <button
                className="titlebar-dropdown-item-del"
                onClick={() => deleteConnection(conn.id)}
                aria-label="Remove"
              >×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectionChip({ conn, isPrimary }: { conn: VmixConnectionEntry; isPrimary: boolean }) {
  const { disconnectById, connect } = useVmixStore();
  const [showMenu, setShowMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  const retry = () => {
    connect({ host: conn.host, port: conn.port });
    setShowMenu(false);
  };

  return (
    <div className="titlebar-conn-wrap" ref={ref}>
      <button
        className={`titlebar-vmix-chip titlebar-vmix-chip--${conn.status}`}
        onClick={() => setShowMenu(v => !v)}
        title={`${conn.name} — ${conn.status}`}
      >
        <span className={`titlebar-dot titlebar-dot--${conn.status}`} />
        <span className="titlebar-vmix-label">
          {conn.status === 'connecting' ? 'Connecting…' : `${conn.host}:${conn.port}`}
        </span>
        {!isPrimary && (
          <span className="titlebar-conn-label">{conn.name}</span>
        )}
        <button
          className="titlebar-disconnect"
          onClick={e => { e.stopPropagation(); disconnectById(conn.id); }}
          title="Disconnect"
        >✕</button>
      </button>

      {showMenu && (
        <div className="titlebar-conn-menu">
          {conn.status === 'error' && (
            <button className="titlebar-conn-menu-item" onClick={retry}>↻ Retry</button>
          )}
          <div className="titlebar-conn-menu-info">
            {conn.host}:{conn.port}
          </div>
          {conn.error && (
            <div className="titlebar-conn-menu-error">{conn.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function TitleBar() {
  const { connections, vmixState, toggleRecord, toggleStream, toggleFadeToBlack } = useVmixStore();
  const { syncAllToVmix: canvasSyncAllToVmix } = useCanvasStore();
  const [showConnectMode, setShowConnectMode] = useState<'primary' | 'new' | null>(null);
  const [syncFlash, setSyncFlash] = useState(false);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  const [buildNumber, setBuildNumber] = useState<string>('');
  const [syncInfo, setSyncInfo] = useState<{
    url: string; readonlyUrl: string;
    interactiveEnabled: boolean; readonlyEnabled: boolean;
  } | null>(null);

  const refreshServerInfo = useCallback(() => {
    if (!isTauri) return;
    import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke<any>('get_server_info').then((info) => { if (info?.url) setSyncInfo(info); })
    ).catch(() => {});
  }, [isTauri]);

  useEffect(() => { refreshServerInfo(); }, [refreshServerInfo]);

  useEffect(() => {
    if (!isTauri) return;
    import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke<string>('get_build_number').then(setBuildNumber).catch(() => {})
    );
  }, [isTauri]);

  const toggleInteractive = useCallback(async () => {
    if (!isTauri) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const enabled = await invoke<boolean>('toggle_interactive');
    setSyncInfo((prev) => prev ? { ...prev, interactiveEnabled: enabled } : prev);
  }, [isTauri]);

  const toggleReadonly = useCallback(async () => {
    if (!isTauri) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const enabled = await invoke<boolean>('toggle_readonly');
    setSyncInfo((prev) => prev ? { ...prev, readonlyEnabled: enabled } : prev);
  }, [isTauri]);

  const copyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url).catch(() => {});
  }, []);

  const hasConnections = connections.length > 0;

  const handleSync = () => {
    canvasSyncAllToVmix();
    setSyncFlash(true);
    setTimeout(() => setSyncFlash(false), 800);
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      {/* Left — traffic light spacer */}
      <div className="titlebar-left" data-tauri-drag-region />

      {/* Center — drag region */}
      <div className="titlebar-center" data-tauri-drag-region>
        {isTauri && (
          <span className="titlebar-app-name">
            GOMOLAB vMix Control{buildNumber ? ` #${buildNumber}` : ''}
          </span>
        )}
      </div>

      {/* Right — transport buttons + connections */}
      <div className="titlebar-right">
        {vmixState && (
          <>
            <button
              className={`titlebar-transport-btn ${syncFlash ? 'titlebar-transport-btn--flash' : ''}`}
              onClick={handleSync}
              title="Push all timer and scoreboard values to vMix"
            >{syncFlash ? '✓' : '↑'} Sync</button>
            <button
              className={`titlebar-transport-btn ${vmixState.recording ? 'titlebar-transport-btn--rec' : ''}`}
              onClick={toggleRecord}
              title="Toggle Recording"
            >● REC</button>
            <button
              className={`titlebar-transport-btn ${vmixState.streaming ? 'titlebar-transport-btn--rec' : ''}`}
              onClick={toggleStream}
              title="Toggle Streaming"
            >▶ STR</button>
            <button
              className={`titlebar-transport-btn ${vmixState.fadeToBlack ? 'titlebar-transport-btn--ftb' : ''}`}
              onClick={toggleFadeToBlack}
              title="Fade to Black"
            >FTB</button>
            <div className="titlebar-sep" />
          </>
        )}

        {syncInfo && (
          <>
            <div className={`sync-port-chip ${syncInfo.interactiveEnabled ? 'sync-port-chip--on' : 'sync-port-chip--off'}`}>
              <button
                className="sync-port-url"
                onClick={() => copyUrl(syncInfo.url)}
                title={`Interactive URL (click to copy)\n${syncInfo.url}`}
              >⚡ {syncInfo.url.replace('http://', '')}</button>
              <button
                className="sync-port-toggle"
                onClick={toggleInteractive}
                title={syncInfo.interactiveEnabled ? 'Disable interactive access' : 'Enable interactive access'}
              >{syncInfo.interactiveEnabled ? 'ON' : 'OFF'}</button>
            </div>
            <div className={`sync-port-chip sync-port-chip--ro ${syncInfo.readonlyEnabled ? 'sync-port-chip--on' : 'sync-port-chip--off'}`}>
              <button
                className="sync-port-url"
                onClick={() => copyUrl(syncInfo.readonlyUrl)}
                title={`Read-only URL (click to copy)\n${syncInfo.readonlyUrl}`}
              >👁 {syncInfo.readonlyUrl.replace('http://', '')}</button>
              <button
                className="sync-port-toggle"
                onClick={toggleReadonly}
                title={syncInfo.readonlyEnabled ? 'Disable read-only access' : 'Enable read-only access'}
              >{syncInfo.readonlyEnabled ? 'ON' : 'OFF'}</button>
            </div>
            <div className="titlebar-sep" />
          </>
        )}

        {!hasConnections ? (
          <button
            className="titlebar-vmix-chip titlebar-vmix-chip--disconnected"
            onClick={() => setShowConnectMode('primary')}
            title="Connect to vMix"
          >
            <span className="titlebar-dot titlebar-dot--disconnected" />
            <span className="titlebar-vmix-label">vMix — tap to connect</span>
          </button>
        ) : (
          <div className="titlebar-conn-list">
            {connections.map((conn, i) => (
              <ConnectionChip key={conn.id} conn={conn} isPrimary={i === 0} />
            ))}
            <button
              className="titlebar-add-conn"
              onClick={() => setShowConnectMode('new')}
              title="Add another vMix connection"
            >+ vMix</button>
          </div>
        )}

        {showConnectMode && (
          <VmixConnectDropdown
            mode={showConnectMode}
            onClose={() => setShowConnectMode(null)}
          />
        )}
      </div>
    </div>
  );
}
