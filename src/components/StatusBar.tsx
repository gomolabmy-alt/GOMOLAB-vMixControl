import { useState } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import { useCanvasStore } from '../stores/canvasStore';
import { ProjectMenu } from './ProjectMenu';
import { TournamentManager } from './TournamentManager';
import { AppSettingsModal } from './AppSettingsModal';
import { syncClient } from '../lib/syncClient';

export function StatusBar() {
  const {
    vmixState,
    lastUpdated,
  } = useVmixStore();

  const { resetMatchData, restoreMatchData, matchDataSnapshot, editMode, setEditMode } = useCanvasStore();
  const isReadOnly = syncClient.isReadOnly;
  const [showTournamentDb, setShowTournamentDb] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const secondsAgo = lastUpdated ? Math.floor((Date.now() - lastUpdated) / 1000) : null;
  const isStale = secondsAgo !== null && secondsAgo > 3;

  const midTrunc = (name: string, max = 22) => {
    if (name.length <= max) return name;
    const half = Math.floor((max - 1) / 2);
    return `${name.slice(0, half)}…${name.slice(-half)}`;
  };

  return (
    <header className="status-bar" style={{ position: 'relative' }}>
      <div className="status-bar-left">
        {vmixState && (
          <span className="status-edition" title={`vMix ${vmixState.version}`}>
            {vmixState.edition}
          </span>
        )}
        {isStale && <span className="status-stale">⚠ stale</span>}
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
        <button
          className="status-btn status-btn--db"
          onClick={() => setShowTournamentDb(true)}
          title="Tournament Database"
        >🏆 DB</button>
        {matchDataSnapshot ? (
          <button
            className="status-btn status-btn--restore"
            onClick={() => restoreMatchData()}
            title="Restore match data to state before last reset"
          >↩ Restore</button>
        ) : null}
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
    </header>
  );
}
