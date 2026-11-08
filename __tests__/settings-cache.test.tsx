import React from 'react';
import {Text} from 'react-native';
import TestRenderer, {act} from 'react-test-renderer';
import {readSettings, peekSettings, invalidateSettings, clearSettings} from '../src/services/settingsCache';
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
  clearSettings(request, 'one'); expect(peekSettings(request, 'one', method)).toBeNull();
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

test('does not poll while settings screen is hidden; rechecks when active without overlapping requests', async () => {
  jest.useFakeTimers();
  const request = jest.fn(async (_id: string, name: string) => name === 'workspace.settings.revision.get' ? {revision: 'stable'} : {name: 'one'}) as RemoteRequest;
  let root!: TestRenderer.ReactTestRenderer;
  const view = (active: boolean) => <SettingsActivityContext.Provider value={active}><Page request={request} id="poll" /></SettingsActivityContext.Provider>;
  await act(async () => {root = TestRenderer.create(view(false));});
  const initial = (request as jest.Mock).mock.calls.length;
  await act(async () => {jest.advanceTimersByTime(45000);});
  expect((request as jest.Mock).mock.calls.length).toBe(initial);
  await act(async () => root.update(view(true)));
  await act(async () => {jest.advanceTimersByTime(15000);});
  expect((request as jest.Mock).mock.calls.length).toBe(initial + 1);
  await act(async () => root.unmount());
  jest.useRealTimers();
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
