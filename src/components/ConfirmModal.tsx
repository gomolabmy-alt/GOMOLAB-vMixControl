import { createPortal } from 'react-dom';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// Portal-rendered so it isn't clipped by a scaled/overflow:hidden canvas
// widget (same reasoning as TeamPicker/MatchSchedulePicker). Replaces native
// confirm(), which was already found unreliable in the packaged Tauri
// webview elsewhere in this app.
export function ConfirmModal({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel }: Props) {
  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>{message}</p>
        <div className="modal-actions">
          <button className="btn btn--ghost btn--small" onClick={onCancel}>{cancelLabel}</button>
          <button className={`btn btn--small ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
