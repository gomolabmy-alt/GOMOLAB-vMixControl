import { useEffect, useRef, useState } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import type { ConnectionLogEvent } from '../types/vmix';

interface Props {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

type Tab = 'stats' | 'data' | 'log';
type Filter = 'all' | 'connection' | 'commands' | 'errors';

const EVENT_META: Record<ConnectionLogEvent, { icon: string; label: string; color: string; group: Filter }> = {
  'connected':      { icon: '✓',  label: 'Connected',       color: 'var(--green-bright)', group: 'connection' },
  'disconnected':   { icon: '–',  label: 'Disconnected',    color: 'var(--text-muted)',   group: 'connection' },
  'error':          { icon: '✗',  label: 'Error',           color: 'var(--red)',           group: 'errors' },
  'stale':          { icon: '⚠',  label: 'Stale',           color: '#f39c12',             group: 'connection' },
  'recovered':      { icon: '↺',  label: 'Recovered',       color: 'var(--green-bright)', group: 'connection' },
  'sent':           { icon: '→',  label: 'Sent',            color: 'var(--accent)',        group: 'commands' },
  'send-error':     { icon: '✗',  label: 'Send failed',     color: 'var(--red)',           group: 'errors' },
  'tcp-connect':    { icon: '⚡', label: 'TCP connected',   color: 'var(--green-bright)', group: 'connection' },
  'tcp-disconnect': { icon: '⚡', label: 'TCP dropped',     color: '#f39c12',             group: 'connection' },
  'tcp-reconnect':  { icon: '⚡', label: 'TCP reconnected', color: 'var(--green-bright)', group: 'connection' },
  'poll-fallback':  { icon: '↔',  label: 'HTTP fallback',   color: '#f39c12',             group: 'connection' },
  'poll-error':     { icon: '✗',  label: 'Poll failed',     color: 'var(--red)',           group: 'errors' },
  'poll-restart':   { icon: '↺',  label: 'Poll restarted',  color: '#f39c12',             group: 'connection' },
  'tcp-stale':      { icon: '↺',  label: 'TCP stale—reset', color: '#e67e22',             group: 'connection' },
};

function parseFieldKey(key: string) {
  const [fn, input, field] = key.split('::');
  return { fn: fn ?? '', input: input ?? '', field: field ?? '' };
}

export function VmixStatsPanel({ anchorRef, onClose }: Props) {
  const { connection, connectionLog, clearConnectionLog, vmixFieldStats, resyncAll } = useVmixStore();
  // Kept as a 0-or-1-element array so the rest of this component (built for
  // a connection list) doesn't need to change shape.
  const connections = connection ? [connection] : [];
  const [tab, setTab] = useState<Tab>('stats');
  const [filter, setFilter] = useState<Filter>('all');
  const [showOk, setShowOk] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef<HTMLDivElement>(null);

  // Tick every second so "ago" timestamps stay fresh
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [anchorRef, onClose]);

  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };

  const fmtAgo = (ms: number | null) => {
    if (ms === null) return '—';
    const s = Math.floor((now - ms) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  };

  const filteredLog = filter === 'all'
    ? connectionLog
    : connectionLog.filter(e => (EVENT_META[e.event]?.group ?? 'connection') === filter);

  const errorCount = connectionLog.filter(e =>
    e.event === 'error' || e.event === 'send-error' || e.event === 'poll-error'
  ).length;

  const missingFields    = vmixFieldStats.filter(f => f.fieldMissing);
  const inputMissingFields = vmixFieldStats.filter(f => f.inputMissing);
  const okFields         = vmixFieldStats.filter(f => f.status === 'ok' && f.mismatch !== true && !f.fieldMissing && !f.inputMissing);
  const pendingFields    = vmixFieldStats.filter(f => f.status === 'pending' && !f.inputMissing);
  const errFields        = vmixFieldStats.filter(f => f.status === 'err');
  const mismatchFields   = vmixFieldStats.filter(f => f.mismatch === true);
  const dataAlertCount   = errFields.length + mismatchFields.length + pendingFields.length + missingFields.length + inputMissingFields.length;

  return (
    <div className="vmix-stats-panel" ref={panelRef}>
      <div className="vmix-stats-header">
        <div className="vmix-stats-tabs">
          <button
            className={`vmix-stats-tab${tab === 'stats' ? ' vmix-stats-tab--active' : ''}`}
            onClick={() => setTab('stats')}
          >Stats</button>
          <button
            className={`vmix-stats-tab${tab === 'data' ? ' vmix-stats-tab--active' : ''}`}
            onClick={() => setTab('data')}
          >
            Data
            {errFields.length > 0 && (
              <span className="vmix-stats-badge vmix-stats-badge--err">{errFields.length}</span>
            )}
            {mismatchFields.length > 0 && (
              <span className="vmix-stats-badge vmix-stats-badge--mismatch">{mismatchFields.length}</span>
            )}
            {missingFields.length > 0 && (
              <span className="vmix-stats-badge vmix-stats-badge--missing">{missingFields.length}</span>
            )}
            {inputMissingFields.length > 0 && (
              <span className="vmix-stats-badge vmix-stats-badge--input-missing">{inputMissingFields.length}</span>
            )}
            {pendingFields.length > 0 && errFields.length === 0 && mismatchFields.length === 0 && missingFields.length === 0 && inputMissingFields.length === 0 && (
              <span className="vmix-stats-badge vmix-stats-badge--warn">{pendingFields.length}</span>
            )}
          </button>
          <button
            className={`vmix-stats-tab${tab === 'log' ? ' vmix-stats-tab--active' : ''}`}
            onClick={() => setTab('log')}
          >
            Log
            {connectionLog.length > 0 && <span className="vmix-stats-badge">{connectionLog.length}</span>}
            {errorCount > 0 && <span className="vmix-stats-badge vmix-stats-badge--err">{errorCount}</span>}
          </button>
        </div>
        {tab === 'log' && connectionLog.length > 0 && (
          <button className="vmix-stats-clear" onClick={clearConnectionLog} title="Clear log">Clear</button>
        )}
        {tab === 'data' && vmixFieldStats.length > 0 && (
          <button className="vmix-stats-clear" onClick={resyncAll} title="Force resync all fields">Resync</button>
        )}
      </div>

      {/* ── Stats tab ──────────────────────────────────────────────────────── */}
      {tab === 'stats' && (
        <div className="vmix-stats-body">
          {connections.length === 0 && (
            <div className="vmix-stats-empty">No vMix connections</div>
          )}
          {connections.map((c) => (
            <div key={c.id} className="vmix-stats-row">
              <span className={`status-dot status-dot--${c.status}`} />
              <div className="vmix-stats-info">
                <div className="vmix-stats-name">{c.name}</div>
                <div className="vmix-stats-meta">
                  {c.status === 'connected' && c.vmixState ? (
                    <>
                      <span className="vmix-stats-chip">{c.vmixState.edition}</span>
                      <span className="vmix-stats-chip">{c.vmixState.inputs.length} inputs</span>
                      {c.vmixState.version && (
                        <span className="vmix-stats-chip vmix-stats-chip--muted">v{c.vmixState.version}</span>
                      )}
                      <span className="vmix-stats-chip vmix-stats-chip--muted">{fmtAgo(c.lastUpdated)}</span>
                    </>
                  ) : c.status === 'error' ? (
                    <span className="vmix-stats-error">{c.error}</span>
                  ) : (
                    <span className="vmix-stats-chip vmix-stats-chip--muted">{c.status}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Data tab ───────────────────────────────────────────────────────── */}
      {tab === 'data' && (
        <div className="vmix-stats-body">
          {vmixFieldStats.length === 0 ? (
            <div className="vmix-stats-empty">No data fields tracked yet</div>
          ) : (
            <>
              {/* Summary bar */}
              <div className="vmix-data-summary">
                <span className="vmix-data-pill vmix-data-pill--ok">{okFields.length} OK</span>
                {mismatchFields.length > 0 && (
                  <span className="vmix-data-pill vmix-data-pill--mismatch">{mismatchFields.length} mismatch</span>
                )}
                {missingFields.length > 0 && (
                  <span className="vmix-data-pill vmix-data-pill--missing">{missingFields.length} field not found</span>
                )}
                {inputMissingFields.length > 0 && (
                  <span className="vmix-data-pill vmix-data-pill--input-missing">{inputMissingFields.length} input not found</span>
                )}
                {pendingFields.length > 0 && (
                  <span className="vmix-data-pill vmix-data-pill--pending">{pendingFields.length} pending</span>
                )}
                {errFields.length > 0 && (
                  <span className="vmix-data-pill vmix-data-pill--err">{errFields.length} failed</span>
                )}
                <div className="vmix-data-bar">
                  {vmixFieldStats.length > 0 && (
                    <>
                      <div
                        className="vmix-data-bar-ok"
                        style={{ width: `${(okFields.length / vmixFieldStats.length) * 100}%` }}
                      />
                      <div
                        className="vmix-data-bar-mismatch"
                        style={{ width: `${(mismatchFields.length / vmixFieldStats.length) * 100}%` }}
                      />
                      <div
                        className="vmix-data-bar-pending"
                        style={{ width: `${(pendingFields.length / vmixFieldStats.length) * 100}%` }}
                      />
                      <div
                        className="vmix-data-bar-err"
                        style={{ width: `${(errFields.length / vmixFieldStats.length) * 100}%` }}
                      />
                    </>
                  )}
                </div>
              </div>

              {/* Input-missing fields — params.Input doesn't match any input in the
                  current vMix project at all. vMix assigns a fresh random GUID to
                  every input on each preset load, so a widget still pointed at a
                  previous load's key silently no-ops forever with no error. */}
              {inputMissingFields.map(f => {
                const { input, field } = parseFieldKey(f.key);
                return (
                  <div key={f.key} className="vmix-field-row vmix-field-row--input-missing">
                    <span className="vmix-field-dot vmix-field-dot--input-missing" title="Input not found in vMix" />
                    <div className="vmix-field-info">
                      <div className="vmix-field-name">{field || f.label}</div>
                      <div className="vmix-field-meta">
                        {input && <span className="vmix-field-input">{input.slice(0, 8)}…</span>}
                        {f.connectionName && <span className="vmix-field-conn">{f.connectionName}</span>}
                        <span className="vmix-field-time" style={{ color: '#c0392b' }}>
                          target input not found in current vMix project — re-pick it in ⚙ config
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Mismatch fields — app value ≠ vMix value */}
              {mismatchFields.map(f => {
                const { input, field } = parseFieldKey(f.key);
                return (
                  <div key={f.key} className="vmix-field-row vmix-field-row--mismatch">
                    <span className="vmix-field-dot vmix-field-dot--mismatch" title="Value mismatch" />
                    <div className="vmix-field-info">
                      <div className="vmix-field-name">{field || f.label}</div>
                      <div className="vmix-field-values">
                        <span className="vmix-field-val vmix-field-val--app" title="App value">
                          App: {f.appValue !== null ? (f.appValue.slice(0, 30) || '(empty)') : '—'}
                        </span>
                        <span className="vmix-field-val-arrow">≠</span>
                        <span className="vmix-field-val vmix-field-val--vmix" title="vMix current value">
                          vMix: {f.vmixValue === null ? 'not found in input' : (f.vmixValue.slice(0, 30) || '(empty)')}
                        </span>
                      </div>
                      <div className="vmix-field-meta">
                        {input && <span className="vmix-field-input">{input.slice(0, 8)}…</span>}
                        {f.connectionName && <span className="vmix-field-conn">{f.connectionName}</span>}
                        <span className="vmix-field-time vmix-field-time--mismatch">
                          out of sync · sent {fmtAgo(f.lastOkAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Missing fields — input exists but SelectedName doesn't match anything on
                  it. Almost always a case-mismatch/typo: vMix's field match is case-
                  sensitive and silently no-ops rather than erroring at send time. */}
              {missingFields.map(f => {
                const { input, field } = parseFieldKey(f.key);
                return (
                  <div key={f.key} className="vmix-field-row vmix-field-row--missing">
                    <span className="vmix-field-dot vmix-field-dot--missing" title="Field not found on input" />
                    <div className="vmix-field-info">
                      <div className="vmix-field-name">{field || f.label}</div>
                      <div className="vmix-field-meta">
                        {input && <span className="vmix-field-input">{input.slice(0, 8)}…</span>}
                        {f.connectionName && <span className="vmix-field-conn">{f.connectionName}</span>}
                        <span className="vmix-field-time" style={{ color: '#9b59b6' }}>
                          no field named "{field}" on this input — check spelling/case
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Failed fields — always visible */}
              {errFields.map(f => {
                const { input, field } = parseFieldKey(f.key);
                return (
                  <div key={f.key} className="vmix-field-row vmix-field-row--err">
                    <span className="vmix-field-dot vmix-field-dot--err" title="Failed" />
                    <div className="vmix-field-info">
                      <div className="vmix-field-name">{field || f.label}</div>
                      <div className="vmix-field-meta">
                        {input && <span className="vmix-field-input">{input.slice(0, 8)}…</span>}
                        {f.connectionName && <span className="vmix-field-conn">{f.connectionName}</span>}
                        <span className="vmix-field-time vmix-field-time--err">
                          failed {fmtAgo(f.lastErrAt)} · {f.errCount}x
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Pending fields */}
              {pendingFields.map(f => {
                const { input, field } = parseFieldKey(f.key);
                return (
                  <div key={f.key} className="vmix-field-row vmix-field-row--pending">
                    <span className="vmix-field-dot vmix-field-dot--pending" title="Pending" />
                    <div className="vmix-field-info">
                      <div className="vmix-field-name">{field || f.label}</div>
                      <div className="vmix-field-meta">
                        {input && <span className="vmix-field-input">{input.slice(0, 8)}…</span>}
                        {f.connectionName && <span className="vmix-field-conn">{f.connectionName}</span>}
                        <span className="vmix-field-time">not yet confirmed</span>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* OK fields — collapsed by default */}
              {okFields.length > 0 && (
                <button
                  className="vmix-data-toggle"
                  onClick={() => setShowOk(v => !v)}
                >
                  {showOk ? 'Hide' : 'Show'} {okFields.length} confirmed fields
                </button>
              )}
              {showOk && okFields.map(f => {
                const { input, field } = parseFieldKey(f.key);
                return (
                  <div key={f.key} className="vmix-field-row vmix-field-row--ok">
                    <span className="vmix-field-dot vmix-field-dot--ok" title="OK" />
                    <div className="vmix-field-info">
                      <div className="vmix-field-name vmix-field-name--ok">{field || f.label}</div>
                      <div className="vmix-field-meta">
                        {input && <span className="vmix-field-input">{input.slice(0, 8)}…</span>}
                        {f.connectionName && <span className="vmix-field-conn">{f.connectionName}</span>}
                        <span className="vmix-field-time">{fmtAgo(f.lastOkAt)} · {f.sendCount} sends</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* ── Log tab ────────────────────────────────────────────────────────── */}
      {tab === 'log' && (
        <>
          <div className="vmix-log-filters">
            {(['all', 'connection', 'commands', 'errors'] as Filter[]).map(f => (
              <button
                key={f}
                className={`vmix-log-filter${filter === f ? ' vmix-log-filter--active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'connection' ? 'Connection' : f === 'commands' ? 'Commands' : 'Errors'}
              </button>
            ))}
          </div>
          <div className="vmix-stats-body vmix-stats-body--log">
            {filteredLog.length === 0 && (
              <div className="vmix-stats-empty">{filter === 'all' ? 'No events yet' : `No ${filter} events`}</div>
            )}
            {filteredLog.map((entry) => {
              const meta = EVENT_META[entry.event];
              return (
                <div key={entry.id} className="vmix-log-row">
                  <span className="vmix-log-time">{fmtTime(entry.time)}</span>
                  <span
                    className="vmix-log-badge"
                    style={{ background: meta?.color ?? 'var(--text-muted)', color: '#fff' }}
                    title={meta?.label}
                  >
                    {meta?.icon ?? '?'}
                  </span>
                  <div className="vmix-log-info">
                    <div className="vmix-log-top">
                      <span className="vmix-log-event" style={{ color: meta?.color }}>{meta?.label ?? entry.event}</span>
                      <span className="vmix-log-name">{entry.connectionName}</span>
                    </div>
                    {entry.detail && <span className="vmix-log-detail">{entry.detail}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
