import { useCanvasStore } from '../stores/canvasStore';
import { WIDGET_TYPE_ICONS, WIDGET_TYPE_LABELS } from '../types/canvas';
import type { WidgetType } from '../types/canvas';

const WIDGET_GROUPS: { label: string; types: WidgetType[] }[] = [
  { label: 'Controls',  types: ['button', 'transitions', 'tbar', 'panel'] },
  { label: 'Input',     types: ['input-tally', 'title-field', 'vmix-titles', 'file-path', 'ndi-input'] },
  { label: 'Overlay',   types: ['overlay'] },
  { label: 'Audio',     types: ['volume'] },
  { label: 'Sports',    types: ['scoreboard', 'score-log', 'score-lower-third', 'sin-bin-lower-third', 'player-lower-third', 'timer', 'timeline', 'player-list', 'substitution', 'card-display', 'rugby-lineup'] },
  { label: 'Display',   types: ['label'] },
];

interface Props {
  onClose: () => void;
}

export function WidgetPalette({ onClose }: Props) {
  const { addWidget } = useCanvasStore();

  const handleAdd = (type: WidgetType) => {
    addWidget(type);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal palette-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Add Widget</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {WIDGET_GROUPS.map((group) => (
          <div key={group.label} className="palette-group">
            <div className="palette-group-label">{group.label}</div>
            <div className="palette-grid">
              {group.types.map((type) => (
                <button key={type} className="palette-item" onClick={() => handleAdd(type)}>
                  <span className="palette-item-icon">{WIDGET_TYPE_ICONS[type]}</span>
                  <span className="palette-item-label">{WIDGET_TYPE_LABELS[type]}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
