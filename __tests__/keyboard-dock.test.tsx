import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Keyboard, StyleSheet, Text, type KeyboardEvent} from 'react-native';
import {KeyboardDock, keyboardOverlap} from '../src/components/KeyboardDock';

let mockViewHeight = 696;
const mockMeasure = jest.fn(callback => callback(0, 104, 390, mockViewHeight));
jest.mock('react-native/Libraries/Components/View/View', () => {
  const R = require('react');
  return {__esModule: true, default: R.forwardRef((props: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({measureInWindow: mockMeasure}));
    return R.createElement('MockView', props, props.children);
  })};
});
afterEach(() => jest.restoreAllMocks());

it('calculates overlap in screen coordinates including the topbar and safe area', () => {
  expect(keyboardOverlap(104, 696, 480)).toBe(320);
  expect(keyboardOverlap(104, 376, 480)).toBe(0); // already adjustResize'd
  expect(keyboardOverlap(104, 696)).toBe(0);
  expect(keyboardOverlap(104, 696, 900)).toBe(0);
  expect(keyboardOverlap(104, 696, 0)).toBe(696);
});

it('raises the whole chat, avoids double inset after resize, and restores on hide', async () => {
  const listeners = new Map<string, (event: KeyboardEvent) => void>();
  const remove = jest.fn();
  jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
    listeners.set(event, listener);
    return {remove} as unknown as ReturnType<typeof Keyboard.addListener>;
  });
  jest.spyOn(Keyboard, 'metrics').mockReturnValue(undefined);
  mockViewHeight = 696;
  mockMeasure.mockClear();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<KeyboardDock><Text>Composer and messages</Text></KeyboardDock>);
  });
  const host = () => root.root.findAll(node => node.props.accessibilityLabel === '聊天键盘避让区域' && node.props.onLayout)[0];
  const bottom = () => StyleSheet.flatten(host().props.style).paddingBottom;
  await act(async () => listeners.get('keyboardDidShow')!({endCoordinates: {screenY: 480}} as KeyboardEvent));
  expect(mockMeasure).toHaveBeenCalled();
  expect(bottom()).toBe(320);
  mockViewHeight = 376;
  await act(async () => host().props.onLayout());
  expect(bottom()).toBe(0);
  mockViewHeight = 696;
  await act(async () => listeners.get('keyboardDidChangeFrame')!({endCoordinates: {screenY: 450}} as KeyboardEvent));
  expect(bottom()).toBe(350);
  await act(async () => listeners.get('keyboardDidHide')!({} as KeyboardEvent));
  expect(bottom()).toBe(0);
  await act(async () => root.unmount());
  expect(remove).toHaveBeenCalledTimes(3);
  jest.restoreAllMocks();
});
