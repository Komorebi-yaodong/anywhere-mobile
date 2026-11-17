import React from 'react';
import {Text} from 'react-native';
import {FileSystem} from 'react-native-file-access';
import type {PairedDesktop} from '../src/domain/pairing';
import TestRenderer, {act} from 'react-test-renderer';
import {readSettings, peekSettings, invalidateSettings, clearSettings, registerSettingsDesktop, storeSettings} from '../src/services/settingsCache';
import {SettingsActivityContext, useSettingsCatalog} from '../src/hooks/useSettingsCatalog';
import type {RemoteRequest} from '../src/remote/api';

function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
const method = 'workspace.provider.catalog';
test('reuses same-revision catalogs, isolates Desktop IDs and request clients, reloads after mutation', async () => {
  let token = 'v1', count = 0;
  const request = jest.fn(async (_id: string, name: string) => name === 'workspace.settings.revision.get' ? {revision: token} : {count: ++count}) as RemoteRequest;
  const first = await readSettings(request, 'one', method);
  expect(await readSettings(request, 'one', method)).toBe(first);
  expect(count).toBe(1);
  expect(peekSettings(request, 'two', method)).toBeNull();
  token = 'v2'; expect(await readSettings(request, 'one', method)).toEqual({count: 2});
  invalidateSettings(request, 'one'); await readSettings(request, 'one', method); expect(count).toBe(3);
  const other = (async () => ({revision: 'v2'})) as RemoteRequest;
  expect(peekSettings(other, 'one', method)).toBeNull();
  await clearSettings(request, 'one'); expect(peekSettings(request, 'one', method)).toBeNull();
});

test('deduplicates concurrent reads and rejects responses made stale by a mutation', async () => {
  const wait = deferred<{name: string}>(); let reads = 0;
  const request = jest.fn(async (_id: string, name: string) => {
    if (name === 'workspace.settings.revision.get') return {revision: 'v1'};
    reads++; return wait.promise;
  }) as RemoteRequest;
  const one = readSettings(request, 'one', method), two = readSettings(request, 'one', method);
  const rejected = one.catch(error => error.message);
  const duplicate = two.catch(error => error.message);
  await act(async () => {});
  invalidateSettings(request, 'one'); wait.resolve({name: 'old'});
  expect(await rejected).toBe('settings_read_superseded'); expect(await duplicate).toBe('settings_read_superseded');
  expect(reads).toBe(1); expect(peekSettings(request, 'one', method)).toBeNull();
});

test('older Desktop without revision capability still refreshes and preserves cached content on failure', async () => {
  let failed = false, value = 1;
  const request = jest.fn(async (_id: string, name: string) => {
    if (name === 'workspace.settings.revision.get') throw Error('remote_method_unavailable');
    if (failed) throw Error('offline'); return {value: value++};
  }) as RemoteRequest;
  await readSettings(request, 'one', method); await readSettings(request, 'one', method);
  expect(peekSettings(request, 'one', method)).toEqual({value: 2});
  failed = true; await expect(readSettings(request, 'one', method)).rejects.toThrow('offline');
  expect(peekSettings(request, 'one', method)).toEqual({value: 2});
  expect((request as jest.Mock).mock.calls.filter(([, name]) => name === 'workspace.settings.revision.get')).toHaveLength(1);
});

test('does not poll while hidden; activation and later polls are serial and stop on unmount', async () => {
  jest.useFakeTimers();
  const request = jest.fn(async (_id: string, name: string) => name === 'workspace.settings.revision.get' ? {revision: 'stable'} : {name: 'one'}) as RemoteRequest;
  const timeoutSpy = jest.spyOn(globalThis, 'setTimeout');
  const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
  let root: TestRenderer.ReactTestRenderer | undefined;
  const calls = () => (request as jest.Mock).mock.calls;
  const view = (active: boolean) => <SettingsActivityContext.Provider value={active}><Page request={request} id="poll" /></SettingsActivityContext.Provider>;
  try {
    await act(async () => {root = TestRenderer.create(view(false));});
    const initial = calls().length;
    await act(async () => {jest.advanceTimersByTime(45000);});
    expect(calls()).toHaveLength(initial);
    await act(async () => root!.update(view(true)));
    expect(calls()).toHaveLength(initial + 1); // immediate foreground validation
    await act(async () => {jest.advanceTimersByTime(15000);});
    expect(calls()).toHaveLength(initial + 2); // one scheduled validation, no body reload
    expect(calls().filter(([, name]) => name === method)).toHaveLength(1);
    const pollTimers = timeoutSpy.mock.calls.flatMap(([, delay], index) => delay === 15000 ? [timeoutSpy.mock.results[index].value] : []);
    expect(pollTimers.length).toBeGreaterThan(0);
    await act(async () => root!.unmount()); root = undefined;
    const cleared = clearSpy.mock.calls.map(([timer]) => timer);
    expect(pollTimers.every(timer => cleared.includes(timer))).toBe(true);
    const stopped = calls().length;
    await act(async () => {jest.advanceTimersByTime(45000);});
    expect(calls()).toHaveLength(stopped);

  } finally {
    if (root) await act(async () => root!.unmount());
    timeoutSpy.mockRestore(); clearSpy.mockRestore();
    jest.useRealTimers();
  }
});


function Page({request, id}: {request: RemoteRequest; id: string}) {
  const {catalog, reload} = useSettingsCatalog<{name: string}>(request, id, method);
  React.useEffect(() => {reload(false).catch(() => undefined);}, [reload]);
  return <Text>{catalog?.name || 'empty'}</Text>;
}
test('remount displays cached settings immediately while remote validation is pending; foreign scope never flashes', async () => {
  let wait: ReturnType<typeof deferred<{revision: string}>> | null = null;
  const request = jest.fn(async (id: string, name: string) => name === 'workspace.settings.revision.get' ? wait ? wait.promise : {revision: 'same'} : {name: id}) as RemoteRequest;
  await readSettings(request, 'one', method);
  wait = deferred();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<Page request={request} id="one" />);});
  expect(root.root.findByType(Text).props.children).toBe('one');
  await act(async () => {root.update(<Page request={request} id="two" />);});
  expect(root.root.findByType(Text).props.children).toBe('empty');
  await act(async () => {wait!.resolve({revision: 'same'});});
  expect(root.root.findByType(Text).props.children).toBe('two');
  await act(async () => root.unmount());
});

function desktopFixture(id: string): PairedDesktop {
  return {id, name: 'Fixture', endpoint: 'https://fixture.invalid', endpoints: ['https://fixture.invalid'], certificateFingerprint: 'fixture-certificate', desktopIdentityPublicKey: 'fixture-public-key', tlsMode: 'pinned', pairedAt: '2026-11-17T00:00:00Z'};
}

test('restores persisted paired configuration into a fresh runtime without leaking to unregistered clients', async () => {
  jest.useFakeTimers();
  const desktop = desktopFixture('persisted-settings-fixture');
  const writer = jest.fn(async () => ({revision: 'v1'})) as RemoteRequest;
  let recovered: typeof import('../src/services/settingsCache') | undefined;
  let reader: RemoteRequest | undefined;
  try {
    await registerSettingsDesktop(desktop, writer);
    storeSettings(writer, desktop.id, method, {}, {name: 'Persisted provider'});
    await jest.advanceTimersByTimeAsync(100);
    const write = (FileSystem.writeFile as jest.Mock).mock.calls.find(([path]) => path.startsWith('/documents/anywhere-workspace-cache/') && path.endsWith('.tmp'));
    expect(write).toBeDefined();
    const saved = JSON.parse(write![1]);
    expect(saved.entries[0][1]).toMatchObject({hash: expect.any(String), updatedAt: expect.any(Number), checkedAt: expect.any(Number)});
    const disk = new Map<string, string>([[write![0].slice(0, -4), write![1]]]);
    (FileSystem.exists as jest.Mock).mockImplementation(async (path: string) => disk.has(path));
    (FileSystem.readFile as jest.Mock).mockImplementation(async (path: string) => disk.get(path) || '');
    // New module state models a process restart, not just another mount.
    jest.isolateModules(() => {recovered = require('../src/services/settingsCache');});
    reader = jest.fn(async () => {throw Error('offline');}) as RemoteRequest;
    expect(recovered!.peekSettings(reader, desktop.id, method)).toBeNull();
    await recovered!.registerSettingsDesktop(desktop, reader);
    expect(recovered!.peekSettings(reader, desktop.id, method)).toEqual({name: 'Persisted provider'});
    expect(reader).not.toHaveBeenCalled();
    const foreign = jest.fn(async () => ({})) as RemoteRequest;
    expect(recovered!.peekSettings(foreign, desktop.id, method)).toBeNull();
    await expect(recovered!.readSettings(reader, desktop.id, method)).rejects.toThrow('offline');
    expect(recovered!.peekSettings(reader, desktop.id, method)).toEqual({name: 'Persisted provider'});
  } finally {
    await clearSettings(writer, desktop.id);
    if (recovered && reader) await recovered.clearSettings(reader, desktop.id);
    (FileSystem.exists as jest.Mock).mockImplementation(async () => false);
    (FileSystem.readFile as jest.Mock).mockImplementation(async () => '');
    jest.useRealTimers();
  }
});

test('scoped versions reload only affected domains and forced reads bypass version-only reuse', async () => {
  let providers = 'p1', agents = 'a1', bodies = 0;
  const request = jest.fn(async (_id: string, name: string) => name === 'workspace.settings.revision.get' ? {resources: {providers: {hash: providers, updatedAt: 1}, agents: {hash: agents, updatedAt: 1}}} : {count: ++bodies}) as RemoteRequest;
  const first = await readSettings(request, 'resource-fixture', method);
  agents = 'a2'; expect(await readSettings(request, 'resource-fixture', method)).toBe(first);
  providers = 'p2'; expect(await readSettings(request, 'resource-fixture', method)).toEqual({count: 2});
  expect(await readSettings(request, 'resource-fixture', method, {}, true)).toEqual({count: 3});
});

test('unmount during a pending read does not notify UI or schedule another poll', async () => {
  jest.useFakeTimers();
  const pending = deferred<{name: string}>();
  const request = jest.fn(async (_id: string, name: string) => name === 'workspace.settings.revision.get' ? {revision: 'pending'} : pending.promise) as RemoteRequest;
  let root: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {root = TestRenderer.create(<Page request={request} id="unmount-fixture" />);});
    await act(async () => root!.unmount()); root = undefined;
    const before = (request as jest.Mock).mock.calls.length;
    await act(async () => {pending.resolve({name: 'late'});});
    await act(async () => {jest.advanceTimersByTime(60000);});
    expect((request as jest.Mock).mock.calls).toHaveLength(before);
  } finally {if (root) await act(async () => root!.unmount()); jest.useRealTimers();}
});
