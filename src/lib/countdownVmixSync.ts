import { useCanvasStore } from '../stores/canvasStore';
import { useMatchScheduleStore } from '../stores/matchScheduleStore';
import { useRundownStore } from '../stores/rundownStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { useVmixStore } from '../stores/vmixStore';
import { computeCountdownState, buildCountdownVmixPushes } from './countdownCompute';

const _isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// A canvas page only renders (and thus only ticks) its widgets while it's
// the ACTIVE tab (see Canvas.tsx — activePage?.widgets.map(...), every other
// page's widgets simply don't exist as mounted components). A Custom
// Timer/Countdown widget's own per-second vMix push therefore only ever
// fired while its own tab happened to be the one on screen — everywhere
// else it silently stopped. This runs the exact same push on a plain
// interval instead, reading store state directly (no component, no mount
// dependency), so it keeps going regardless of which tab is showing —
// same reasoning as tournamentAutoAdvance.ts's "independent of any open
// window" background loop.
function runCountdownVmixSync() {
  const client = useVmixStore.getState().getClient();
  if (!client) return;
  const pages = useCanvasStore.getState().pages;
  const scheduleMatches = useMatchScheduleStore.getState().matches;
  const rundownSegments = useRundownStore.getState().segments;
  const canvasTournamentId = useAppSettings.getState().canvasTournamentId;
  const now = Date.now();

  for (const page of pages) {
    for (const widget of page.widgets) {
      if (widget.type !== 'pomodoro') continue;
      const cfg = widget.config ?? {};
      if (!cfg.vmixInputKey) continue;
      const state = computeCountdownState(cfg, now, {
        scheduleMatches, rundownSegments, pageTournamentId: page.tournamentId, canvasTournamentId,
      });
      for (const { field, value } of buildCountdownVmixPushes(cfg, state)) {
        client.setTextField(cfg.vmixInputKey, field, value);
      }
    }
  }
}

let started = false;

/** Starts the always-on Countdown-widget → vMix push loop. Desktop-host
 *  only, same as every other write-owning background process in this app. */
export function startCountdownVmixSync() {
  if (!_isTauriApp || started) return;
  started = true;
  setInterval(runCountdownVmixSync, 1000);
}
