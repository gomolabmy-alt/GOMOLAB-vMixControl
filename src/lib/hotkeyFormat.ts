// Shared helpers for turning a physical key-press into a Tauri accelerator
// string (e.g. "CommandOrControl+Shift+1") and back into a human-readable
// label (e.g. "⌘⇧1" / "Ctrl+Shift+1") — used by HotkeyRecorder (capture +
// display) and anywhere a bound hotkey needs to be shown as a small badge.

const _isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent ?? '');

const CODE_KEY_MAP: Record<string, string> = {
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  Space: 'Space', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']);

// Builds a Tauri-accelerator string from a real KeyboardEvent captured while
// the app is focused (recording only ever happens in-app; firing later does
// not require focus). Returns null for a bare modifier press (nothing to
// bind yet) or an unrecognized key.
export function buildAccelerator(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) return null;

  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else key = CODE_KEY_MAP[e.code];
  if (!key) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

// Human-readable label for a stored accelerator string.
export function hotkeyLabel(accelerator: string | undefined): string {
  if (!accelerator) return '';
  return accelerator
    .split('+')
    .map(part => {
      if (part === 'CommandOrControl') return _isMac ? '⌘' : 'Ctrl';
      if (part === 'Alt') return _isMac ? '⌥' : 'Alt';
      if (part === 'Shift') return _isMac ? '⇧' : 'Shift';
      return part;
    })
    .join(_isMac ? '' : '+');
}
