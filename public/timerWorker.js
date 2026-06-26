// Web Worker for timer ticks.
// Runs in its own thread — never throttled by page visibility or idle state.
const intervals = {};

self.onmessage = function (e) {
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
