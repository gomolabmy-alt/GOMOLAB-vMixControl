import { useAuthStore } from '../stores/authStore';

function handleUrls(urls: string[] | null) {
  if (!urls) return;
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'gomolab:') continue;
      const token = url.searchParams.get('token');
      const state = url.searchParams.get('state');
      if (token && state) useAuthStore.getState().completeSignIn(token, state);
    } catch {
      // malformed URL — ignore
    }
  }
}

// Catches the gomolab://auth?token=...&state=... callback handed back by the
// eventmanagementsystem site after a successful web login. getCurrent()
// covers a cold start (app wasn't running yet); onOpenUrl() covers the warm
// case (already running — macOS native reopen event, or Windows/Linux via
// tauri-plugin-single-instance forwarding the second process's argv in).
export async function initDeepLink() {
  const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
  try {
    handleUrls(await getCurrent());
  } catch {
    // not launched via a deep link — fine
  }
  try {
    await onOpenUrl(handleUrls);
  } catch {
    // plugin unavailable (e.g. running in a plain browser tab) — fine
  }
}
