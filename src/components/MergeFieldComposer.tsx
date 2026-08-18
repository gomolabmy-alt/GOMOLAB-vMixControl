import { useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import type { VmixInput } from '../types/vmix';
import { Field } from './WidgetConfigPanel';

export interface MergePart {
  key: string;
  label: string;
  /** Sample value shown in the live preview string, e.g. "Chelsea". */
  sample: string;
}

interface Props {
  /** Canonical catalog of mergeable pieces for this widget, in default order. */
  parts: MergePart[];
  mergedParts: string[];
  mergedPrefix: string;
  mergedSeparator: string;
  onChange: (patch: { mergedParts?: string[]; mergedPrefix?: string; mergedSeparator?: string }) => void;
  inputKey: string;
  allInputs: VmixInput[];
  /** Unique across every composer instance rendered at once (e.g.
   *  `${widget.id}_${target.id}`) — scopes this composer's own
   *  drag-and-drop so two composers open at once never cross-hit-test. */
  dragKey: string;
  /** "Merged field" by default; pass "Merged field prefix" for a widget
   *  that pushes one indexed row per item (e.g. Match Schedule's
   *  Merged1.Text, Merged2.Text, ... per fixture slot). */
  fieldLabel?: string;
  /** True for a widget that pushes one indexed row per item (Match
   *  Schedule/Results/Group Standings — `${mergedPrefix}${idx}.Text`).
   *  The datalist below still suggests real, complete field names (e.g.
   *  "Round1.Text") as a reference for what exists on this input, but
   *  typing/picking one verbatim would make the reconstructed field name
   *  wrong once the index gets appended (`Round1.Text1.Text`) — so on
   *  blur, a trailing ".Text" and trailing digit run get stripped back
   *  down to just the prefix ("Round"). Never applies to a non-indexed
   *  widget, where mergedPrefix IS the exact target field name as-is. */
  indexed?: boolean;
}

// Drag-to-reorder chip composer for combining several of a widget's own
// vMix fields (team name, score, player name, whatever that widget already
// pushes individually) into ONE field instead — for a vMix Title/GT
// graphic that only has a single generic text field rather than one
// separately named field per piece of data. Plain mouse-event drag, not
// native HTML5 drag-and-drop (doesn't fire reliably in this app's
// WebView — same reasoning as every other reorderable list in this app).
// Self-contained (owns its own drag state) so any widget's config case can
// just render this with its own parts catalog, no shared/lifted state
// needed in WidgetConfigPanel.
export function MergeFieldComposer({
  parts, mergedParts, mergedPrefix, mergedSeparator, onChange, inputKey, allInputs, dragKey,
  fieldLabel = 'Merged field', indexed = false,
}: Props) {
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragFromRef = useRef<number | null>(null);

  const byKey = new Map(parts.map(p => [p.key, p]));
  const available = parts.filter(p => !mergedParts.includes(p.key));
  const fieldOptions = allInputs.find(inp => inp.key === inputKey)?.textFields ?? [];
  const datalistId = `merge-fields-${dragKey}`;

  const setMergedParts = (next: string[]) => onChange({ mergedParts: next });

  const startDrag = (fromIdx: number) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.vmix-merge-chip-x')) return;
    dragFromRef.current = fromIdx;
    setDragOverIdx(fromIdx);
    const onMove = (ev: MouseEvent) => {
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const chipEl = under?.closest(`[data-merge-drag-key="${dragKey}"]`) as HTMLElement | null;
      const idx = chipEl ? parseInt(chipEl.getAttribute('data-merge-idx') ?? '-1', 10) : -1;
      setDragOverIdx(idx >= 0 ? idx : null);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setDragOverIdx(overIdx => {
        const fromIdx2 = dragFromRef.current;
        if (fromIdx2 != null && overIdx != null && overIdx !== fromIdx2) {
          const next = [...mergedParts];
          const [moved] = next.splice(fromIdx2, 1);
          next.splice(overIdx, 0, moved);
          setMergedParts(next);
        }
        return null;
      });
      dragFromRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div className="vmix-merge-composer">
      <div className="vmix-merge-hdr">Merge into one field (optional)</div>
      {available.length > 0 && (
        <div className="vmix-merge-avail">
          {available.map(p => (
            <button key={p.key} type="button" className="vmix-merge-chip vmix-merge-chip--avail"
              onClick={() => setMergedParts([...mergedParts, p.key])}
            >+ {p.label}</button>
          ))}
        </div>
      )}
      {mergedParts.length > 0 && (
        <>
          <div className="vmix-merge-list">
            {mergedParts.map((key, idx) => (
              <div
                key={key}
                className={`vmix-merge-chip vmix-merge-chip--used${dragOverIdx === idx ? ' vmix-merge-chip--drag-over' : ''}`}
                data-merge-drag-key={dragKey}
                data-merge-idx={idx}
                onMouseDown={startDrag(idx)}
              >
                <GripVertical size={11} strokeWidth={2} />
                {byKey.get(key)?.label ?? key}
                <button type="button" className="vmix-merge-chip-x"
                  onClick={() => setMergedParts(mergedParts.filter((_, i) => i !== idx))}
                >×</button>
              </div>
            ))}
          </div>
          <Field label={fieldLabel}>
            <input className="field-input" list={datalistId} value={mergedPrefix}
              onChange={e => onChange({ mergedPrefix: e.target.value })}
              onBlur={e => {
                if (!indexed) return;
                const normalized = e.target.value.replace(/\.Text$/i, '').replace(/\d+$/, '');
                if (normalized !== e.target.value) onChange({ mergedPrefix: normalized });
              }}
              placeholder={indexed ? 'Merged' : 'Merged.Text'} />
          </Field>
          {indexed && mergedPrefix && /\.text$|\d$/i.test(mergedPrefix) && (
            <div style={{ fontSize: 10, color: '#e67e22', margin: '-4px 0 4px' }}>
              This looks like a complete field name, not a prefix — it'll actually send to "{mergedPrefix}1.Text".
              Click into the field and back out to auto-fix it to a prefix.
            </div>
          )}
          <datalist id={datalistId}>
            {fieldOptions.map(f => <option key={f.name} value={f.name} />)}
          </datalist>
          <Field label="Separator">
            <input className="field-input" style={{ width: 60 }} value={mergedSeparator}
              onChange={e => onChange({ mergedSeparator: e.target.value })} placeholder="space" />
          </Field>
          <div className="vmix-merge-preview">
            Preview: "{mergedParts.map(k => byKey.get(k)?.sample ?? '').join(mergedSeparator || ' ')}"
          </div>
        </>
      )}
    </div>
  );
}
