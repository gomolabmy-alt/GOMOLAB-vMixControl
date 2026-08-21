const _isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Ports used by the embedded image server (sync, readonly, commentator)
const IMAGE_PORTS = new Set(['9877', '9878', '9879']);

/**
 * Resolves a stored image URL to one that is actually reachable from the
 * current environment:
 *
 * - Tauri WebView: always rewrite to http://localhost:PORT — the embedded
 *   HTTP server always listens on localhost regardless of which network is
 *   active, so stored LAN-IP URLs from a previous session still work.
 *
 * - Remote browser client (commentator / readonly page): rewrite localhost to
 *   window.location.hostname — the page was served by the Tauri machine, so
 *   that host is the correct image server address from the client's perspective.
 */
export function resolveImageUrl(url: string): string {
  if (!url) return url;
  const m = url.match(/^http:\/\/([^/:]+):(\d+)(\/images\/.*)$/);
  if (!m || !IMAGE_PORTS.has(m[2])) return url;
  if (_isTauri) {
    return `http://localhost:${m[2]}${m[3]}`;
  }
  // Browser context: use the hostname the page was loaded from
  const host = typeof window !== 'undefined' ? (window.location.hostname || 'localhost') : 'localhost';
  return `http://${host}:${m[2]}${m[3]}`;
}

// A fully transparent PNG the Rust side seeds into the images folder on
// every launch (see lib.rs) — always present on every port (9877/9878/9879
// all serve the same images dir), so it can be referenced by a stable URL
// without uploading anything. Useful as a deliberate "blank" logo, e.g. so
// a vMix push can actively clear an image field instead of leaving
// whatever the previous team's logo was showing.
export function transparentLogoUrl(): string {
  const port = (typeof window !== 'undefined' && window.location.port) || '9877';
  return `http://localhost:${port}/images/transparent.png`;
}

/**
 * Resets any indexed logo (".Source") field beyond the current row/item
 * count back to the transparent placeholder — the image-field equivalent
 * of clearing a stale indexed text field (`^prefix(\d+)\.Text$`), which
 * every per-row vMix push in this app already does for its text fields but
 * — until this existed — never did for the logo alongside them, since an
 * image field can't be blanked with an empty string the way text can. E.g.
 * a Group Standings/Bracket/Match Schedule list shrinking (fewer teams,
 * fewer matches) used to leave the extra slots showing whichever team's
 * logo was there from before, forever, even though the matching text
 * fields at those same indices correctly went blank.
 */
export function clearStaleLogoSlots(
  c: { setImageField: (inputKey: string, field: string, url: string) => void },
  inputKey: string,
  textFields: { name: string }[],
  prefix: string | undefined,
  currentCount: number,
): void {
  if (!prefix) return;
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}(\\d+)\\.Source$`, 'i');
  for (const field of textFields) {
    const m = field.name.match(re);
    if (m && parseInt(m[1], 10) > currentCount) c.setImageField(inputKey, field.name, transparentLogoUrl());
  }
}
