import { useState } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import type { SavedConnection } from '../types/vmix';

export function ConnectionSetup() {
  const { connect, saveConnection, savedConnections, deleteConnection, connectionStatus, connectionError } =
    useVmixStore();

  const [host, setHost] = useState('');
  const [port, setPort] = useState('8088');
  const [saveName, setSaveName] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);

  const isConnecting = connectionStatus === 'connecting';

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!host.trim()) return;
    await connect({ host: host.trim(), port: parseInt(port, 10) || 8088 });
  };

  const handleConnectSaved = (conn: SavedConnection) => {
    setHost(conn.host);
    setPort(String(conn.port));
    connect({ host: conn.host, port: conn.port });
  };

  const handleSave = () => {
    if (!host.trim() || !saveName.trim()) return;
    saveConnection({ host: host.trim(), port: parseInt(port, 10) || 8088 }, saveName.trim());
    setSaveName('');
    setShowSaveForm(false);
  };

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <div className="connect-logo">
          <div className="connect-logo-mark">G</div>
          <div className="connect-logo-text">
            <span>GOMOLAB</span>
            <span className="connect-logo-sub">vMix Control</span>
          </div>
        </div>

        <form onSubmit={handleConnect} className="connect-form">
          <div className="field-row">
            <label className="field-label">vMix Host</label>
            <input
              className="field-input"
              type="text"
              placeholder="192.168.1.100"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </div>

          <div className="field-row">
            <label className="field-label">Port</label>
            <input
              className="field-input field-input--short"
              type="number"
              placeholder="8088"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              min={1}
              max={65535}
            />
          </div>

          {connectionError && (
            <div className="connect-error">{connectionError}</div>
          )}

          <button
            className="btn btn--primary btn--full"
            type="submit"
            disabled={isConnecting || !host.trim()}
          >
            {isConnecting ? 'Connecting…' : 'Connect'}
          </button>
        </form>

        {host.trim() && !showSaveForm && (
          <button
            className="btn btn--ghost btn--small"
            onClick={() => setShowSaveForm(true)}
          >
            Save this connection
          </button>
        )}

        {showSaveForm && (
          <div className="save-form">
            <input
              className="field-input"
              type="text"
              placeholder="Connection name (e.g. Studio A)"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
            />
            <div className="save-form-actions">
              <button className="btn btn--primary btn--small" onClick={handleSave} disabled={!saveName.trim()}>
                Save
              </button>
              <button className="btn btn--ghost btn--small" onClick={() => setShowSaveForm(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {savedConnections.length > 0 && (
          <div className="saved-connections">
            <h3 className="saved-connections-title">Saved</h3>
            <ul className="saved-list">
              {savedConnections.map((conn) => (
                <li key={conn.id} className="saved-item">
                  <button
                    className="saved-item-connect"
                    onClick={() => handleConnectSaved(conn)}
                    disabled={isConnecting}
                  >
                    <span className="saved-item-name">{conn.name}</span>
                    <span className="saved-item-addr">
                      {conn.host}:{conn.port}
                    </span>
                  </button>
                  <button
                    className="saved-item-delete"
                    onClick={() => deleteConnection(conn.id)}
                    aria-label="Delete"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="connect-hint">
          Open vMix → Settings → Web Controller and enable the API on port {port || 8088}.
        </p>
      </div>
    </div>
  );
}
