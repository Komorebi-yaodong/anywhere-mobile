import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {useContextUsageRefresh} from '../src/hooks/useContextUsageRefresh';
import type {RemoteRequest, RemoteTrackedRequest} from '../src/remote/api';
import type {ContextUsage} from '../src/remote/commands';

const usage: ContextUsage = {status: 'ready', estimated: true, systemTokens: 10, conversationTokens: 20, toolTokens: 30, updatedAt: 100};
function fixture() {
  let result: unknown = {contextUsage: usage};
  let response: Promise<unknown> = Promise.resolve({ok: true});
  const tracked = jest.fn(() => ({requestId: 'read-context', response}));
  const read = jest.fn(async () => ({terminal: true, event: 'conversation.config.result', result}));
  return {
    props: {active: true, desktopId: 'synthetic-desktop', conversationId: 'synthetic-chat', request: read as RemoteRequest, requestTracked: tracked as RemoteTrackedRequest, onUsage: jest.fn()},
    tracked, read,
    result: (next: unknown) => {result = next;},
    response: (next: Promise<unknown>) => {response = next;},
  };
}
function Probe(props: Parameters<typeof useContextUsageRefresh>[0]) {
  useContextUsageRefresh(props);
  return null;
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('reads on entry, refreshes while open and stops when hidden, without control/capacity writes', async () => {
  const f = fixture(); let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<Probe {...f.props} />);});
  expect(f.props.onUsage).toHaveBeenLastCalledWith(usage);
  f.result({contextUsage: {...usage, conversationTokens: 200}, config: {systemPrompt: 'must not overwrite a draft'}});
  await act(async () => {jest.advanceTimersByTime(2000);});
  expect(f.props.onUsage).toHaveBeenLastCalledWith({...usage, conversationTokens: 200});
  expect(f.tracked.mock.calls).toHaveLength(2);
  const calls = f.tracked.mock.calls as unknown as unknown[][];
  expect(calls.every(call => call[1] === 'conversation.config.get')).toBe(true);
  await act(async () => root.update(<Probe {...f.props} active={false} />));
  await act(async () => {jest.advanceTimersByTime(10000);});
  expect(f.tracked).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

it('serializes slow reads and discards old-scope replies after switching conversations', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.response(new Promise(done => {resolve = done;}));
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<Probe {...f.props} />);});
  await act(async () => {jest.advanceTimersByTime(10000);});
  expect(f.tracked).toHaveBeenCalledTimes(1);
  await act(async () => root.update(<Probe {...f.props} conversationId="other-chat" />));
  expect(f.tracked).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ok: true}));
  expect(f.props.onUsage).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  await act(async () => {jest.advanceTimersByTime(10000);});
  expect(f.tracked).toHaveBeenCalledTimes(2);
});

it('keeps previous values on failure/empty/malformed snapshots and recovers automatically', async () => {
  const f = fixture(); let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<Probe {...f.props} />);});
  f.read.mockRejectedValueOnce(new Error('fixture disconnected'));
  await act(async () => {jest.advanceTimersByTime(2000);});
  expect(f.props.onUsage).toHaveBeenCalledTimes(1);
  for (const contextUsage of [null, {...usage, updatedAt: 0}, {...usage, toolTokens: NaN}, {...usage, systemTokens: -1}]) {
    f.result({contextUsage});
    await act(async () => {jest.advanceTimersByTime(2000);});
    expect(f.props.onUsage).toHaveBeenCalledTimes(1);
  }
  f.result({contextUsage: {...usage, conversationTokens: 999}});
  await act(async () => {jest.advanceTimersByTime(2000);});
  expect(f.props.onUsage).toHaveBeenLastCalledWith({...usage, conversationTokens: 999});
  await act(async () => root.unmount());
});

it('does not read when disconnected or not displaying a context panel', async () => {
  const f = fixture(); let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<Probe {...f.props} active={false} />);});
  await act(async () => {jest.advanceTimersByTime(10000);});
  expect(f.tracked).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
