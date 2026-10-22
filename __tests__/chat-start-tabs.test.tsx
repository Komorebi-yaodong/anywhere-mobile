import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {StyleSheet, Text, View} from 'react-native';
import {ChatStartTabs} from '../src/components/ChatStartTabs';
import {palettes, ThemeProvider, themePreferenceStore} from '../src/components/theme';

afterEach(() => jest.restoreAllMocks());
it.each(['light', 'dark'] as const)('renders equal-width accessible bookmark tabs in the %s theme', async mode => {
  jest.spyOn(themePreferenceStore, 'load').mockResolvedValue(mode);
  const select = jest.fn(); let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<ThemeProvider><ChatStartTabs selected="opened" onSelect={select} /></ThemeProvider>);});
  const tabs = root.root.findAll(node => node.props.accessibilityRole === 'tab' && typeof node.props.onPress === 'function');
  expect(tabs.map(tab => tab.props.accessibilityLabel)).toEqual(['新的聊天', '打开的会话']);
  expect(tabs.map(tab => tab.props.accessibilityState.selected)).toEqual([false, true]);
  for (const tab of tabs) expect(StyleSheet.flatten(tab.props.style)).toMatchObject({flex: 1, minHeight: 48, minWidth: 0});
  expect(StyleSheet.flatten(tabs[1].props.style).backgroundColor).toBe(palettes[mode].primarySoft);
  expect(StyleSheet.flatten(tabs[1].findByType(Text).props.style).color).toBe(palettes[mode].primary);
  const frame = root.root.findAllByType(View).find(node => node.props.accessibilityRole === 'tablist')!;
  expect(StyleSheet.flatten(frame.props.style).borderBottomColor).toBe(palettes[mode].line);
  await act(async () => tabs[0].props.onPress()); expect(select).toHaveBeenCalledWith('new');
  await act(async () => root.unmount());
});
