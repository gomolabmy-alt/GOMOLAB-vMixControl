import type { CanvasWidget, CanvasPage, WidgetType } from '../types/canvas';

/** Finds the CanvasPage that owns a given widget id — the "which page am I
 *  on" lookup most widget components already repeat ad hoc for their own
 *  tournament-fallback logic. */
export function findOwningPage(pages: CanvasPage[], widgetId: string): CanvasPage | undefined {
  return pages.find(p => p.widgets.some(w => w.id === widgetId));
}

/**
 * Resolves a "linked X widget" config reference — an explicit id always
 * wins (an existing manual choice is never silently overridden), but when
 * nothing has been picked yet (a fresh widget, default config) and there's
 * exactly one widget of the target type on the SAME page, that one gets
 * used automatically instead of requiring a manual pick in settings first.
 * Ambiguous (zero, or two-plus matching widgets on the page) still requires
 * an explicit choice — auto-linking to the wrong one of several candidates
 * would be worse than just asking.
 */
export function autoLinkedWidget(
  pages: CanvasPage[], ownWidgetId: string, explicitId: string | undefined, targetType: WidgetType,
): CanvasWidget | undefined {
  const allWidgets = pages.flatMap(p => p.widgets);
  if (explicitId) {
    const explicit = allWidgets.find(w => w.id === explicitId && w.type === targetType);
    if (explicit) return explicit;
  }
  const page = findOwningPage(pages, ownWidgetId);
  if (!page) return undefined;
  const candidates = page.widgets.filter(w => w.type === targetType && w.id !== ownWidgetId);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Same auto-pick reasoning as autoLinkedWidget, but for the id string only
 *  (some call sites just need the id to store/compare, not the widget). */
export function autoLinkedWidgetId(
  pages: CanvasPage[], ownWidgetId: string, explicitId: string | undefined, targetType: WidgetType,
): string | undefined {
  return autoLinkedWidget(pages, ownWidgetId, explicitId, targetType)?.id;
}

/**
 * Same idea as autoLinkedWidget, but for fields that need TWO distinct
 * widgets of the same type at once — one per side (e.g. a Card Display's
 * Team A / Team B Player List links). If either side already has an
 * explicit id, both are left exactly as configured (never overridden). If
 * neither is set and there are exactly two matching widgets on the page,
 * they're assigned by their own `teamSide` config ('A'/'B') when available,
 * falling back to left-to-right canvas position as a reasonable guess.
 */
export function autoLinkedWidgetPair(
  pages: CanvasPage[], ownWidgetId: string,
  explicitA: string | undefined, explicitB: string | undefined, targetType: WidgetType,
): { a?: CanvasWidget; b?: CanvasWidget } {
  const allWidgets = pages.flatMap(p => p.widgets);
  const explicitAWidget = explicitA ? allWidgets.find(w => w.id === explicitA && w.type === targetType) : undefined;
  const explicitBWidget = explicitB ? allWidgets.find(w => w.id === explicitB && w.type === targetType) : undefined;
  if (explicitAWidget || explicitBWidget) return { a: explicitAWidget, b: explicitBWidget };

  const page = findOwningPage(pages, ownWidgetId);
  if (!page) return {};
  const candidates = page.widgets.filter(w => w.type === targetType);
  // A single side-by-side Player List widget already covers both teams by
  // itself (a_/b_-prefixed config, see playerListSquad.ts) — no second
  // widget to pair it with, so it's assigned to both sides at once.
  if (candidates.length === 1 && candidates[0].config?.layout === 'side-by-side') {
    return { a: candidates[0], b: candidates[0] };
  }
  if (candidates.length !== 2) return {};
  const bySide = (side: 'A' | 'B') => candidates.find(w => w.config?.teamSide === side);
  const byPosition = [...candidates].sort((x, y) => x.x - y.x);
  const a = bySide('A') ?? byPosition[0];
  const b = bySide('B') ?? byPosition[1];
  return { a, b };
}

// Every top-level config field, across every widget type, whose value is a
// plain reference to another widget's `id` (audited against every consumer
// in the app, including the Companion module's own collectors — see the
// "widget-id rename cascade" work). Kept as one flat list since a field
// only ever needs checking by name, regardless of which widget type it
// happens to live on.
const WIDGET_ID_LINK_FIELDS = [
  'linkedScoreboardId', 'linkedTimerWidgetId', 'linkedTimerSourceId',
  'linkedScoreboardSourceId', 'linkedPlayerListId', 'linkedPlayerListA',
  'linkedPlayerListB', 'linkedTimelineId', 'linkedPlayerHighlightId',
  'linkedScoreLogWidgetId',
] as const;

// Button/hotkey action items whose `fn` is an App.* function store their
// target widget's id in `params.Input` (vMix functions store a vMix input
// key there instead, never a canvas widget id — a plain value-equality
// check against oldId is safe either way, since the two never coincide).
function remapActionList(list: any, oldId: string, newId: string): any {
  if (!Array.isArray(list)) return list;
  return list.map(item =>
    item?.params?.Input === oldId ? { ...item, params: { ...item.params, Input: newId } } : item
  );
}

/**
 * Rewrites every reference to `oldId` inside a single widget's config —
 * top-level linked-widget fields (see WIDGET_ID_LINK_FIELDS) plus the
 * button/hotkey action arrays that can target a widget via an App.*
 * function — to `newId` instead. Used when a widget's id is renamed, so
 * every OTHER widget that points at it (a linked scoreboard, a button's
 * "Start this Timer" action, etc.) keeps working under the new id.
 * Returns the same object reference unchanged if nothing needed rewriting.
 */
export function remapWidgetIdInConfig(config: Record<string, any>, oldId: string, newId: string): Record<string, any> {
  let changed = false;
  const next = { ...config };

  for (const field of WIDGET_ID_LINK_FIELDS) {
    if (next[field] === oldId) { next[field] = newId; changed = true; }
  }

  const remapField = (field: string) => {
    const before = next[field];
    const after = remapActionList(before, oldId, newId);
    if (after !== before) { next[field] = after; changed = true; }
  };
  remapField('actions');
  remapField('releaseActions');
  if (Array.isArray(next.sideButtons)) {
    const sideButtons = next.sideButtons.map((sb: any) => {
      const actions = remapActionList(sb.actions, oldId, newId);
      const releaseActions = remapActionList(sb.releaseActions, oldId, newId);
      if (actions === sb.actions && releaseActions === sb.releaseActions) return sb;
      changed = true;
      return { ...sb, actions, releaseActions };
    });
    next.sideButtons = sideButtons;
  }
  if (Array.isArray(next.hotkeyActions)) {
    const hotkeyActions = next.hotkeyActions.map((hb: any) => {
      const actions = remapActionList(hb.actions, oldId, newId);
      if (actions === hb.actions) return hb;
      changed = true;
      return { ...hb, actions };
    });
    next.hotkeyActions = hotkeyActions;
  }

  return changed ? next : config;
}
