import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Save, Cloud, Download, Upload } from 'lucide-react';
import { useCanvasStore } from '../stores/canvasStore';
import { useVmixStore } from '../stores/vmixStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { useTeamDbStore } from '../stores/teamDbStore';
import { useMatchScheduleStore } from '../stores/matchScheduleStore';
import { useMatchResultsStore } from '../stores/matchResultsStore';
import { buildSnapshot, exportToFile, localFileBackend, collectImages, restoreImages } from '../utils/project';

export function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const { pages, activePageId, restoreCanvas } = useCanvasStore();
  const { savedConnections, shortcuts, scoreboards, timers, dataBindings, globalVariables, restoreVmix } = useVmixStore();
  const { tournaments, activeTournamentId, restoreTournaments } = useTournamentStore();
  const { teams, restoreTeams } = useTeamDbStore();
  const { matches, restoreMatches } = useMatchScheduleStore();
  const { results, restoreResults } = useMatchResultsStore();

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(t);
  }, [status]);

  const handleExport = async () => {
    setOpen(false);
    setBusy(true);
    try {
      const images = await collectImages();
      const snapshot = buildSnapshot(
        { pages, activePageId },
        { savedConnections, shortcuts, scoreboards, timers: timers as never, dataBindings, globalVariables },
        { tournaments, activeTournamentId },
        { teams },
        { matches },
        { results },
        images,
      );
      await localFileBackend.save(snapshot);
      setStatus({ msg: 'Exported', ok: true });
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    setOpen(false);
    const snapshot = await localFileBackend.load();
    if (!snapshot) { setStatus({ msg: 'Import cancelled', ok: false }); return; }
    setBusy(true);
    try {
      restoreCanvas(snapshot.canvas.pages, snapshot.canvas.activePageId);
      restoreVmix(snapshot.vmix);
      if (snapshot.tournament) {
        restoreTournaments(snapshot.tournament.tournaments, snapshot.tournament.activeTournamentId);
      }
      if (snapshot.teamDb) restoreTeams(snapshot.teamDb.teams);
      if (snapshot.matchSchedule) restoreMatches(snapshot.matchSchedule.matches);
      if (snapshot.matchResults) restoreResults(snapshot.matchResults.results);
      if (snapshot.images?.length) await restoreImages(snapshot.images);
      setStatus({ msg: 'Imported', ok: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-menu">
      <button
        className={`status-btn project-menu-btn ${open ? 'status-btn--active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Project: save / load"
      >
        {busy ? (
          <span className="project-status--busy">…</span>
        ) : status ? (
          <span className={status.ok ? 'project-status--ok' : 'project-status--err'}>{status.msg}</span>
        ) : <Save size={16} strokeWidth={1.75} />}
      </button>

      {/* Centered modal, same .modal-overlay/.modal pattern as ConfirmModal —
          this used to be an anchored dropdown but .app-sidebar's
          overflow: hidden clipped it (it sits right above the footer). */}
      {open && createPortal(
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Project</h3>

            <div className="project-autosave-row">
              <span className="project-autosave-dot" />
              Auto-saved locally
            </div>

            <p className="app-settings-hint" style={{ margin: 0 }}>
              Includes canvas, vMix settings, tournaments, teams, schedule, results, and the logo library.
            </p>

            <button className="project-action-btn" onClick={handleExport} disabled={busy}>
              <span><Download size={14} strokeWidth={2} /></span> Export to file
            </button>
            <button className="project-action-btn" onClick={handleImport} disabled={busy}>
              <span><Upload size={14} strokeWidth={2} /></span> Import from file
            </button>

            <div className="project-cloud-row">
              <span className="project-cloud-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Cloud size={13} strokeWidth={2} /> Cloud sync</span>
              <span className="project-cloud-soon">coming soon</span>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
