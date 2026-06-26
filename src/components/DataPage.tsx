import { useState, useEffect, useRef } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import type { DataBinding, DataSourceType } from '../types/vmix';

// ─── Data Binding Card ─────────────────────────────────────────────────────

function DataBindCard({ binding }: { binding: DataBinding }) {
  const { updateDataBinding, deleteDataBinding, pollDataBinding, vmixState } = useVmixStore();
  const [expanded, setExpanded] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputOptions = vmixState?.inputs.filter((i) => i.type === 'GT') ?? [];

  // Start/stop polling interval
  useEffect(() => {
    if (binding.enabled && binding.sourceUrl) {
      pollDataBinding(binding.id);
      intervalRef.current = setInterval(() => pollDataBinding(binding.id), binding.pollIntervalMs);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [binding.enabled, binding.sourceUrl, binding.pollIntervalMs, binding.id, pollDataBinding]);

  const timeSince = binding.lastFetched
    ? `${Math.round((Date.now() - binding.lastFetched) / 1000)}s ago`
    : 'never';

  return (
    <div className={`data-card ${binding.enabled ? 'data-card--active' : ''}`}>
      <div className="data-card-header">
        <div className="data-card-info">
          <span className="data-card-name">{binding.name}</span>
          {binding.lastValue && (
            <span className="data-card-value">→ {binding.lastValue}</span>
          )}
          {binding.lastError && (
            <span className="data-card-error">⚠ {binding.lastError}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span className="data-card-time">{timeSince}</span>
          <button
            className={`btn btn--small ${binding.enabled ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => updateDataBinding(binding.id, { enabled: !binding.enabled })}
          >
            {binding.enabled ? 'ON' : 'OFF'}
          </button>
          <button className="btn btn--ghost btn--small" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '▲' : '▼'}
          </button>
          <button className="btn btn--ghost btn--small" onClick={() => deleteDataBinding(binding.id)}>×</button>
        </div>
      </div>

      {expanded && (
        <div className="data-card-settings">
          <div className="field-row">
            <label className="field-label">Name</label>
            <input className="field-input" value={binding.name}
              onChange={(e) => updateDataBinding(binding.id, { name: e.target.value })} />
          </div>
          <div className="field-row">
            <label className="field-label">Source Type</label>
            <select className="field-input" value={binding.sourceType}
              onChange={(e) => updateDataBinding(binding.id, { sourceType: e.target.value as DataSourceType })}>
              <option value="json">JSON</option>
              <option value="xml">XML</option>
              <option value="text">Plain Text</option>
            </select>
          </div>
          <div className="field-row">
            <label className="field-label">URL</label>
            <input className="field-input" type="url" value={binding.sourceUrl} placeholder="https://..."
              onChange={(e) => updateDataBinding(binding.id, { sourceUrl: e.target.value })} />
          </div>
          {binding.sourceType !== 'text' && (
            <div className="field-row">
              <label className="field-label">
                {binding.sourceType === 'json' ? 'JSON Path (dot-notation)' : 'CSS/Tag Selector'}
              </label>
              <input className="field-input" value={binding.selector}
                placeholder={binding.sourceType === 'json' ? 'data.value' : 'temperature'}
                onChange={(e) => updateDataBinding(binding.id, { selector: e.target.value })} />
            </div>
          )}
          <div className="field-row">
            <label className="field-label">Poll Interval (ms)</label>
            <input className="field-input" type="number" value={binding.pollIntervalMs} min={500}
              onChange={(e) => updateDataBinding(binding.id, { pollIntervalMs: Number(e.target.value) })} />
          </div>
          <div className="field-row">
            <label className="field-label">vMix Title Input</label>
            <select className="field-input" value={binding.vmixInputKey}
              onChange={(e) => updateDataBinding(binding.id, { vmixInputKey: e.target.value })}>
              <option value="">— none —</option>
              {inputOptions.map((i) => (
                <option key={i.key} value={i.key}>{i.number}. {i.title}</option>
              ))}
            </select>
          </div>
          {binding.vmixInputKey && (
            <div className="field-row">
              <label className="field-label">Field Name</label>
              <input className="field-input" value={binding.fieldName} placeholder="Value.Text"
                onChange={(e) => updateDataBinding(binding.id, { fieldName: e.target.value })} />
            </div>
          )}
          <button
            className="btn btn--ghost btn--small"
            onClick={() => pollDataBinding(binding.id)}
          >
            Fetch Now
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Global Variables ──────────────────────────────────────────────────────

function VariableRow({ id, name, value }: { id: string; name: string; value: string }) {
  const { setVariable, deleteVariable } = useVmixStore();
  return (
    <div className="var-row">
      <span className="var-name">{'{' + name + '}'}</span>
      <input
        className="field-input var-value"
        value={value}
        onChange={(e) => setVariable(id, e.target.value)}
      />
      <button className="btn btn--ghost btn--small" onClick={() => deleteVariable(id)}>×</button>
    </div>
  );
}

// ─── Data Page ─────────────────────────────────────────────────────────────

export function DataPage() {
  const { dataBindings, addDataBinding, globalVariables, addVariable } = useVmixStore();
  const [newVarName, setNewVarName] = useState('');

  const handleAddVar = () => {
    if (!newVarName.trim()) return;
    addVariable(newVarName.trim());
    setNewVarName('');
  };

  return (
    <div className="data-page page-scroll">
      {/* Data Bindings */}
      <div className="data-section">
        <div className="score-page-row">
          <div className="mix-section-title">Data Bindings</div>
          <button className="btn btn--ghost btn--small" onClick={addDataBinding}>+ Add</button>
        </div>
        <p className="data-hint">
          Pull JSON/XML from a URL and push the value into a vMix title field automatically.
        </p>
        {dataBindings.map((db) => <DataBindCard key={db.id} binding={db} />)}
        {dataBindings.length === 0 && (
          <div className="data-empty">No data bindings yet. Add one above.</div>
        )}
      </div>

      {/* Global Variables */}
      <div className="data-section">
        <div className="mix-section-title">Global Variables</div>
        <p className="data-hint">
          Use <code>{'{ name }'}</code> in shortcut button labels to display variable values.
        </p>
        <div className="var-add-row">
          <input
            className="field-input"
            placeholder="variable name"
            value={newVarName}
            onChange={(e) => setNewVarName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddVar()}
          />
          <button className="btn btn--primary btn--small" onClick={handleAddVar} disabled={!newVarName.trim()}>
            Add
          </button>
        </div>
        {globalVariables.map((v) => (
          <VariableRow key={v.id} id={v.id} name={v.name} value={v.value} />
        ))}
        {globalVariables.length === 0 && (
          <div className="data-empty">No variables defined.</div>
        )}
      </div>
    </div>
  );
}
