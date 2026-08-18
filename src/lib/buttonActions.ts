import { useVmixStore } from '../stores/vmixStore';
import { useCanvasStore } from '../stores/canvasStore';

export type ActionItem = { fn: string; params: Record<string, string> };
export type ButtonLike = { mode?: string; actions?: ActionItem[]; releaseActions?: ActionItem[] };

export function isAppFn(fn: string) { return fn?.startsWith('App.'); }

// Runs one action item outside of React — usable from a widget's own click
// handler or from a global hotkey callback with no component mounted.
export async function dispatchAction(fn: string, params: Record<string, string>) {
  if (!fn) return;
  // Special-cased here rather than in executeAppFunction's switch: this is
  // the ONLY caller of executeAppFunction (grep-verified), and it's the one
  // that's actually async/awaited by runActions' for-loop below — a real
  // delay only holds up the next action in the list if it happens here,
  // before delegating to that synchronous switch.
  if (fn === 'App.Wait') {
    const seconds = parseFloat(params.Seconds ?? '1');
    if (seconds > 0) await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    return;
  }
  if (isAppFn(fn)) useCanvasStore.getState().executeAppFunction(fn, params);
  else await useVmixStore.getState().getClient()?.sendFunction(fn, params);
}

export async function runActions(actions: ActionItem[]) {
  for (const action of actions) {
    await dispatchAction(action.fn, action.params);
  }
}

// Derives a toggle button's on/off state from live vMix state rather than
// local click tracking, so it reflects reality even when the state changed
// via another control surface, vMix itself, or a command that silently failed.
export function deriveToggleOn(actions: ActionItem[], vmixState: any): boolean {
  if (!vmixState) return false;
  for (const a of actions) {
    const fn = a.fn;
    if (!fn) continue;
    const ovlMatch = fn.match(/^OverlayInput(\d)(In|Out|Off|Toggle)?$/);
    if (ovlMatch) {
      const ch = parseInt(ovlMatch[1], 10);
      const overlay = vmixState.overlays?.find((o: any) => o.number === ch);
      if (overlay) return !!(overlay.key && overlay.key !== '');
    }
    switch (fn) {
      case 'StartRecording': case 'StopRecording': case 'RecordingToggle':
        return !!vmixState.recording;
      case 'StartStreaming': case 'StopStreaming': case 'StreamingToggle':
        return !!vmixState.streaming;
      case 'StartExternal': case 'StopExternal': case 'ExternalToggle':
        return !!vmixState.external;
      case 'StartFullScreen': case 'StopFullScreen': case 'FullScreenToggle':
        return !!vmixState.fullscreen;
      case 'FadeToBlack':
        return !!vmixState.fadeToBlack;
      case 'StartMultiCorder': case 'StopMultiCorder': case 'MultiCorderToggle':
        return !!vmixState.multiCorder;
    }
  }
  return false;
}

// Replicates a button's onPointerDown behavior (mode-aware: toggle flips
// between press/release action lists based on live vMix state, momentary
// just runs the press actions) — shared by ButtonWidget's own click handler
// and the global hotkey registry so both trigger identical behavior.
export async function runButtonPress(btn: ButtonLike) {
  const press = btn.actions ?? [];
  const release = btn.releaseActions ?? [];
  if (btn.mode === 'toggle') {
    const vmixState = useVmixStore.getState().vmixState;
    const currentlyOn = deriveToggleOn([...press, ...release], vmixState);
    if (!currentlyOn) await runActions(press);
    else await runActions(release);
  } else {
    await runActions(press);
  }
}

// Replicates a button's onPointerUp behavior — no-op for toggle mode, since
// toggle already resolved everything on press.
export async function runButtonRelease(btn: ButtonLike) {
  if (btn.mode !== 'toggle') await runActions(btn.releaseActions ?? []);
}
