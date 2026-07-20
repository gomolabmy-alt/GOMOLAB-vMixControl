import { create } from 'zustand';

// A short, local history of recent destructive actions (deletes, resets,
// clears) that can be reversed — a safety net, not a full undo/redo system.
// Deliberately NOT persisted: an undo closure captures live function
// references, which can't survive serialization to storage, and isn't
// synced to other connected clients — it's local to whoever performed the
// action on this machine.
export interface UndoEntry {
  id: string;
  label: string;
  timestamp: number;
  undo: () => void;
}

interface UndoStore {
  /** Newest first. */
  history: UndoEntry[];
  pushUndo: (label: string, undo: () => void) => void;
  removeEntry: (id: string) => void;
}

const MAX_UNDO = 10;

export const useUndoStore = create<UndoStore>()((set) => ({
  history: [],

  pushUndo: (label, undo) => set(s => ({
    history: [{ id: crypto.randomUUID(), label, timestamp: Date.now(), undo }, ...s.history].slice(0, MAX_UNDO),
  })),

  removeEntry: (id) => set(s => ({ history: s.history.filter(e => e.id !== id) })),
}));
