import { useState } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import type { Shortcut, ShortcutMode } from '../types/vmix';

const PRESET_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#34495e',
];

// ─── Single Shortcut Button ────────────────────────────────────────────────

function ShortcutButton({
  shortcut,
  onEdit,
}: {
  shortcut: Shortcut;
  onEdit: () => void;
}) {
  const { sendFunction, vmixState, resolveLabel } = useVmixStore();
  const [toggled, setToggled] = useState(false);
  const [firing, setFiring] = useState(false);

  const label = shortcut.variableLabel
    ? resolveLabel(shortcut.variableLabel)
    : shortcut.label;

  const handlePress = async () => {
    if (shortcut.mode === 'toggle') {
      const newToggled = !toggled;
      setToggled(newToggled);
      if (newToggled) {
        await sendFunction(shortcut.function, shortcut.params);
      } else if (shortcut.releaseFunction) {
        await sendFunction(shortcut.releaseFunction, shortcut.releaseParams ?? {});
      }
      return;
    }
    // momentary
    setFiring(true);
    await sendFunction(shortcut.function, shortcut.params);
    setTimeout(() => setFiring(false), 200);
  };

  const handleRelease = async () => {
    if (shortcut.mode === 'momentary' && shortcut.releaseFunction) {
      await sendFunction(shortcut.releaseFunction, shortcut.releaseParams ?? {});
    }
  };

  const isActiveToggle = shortcut.mode === 'toggle' && toggled;

  return (
    <div className="shortcut-wrapper">
      <button
        className={[
          'shortcut-btn',
          firing ? 'shortcut-btn--firing' : '',
          isActiveToggle ? 'shortcut-btn--toggled' : '',
        ].filter(Boolean).join(' ')}
        style={{ '--shortcut-color': shortcut.color ?? '#3498db' } as React.CSSProperties}
        onPointerDown={handlePress}
        onPointerUp={handleRelease}
        disabled={!vmixState}
      >
        {shortcut.mode === 'toggle' && (
          <span className="shortcut-mode-dot" />
        )}
        {label}
      </button>
      <button className="shortcut-edit-btn" onClick={onEdit} title="Edit">⋯</button>
    </div>
  );
}

// ─── Edit Modal ────────────────────────────────────────────────────────────

function EditShortcutModal({
  shortcut,
  onSave,
  onDelete,
  onClose,
}: {
  shortcut: Shortcut | null;
  onSave: (s: Shortcut) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const isNew = !shortcut;
  const [label, setLabel] = useState(shortcut?.label ?? '');
  const [fn, setFn] = useState(shortcut?.function ?? '');
  const [paramStr, setParamStr] = useState(
    shortcut ? Object.entries(shortcut.params).map(([k, v]) => `${k}=${v}`).join('\n') : '',
  );
  const [mode, setMode] = useState<ShortcutMode>(shortcut?.mode ?? 'momentary');
  const [releaseFn, setReleaseFn] = useState(shortcut?.releaseFunction ?? '');
  const [releaseParamStr, setReleaseParamStr] = useState(
    shortcut?.releaseParams
      ? Object.entries(shortcut.releaseParams).map(([k, v]) => `${k}=${v}`).join('\n')
      : '',
  );
  const [varLabel, setVarLabel] = useState(shortcut?.variableLabel ?? '');
  const [color, setColor] = useState(shortcut?.color ?? '#3498db');

  const parseParams = (str: string): Record<string, string> => {
    const result: Record<string, string> = {};
    str.split('\n').forEach((line) => {
      const [k, ...rest] = line.split('=');
      if (k?.trim()) result[k.trim()] = rest.join('=').trim();
    });
    return result;
  };

  const handleSave = () => {
    if (!label.trim() || !fn.trim()) return;
    onSave({
      id: shortcut?.id ?? crypto.randomUUID(),
      label: label.trim(),
      function: fn.trim(),
      params: parseParams(paramStr),
      mode,
      releaseFunction: releaseFn.trim() || undefined,
      releaseParams: releaseFn.trim() ? parseParams(releaseParamStr) : undefined,
      variableLabel: varLabel.trim() || undefined,
      color,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{isNew ? 'Add Shortcut' : 'Edit Shortcut'}</h3>

        <div className="field-row">
          <label className="field-label">Label</label>
          <input className="field-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My Button" />
        </div>

        <div className="field-row">
          <label className="field-label">Variable Label <span className="field-label-hint">(replaces label with {'{varName}'})</span></label>
          <input className="field-input" value={varLabel} onChange={(e) => setVarLabel(e.target.value)} placeholder="{score}" />
        </div>

        <div className="field-row">
          <label className="field-label">Mode</label>
          <select className="field-input" value={mode} onChange={(e) => setMode(e.target.value as ShortcutMode)}>
            <option value="momentary">Momentary (fire on press)</option>
            <option value="toggle">Toggle (on/off)</option>
          </select>
        </div>

        <div className="field-row">
          <label className="field-label">vMix Function</label>
          <input className="field-input" value={fn} onChange={(e) => setFn(e.target.value)} placeholder="Cut, Fade, SetText…" />
        </div>

        <div className="field-row">
          <label className="field-label">Params <span className="field-label-hint">(Key=Value per line)</span></label>
          <textarea className="field-input" value={paramStr} onChange={(e) => setParamStr(e.target.value)}
            placeholder={'Input=1\nValue=Hello'} rows={3} />
        </div>

        {(mode === 'toggle' || mode === 'momentary') && (
          <>
            <div className="field-row">
              <label className="field-label">
                {mode === 'toggle' ? 'Off Function (toggle off)' : 'Release Function (on pointer up)'}
              </label>
              <input className="field-input" value={releaseFn} onChange={(e) => setReleaseFn(e.target.value)} placeholder="optional" />
            </div>
            {releaseFn && (
              <div className="field-row">
                <label className="field-label">Release Params</label>
                <textarea className="field-input" value={releaseParamStr} onChange={(e) => setReleaseParamStr(e.target.value)} rows={2} />
              </div>
            )}
          </>
        )}

        <div className="field-row">
          <label className="field-label">Color</label>
          <div className="color-picker">
            {PRESET_COLORS.map((c) => (
              <button key={c} className={`color-swatch ${color === c ? 'color-swatch--selected' : ''}`}
                style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>

        <div className="modal-actions">
          {!isNew && (
            <button className="btn btn--danger btn--small" onClick={() => { onDelete(shortcut!.id); onClose(); }}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn btn--ghost btn--small" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary btn--small" onClick={handleSave} disabled={!label.trim() || !fn.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shortcut Panel (page) ─────────────────────────────────────────────────

export function ShortcutPanel() {
  const { shortcuts, updateShortcuts } = useVmixStore();
  const [editTarget, setEditTarget] = useState<Shortcut | null | 'new'>(null);

  const handleSave = (updated: Shortcut) => {
    const exists = shortcuts.find((s) => s.id === updated.id);
    updateShortcuts(exists
      ? shortcuts.map((s) => (s.id === updated.id ? updated : s))
      : [...shortcuts, updated]);
  };

  const handleDelete = (id: string) => updateShortcuts(shortcuts.filter((s) => s.id !== id));

  return (
    <div className="shortcut-page page-scroll">
      <div className="score-page-row" style={{ padding: '10px 12px 0' }}>
        <div className="mix-section-title">Shortcuts</div>
        <button className="btn btn--ghost btn--small" onClick={() => setEditTarget('new')}>+ Add</button>
      </div>
      <p style={{ padding: '4px 12px 8px', fontSize: 11, color: 'var(--text-muted)' }}>
        Long-press or tap ⋯ to edit. Toggle mode fires the "off" function on second press.
      </p>

      <div className="shortcut-grid shortcut-grid--page">
        {shortcuts.map((sc) => (
          <ShortcutButton key={sc.id} shortcut={sc} onEdit={() => setEditTarget(sc)} />
        ))}
      </div>

      {editTarget !== null && (
        <EditShortcutModal
          shortcut={editTarget === 'new' ? null : editTarget}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}
