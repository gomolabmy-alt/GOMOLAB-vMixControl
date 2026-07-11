import { useState, useRef, useEffect, useCallback } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import { useCanvasStore } from '../stores/canvasStore';
import { syncClient } from '../lib/syncClient';
import type { VmixConnectionEntry } from '../types/vmix';
import type { SavedConnection } from '../types/vmix';

type ScanState = 'idle' | 'scanning' | 'done';

function VmixConnectDropdown({
  onClose,
}: {
  onClose: () => void;
}) {
  const { connect, savedConnections, deleteConnection, connectionError } = useVmixStore();
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8088');
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanSubnet, setScanSubnet] = useState('');
  const [scanResults, setScanResults] = useState<string[]>([]);
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
    await connect(cfg);
    onClose();
  };

  const quickConnect = (ip: string) => {
    const cfg = { host: ip, port: parseInt(port, 10) || 8088 };
    connect(cfg);
    onClose();
  };

  const handleSaved = (conn: SavedConnection) => {
    const cfg = { host: conn.host, port: conn.port };
    connect(cfg);
    onClose();
  };

  const handleScan = async () => {
    setScanState('scanning');
    setScanResults([]);
    const scanPort = parseInt(port, 10) || 8088;

    // Collect every unique /24 subnet from all local network interfaces.
    // A Mac often has Wi-Fi + Ethernet + VPN — scanning only the first
    // interface missed vMix when it lives on a different one.
    const subnets: string[] = [];
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const ips = await invoke<string[]>('get_local_ips');
      for (const ip of ips) {
        if (ip.startsWith('127.')) continue;
        const parts = ip.split('.');
        if (parts.length === 4) {
          const sn = `${parts[0]}.${parts[1]}.${parts[2]}`;
          if (!subnets.includes(sn)) subnets.push(sn);
        }
      }
    } catch {}

    // Fallback: derive from window.location hostname
    if (subnets.length === 0 && typeof window !== 'undefined') {
      const h = window.location.hostname;
      if (h && h !== 'localhost' && h !== '127.0.0.1') {
        const parts = h.split('.');
        if (parts.length === 4) subnets.push(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }

    if (subnets.length === 0) {
      setScanSubnet('');
      setScanState('done');
      return;
    }

    setScanSubnet(subnets.join(', '));

    // Build full candidate list across all detected subnets
    const candidates: string[] = [];
    for (const sn of subnets) {
      for (let i = 1; i <= 254; i++) candidates.push(`${sn}.${i}`);
    }

    const found: string[] = [];

    // Sliding-window concurrent scan: max 50 in-flight at once.
    // Flooding all 254 simultaneously can cause routers / WKWebView to
    // drop packets, including the one to the actual vMix machine.
    // 1500 ms timeout gives LAN hosts plenty of time to respond.
    const CONCURRENCY = 50;
    const TIMEOUT_MS  = 1500;

    await new Promise<void>((resolve) => {
      let idx = 0;
      let inFlight = 0;

      function startNext() {
        while (inFlight < CONCURRENCY && idx < candidates.length) {
          const ip = candidates[idx++];
          inFlight++;
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
          fetch(`http://${ip}:${scanPort}/api`, { signal: ctrl.signal })
            .then(async (res) => {
              clearTimeout(tid);
              if (res.ok) {
                const text = await res.text();
                if (text.includes('<vmix')) found.push(ip);
              }
            })
            .catch(() => { clearTimeout(tid); })
            .finally(() => {
              inFlight--;
              startNext();
            });
        }
        if (idx >= candidates.length && inFlight === 0) resolve();
      }

      startNext();
    });

    setScanResults(found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    setScanState('done');
  };

  return (
    <div className="titlebar-dropdown" ref={ref}>
      <div className="titlebar-dropdown-heading">
        Connect to vMix
      </div>

      {/* Manual IP entry */}
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
          style={{ background: 'var(--bg-3)', color: 'var(--text-primary)' }}
          disabled={!host.trim() || diagRunning}
          onClick={handleDiagnose}
        >
          {diagRunning ? '…' : 'Test'}
        </button>
      </form>

      {diagResult && (
        <pre className="titlebar-diag-result">{diagResult}</pre>
      )}

      {connectionError && (
        <div className="titlebar-dropdown-error">{connectionError}</div>
      )}

      {/* Scan section */}
      <div className="titlebar-scan-row">
        <button
          className="titlebar-scan-btn"
          type="button"
          onClick={handleScan}
          disabled={scanState === 'scanning'}
        >
          {scanState === 'scanning' ? '⟳ Scanning…' : '⊙ Scan Network'}
        </button>
        {scanState === 'scanning' && (
          <span className="titlebar-scan-hint">
            Scanning {scanSubnet.split(', ').map(s => `${s}.x`).join(', ')}:{port}…
          </span>
        )}
        {scanState === 'done' && scanResults.length === 0 && (
          <span className="titlebar-scan-hint">
            {scanSubnet
              ? `No vMix found on ${scanSubnet.split(', ').map(s => `${s}.x`).join(', ')}`
              : 'Could not detect local network'}
          </span>
        )}
      </div>

      {scanState === 'done' && scanResults.length > 0 && (
        <>
          <div className="titlebar-scan-found-label">Found {scanResults.length} vMix instance{scanResults.length > 1 ? 's' : ''}:</div>
          <ul className="titlebar-dropdown-list" style={{ marginTop: 4 }}>
            {scanResults.map(ip => (
              <li key={ip} className="titlebar-dropdown-item">
                <button className="titlebar-dropdown-item-btn" onClick={() => setHost(ip)}>
                  <span className="titlebar-dropdown-item-name">{ip}</span>
                  <span className="titlebar-dropdown-item-addr">:{port}</span>
                </button>
                <button
                  className="titlebar-dropdown-btn titlebar-scan-connect-btn"
                  onClick={() => quickConnect(ip)}
                >→</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Saved connections */}
      {savedConnections.length > 0 && (
        <ul className="titlebar-dropdown-list">
          <li className="titlebar-dropdown-section-label">Saved</li>
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

function ConnectionChip({ conn }: { conn: VmixConnectionEntry }) {
  const { disconnect, connect } = useVmixStore();
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
        <button
          className="titlebar-disconnect"
          onClick={e => { e.stopPropagation(); disconnect(); }}
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
  const { connection, remoteVmixConnections, vmixState, toggleRecord, toggleStream, toggleFadeToBlack } = useVmixStore();
  const { syncAllToVmix: canvasSyncAllToVmix } = useCanvasStore();
  const [showConnect, setShowConnect] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const isBrowserClient = !syncClient.isHost;

  const [buildNumber, setBuildNumber] = useState<string>('');
  const [syncInfo, setSyncInfo] = useState<{
    url: string; readonlyUrl: string; commentatorUrl: string;
    interactiveEnabled: boolean; readonlyEnabled: boolean; commentatorEnabled: boolean;
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

  const toggleCommentator = useCallback(async () => {
    if (!isTauri) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const enabled = await invoke<boolean>('toggle_commentator');
    setSyncInfo((prev) => prev ? { ...prev, commentatorEnabled: enabled } : prev);
  }, [isTauri]);

  const copyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url).catch(() => {});
  }, []);

  const hasConnections = !!connection;

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
            GOMOLAB vMix Control{buildNumber ? ` Build ${buildNumber}` : ''}
          </span>
        )}
      </div>

      {/* Right — transport buttons + connections */}
      <div className="titlebar-right">
        {vmixState && (
          <>
            {!isBrowserClient && (
              <button
                className={`titlebar-transport-btn ${syncFlash ? 'titlebar-transport-btn--flash' : ''}`}
                onClick={handleSync}
                title="Push all timer and scoreboard values to vMix"
              >{syncFlash ? '✓' : '↑'} Sync</button>
            )}
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

        {syncInfo && !isBrowserClient && (
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
            <div className={`sync-port-chip sync-port-chip--cmt ${syncInfo.commentatorEnabled ? 'sync-port-chip--on' : 'sync-port-chip--off'}`}>
              <button
                className="sync-port-url"
                onClick={() => copyUrl(syncInfo.commentatorUrl)}
                title={`Commentator URL (click to copy)\n${syncInfo.commentatorUrl}`}
              >🎙 {syncInfo.commentatorUrl.replace('http://', '')}</button>
              <button
                className="sync-port-toggle"
                onClick={toggleCommentator}
                title={syncInfo.commentatorEnabled ? 'Disable commentator access' : 'Enable commentator access'}
              >{syncInfo.commentatorEnabled ? 'ON' : 'OFF'}</button>
            </div>
            <div className="titlebar-sep" />
          </>
        )}

        {isBrowserClient ? (
          remoteVmixConnections.length === 0 ? (
            <div className="titlebar-vmix-chip titlebar-vmix-chip--disconnected">
              <span className="titlebar-dot titlebar-dot--disconnected" />
              <span className="titlebar-vmix-label">No host connection</span>
            </div>
          ) : (
            <div className="titlebar-conn-list">
              {remoteVmixConnections.map((conn) => (
                <div key={conn.id} className={`titlebar-vmix-chip titlebar-vmix-chip--${conn.status}`}>
                  <span className={`titlebar-dot titlebar-dot--${conn.status}`} />
                  <span className="titlebar-vmix-label">{conn.host}:{conn.port}</span>
                </div>
              ))}
            </div>
          )
        ) : !hasConnections ? (
          <button
            className="titlebar-vmix-chip titlebar-vmix-chip--disconnected"
            onClick={() => setShowConnect(true)}
            title="Connect to vMix"
          >
            <span className="titlebar-dot titlebar-dot--disconnected" />
            <span className="titlebar-vmix-label">vMix — tap to connect</span>
          </button>
        ) : (
          <div className="titlebar-conn-list">
            <ConnectionChip conn={connection!} />
          </div>
        )}

        {showConnect && (
          <VmixConnectDropdown
            onClose={() => setShowConnect(false)}
          />
        )}
      </div>
    </div>
  );
}
