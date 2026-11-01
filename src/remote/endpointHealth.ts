/** Memory-only ranking of already-paired URLs. Never discovers an endpoint. */
export function createEndpointHealth(now = Date.now) {
  const health = new Map<string, {failures: number; retryAt: number; successAt: number}>();
  const key = (desktopId: string, endpoint: string) => `${desktopId}\n${endpoint}`;
  return {
    order(desktopId: string, paired: string[]) {
      const candidates = paired.map((endpoint, index) => ({endpoint, index, state: health.get(key(desktopId, endpoint))}));
      const ready = candidates.filter(item => !item.state || item.state.retryAt <= now());
      // If every trusted endpoint is cooling, retry the earliest one; never get
      // stuck forever, nor serially wait on every known-unhealthy address.
      return (ready.length ? ready : candidates.sort((a, b) => (a.state?.retryAt || 0) - (b.state?.retryAt || 0)).slice(0, 1))
        .sort((a, b) => (b.state?.successAt || 0) - (a.state?.successAt || 0) || a.index - b.index).map(item => item.endpoint);
    },
    success(desktopId: string, endpoint: string) {health.set(key(desktopId, endpoint), {failures: 0, retryAt: 0, successAt: now()});},
    fail(desktopId: string, endpoint: string) {
      const id = key(desktopId, endpoint), old = health.get(id);
      const failures = (old?.failures || 0) + 1;
      health.set(id, {failures, retryAt: now() + Math.min(60000, 2000 * 2 ** Math.min(failures, 5)), successAt: old?.successAt || 0});
      if (health.size > 128) health.delete(health.keys().next().value!);
    },
  };
}
