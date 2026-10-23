import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {AccessibilityInfo, ActivityIndicator, Animated, Image, StyleSheet, Text, View} from 'react-native';
import {Rect} from 'react-native-svg';
import {ConversationLoading} from '../src/components/ConversationLoading';
import {DesktopBrandMark} from '../src/components/DesktopBrandMark';
import {ThemeProvider, themePreferenceStore} from '../src/components/theme';

beforeEach(() => {jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);});
afterEach(() => jest.restoreAllMocks());
it.each(['light', 'dark'] as const)('centers a text-free moving brand with readable eyes in the %s theme', async mode => {
 jest.spyOn(themePreferenceStore, 'load').mockResolvedValue(mode);
 let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ThemeProvider><ConversationLoading /></ThemeProvider>);});
 const host = root.root.findAllByType(View).find(node => node.props.testID === 'conversation-loading')!;
 expect(host.props).toMatchObject({pointerEvents: 'none', accessibilityRole: 'progressbar', accessibilityState: {busy: true}});
 expect(StyleSheet.flatten(host.props.style)).toMatchObject({width: '100%', alignItems: 'center', justifyContent: 'center', minHeight: 76});
 expect(root.root.findAllByType(Text)).toHaveLength(0);
 expect(root.root.findAllByType(ActivityIndicator)).toHaveLength(0);
 const brand = root.root.findByType(Image);
 expect(brand.props.source).toBe(require('../android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'));
 expect(StyleSheet.flatten(brand.props.style)).toMatchObject({width: 44, height: 44});
 expect(StyleSheet.flatten(brand.props.style).tintColor).toBeUndefined();
 expect(brand.props.tintColor).toBeUndefined();
 expect(root.root.findAllByType(DesktopBrandMark)).toHaveLength(0);
 for (const id of ['loading-brand-eye-mask-left', 'loading-brand-eye-mask-right']) {
  const mask = root.root.findAllByType(View).find(node => node.props.testID === id)!;
  expect(StyleSheet.flatten(mask.props.style).backgroundColor).toBe('#000000');
 }
 for (const id of ['loading-brand-eye-left', 'loading-brand-eye-right']) {
  const eye = root.root.findAllByType(View).find(node => node.props.testID === id)!;
  expect(StyleSheet.flatten(eye.props.style)).toMatchObject({backgroundColor: '#FFFFFF', borderRadius: 4 * 44 / 192, width: 18 * 44 / 192, height: 23 * 44 / 192});
 }
 await act(async () => root.unmount());
});

it('uses one non-interaction native loop for left/right travel and gaze, and stops on unmount', async () => {
 const start = jest.fn(); const stop = jest.fn();
 const loop = jest.spyOn(Animated, 'loop').mockReturnValue({start, stop, reset: jest.fn()});
 const timing = jest.spyOn(Animated, 'timing');
 let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ConversationLoading />);});
 expect(loop).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
 expect(timing).toHaveBeenCalledWith(expect.any(Animated.Value), expect.objectContaining({duration: 3200, toValue: 1, useNativeDriver: true, isInteraction: false}));
 const phase = timing.mock.calls[0][0] as Animated.Value;
 const motion = () => StyleSheet.flatten(root.root.findAllByType(View).find(node => node.props.testID === 'loading-brand-motion')!.props.style).transform as any[];
 const gaze = () => StyleSheet.flatten(root.root.findAllByType(View).find(node => node.props.testID === 'loading-brand-gaze')!.props.style).transform as any[];
 await act(async () => phase.setValue(0.3)); expect(motion()[0].translateX).toBe(7); expect(gaze()[0].translateX).toBeCloseTo(1.4);
 await act(async () => phase.setValue(0.7)); expect(motion()[0].translateX).toBe(-7); expect(gaze()[0].translateX).toBeCloseTo(-1.4);
 await act(async () => root.unmount()); expect(stop).toHaveBeenCalledTimes(1);
});

it('respects initial reduce motion and live changes, stops old motion and removes its listener', async () => {
 jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(true);
 const remove = jest.fn();
 const subscription = jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({remove} as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>).mockClear();
 const stop = jest.fn(); const loop = jest.spyOn(Animated, 'loop').mockReturnValue({start: jest.fn(), stop, reset: jest.fn()});
 let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ConversationLoading />);});
 expect(loop).not.toHaveBeenCalled(); expect(root.root.findAllByType(Image)).toHaveLength(1);
 const change = subscription.mock.calls.filter(([event]) => String(event) === 'reduceMotionChanged').at(-1)![1] as unknown as (value: boolean) => void;
 expect(subscription.mock.calls[0][0]).toBe('reduceMotionChanged');
 await act(async () => change(false)); expect(loop).toHaveBeenCalledTimes(1);
 await act(async () => change(true)); expect(stop).toHaveBeenCalledTimes(1);
 await act(async () => root.unmount()); expect(remove).toHaveBeenCalledTimes(1);
});

it('does not let a late preference query override a newer system event', async () => {
 let resolve!: (value: boolean) => void;
 jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockReturnValue(new Promise<boolean>(yes => {resolve = yes;}));
 const subscription = jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({remove: jest.fn()} as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>).mockClear();
 const loop = jest.spyOn(Animated, 'loop').mockReturnValue({start: jest.fn(), stop: jest.fn(), reset: jest.fn()});
 let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ConversationLoading />);});
 const change = subscription.mock.calls.filter(([event]) => String(event) === 'reduceMotionChanged').at(-1)![1] as unknown as (value: boolean) => void;
 await act(async () => {change(true); resolve(false);});
 expect(loop).not.toHaveBeenCalled();
 await act(async () => root.unmount());
});

it('preserves the static black-and-white brand geometry for existing callers', async () => {
 let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<DesktopBrandMark />);});
 const rectangles = root.root.findAllByType(Rect);
 expect(rectangles).toHaveLength(10);
 expect(rectangles[0].props.fill).toBe('#000000');
 expect(rectangles[7].props).toMatchObject({x: '45', y: '60', width: '15', height: '15', fill: '#FFFFFF'});
 expect(rectangles[8].props).toMatchObject({x: '100', y: '60', width: '15', height: '15', fill: '#FFFFFF'});
 expect(rectangles[9].props).toMatchObject({x: '70', y: '85', width: '20', height: '8', fill: '#FFFFFF'});
 await act(async () => root.unmount());
});
