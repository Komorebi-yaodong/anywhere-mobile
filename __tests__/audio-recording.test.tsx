import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PermissionsAndroid, Platform } from 'react-native';
import { useAudioRecording } from '../src/hooks/useAudioRecording';
import { MediaCapture } from '../src/native/MediaCapture';

jest.mock('../src/native/MediaCapture', () => ({
  MediaCapture: {
    startAudio: jest.fn(async () => undefined),
    stopAudio: jest.fn(),
    cancelAudio: jest.fn(async () => undefined),
    deleteCapture: jest.fn(async () => undefined),
  },
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
let state!: ReturnType<typeof useAudioRecording>;
const captured = jest.fn(async () => undefined);
const error = jest.fn();
function Harness() {
  state = useAudioRecording(captured, error);
  return null;
}
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: 'android',
  });
  jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
  (MediaCapture.stopAudio as jest.Mock).mockResolvedValue({
    captureId: 'capture',
    name: 'audio.m4a',
    type: 'audio/mp4',
    size: 10,
    durationMs: 1000,
  });
});
afterEach(() => jest.restoreAllMocks());

test('release during native start cancels capture and never uploads', async () => {
  const pending = deferred();
  (MediaCapture.startAudio as jest.Mock).mockImplementationOnce(
    () => pending.promise,
  );
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    state.start();
  });
  let finish!: Promise<void>;
  await act(async () => {
    finish = state.finish();
    pending.resolve();
    await finish;
  });
  expect(MediaCapture.cancelAudio).toHaveBeenCalled();
  expect(captured).not.toHaveBeenCalled();
  expect(state.recording).toBe(false);
  await act(async () => root.unmount());
});

test('a completed hold emits one audio attachment and unmount cancels active capture', async () => {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    state.start();
  });
  expect(state.recording).toBe(true);
  await act(async () => {
    await state.finish();
  });
  expect(captured).toHaveBeenCalledTimes(1);
  await act(async () => {
    state.start();
  });
  await act(async () => {
    root.unmount();
  });
  expect(MediaCapture.cancelAudio).toHaveBeenCalled();
});

test('swipe cancellation never uploads and resets the recording state', async () => {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<Harness />);
  });
  await act(async () => {
    state.start();
  });
  await act(async () => {
    await state.cancel();
    await state.finish();
  });
  expect(captured).not.toHaveBeenCalled();
  expect(state.recording).toBe(false);
  await act(async () => root.unmount());
});
