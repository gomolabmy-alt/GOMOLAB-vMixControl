import type { CanvasPage } from '../types/canvas';
import type { ActionItem } from './buttonActions';

export interface HotkeyBinding {
  accelerator: string;
  mode?: string;
  actions: ActionItem[];
  releaseActions?: ActionItem[];
  source: string;
}

// Walks every page's widgets collecting every configured hotkey — a Button
// widget's main/side buttons (bound directly to that button's own existing
// actions) plus any widget's generic config.hotkeyActions[] list (Scoreboard
// etc.) — into one flat list. Pure/browser-safe (no Tauri import) so it can
// be reused both by the OS-registration side (hotkeyRegistry.ts) and by
// WidgetConfigPanel for inline duplicate-accelerator warnings.
export function collectHotkeyBindings(pages: CanvasPage[]): HotkeyBinding[] {
  const out: HotkeyBinding[] = [];
  for (const page of pages) {
    for (const w of page.widgets) {
      const cfg: any = w.config ?? {};

      if (w.type === 'button') {
        if (cfg.hotkey) {
          out.push({ accelerator: cfg.hotkey, mode: cfg.mode, actions: cfg.actions ?? [], releaseActions: cfg.releaseActions ?? [], source: cfg.label || 'Button' });
        }
        for (const sb of cfg.sideButtons ?? []) {
          if (sb.hotkey) {
            out.push({ accelerator: sb.hotkey, mode: sb.mode, actions: sb.actions ?? [], releaseActions: sb.releaseActions ?? [], source: sb.label || 'Side Button' });
          }
        }
      }

      for (const hb of cfg.hotkeyActions ?? []) {
        if (hb.hotkey) {
          const widgetLabel = cfg.teamAName ? `${cfg.teamAName} vs ${cfg.teamBName}` : w.type;
          out.push({ accelerator: hb.hotkey, actions: hb.actions ?? [], source: hb.label || widgetLabel });
        }
      }
    }
  }
  return out;
}
