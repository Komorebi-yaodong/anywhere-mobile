import {Dirs, FileSystem} from 'react-native-file-access';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {RemoteRequest} from '../remote/api';
import type {PairedDesktop} from '../domain/pairing';
import {utf8ToBytes} from '../remote/utf8';
import {ensureCacheDirectory} from './cacheDirectory';

type Manifest = {revision?: string; resources?: Record<string, {hash: string; updatedAt: number}>};
type Entry = {value: unknown; revision: string; hash: string; updatedAt: number; checkedAt: number; pending?: Promise<unknown>};
const methods = new Set(['conversation.config.snapshot', 'conversation.list', 'workspace.bootstrap.get', 'workspace.assistants.list', 'conversation.assistants.list', 'workspace.agent.catalog', 'workspace.agent.get', 'workspace.provider.catalog', 'workspace.provider.get', 'workspace.management.details.get', 'workspace.management.catalog.get', 'management.catalog']);
const cache = new Map<string, Entry>();
const identities = new Map<string, string>();
const hydrations = new Map<string, Promise<void>>();
const epochs = new Map<string, number>();
const mutations = new Map<string, number>();
const listeners = new Set<() => void>();
const writes = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const manifests = new WeakMap<RemoteRequest, Map<string, {pending?: Promise<Manifest>; value?: Manifest; at: number}>>();
const unsupported = new WeakMap<RemoteRequest, Set<string>>();
const root = `${Dirs.DocumentDir}/anywhere-workspace-cache`;
const hash = (value: string) => bytesToHex(sha256(utf8ToBytes(value)));
const fileFor = (desktopId: string) => `${root}/${hash(desktopId)}.json`;
const keyFor = (desktopId: string, method: string, params: Record<string, unknown>) => JSON.stringify([desktopId, method, Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))]);
const epoch = (id: string) => epochs.get(id) || 0;
const notify = () => {for (const listener of listeners) {try {listener();} catch { /* A detached UI must not fail persistence. */ }}};
export function subscribeSettings(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};}
export function settingsCacheMethod(method: string) {return methods.has(method);}
function domains(method: string, params: Record<string, unknown>): string[] {
  if (method.startsWith('workspace.provider.')) return ['providers'];
  if (method.startsWith('workspace.agent.')) return ['agents', 'providers', 'mcp', 'skillsRoot', 'skillsFiles', 'skillsContent', 'projectRoot', 'projects'];
  if (method === 'workspace.management.details.get') return [String(params.section), ...(params.section === 'skills' ? ['skillsRoot', 'skillsFiles', 'skillsContent'] : [])];
  if (method === 'management.catalog') return [String(params.section), 'providers', 'agents', 'mcp', 'skillsRoot', 'skillsFiles', 'skillsContent', 'projectRoot', 'projects'];
  return ['agents', 'providers', 'general', 'projectRoot', 'projects'];
}
function token(manifest: Manifest, method: string, params: Record<string, unknown>) {
  return manifest.resources ? JSON.stringify(domains(method, params).map(domain => [domain, manifest.resources?.[domain]?.hash || ''])) : manifest.revision || '';
}
function scheduleWrite(desktopId: string) {
  if (!identities.has(desktopId)) return;
  const previous = timers.get(desktopId); if (previous) clearTimeout(previous);
  timers.set(desktopId, setTimeout(() => {
    timers.delete(desktopId);
    const generation = epoch(desktopId), identity = identities.get(desktopId);
    const job = (writes.get(desktopId) || Promise.resolve()).catch(() => undefined).then(async () => {
      if (generation !== epoch(desktopId) || identity !== identities.get(desktopId)) {scheduleWrite(desktopId); return;}
      await ensureCacheDirectory(root);
      const entries = [...cache].filter(([key]) => JSON.parse(key)[0] === desktopId).map(([key, entry]) => [key, {value: entry.value, revision: entry.revision, hash: entry.hash, updatedAt: entry.updatedAt, checkedAt: entry.checkedAt}]);
      const target = fileFor(desktopId), temp = `${target}.tmp`;
      await FileSystem.writeFile(temp, JSON.stringify({version: 1, identity, entries}), 'utf8');
      if (identity !== identities.get(desktopId)) return;
      await FileSystem.mv(temp, target);
    });
    writes.set(desktopId, job); job.catch(() => undefined);
  }, 100));
}
export async function hydrateSettings(desktopId: string) {
  if (hydrations.has(desktopId)) return hydrations.get(desktopId)!;
  const identity = identities.get(desktopId), generation = epoch(desktopId);
  if (!identity) return;
  const operation = (async () => {
    try {
      const file = fileFor(desktopId);
      if (!(await FileSystem.exists(file))) return;
      const saved = JSON.parse(await FileSystem.readFile(file, 'utf8'));
      if (saved.version !== 1 || saved.identity !== identity || !Array.isArray(saved.entries) || identity !== identities.get(desktopId) || generation !== epoch(desktopId)) return;
      for (const pair of saved.entries) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [key, entry] = pair, parsed = JSON.parse(key);
        if (parsed[0] !== desktopId || !methods.has(parsed[1]) || !entry || !entry.value || typeof entry.hash !== 'string' || hash(JSON.stringify(entry.value)) !== entry.hash || cache.has(key)) continue;
        cache.set(key, {...entry, checkedAt: 0});
      }
      notify();
    } catch { /* A disposable cache failure never blocks the workspace. */ }
  })();
  hydrations.set(desktopId, operation); return operation;
}
export function registerSettingsDesktop(desktop: PairedDesktop) {
  const identity = hash(`${desktop.desktopIdentityPublicKey}:${desktop.pairedAt}`);
  if (identities.get(desktop.id) !== identity) {
    for (const key of cache.keys()) if (JSON.parse(key)[0] === desktop.id) cache.delete(key);
    epochs.set(desktop.id, epoch(desktop.id) + 1);
    identities.set(desktop.id, identity); hydrations.delete(desktop.id);
  }
  return hydrateSettings(desktop.id);
}
export function peekSettings<T>(_request: RemoteRequest, desktopId: string, method: string, params: Record<string, unknown> = {}): T | null {
  return (cache.get(keyFor(desktopId, method, params))?.value as T) ?? null;
}
export function storeSettings<T>(_request: RemoteRequest, desktopId: string, method: string, params: Record<string, unknown>, value: T | null) {
  if (!methods.has(method) || value === null) return;
  const key = keyFor(desktopId, method, params), previous = cache.get(key), digest = hash(JSON.stringify(value));
  cache.set(key, {...previous, pending: undefined, value: digest === previous?.hash ? previous.value : value, hash: digest, revision: previous?.revision || '', updatedAt: digest === previous?.hash ? previous.updatedAt : Date.now(), checkedAt: Date.now()});
  scheduleWrite(desktopId); notify();
}
export async function clearSettings(request: RemoteRequest, desktopId: string) {
  invalidateSettings(request, desktopId);
  identities.delete(desktopId); hydrations.delete(desktopId); mutations.delete(desktopId);
  const timer = timers.get(desktopId); if (timer) clearTimeout(timer); timers.delete(desktopId);
  for (const key of cache.keys()) if (JSON.parse(key)[0] === desktopId) cache.delete(key);
  unsupported.get(request)?.delete(desktopId); notify();
  await writes.get(desktopId)?.catch(() => undefined); writes.delete(desktopId);
  await FileSystem.unlink(fileFor(desktopId)).catch(() => undefined);
  await FileSystem.unlink(`${fileFor(desktopId)}.tmp`).catch(() => undefined);
}
export function invalidateSettings(request: RemoteRequest, desktopId: string, method = '', params: Record<string, unknown> = {}) {
  epochs.set(desktopId, epoch(desktopId) + 1);
  manifests.get(request)?.delete(desktopId);
  const changed = method.includes('.provider.') ? ['providers'] : method.includes('.agent.') || method.includes('.assistant.') ? ['agents'] : method.includes('.project.') ? ['projects'] : [String(params.section || '')];
  for (const [key, entry] of cache) {
    const [id, readMethod, readParams] = JSON.parse(key);
    if (id === desktopId && (!method || domains(readMethod, readParams).some(domain => changed.includes(domain)))) {entry.revision = ''; entry.checkedAt = 0; entry.pending = undefined;}
  }
}
async function revision(request: RemoteRequest, desktopId: string, fresh = false): Promise<Manifest> {
  if (unsupported.get(request)?.has(desktopId)) return {};
  let values = manifests.get(request); if (!values) {values = new Map(); manifests.set(request, values);}
  let entry = values.get(desktopId);
  if (entry?.pending) {if (!fresh) return entry.pending; await entry.pending.catch(() => undefined); entry = values.get(desktopId);}
  if (!fresh && entry?.value && Date.now() - entry.at < 500) return entry.value;
  entry = {at: 0}; values.set(desktopId, entry);
  const current = entry;
  const operation = request<Manifest>(desktopId, 'workspace.settings.revision.get').then(value => {current.value = value; current.at = Date.now(); return value;}).catch(error => {
    if (/remote_method_(?:unavailable|unsupported|unknown)|remote_method_not_found/.test(String(error?.message || error))) {
      let ids = unsupported.get(request); if (!ids) {ids = new Set(); unsupported.set(request, ids);} ids.add(desktopId); return {};
    }
    throw error;
  }).finally(() => {current.pending = undefined;});
  current.pending = operation; return operation;
}
export async function readSettings<T>(request: RemoteRequest, desktopId: string, method: string, params: Record<string, unknown> = {}, force = false): Promise<T> {
  if (!methods.has(method)) return request<T>(desktopId, method, params);
  await hydrateSettings(desktopId);
  const key = keyFor(desktopId, method, params), generation = epoch(desktopId);
  let current = cache.get(key);
  if (current?.pending) return current.pending as Promise<T>;
  if (!current) {current = {value: null, revision: '', hash: '', updatedAt: 0, checkedAt: 0}; cache.set(key, current);}
  const entry = current;
  const job = (async () => {
    if ((mutations.get(desktopId) || 0) > 0 && entry.value) return entry.value as T;
    // With cached UI already painted, one lightweight manifest is the only
    // blocking read. A data response is labelled with the BEFORE-read token:
    // changes racing the read can cause a harmless extra refresh, never stale reuse.
    const manifest = await revision(request, desktopId).catch(() => ({} as Manifest));
    const version = token(manifest, method, params);
    if (!force && version && entry.value && entry.revision === version && epoch(desktopId) === generation && cache.get(key) === entry) {entry.checkedAt = Date.now(); return entry.value as T;}
    if (epoch(desktopId) !== generation || cache.get(key) !== entry) throw new Error('settings_read_superseded');
    const value = await request<T>(desktopId, method, params);
    if (epoch(desktopId) !== generation || cache.get(key) !== entry) throw new Error('settings_read_superseded');
    storeSettings(request, desktopId, method, params, value);
    const stored = cache.get(key)!; stored.revision = version; scheduleWrite(desktopId);
    return value;
  })().catch(error => {
    if (epoch(desktopId) !== generation || cache.get(key) !== entry) throw new Error('settings_read_superseded');
    if (!force && entry.value && error?.message !== 'settings_read_superseded') return entry.value as T; throw error;
  });
  entry.pending = job;
  try {return await job;} finally {if (cache.get(key)?.pending === job) cache.get(key)!.pending = undefined;}
}
export function settingsMutation(method: string): boolean {
  return (method.startsWith('workspace.') && /\.(mutate|patch|create|update|remove)$/.test(method)) || method === 'management.mutate';
}

/** Only committed Desktop DTOs enter persisted config caches; never submitted keys/headers. */
export function applySettingsMutation(request: RemoteRequest, desktopId: string, method: string, params: Record<string, unknown>, reply: unknown) {
  const result = reply as {agent?: Record<string, unknown>; provider?: Record<string, unknown>; detail?: Record<string, unknown>; item?: Record<string, unknown>};
  if (!result || typeof result !== 'object') return;
  const isAgent = method === 'workspace.agent.mutate', isProvider = method === 'workspace.provider.mutate';
  if (method === 'workspace.management.patch') {
    const section = params.section, target = String(params.id || '');
    const current = peekSettings<Record<string, unknown>>(request, desktopId, 'workspace.management.details.get', {section});
    const value = reply as {revision?: string; value?: unknown; item?: Record<string, unknown>};
    if (current && section === 'general' && value.revision && value.value) storeSettings(request, desktopId, 'workspace.management.details.get', {section}, {...current, revision: value.revision, value: value.value});
    else if (current && Array.isArray(current.items) && value.item) storeSettings(request, desktopId, 'workspace.management.details.get', {section}, {...current, items: current.items.map(item => (item as {id?: unknown}).id === target ? value.item : item)});
  }
  const object = isAgent ? result.agent : isProvider ? result.provider : null;
  const methodFor = isAgent ? 'workspace.agent.get' : 'workspace.provider.get';
  const keyField = isAgent ? 'code' : 'id', id = String(object?.[keyField] || params[keyField] || '');
  if (isAgent || isProvider) {
    const catalogMethod = isAgent ? 'workspace.agent.catalog' : 'workspace.provider.catalog', field = isAgent ? 'agents' : 'providers';
    const catalog = peekSettings<Record<string, unknown>>(request, desktopId, catalogMethod);
    if (catalog && Array.isArray(catalog[field])) {
      const items = (catalog[field] as Array<Record<string, unknown>>).filter(item => item[keyField] !== id);
      if (object) items.push(object);
      storeSettings(request, desktopId, catalogMethod, {}, {...catalog, [field]: items});
    }
    const detail = peekSettings<Record<string, unknown>>(request, desktopId, methodFor, {[keyField]: id});
    if (object && detail) storeSettings(request, desktopId, methodFor, {[keyField]: id}, {...detail, [isAgent ? 'agent' : 'provider']: {...(detail[isAgent ? 'agent' : 'provider'] as object), ...object}});
    if (params.operation === 'delete') cache.delete(keyFor(desktopId, methodFor, {[keyField]: id}));
  }
  if (method === 'management.mutate') {
    const section = params.section, target = String(params.id || '');
    const list = peekSettings<{items?: Array<Record<string, unknown>>}>(request, desktopId, 'management.catalog', {section});
    if (list?.items && result.item) storeSettings(request, desktopId, 'management.catalog', {section}, {...list, items: [...list.items.filter(item => item.id !== target), result.item]});
    if (result.detail) {
      const old = peekSettings<Record<string, unknown>>(request, desktopId, 'management.catalog', {section, id: target});
      storeSettings(request, desktopId, 'management.catalog', {section, id: target}, {...old, ...result.detail, options: old?.options || (list as Record<string, unknown> | null)?.options || {}});
    }
    if (params.operation === 'delete') {
      cache.delete(keyFor(desktopId, 'management.catalog', {section, id: target}));
      if (list?.items) storeSettings(request, desktopId, 'management.catalog', {section}, {...list, items: list.items.filter(item => item.id !== target)});
    }
  }
  scheduleWrite(desktopId); notify();
}

export function beginSettingsMutation(request: RemoteRequest, desktopId: string, method: string, params: Record<string, unknown>) {
  mutations.set(desktopId, (mutations.get(desktopId) || 0) + 1); invalidateSettings(request, desktopId, method, params);
}
export function endSettingsMutation(request: RemoteRequest, desktopId: string, method: string, params: Record<string, unknown>) {
  mutations.set(desktopId, Math.max(0, (mutations.get(desktopId) || 0) - 1)); invalidateSettings(request, desktopId, method, params);
}
