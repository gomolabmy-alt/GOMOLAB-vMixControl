import { createContext } from 'react';
import type { CanvasPage } from '../types/canvas';

export interface CanvasActionOverrides {
  pages: CanvasPage[];
  activePageId: string;
  selectedWidgetId: string | null;
  moveWidget: (id: string, x: number, y: number) => void;
  resizeWidget: (id: string, w: number, h: number) => void;
  selectWidget: (id: string | null) => void;
  deleteWidget: (id: string) => void;
  transferWidgetToPage: (widgetId: string, targetPageId: string, copy: boolean) => void;
  updateWidgetConfig: (widgetId: string, patch: Record<string, any>) => void;
}

/** Provided by Canvas when in commentator mode so WidgetWrapper uses the right actions. */
export const CanvasActionContext = createContext<CanvasActionOverrides | null>(null);
