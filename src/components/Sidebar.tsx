import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  MapPin, Lock, User, Monitor, BarChart3, ArrowUp, Check, Circle, Play,
  RotateCw, AlertTriangle, RotateCcw, Sun, Moon, Settings, Pencil, Zap,
  Eye, Mic, Wifi, Trophy, X, ArrowRight,
} from 'lucide-react';
import { useVmixStore } from '../stores/vmixStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { useAuthStore } from '../stores/authStore';
import { useCloudSyncStatus } from '../stores/cloudSyncStatusStore';
import { syncClient } from '../lib/syncClient';
import { ProjectMenu } from './ProjectMenu';
import { CanvasTournamentPicker } from './CanvasTournamentPicker';
import { TournamentManager } from './TournamentManager';
import { AppSettingsModal } from './AppSettingsModal';
import { VmixStatsPanel } from './VmixStatsPanel';
import { UndoControl } from './UndoControl';
import type { VmixConnectionEntry } from '../types/vmix';
import type { SavedConnection } from '../types/vmix';

type ScanState = 'idle' | 'scanning' | 'done';

// ── Venue scope (tournament + venue this physical install is scoped to) ────
function SidebarVenueScope() {
  const { tournaments } = useTournamentStore();
  const { canvasTournamentId, setCanvasTournamentId, canvasVenue, setCanvasVenue } = useAppSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const activeTournament = tournaments.find(t => t.id === canvasTournamentId);
  const venues = activeTournament?.venues ?? [];
  const label = activeTournament ? (canvasVenue || 'All Venues') : 'All Tournaments';

  return (
    <div className="sb-popover" ref={ref}>
      <button className="sb-row" onClick={() => setOpen(o => !o)} title="Filter Upcoming Matches / Load Match to one tournament & venue">
        <span className="sb-row-icon"><MapPin size={14} strokeWidth={2} /></span>
        <span className="sb-row-text">{label}</span>
      </button>
      {open && (
        <div className="sb-popover-panel">
          <label className="sb-popover-label">Tournament</label>
          <select className="sb-popover-select" value={canvasTournamentId} onChange={e => setCanvasTournamentId(e.target.value)}>
            <option value="">All Tournaments</option>
            {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {activeTournament && (
            <>
              <label className="sb-popover-label">Venue</label>
              <select className="sb-popover-select" value={canvasVenue} onChange={e => setCanvasVenue(e.target.value)} disabled={venues.length === 0}>
                <option value="">All Venues</option>
                {venues.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
              {venues.length === 0 && <div className="sb-popover-hint">No venues set up — DB → Schedule tab</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Signed-in user / offline-bypass chip ────────────────────────────────────
function SidebarAuthChip() {
  const { user, signOut, offlineBypass, exitBypass } = useAuthStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!user && !offlineBypass) return null;

  if (offlineBypass) {
    return (
      <div className="sb-popover" ref={ref}>
        <button className="sb-row" onClick={() => setOpen(o => !o)} title="Using GOMOLAB vMix Control offline via PIN bypass — not signed in, cloud sync is off">
          <span className="sb-row-icon"><Lock size={14} strokeWidth={2} /></span>
          <span className="sb-row-text">Offline Mode</span>
        </button>
        {open && (
          <div className="sb-popover-panel">
            <button className="sb-popover-select" style={{ cursor: 'pointer' }} onClick={() => { exitBypass(); setOpen(false); }}>
              Exit Offline Mode
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="sb-popover" ref={ref}>
      <button className="sb-row" onClick={() => setOpen(o => !o)} title={user!.email}>
        <span className="sb-row-icon"><User size={14} strokeWidth={2} /></span>
        <span className="sb-row-text">{user!.name}</span>
      </button>
      {open && (
        <div className="sb-popover-panel">
          <button className="sb-popover-select" style={{ cursor: 'pointer' }} onClick={() => { signOut(); setOpen(false); }}>
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}

// ── Clock + time zone picker ─────────────────────────────────────────────
function SidebarClock() {
  const { clockTimeZone, setClockTimeZone } = useAppSettings();
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setSearch(''); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const allZones: string[] = useMemo(() => {
    try {
      const supported = (Intl as any).supportedValuesOf;
      return supported ? supported('timeZone') : [];
    } catch { return []; }
  }, []);

  const filtered = search
    ? allZones.filter(z => z.toLowerCase().includes(search.toLowerCase()))
    : allZones;

  let timeStr: string;
  try {
    timeStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: clockTimeZone || undefined,
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now);
  } catch {
    timeStr = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now);
  }

  const tzLabel = clockTimeZone ? clockTimeZone.split('/').pop()!.replace(/_/g, ' ') : 'Local';

  return (
    <div className="sb-popover sb-clock" ref={ref}>
      <button className="sb-clock-btn" onClick={() => setOpen(o => !o)} title="Click to change time zone">
        <span className="sb-clock-time">{timeStr}</span>
        <span className="sb-clock-tz">{tzLabel}</span>
      </button>
      {open && (
        <div className="sb-popover-panel sb-popover-panel--up">
          <input
            className="sb-popover-search"
            placeholder="Search time zone…"
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <ul className="sb-popover-list">
            <li
              className={`sb-popover-item${!clockTimeZone ? ' sb-popover-item--selected' : ''}`}
              onClick={() => { setClockTimeZone(''); setOpen(false); setSearch(''); }}
            ><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Monitor size={12} strokeWidth={2} /> System (Local)</span></li>
            {filtered.length === 0
              ? <li className="sb-popover-empty">No matching time zone</li>
              : filtered.map(z => (
                <li
                  key={z}
                  className={`sb-popover-item${z === clockTimeZone ? ' sb-popover-item--selected' : ''}`}
                  onClick={() => { setClockTimeZone(z); setOpen(false); setSearch(''); }}
                >{z.replace(/_/g, ' ')}</li>
              ))
            }
          </ul>
        </div>
      )}
    </div>
  );
}

// ── vMix connect dropdown (manual host entry, network scan, saved list) ────
function VmixConnectPanel({ onClose, anchorRef }: { onClose: () => void; anchorRef: React.RefObject<HTMLButtonElement> }) {
  const { connect, savedConnections, deleteConnection, connectionError } = useVmixStore();
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8088');
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanSubnet, setScanSubnet] = useState('');
  const [scanResults, setScanResults] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  // Rendered via a portal into document.body, positioned with fixed
  // coordinates: this panel lives in the sidebar's own scroll container
  // (`.sb-scroll`, overflow-x: hidden), which would silently clip it once
  // it grows past the sidebar's ~250px width — same fix as
  // CanvasTournamentPicker/TeamPicker.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const panelWidth = 300;
    setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - panelWidth - 12) });
  }, [anchorRef]);

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

  if (!pos) return null;
  return createPortal(
    <div className="sb-popover-panel sb-popover-panel--wide" ref={ref} style={{ position: 'fixed', top: pos.top, left: pos.left }}>
      <div className="sb-popover-heading">
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
          {scanState === 'scanning'
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><RotateCw size={12} strokeWidth={2} /> Scanning…</span>
            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Wifi size={12} strokeWidth={2} /> Scan Network</span>}
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
                ><ArrowRight size={14} strokeWidth={2} /></button>
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
              ><X size={12} strokeWidth={2} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body
  );
}

function SidebarConnectionChip({ conn }: { conn: VmixConnectionEntry }) {
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
    <div className="sb-popover" ref={ref}>
      <button
        className={`sb-row sb-row--vmix sb-row--${conn.status}`}
        onClick={() => setShowMenu(v => !v)}
        title={`${conn.name} — ${conn.status}`}
      >
        <span className={`status-dot status-dot--${conn.status}`} />
        <span className="sb-row-text">
          {conn.status === 'connecting' ? 'Connecting…' : `${conn.host}:${conn.port}`}
        </span>
        <button
          className="sb-row-inline-btn"
          onClick={e => { e.stopPropagation(); disconnect(); }}
          title="Disconnect"
        ><X size={11} strokeWidth={2} /></button>
      </button>

      {showMenu && (
        <div className="sb-popover-panel">
          {conn.status === 'error' && (
            <button className="sb-popover-select" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={retry}><RotateCw size={12} strokeWidth={2} /> Retry</button>
          )}
          <div className="sb-popover-hint">{conn.host}:{conn.port}</div>
          {conn.error && <div className="sb-popover-hint" style={{ color: 'var(--red)' }}>{conn.error}</div>}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { connection, remoteVmixConnections, vmixState, toggleRecord, toggleStream, toggleFadeToBlack, lastUpdated, connectionLog, resyncAll, browserClients } = useVmixStore();
  const { syncAllToVmix: canvasSyncAllToVmix, resetMatchData, editMode, setEditMode } = useCanvasStore();
  const { theme, setTheme, sidebarCollapsed, setSidebarCollapsed } = useAppSettings();
  const { pushing, pulling, lastError } = useCloudSyncStatus();
  const [showConnect, setShowConnect] = useState(false);
  const [canvasSyncFlash, setCanvasSyncFlash] = useState(false);
  const [vmixSyncFlash, setVmixSyncFlash] = useState(false);
  const [showTournamentDb, setShowTournamentDb] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const statsAnchorRef = useRef<HTMLButtonElement>(null);
  const connectAnchorRef = useRef<HTMLButtonElement>(null);

  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const isBrowserClient = !syncClient.isHost;
  const isReadOnly = syncClient.isReadOnly;

  const [buildNumber, setBuildNumber] = useState<string>('');
  const [pid, setPid] = useState<number | null>(null);
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
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string>('get_build_number').then(setBuildNumber).catch(() => {});
      invoke<number>('get_pid').then(setPid).catch(() => {});
    });
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
  const isSyncingCloud = pushing || pulling;

  // Kept as a 0-or-1-element array — same shape the old status bar used.
  const connections = connection ? [connection] : [];
  const displayConns = isBrowserClient ? remoteVmixConnections : connections;
  const connectedCount = displayConns.filter(c => c.status === 'connected').length;
  const errorCount = displayConns.filter(c => c.status === 'error').length;
  const hasNewErrors = !isBrowserClient && connectionLog.some(e => e.event === 'error');
  const overallDot =
    errorCount > 0 ? 'error' :
    connectedCount > 0 ? 'connected' :
    displayConns.some(c => c.status === 'connecting') ? 'connecting' :
    'disconnected';

  const secondsAgo = lastUpdated ? Math.floor((Date.now() - lastUpdated) / 1000) : null;
  const isStale = secondsAgo !== null && secondsAgo > 10;

  const midTrunc = (name: string, max = 26) => {
    if (name.length <= max) return name;
    const half = Math.floor((max - 1) / 2);
    return `${name.slice(0, half)}…${name.slice(-half)}`;
  };

  const handleCanvasSync = () => {
    canvasSyncAllToVmix();
    setCanvasSyncFlash(true);
    setTimeout(() => setCanvasSyncFlash(false), 800);
  };
  const handleVmixResync = () => {
    resyncAll();
    setVmixSyncFlash(true);
    setTimeout(() => setVmixSyncFlash(false), 800);
  };

  return (
    <aside className={`app-sidebar${sidebarCollapsed ? ' app-sidebar--collapsed' : ''}`}>
      {/* Header — also the window's drag handle (macOS traffic lights sit in
          the reserved top-left corner; titleBarStyle:"Overlay" in
          tauri.conf.json means they float over whatever's here, they don't
          need dedicated chrome of their own). */}
      <div className="sb-head" data-tauri-drag-region>
        <div className="sb-mark" data-tauri-drag-region>G</div>
        <div className="sb-wordmark" data-tauri-drag-region>
          <div className="sb-name">GOMOLAB vMix Control</div>
          {buildNumber && <div className="sb-build">Build {buildNumber}{pid !== null ? ` · PID ${pid}` : ''}</div>}
        </div>
        <button
          className="sb-collapse-btn"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Minimize sidebar — maximizes canvas space'}
        >{sidebarCollapsed ? '»' : '«'}</button>
      </div>

      {/* Everything except Utilities/Clock scrolls independently in here —
          those two stay pinned below, always visible without scrolling. */}
      <div className="sb-scroll">
      {isTauri && (
        <div className="sb-section">
          <SidebarAuthChip />
        </div>
      )}

      <div className="sb-section">
        <div className="sb-label">Tournament</div>
        <button className="sb-row" onClick={() => setShowTournamentDb(true)} title="Tournament Database">
          <span className="sb-row-icon"><Trophy size={14} strokeWidth={2} /></span>
          <span className="sb-row-text">Database</span>
        </button>
        <SidebarVenueScope />
        <div className="sb-row-wrap"><CanvasTournamentPicker /></div>
      </div>

      <div className="sb-section">
        <div className="sb-label">vMix</div>
        {isBrowserClient ? (
          remoteVmixConnections.length === 0 ? (
            <div className="sb-row sb-row--static">
              <span className="status-dot status-dot--disconnected" />
              <span className="sb-row-text">No host connection</span>
            </div>
          ) : (
            remoteVmixConnections.map(conn => (
              <div key={conn.id} className={`sb-row sb-row--static sb-row--${conn.status}`}>
                <span className={`status-dot status-dot--${conn.status}`} />
                <span className="sb-row-text">{conn.host}:{conn.port}</span>
              </div>
            ))
          )
        ) : !hasConnections ? (
          <button ref={connectAnchorRef} className="sb-row" onClick={() => setShowConnect(true)} title="Connect to vMix">
            <span className="status-dot status-dot--disconnected" />
            <span className="sb-row-text">Tap to connect</span>
          </button>
        ) : (
          <SidebarConnectionChip conn={connection!} />
        )}
        {showConnect && <VmixConnectPanel onClose={() => setShowConnect(false)} anchorRef={connectAnchorRef} />}

        {!isBrowserClient && (
          <button
            ref={statsAnchorRef}
            className={`sb-row${showStats ? ' sb-row--active' : ''}`}
            onClick={() => setShowStats(v => !v)}
            title="vMix connection stats & log"
          >
            <span className="sb-row-icon"><BarChart3 size={14} strokeWidth={2} /></span>
            <span className="sb-row-text">
              Stats {connections.length > 0 ? `${connectedCount}/${connections.length}` : ''}
            </span>
            {hasNewErrors && <span className="sb-row-alert">!</span>}
          </button>
        )}
        {browserClients.length > 0 && (
          <div className="sb-row sb-row--static" title={browserClients.map(c => `${c.ip}  (${c.kind})`).join('\n')}>
            <span className="status-dot status-dot--connected" />
            <span className="sb-row-text">{browserClients.length} client{browserClients.length !== 1 ? 's' : ''}</span>
          </div>
        )}
        {!isBrowserClient && vmixState && (
          <div className="sb-row sb-row--static">
            <span className="sb-row-icon">ℹ</span>
            <span className="sb-row-text">{vmixState.edition}{isStale ? ' · stale' : ''}</span>
          </div>
        )}
        {!isBrowserClient && showStats && (
          <VmixStatsPanel anchorRef={statsAnchorRef} onClose={() => setShowStats(false)} />
        )}
      </div>

      {vmixState && (
        <div className="sb-section">
          <div className="sb-label">Transport</div>
          <div className="sb-grid-2">
            {!isBrowserClient && (
              <button
                className={`sb-btn${canvasSyncFlash ? ' sb-btn--flash' : ''}`}
                onClick={handleCanvasSync}
                title="Push all timer and scoreboard values to vMix"
              ><span>{canvasSyncFlash ? <Check size={12} strokeWidth={2} /> : <ArrowUp size={12} strokeWidth={2} />}</span><span className="lbl">Sync</span></button>
            )}
            <button
              className={`sb-btn sb-btn--rec ${vmixState.recording ? 'sb-btn--rec-active' : ''}`}
              onClick={toggleRecord}
              title="Toggle Recording"
            ><span><Circle size={12} fill="currentColor" stroke="none" /></span><span className="lbl">REC</span></button>
            <button
              className={`sb-btn sb-btn--rec ${vmixState.streaming ? 'sb-btn--rec-active' : ''}`}
              onClick={toggleStream}
              title="Toggle Streaming"
            ><span><Play size={12} fill="currentColor" stroke="none" /></span><span className="lbl">STR</span></button>
            <button
              className={`sb-btn ${vmixState.fadeToBlack ? 'sb-btn--ftb-active' : ''}`}
              onClick={toggleFadeToBlack}
              title="Fade to Black"
            ><span className="lbl">FTB</span></button>
          </div>
        </div>
      )}

      {!isBrowserClient && connections.some(c => c.status === 'connected') && (
        <div className="sb-section">
          <button
            className={`sb-row${vmixSyncFlash ? ' sb-row--active' : ''}`}
            onClick={handleVmixResync}
            title="Force push all app data to vMix now"
          >
            <span className="sb-row-icon">{vmixSyncFlash ? <Check size={14} strokeWidth={2} /> : <RotateCw size={14} strokeWidth={2} />}</span>
            <span className="sb-row-text">Force Resync to vMix</span>
          </button>
        </div>
      )}

      {vmixState && (
        <div className="sb-section">
          <div className="sb-label">Tally</div>
          <div className="sb-tally">
            <div className="sb-tally-row">
              <span className="sb-tally-tag sb-tally-tag--prv">PRV</span>
              <span className="sb-tally-title" title={vmixState.inputs.find(i => i.number === vmixState.preview)?.title}>
                {midTrunc(vmixState.inputs.find(i => i.number === vmixState.preview)?.title ?? String(vmixState.preview))}
              </span>
            </div>
            <div className="sb-tally-row">
              <span className="sb-tally-tag sb-tally-tag--pgm">PGM</span>
              <span className="sb-tally-title" title={vmixState.inputs.find(i => i.number === vmixState.active)?.title}>
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
                <div key={o.number} className="sb-tally-row">
                  <span className="sb-tally-tag sb-tally-tag--ovl">OVL{o.number}</span>
                  <span className="sb-tally-title" title={ovlTitle}>{midTrunc(ovlTitle)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {syncInfo && !isBrowserClient && (
        <div className="sb-section">
          <div className="sb-label">Remote Access</div>
          <div className="sb-remote-row">
            <span className={`status-dot status-dot--${syncInfo.interactiveEnabled ? 'on' : 'off'}`} />
            <button className="sb-remote-url" onClick={() => copyUrl(syncInfo.url)} title={`Interactive URL (click to copy)\n${syncInfo.url}`}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Zap size={11} strokeWidth={2} /> {syncInfo.url.replace('http://', '')}</span>
            </button>
            <button className={`sb-toggle sb-toggle--${syncInfo.interactiveEnabled ? 'on' : 'off'}`} onClick={toggleInteractive}
              title={syncInfo.interactiveEnabled ? 'Disable interactive access' : 'Enable interactive access'}>
              {syncInfo.interactiveEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="sb-remote-row">
            <span className={`status-dot status-dot--${syncInfo.readonlyEnabled ? 'on' : 'off'}`} />
            <button className="sb-remote-url" onClick={() => copyUrl(syncInfo.readonlyUrl)} title={`Read-only URL (click to copy)\n${syncInfo.readonlyUrl}`}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Eye size={11} strokeWidth={2} /> {syncInfo.readonlyUrl.replace('http://', '')}</span>
            </button>
            <button className={`sb-toggle sb-toggle--${syncInfo.readonlyEnabled ? 'on' : 'off'}`} onClick={toggleReadonly}
              title={syncInfo.readonlyEnabled ? 'Disable read-only access' : 'Enable read-only access'}>
              {syncInfo.readonlyEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="sb-remote-row">
            <span className={`status-dot status-dot--${syncInfo.commentatorEnabled ? 'on' : 'off'}`} />
            <button className="sb-remote-url" onClick={() => copyUrl(syncInfo.commentatorUrl)} title={`Commentator URL (click to copy)\n${syncInfo.commentatorUrl}`}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Mic size={11} strokeWidth={2} /> {syncInfo.commentatorUrl.replace('http://', '')}</span>
            </button>
            <button className={`sb-toggle sb-toggle--${syncInfo.commentatorEnabled ? 'on' : 'off'}`} onClick={toggleCommentator}
              title={syncInfo.commentatorEnabled ? 'Disable commentator access' : 'Enable commentator access'}>
              {syncInfo.commentatorEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      )}

      {(isSyncingCloud || lastError) && (
        <div className="sb-section">
          {isSyncingCloud ? (
            <div className="sb-row sb-row--static">
              <span className="sb-sync-spinner" />
              <span className="sb-row-text">{pushing ? 'Saving to cloud…' : 'Syncing from cloud…'}</span>
            </div>
          ) : (
            <div className="sb-row sb-row--static sb-row--error" title={lastError ?? undefined}>
              <span className="sb-row-icon"><AlertTriangle size={14} strokeWidth={2} /></span>
              <span className="sb-row-text">Cloud sync failed</span>
            </div>
          )}
        </div>
      )}

      </div>

      <div className="sb-section sb-section--pinned">
        <div className="sb-label">Utilities</div>
        <div className="sb-grid-icons">
          <UndoControl />
          {confirmReset ? (
            <div className="sb-reset-confirm">
              <span>Reset match?</span>
              <button className="sb-icon-btn sb-icon-btn--danger" onClick={() => { resetMatchData(); setConfirmReset(false); }}>Yes</button>
              <button className="sb-icon-btn" onClick={() => setConfirmReset(false)}>No</button>
            </div>
          ) : (
            <button className="sb-icon-btn" onClick={() => setConfirmReset(true)} title="Reset all match data (scores, timers, player tracking, timeline)"><RotateCcw size={16} strokeWidth={1.75} /></button>
          )}
          <ProjectMenu />
          <button className="sb-icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
          </button>
          <button className="sb-icon-btn" onClick={() => setShowSettings(true)} title="App settings"><Settings size={16} strokeWidth={1.75} /></button>
          {isReadOnly ? (
            <span className="sb-readonly-badge">View Only</span>
          ) : (
            <button className={`sb-icon-btn${editMode ? ' sb-icon-btn--active' : ''}`} onClick={() => setEditMode(!editMode)} title={editMode ? 'Exit edit mode' : 'Enter edit mode'}>
              {editMode ? <Check size={16} strokeWidth={1.75} /> : <Pencil size={16} strokeWidth={1.75} />}
            </button>
          )}
        </div>
      </div>

      <div className="sb-footer">
        <SidebarClock />
      </div>

      {showTournamentDb && <TournamentManager onClose={() => setShowTournamentDb(false)} />}
      {showSettings && <AppSettingsModal onClose={() => setShowSettings(false)} />}
    </aside>
  );
}
