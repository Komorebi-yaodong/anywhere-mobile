import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {PanResponder, Text, type PanResponderCallbacks, type PanResponderGestureState, type GestureResponderEvent} from 'react-native';
import {ChatStartSwipe} from '../src/components/ChatStartSwipe';

const event = {} as GestureResponderEvent;
const gesture = (dx: number, dy = 0, vx = 0, numberActiveTouches = 1) => ({dx, dy, vx, numberActiveTouches}) as PanResponderGestureState;
let callbacks: PanResponderCallbacks;
beforeEach(() => {jest.spyOn(PanResponder, 'create').mockImplementation(config => {callbacks = config; return {panHandlers: {}};});});
afterEach(() => jest.restoreAllMocks());

it.each([['new', -90, 'opened'], ['opened', 90, 'new']] as const)('swipes from %s to its adjacent tab', async (selected, dx, target) => {
 const select = jest.fn(); let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ChatStartSwipe selected={selected} onSelect={select}><Text>page</Text></ChatStartSwipe>);});
 expect(callbacks.onStartShouldSetPanResponder).toBeUndefined();
 expect(callbacks.onMoveShouldSetPanResponderCapture!(event, gesture(dx, 8))).toBe(true);
 await act(async () => {callbacks.onPanResponderGrant!(event, gesture(dx)); callbacks.onPanResponderRelease!(event, gesture(dx, 8));});
 expect(select).toHaveBeenCalledWith(target); expect(select).toHaveBeenCalledTimes(1);
 await act(async () => root.unmount());
});

it('leaves taps, vertical/diagonal scrolling, multitouch and outward boundary movement alone', async () => {
 let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ChatStartSwipe selected="new" onSelect={jest.fn()}><Text>page</Text></ChatStartSwipe>);});
 for (const state of [gesture(0), gesture(-10), gesture(-50, 80), gesture(-40, 35), gesture(-80, 0, 0, 2), gesture(90)]) {
  expect(callbacks.onMoveShouldSetPanResponderCapture!(event, state)).toBe(false);
 }
 await act(async () => root.update(<ChatStartSwipe selected="opened" onSelect={jest.fn()}><Text>page</Text></ChatStartSwipe>));
 expect(callbacks.onMoveShouldSetPanResponderCapture!(event, gesture(-90))).toBe(false);
 await act(async () => root.unmount());
});

it('rejects a short drag, wrong-direction release, vertical release and cancelled or multi-finger gestures', async () => {
 const select = jest.fn(); let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ChatStartSwipe selected="new" onSelect={select}><Text>page</Text></ChatStartSwipe>);});
 for (const state of [gesture(-20), gesture(-40, 0, -0.1), gesture(-90, 100), gesture(90), gesture(-90, 0, -1, 2)]) {
  callbacks.onPanResponderGrant!(event, gesture(-20)); callbacks.onPanResponderRelease!(event, state);
 }
 callbacks.onPanResponderGrant!(event, gesture(-20)); callbacks.onPanResponderTerminate!(event, gesture(-90)); callbacks.onPanResponderRelease!(event, gesture(-90));
 callbacks.onPanResponderGrant!(event, gesture(-20)); callbacks.onPanResponderMove!(event, gesture(-50, 0, 0, 2)); callbacks.onPanResponderRelease!(event, gesture(-90));
 expect(select).not.toHaveBeenCalled();
 await act(async () => root.unmount());
});

it('accepts a deliberate flick, uses the latest tab/callback, and never wraps at the ends', async () => {
 const first = jest.fn(); const second = jest.fn(); let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ChatStartSwipe selected="new" onSelect={first}><Text>page</Text></ChatStartSwipe>);});
 callbacks.onPanResponderGrant!(event, gesture(-20)); callbacks.onPanResponderRelease!(event, gesture(-30, 0, -0.6));
 expect(first).toHaveBeenCalledWith('opened');
 await act(async () => root.update(<ChatStartSwipe selected="opened" onSelect={second}><Text>page</Text></ChatStartSwipe>));
 callbacks.onPanResponderGrant!(event, gesture(20)); callbacks.onPanResponderRelease!(event, gesture(-90));
 expect(second).not.toHaveBeenCalled();
 callbacks.onPanResponderGrant!(event, gesture(20)); callbacks.onPanResponderRelease!(event, gesture(30, 0, 0.6));
 expect(second).toHaveBeenCalledWith('new'); expect(first).toHaveBeenCalledTimes(1);
 await act(async () => root.unmount());
});
