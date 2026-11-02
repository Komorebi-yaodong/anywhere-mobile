/** Connection-owned read coalescing. Never use for commands or authorization. */
export function createSharedReads() {
  const entries = new Map<string, Promise<unknown>>();
  const methods = new Set(['workspace.bootstrap.get', 'workspace.assistants.list', 'conversation.assistants.list']);
  return {
    read<T>(method: string, params: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
      if (!methods.has(method) || Object.keys(params).length) return run();
      const existing = entries.get(method);
      if (existing) return existing as Promise<T>;
      const promise = run(); entries.set(method, promise);
      promise.finally(() => {if (entries.get(method) === promise) entries.delete(method);}).catch(() => undefined);
      return promise;
    },
  };
}
