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
    if (page.hotkey) {
      out.push({ accelerator: page.hotkey, actions: [{ fn: 'App.GoToPage', params: { Page: page.id } }], source: `Go to "${page.name}"` });
    }
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

export interface CompanionButtonTarget {
  /** Stable id — a widget id, `${widgetId}:side:${sideButtonId}`, or
   *  `${widgetId}:hotkey:${entryId}`. Always present regardless of whether a
   *  keyboard shortcut is assigned, so Companion can drive every button in
   *  the app directly, not just ones that also happen to have a hotkey. */
  id: string;
  label: string;
  mode?: string;
  actions: ActionItem[];
  releaseActions?: ActionItem[];
  /** The keyboard shortcut assigned to this target, if any — informational
   *  only, shown alongside the label so it's recognizable in Companion. */
  accelerator?: string;
}

// Every Timer widget's own built-in controls, expressed as the same
// App.Timer* functions the widget's own buttons already dispatch through
// executeAppFunction (canvasStore.ts) — so a synthesized target here behaves
// byte-for-byte like clicking the widget's own Start/Pause/Reset button.
function timerTargets(w: { id: string; label?: string; config: any }): CompanionButtonTarget[] {
  const label = w.label || 'Timer';
  const fn = (name: string, suffix: string, params: Record<string, string> = { Input: w.id }): CompanionButtonTarget => ({
    id: `${w.id}:fn:${name}`,
    label: `${label} — ${suffix}`,
    actions: [{ fn: `App.${name}`, params }],
  });

  const out = [
    fn('TimerToggle', 'Start/Pause'),
    fn('TimerStart', 'Start'),
    fn('TimerPause', 'Pause'),
    fn('TimerReset', 'Reset'),
    fn('TimerEndPeriod', 'End Period'),
    fn('TimerSkipBreak', 'Skip Break'),
    fn('TimerStartExtraTime', 'Start Extra Time'),
    fn('TimerStartAfterEt', 'Start After Extra Time'),
    fn('TimerStartFinalPlay', 'Start Final Play'),
  ];

  const periods: number = w.config?.periods ?? 1;
  for (let p = 1; p <= periods; p++) {
    out.push({
      id: `${w.id}:fn:TimerJumpToPeriod:${p}`,
      label: `${label} — Jump to Period ${p}`,
      actions: [{ fn: 'App.TimerJumpToPeriod', params: { Input: w.id, Period: String(p) } }],
    });
  }

  // Same +/- nudge buttons the widget's own clock-adjust row offers (see
  // TimerWidget.tsx's default adjustButtons) — whichever phase is currently
  // active gets adjusted, matching adjustWidgetTimer's own behavior.
  const adjustButtons: { id: string; label: string; deltaMs: number }[] = w.config?.adjustButtons ?? [
    { id: '_m60', label: '−1m', deltaMs: -60000 },
    { id: '_m10', label: '−10s', deltaMs: -10000 },
    { id: '_p10', label: '+10s', deltaMs: 10000 },
    { id: '_p60', label: '+1m', deltaMs: 60000 },
  ];
  for (const btn of adjustButtons) {
    out.push({
      id: `${w.id}:fn:TimerAdjust:${btn.id}`,
      label: `${label} — Adjust ${btn.label}`,
      actions: [{ fn: 'App.TimerAdjust', params: { Input: w.id, Value: String(btn.deltaMs) } }],
    });
  }

  return out;
}

// Every Scoreboard widget's Reset/Undo controls — its own score buttons
// (Try/Conversion/etc, one per team+increment) have a richer collector of
// their own in companionScoreTargets.ts since they also need a scorer
// picker; these two don't need one.
function scoreboardTargets(w: { id: string; config: any }): CompanionButtonTarget[] {
  const cfg = w.config ?? {};
  const teamAName = cfg.teamAName || 'Team A';
  const teamBName = cfg.teamBName || 'Team B';
  return [
    { id: `${w.id}:fn:ScoreReset`, label: `${teamAName} vs ${teamBName} — Reset Score`, actions: [{ fn: 'App.ScoreReset', params: { Input: w.id } }] },
    { id: `${w.id}:fn:ScoreUndoA`, label: `${teamAName} — Undo Last Score`, actions: [{ fn: 'App.ScoreUndo', params: { Input: w.id, Team: 'A' } }] },
    { id: `${w.id}:fn:ScoreUndoB`, label: `${teamBName} — Undo Last Score`, actions: [{ fn: 'App.ScoreUndo', params: { Input: w.id, Team: 'B' } }] },
  ];
}

// Same widget walk as collectHotkeyBindings, but unconditional on a hotkey
// being assigned — every Button widget (main + side buttons) and every
// Scoreboard "Hotkey Actions" entry already carries its own stable id
// (widget id / side-button id / entry id), so those make perfectly good
// Companion trigger targets on their own. Also synthesizes targets for
// widget types whose built-in controls are already generic App.* functions
// (Timer, Scoreboard reset/undo — see timerTargets/scoreboardTargets above)
// plus app-level ones with no widget of their own (page navigation, edit
// mode). Used only by companionBridge.ts — hotkeyRegistry.ts still uses
// collectHotkeyBindings, since OS-level global shortcuts inherently require
// a real accelerator string.
//
// Not yet covered: widget types whose actions need picking a specific
// player (Player List subs/cards, Card Display) — those need a roster-aware
// picker like companionScoreTargets.ts's, not a plain button id. See
// companion-module/README.md's "Known v1 limitations".
export function collectCompanionButtonTargets(pages: CanvasPage[]): CompanionButtonTarget[] {
  const out: CompanionButtonTarget[] = [];
  for (const page of pages) {
    for (const w of page.widgets) {
      const cfg: any = w.config ?? {};

      if (w.type === 'button') {
        out.push({
          id: w.id,
          label: cfg.label || 'Button',
          mode: cfg.mode,
          actions: cfg.actions ?? [],
          releaseActions: cfg.releaseActions ?? [],
          accelerator: cfg.hotkey || undefined,
        });
        for (const sb of cfg.sideButtons ?? []) {
          out.push({
            id: `${w.id}:side:${sb.id}`,
            label: sb.label || 'Side Button',
            mode: sb.mode,
            actions: sb.actions ?? [],
            releaseActions: sb.releaseActions ?? [],
            accelerator: sb.hotkey || undefined,
          });
        }
      }

      if (w.type === 'timer') out.push(...timerTargets(w));
      if (w.type === 'scoreboard') out.push(...scoreboardTargets(w));

      for (const hb of cfg.hotkeyActions ?? []) {
        const widgetLabel = cfg.teamAName ? `${cfg.teamAName} vs ${cfg.teamBName}` : w.type;
        out.push({
          id: `${w.id}:hotkey:${hb.id}`,
          label: hb.label || widgetLabel,
          actions: hb.actions ?? [],
          accelerator: hb.hotkey || undefined,
        });
      }
    }
  }

  for (const page of pages) {
    out.push({
      id: `page:${page.id}:goto`,
      label: `Go to Page: ${page.name}`,
      actions: [{ fn: 'App.GoToPage', params: { Page: page.id } }],
    });
  }

  out.push({
    id: 'global:toggleEditMode',
    label: 'Toggle Edit Mode',
    actions: [{ fn: 'App.ToggleEditMode', params: {} }],
  });

  return out;
}
