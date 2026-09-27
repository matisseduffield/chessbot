// A health check must not join the analysis WebSocket: connecting a popup
// every five seconds makes the server replay state to a throwaway client.
export function watchBackendHealth(
  onStatus,
  { fetchFn = fetch, interval = 5000, timeout = 2500 } = {},
) {
  let stopped = false,
    timer,
    controller;
  async function check() {
    controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchFn('http://localhost:8080/healthz', {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Backend unavailable');
      const data = await response.json();
      if (!stopped)
        onStatus(data.status === 'ok' && data.engine?.ready === true ? 'ready' : 'starting');
    } catch {
      if (!stopped) onStatus('offline');
    } finally {
      clearTimeout(deadline);
      if (!stopped) timer = setTimeout(check, interval);
    }
  }
  check();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
