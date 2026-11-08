import type {RemoteRequest} from '../remote/api';

type Entry = {value: unknown; revision: string; generation: number; pending?: Promise<unknown>};
const methods = new Set(['workspace.agent.catalog', 'workspace.provider.catalog', 'workspace.management.details.get', 'management.catalog']);
const caches = new WeakMap<RemoteRequest, Map<string, Entry>>();
const revisions = new WeakMap<RemoteRequest, Map<string, Promise<string>>>();
const unsupported = new WeakMap<RemoteRequest, Set<string>>();
const epochs = new WeakMap<RemoteRequest, Map<string, number>>();
const keyFor = (desktopId: string, method: string, params: Record<string, unknown>) => JSON.stringify([desktopId, method, params]);
function entries(request: RemoteRequest) {
  let cache = caches.get(request);
  if (!cache) {cache = new Map(); caches.set(request, cache);}
  return cache;
}
const epoch = (request: RemoteRequest, desktopId: string) => epochs.get(request)?.get(desktopId) || 0;
export function peekSettings<T>(request: RemoteRequest, desktopId: string, method: string, params: Record<string, unknown> = {}): T | null {
  return (entries(request).get(keyFor(desktopId, method, params))?.value as T) || null;
}
export function clearSettings(request: RemoteRequest, desktopId: string) {
  invalidateSettings(request, desktopId);
  for (const key of entries(request).keys()) if (JSON.parse(key)[0] === desktopId) entries(request).delete(key);
  unsupported.get(request)?.delete(desktopId);
}
export function invalidateSettings(request: RemoteRequest, desktopId: string) {
  let values = epochs.get(request);
  if (!values) {values = new Map(); epochs.set(request, values);}
  values.set(desktopId, epoch(request, desktopId) + 1);
  for (const [key, entry] of entries(request)) if (JSON.parse(key)[0] === desktopId) {entry.revision = ''; entry.pending = undefined;}
}
async function revision(request: RemoteRequest, desktopId: string): Promise<string> {
  if (unsupported.get(request)?.has(desktopId)) return '';
  let pending = revisions.get(request);
  if (!pending) {pending = new Map(); revisions.set(request, pending);}
  if (pending.has(desktopId)) return pending.get(desktopId)!;
  const operation = request<{revision?: string}>(desktopId, 'workspace.settings.revision.get').then(value => value.revision || '').catch(error => {
    if (/remote_method_(?:unavailable|unsupported|unknown)|remote_method_not_found/.test(String(error?.message || error))) {
      let ids = unsupported.get(request); if (!ids) {ids = new Set(); unsupported.set(request, ids);} ids.add(desktopId);
      return '';
    }
    throw error;
  }).finally(() => pending!.delete(desktopId));
  pending.set(desktopId, operation);
  return operation;
}
export async function readSettings<T>(request: RemoteRequest, desktopId: string, method: string, params: Record<string, unknown> = {}, force = false): Promise<T> {
  if (!methods.has(method) || params.id) return request<T>(desktopId, method, params);
  const cache = entries(request), key = keyFor(desktopId, method, params);
  let entry = cache.get(key);
  if (entry?.pending) return entry.pending as Promise<T>;
  if (!entry) {
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    entry = {value: null, revision: '', generation: -1}; cache.set(key, entry);
  }
  const current = entry, generation = epoch(request, desktopId);
  const job = (async () => {
    const token = await revision(request, desktopId);
    if (!force && token && current.value && current.revision === token && current.generation === generation) return current.value as T;
    const value = await request<T>(desktopId, method, params);
    // A mutation racing an older read must never refill the cache with pre-mutation data.
    if (epoch(request, desktopId) !== generation) throw new Error('settings_read_superseded');
    current.value = value; current.revision = token; current.generation = generation;
    return value;
  })();
  current.pending = job;
  try {return await job;} finally {if (current.pending === job) current.pending = undefined;}
}

export function settingsMutation(method: string): boolean {
  return method.startsWith('workspace.') && /\.(mutate|patch|create|update|remove)$/.test(method) || method === 'management.mutate';
}
