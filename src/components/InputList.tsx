import { useVmixStore } from '../stores/vmixStore';
import { INPUT_TYPE_LABELS } from '../types/vmix';
import type { VmixInput } from '../types/vmix';

function InputTypeTag({ type }: { type: string }) {
  const label = INPUT_TYPE_LABELS[type] ?? type;
  return <span className={`input-type-tag input-type-tag--${type.toLowerCase()}`}>{label}</span>;
}

function InputCard({
  input,
  isSelected,
  isPreview,
  isActive,
  onSelect,
  onSetPreview,
  onSetActive,
}: {
  input: VmixInput;
  isSelected: boolean;
  isPreview: boolean;
  isActive: boolean;
  onSelect: () => void;
  onSetPreview: () => void;
  onSetActive: () => void;
}) {
  return (
    <li
      className={[
        'input-card',
        isSelected ? 'input-card--selected' : '',
        isActive ? 'input-card--active' : '',
        isPreview ? 'input-card--preview' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button className="input-card-body" onClick={onSelect}>
        <div className="input-card-header">
          <span className="input-card-number">{input.number}</span>
          <InputTypeTag type={input.type} />
          {isActive && <span className="input-tally input-tally--pgm">PGM</span>}
          {isPreview && <span className="input-tally input-tally--prv">PRV</span>}
        </div>
        <div className="input-card-title">{input.title || `Input ${input.number}`}</div>
        {input.textFields.length > 0 && (
          <div className="input-card-preview-text">
            {input.textFields[0].value || <em className="input-card-empty">empty</em>}
          </div>
        )}
      </button>
      <div className="input-card-actions">
        <button
          className={`input-action-btn input-action-btn--prv ${isPreview ? 'input-action-btn--active' : ''}`}
          onClick={onSetPreview}
          title="Send to Preview"
        >
          PRV
        </button>
        <button
          className={`input-action-btn input-action-btn--pgm ${isActive ? 'input-action-btn--active' : ''}`}
          onClick={onSetActive}
          title="Send to Program"
        >
          PGM
        </button>
      </div>
    </li>
  );
}

export function InputList() {
  const { vmixState, selectedInputKey, selectInput, setPreview, setActive } = useVmixStore();

  if (!vmixState) return null;

  const { inputs, preview, active } = vmixState;

  return (
    <aside className="input-list-panel">
      <div className="panel-header">
        <h2 className="panel-title">Inputs</h2>
        <span className="panel-count">{inputs.length}</span>
      </div>
      <ul className="input-list">
        {inputs.map((input) => (
          <InputCard
            key={input.key}
            input={input}
            isSelected={selectedInputKey === input.key}
            isPreview={preview === input.number}
            isActive={active === input.number}
            onSelect={() => selectInput(input.key === selectedInputKey ? null : input.key)}
            onSetPreview={() => setPreview(input.key)}
            onSetActive={() => setActive(input.key)}
          />
        ))}
      </ul>
    </aside>
  );
}
