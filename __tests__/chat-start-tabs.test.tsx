import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {AccessibilityInfo, Animated, StyleSheet, Text, View} from 'react-native';
import {ChatStartTabs} from '../src/components/ChatStartTabs';
import {palettes, ThemeProvider, themePreferenceStore} from '../src/components/theme';

beforeEach(() => {jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);});
afterEach(() => jest.restoreAllMocks());


it('moves one native-driven bubble between tabs, swells and interrupts an old transition', async () => {
  const stop = jest.fn(); const start = jest.fn();
  const parallel = jest.spyOn(Animated, 'parallel').mockImplementation(() => ({start, stop, reset: jest.fn()}));
  const spring = jest.spyOn(Animated, 'spring');
  const timing = jest.spyOn(Animated, 'timing');
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<ChatStartTabs selected="new" onSelect={jest.fn()} />);});
  expect(parallel).not.toHaveBeenCalled();
  await act(async () => root.update(<ChatStartTabs selected="opened" onSelect={jest.fn()} />));
  expect(spring).toHaveBeenLastCalledWith(expect.any(Animated.Value), expect.objectContaining({toValue: 1, useNativeDriver: true}));
  expect(timing).toHaveBeenCalledWith(expect.any(Animated.Value), expect.objectContaining({toValue: 1, duration: 100, useNativeDriver: true}));
  expect(timing).toHaveBeenCalledWith(expect.any(Animated.Value), expect.objectContaining({toValue: 0, duration: 180, useNativeDriver: true}));
  await act(async () => root.update(<ChatStartTabs selected="new" onSelect={jest.fn()} />));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(spring).toHaveBeenLastCalledWith(expect.any(Animated.Value), expect.objectContaining({toValue: 0, useNativeDriver: true}));
  expect(root.root.findAllByType(View).filter(node => node.props.testID === 'chat-start-tab-bubble')).toHaveLength(1);
  await act(async () => root.unmount()); expect(stop).toHaveBeenCalledTimes(2);
});

it('switches without animation when system reduce-motion is enabled', async () => {
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(true);
  const spring = jest.spyOn(Animated, 'spring');
  const timing = jest.spyOn(Animated, 'timing');
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<ChatStartTabs selected="new" onSelect={jest.fn()} />);});
  await act(async () => root.update(<ChatStartTabs selected="opened" onSelect={jest.fn()} />));
  expect(spring).not.toHaveBeenCalled(); expect(timing).not.toHaveBeenCalled();
  expect(root.root.findAll(node => node.props.accessibilityRole === 'tab' && node.props.onPress)[1].props.accessibilityState.selected).toBe(true);
  await act(async () => root.unmount());
});

it.each(['light', 'dark'] as const)('renders equal-width accessible bookmark tabs in the %s theme', async mode => {
  jest.spyOn(themePreferenceStore, 'load').mockResolvedValue(mode);
  const select = jest.fn(); let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<ThemeProvider><ChatStartTabs selected="opened" onSelect={select} /></ThemeProvider>);});
  const tabs = root.root.findAll(node => node.props.accessibilityRole === 'tab' && typeof node.props.onPress === 'function');
  expect(tabs.map(tab => tab.props.accessibilityLabel)).toEqual(['新的聊天', '已打开会话']);
  expect(tabs.map(tab => tab.props.accessibilityState.selected)).toEqual([false, true]);
  for (const tab of tabs) expect(StyleSheet.flatten(tab.props.style)).toMatchObject({flex: 1, minHeight: 48, minWidth: 0});
  const bubble = root.root.findAllByType(View).find(node => node.props.testID === 'chat-start-tab-bubble')!;
  expect(StyleSheet.flatten(bubble.props.style).backgroundColor).toBe(palettes[mode].primarySoft);
  expect(bubble.props.pointerEvents).toBe('none');
  expect(StyleSheet.flatten(tabs[1].findByType(Text).props.style).color).toBe(palettes[mode].primary);
  const frame = root.root.findAllByType(View).find(node => node.props.accessibilityRole === 'tablist')!;
  expect(StyleSheet.flatten(frame.props.style).backgroundColor).toBe(palettes[mode].surfaceMuted);
  await act(async () => frame.props.onLayout({nativeEvent: {layout: {width: 360}}}));
  const bubbleStyle = StyleSheet.flatten(root.root.findAllByType(View).find(node => node.props.testID === 'chat-start-tab-bubble')!.props.style);
  expect(bubbleStyle.width).toBe(173); expect(bubbleStyle.opacity).not.toBe(0);
  await act(async () => tabs[0].props.onPress()); expect(select).toHaveBeenCalledWith('new');
  await act(async () => root.unmount());
});
