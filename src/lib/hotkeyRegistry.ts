import { useCanvasStore } from '../stores/canvasStore';
import { runButtonPress, runButtonRelease } from './buttonActions';
import { collectHotkeyBindings, type HotkeyBinding } from './hotkeyBindings';

const _isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const registered = new Map<string, HotkeyBinding>(); // accelerator -> currently-registered binding
let lastSerialized = '';
let syncChain: Promise<void> = Promise.resolve();

async function syncRegistrations(bindings: HotkeyBinding[]) {
  const { register, unregister } = await import('@tauri-apps/plugin-global-shortcut');

  // First binding wins on an accelerator collision — same "first match" rule
  // as HotkeyRecorder's duplicate warning is meant to steer people away from.
  const byAccel = new Map<string, HotkeyBinding>();
  for (const b of bindings) if (!byAccel.has(b.accelerator)) byAccel.set(b.accelerator, b);

  for (const accel of [...registered.keys()]) {
    if (!byAccel.has(accel)) {
      try { await unregister(accel); } catch { /* already gone */ }
      registered.delete(accel);
    }
  }

  for (const [accel, binding] of byAccel) {
    const prev = registered.get(accel);
    if (prev && JSON.stringify(prev) === JSON.stringify(binding)) continue;
    if (prev) {
      try { await unregister(accel); } catch { /* ignore */ }
      registered.delete(accel);
    }
    try {
      await register(accel, (event: { state: string }) => {
        if (event.state === 'Pressed') runButtonPress(binding);
        else if (event.state === 'Released') runButtonRelease(binding);
      });
      registered.set(accel, binding);
    } catch (err) {
      // Reserved by the OS/another app, or a malformed accelerator — leave
      // this one unregistered rather than failing every other binding.
      console.warn(`[hotkeys] failed to register "${accel}" (${binding.source}):`, err);
    }
  }
}

function maybeSync() {
  const bindings = collectHotkeyBindings(useCanvasStore.getState().pages);
  const serialized = JSON.stringify(bindings);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  syncChain = syncChain
    .then(() => syncRegistrations(bindings))
    .catch(err => console.warn('[hotkeys] registry sync failed:', err));
}

// Starts the global-hotkey registry: collects every Button widget hotkey and
// every widget's config.hotkeyActions[] across all pages, registers them as
// OS-level shortcuts (fire regardless of window focus/minimized state), and
// re-syncs whenever canvas state changes. Desktop-only — no-op elsewhere.
export function startHotkeyRegistry() {
  if (!_isTauriApp) return;
  maybeSync();
  useCanvasStore.subscribe(() => maybeSync());
}
