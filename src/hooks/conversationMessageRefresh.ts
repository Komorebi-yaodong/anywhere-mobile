/** Single-flight, trailing-edge message reads. Events are invalidations, not rows. */
export function createConversationMessageRefresh(read: (conversationId: string) => Promise<void>, intervalMs = 800) {
  let scope = '';
  let running = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextAllowedAt = 0;
  let urgent = false;
  let waiters: Array<{resolve: () => void; reject: (error: unknown) => void}> = [];
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const pump = () => {
    if (running || !waiters.length) return;
    clearTimer();
    const delay = urgent ? 0 : Math.max(0, nextAllowedAt - Date.now());
    if (delay > 0) { timer = setTimeout(pump, delay); return; }
    const requestedScope = scope;

    const started = generation;
    const batch = waiters;
    waiters = [];
    urgent = false;
    running = true;
    nextAllowedAt = Date.now() + intervalMs;
    read(requestedScope).then(
      () => batch.forEach(waiter => waiter.resolve()),
      error => batch.forEach(waiter => waiter.reject(error)),
    ).finally(() => {if (started === generation) {running = false; pump();}});
  };
  return {
    request(conversationId: string, immediate = true): Promise<void> {
      if (!conversationId) return Promise.resolve();
      if (scope !== conversationId) {

        generation++; running = false;
        clearTimer();
        waiters.forEach(waiter => waiter.resolve());
        waiters = [];
        scope = conversationId;
        nextAllowedAt = 0;
      }
      urgent ||= immediate;
      const result = new Promise<void>((resolve, reject) => { waiters.push({resolve, reject}); });
      pump();
      return result;
    },
    cancel() {

      generation++; running = false;
      clearTimer();
      scope = '';
      urgent = false;
      nextAllowedAt = 0;
      waiters.forEach(waiter => waiter.resolve());
      waiters = [];
    },
  };
}
