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
