import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {ActivityIndicator, Text, View} from 'react-native';
import {ConversationLoading} from '../src/components/ConversationLoading';
import {ThemeProvider, palettes, themePreferenceStore} from '../src/components/theme';

afterEach(() => jest.restoreAllMocks());
it.each(['light', 'dark'] as const)('renders text-free non-blocking request feedback in the %s theme', async mode => {
 jest.spyOn(themePreferenceStore, 'load').mockResolvedValue(mode);
 let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<ThemeProvider><ConversationLoading /></ThemeProvider>);});
 const host = root.root.findAllByType(View).find(node => node.props.testID === 'conversation-loading')!;
 expect(host.props).toMatchObject({pointerEvents: 'none', accessibilityRole: 'progressbar', accessibilityState: {busy: true}});
 expect(root.root.findAllByType(Text)).toHaveLength(0);
 expect(root.root.findByType(ActivityIndicator).props.color).toBe(palettes[mode].primary);
 await act(async () => root.unmount());
});
