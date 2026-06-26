// Runs in a dedicated Web Worker thread.
// setInterval here is NEVER throttled — not by page visibility, minimise, or idle.
const intervals: Record<string, ReturnType<typeof setInterval>> = {};

self.onmessage = function (e: MessageEvent) {
  const { type, widgetId, tickMs } = e.data;
  if (type === 'start') {
    if (intervals[widgetId]) return;
    intervals[widgetId] = setInterval(() => {
      self.postMessage({ type: 'tick', widgetId });
    }, tickMs);
  } else if (type === 'stop') {
    if (intervals[widgetId]) {
      clearInterval(intervals[widgetId]);
      delete intervals[widgetId];
    }
  }
};
