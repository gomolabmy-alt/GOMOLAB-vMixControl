import { useState, useRef, useEffect } from 'react';
import { useCanvasStore } from '../stores/canvasStore';
import { useVmixStore } from '../stores/vmixStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { buildSnapshot, exportToFile, localFileBackend } from '../utils/project';

export function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const { pages, activePageId, restoreCanvas } = useCanvasStore();
  const { savedConnections, shortcuts, scoreboards, timers, dataBindings, globalVariables, restoreVmix } = useVmixStore();
  const { tournaments, activeTournamentId, restoreTournaments } = useTournamentStore();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(t);
  }, [status]);

  const handleExport = async () => {
    const snapshot = buildSnapshot(
      { pages, activePageId },
      { savedConnections, shortcuts, scoreboards, timers: timers as never, dataBindings, globalVariables },
      { tournaments, activeTournamentId },
    );
    await localFileBackend.save(snapshot);
    setStatus({ msg: 'Exported', ok: true });
    setOpen(false);
  };

  const handleImport = async () => {
    setOpen(false);
    const snapshot = await localFileBackend.load();
    if (!snapshot) { setStatus({ msg: 'Import cancelled', ok: false }); return; }
    restoreCanvas(snapshot.canvas.pages, snapshot.canvas.activePageId);
    restoreVmix(snapshot.vmix);
    if (snapshot.tournament) {
      restoreTournaments(snapshot.tournament.tournaments, snapshot.tournament.activeTournamentId);
    }
    setStatus({ msg: 'Imported', ok: true });
  };

  return (
    <div className="project-menu" ref={ref}>
      <button
        className={`status-btn project-menu-btn ${open ? 'status-btn--active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Project: save / load"
      >
        {status ? (
          <span className={status.ok ? 'project-status--ok' : 'project-status--err'}>{status.msg}</span>
        ) : '💾'}
      </button>

      {open && (
        <div className="project-dropdown">
          <div className="project-dropdown-title">Project</div>

          <div className="project-autosave-row">
            <span className="project-autosave-dot" />
            Auto-saved locally
          </div>

          <button className="project-action-btn" onClick={handleExport}>
            <span>↓</span> Export to file
          </button>
          <button className="project-action-btn" onClick={handleImport}>
            <span>↑</span> Import from file
          </button>

          <div className="project-cloud-row">
            <span className="project-cloud-label">☁ Cloud sync</span>
            <span className="project-cloud-soon">coming soon</span>
          </div>
        </div>
      )}
    </div>
  );
}
