import { useState } from 'react';

interface Props {
  label: string;
  message: string;
  onConfirm: () => void;
  confirmLabel?: string;
  className?: string;
  disabled?: boolean;
}

// A destructive action that confirms in place instead of relying on the
// native window.confirm() dialog — that dialog was found to silently not
// fire in at least one spot in this app, so buttons that must reliably
// confirm (clearing accumulated data) use this pattern instead.
export function ConfirmButton({ label, message, onConfirm, confirmLabel = 'Confirm', className, disabled }: Props) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="confirm-btn-group" onClick={e => e.stopPropagation()}>
        <span className="confirm-btn-msg">{message}</span>
        <button className="confirm-btn confirm-btn--yes" onClick={() => { onConfirm(); setConfirming(false); }}>
          {confirmLabel}
        </button>
        <button className="confirm-btn confirm-btn--no" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    );
  }

  return (
    <button
      className={className}
      disabled={disabled}
      onClick={e => { e.stopPropagation(); setConfirming(true); }}
    >
      {label}
    </button>
  );
}
