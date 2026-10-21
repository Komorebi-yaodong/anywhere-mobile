import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Appearance, Text, View, StyleSheet, TextInput as NativeTextInput, useColorScheme} from 'react-native';
import {ConversationActions} from '../src/components/ConversationActions';
import {ConversationTaskSheet} from '../src/components/ConversationTaskSheet';
import {ConversationMarkdown} from '../src/components/ConversationMarkdown';
import {MathRenderer} from 'react-native-latex-text';
import {ThemeProvider, useTheme, useThemedStyles, themePreferenceStore, palettes, resolveThemeColor, type ThemeMode} from '../src/components/theme';
import {AppearanceSettings} from '../src/components/AppearanceSettings';
import {TextInput} from '../src/components/ThemedNative';
import {NativeMarkdown} from '../src/components/NativeMarkdown';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({__esModule: true, default: jest.fn(() => 'light')}));
const systemScheme = useColorScheme as jest.Mock;
let latest!: ReturnType<typeof useTheme>;
function Probe() {
  latest = useTheme();
  const styles = useThemedStyles({surface: {backgroundColor: '#FFFFFF'}, text: {color: '#292724'}, primary: {color: '#fff', backgroundColor: '#C96849'}});
  return <View testID="theme-surface" style={styles.surface}><Text style={styles.text}>theme fixture</Text><TextInput placeholder="theme input" /><NativeMarkdown value={'body `code`\n\n```text\ncode block\n```'} /></View>;
}
async function render() {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<ThemeProvider><Probe /><AppearanceSettings visible onClose={() => {}} /></ThemeProvider>);});
  return root;
}
beforeEach(() => {
  jest.spyOn(themePreferenceStore, 'load').mockResolvedValue('system');
  jest.spyOn(themePreferenceStore, 'save').mockResolvedValue(undefined);
  systemScheme.mockReturnValue('light');
});
afterEach(() => jest.restoreAllMocks());

it('switches offline, persists selection and themes actual input and Markdown surfaces', async () => {
  const root = await render();
  await act(async () => latest.setMode('dark'));
  expect(themePreferenceStore.save).toHaveBeenCalledWith('dark');
  expect(latest.dark).toBe(true);
  expect(StyleSheet.flatten(root.root.findByProps({testID: 'theme-surface'}).props.style).backgroundColor).toBe(palettes.dark.surface);
  const input = root.root.findByType(NativeTextInput);
  expect(input.props.keyboardAppearance).toBe('dark');
  expect(input.props.placeholderTextColor).toBe(palettes.dark.muted);
  expect(root.root.findAllByType(Text).some(node => StyleSheet.flatten(node.props.style)?.color === palettes.dark.text)).toBe(true);
  const code = root.root.findAllByType(Text).find(node => node.props.children === 'code block')!;
  expect(StyleSheet.flatten(code.props.style).color).toBe(palettes.dark.text);
  await act(async () => latest.setMode('light'));
  expect(latest.dark).toBe(false);
  await act(async () => root.unmount());
});

it('follows system changes only in system mode and restores a saved explicit mode', async () => {
  jest.mocked(themePreferenceStore.load).mockResolvedValue('dark');
  const root = await render();
  expect(latest.mode).toBe('dark');
  systemScheme.mockReturnValue('light');
  await act(async () => root.update(<ThemeProvider><Probe /></ThemeProvider>));
  expect(latest.dark).toBe(true);
  await act(async () => latest.setMode('system'));
  expect(latest.dark).toBe(false);
  systemScheme.mockReturnValue('dark');
  await act(async () => root.update(<ThemeProvider><Probe /></ThemeProvider>));
  expect(latest.dark).toBe(true);
  await act(async () => root.unmount());
});

it('does not overwrite a user choice with a late preference read and reports save failure', async () => {
  let resolveLoad!: (mode: ThemeMode) => void;
  jest.mocked(themePreferenceStore.load).mockImplementation(() => new Promise(resolve => {resolveLoad = resolve;}));
  const root = await render();
  await act(async () => latest.setMode('dark'));
  await act(async () => resolveLoad('light'));
  expect(latest.mode).toBe('dark');
  jest.mocked(themePreferenceStore.save).mockRejectedValueOnce(new Error('synthetic storage error'));
  await act(async () => latest.setMode('light'));
  expect(latest.mode).toBe('light');
  expect(latest.error).toContain('未能保存');
  await act(async () => root.unmount());
});

it('serializes rapid preference writes and keeps the newest choice', async () => {
  const calls: ThemeMode[] = [];
  let releaseFirst!: () => void;
  jest.mocked(themePreferenceStore.save).mockImplementation(async mode => {
    calls.push(mode);
    if (calls.length === 1) await new Promise<void>(resolve => {releaseFirst = resolve;});
  });
  const root = await render();
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => {
    first = latest.setMode('dark');
    second = latest.setMode('light');
    await Promise.resolve();
  });
  expect(calls).toEqual(['dark']);
  releaseFirst();
  await act(async () => {await first; await second;});
  expect(calls).toEqual(['dark', 'light']);
  expect(latest.mode).toBe('light');
  await act(async () => root.unmount());
});

it('persists only a validated local appearance preference and handles corrupt content', async () => {
  jest.restoreAllMocks();
  const {FileSystem} = require('react-native-file-access');
  FileSystem.exists.mockResolvedValueOnce(true);
  FileSystem.readFile.mockResolvedValueOnce(JSON.stringify({mode: 'dark'}));
  expect(await themePreferenceStore.load()).toBe('dark');
  await themePreferenceStore.save('light');
  expect(FileSystem.writeFile).toHaveBeenCalledWith('/documents/anywhere-appearance.json', JSON.stringify({version: 1, mode: 'light'}), 'utf8');
  FileSystem.exists.mockResolvedValueOnce(true);
  FileSystem.readFile.mockResolvedValueOnce('{broken');
  expect(await themePreferenceStore.load()).toBe('system');
});


it('themes task and edit sheets, native appearance and MathJax without disabling font scaling', async () => {
  const nativeAppearance = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
  jest.mocked(themePreferenceStore.load).mockResolvedValue('dark');
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<ThemeProvider><Probe />
    <ConversationActions desktopId="fixture" conversationId="fixture-conversation" action={{method: 'conversation.message.edit', uiMessageId: 'fixture-message', content: 'kept draft'}} request={jest.fn()} requestTracked={jest.fn()} onClose={() => {}} onCompleted={() => {}} />
    <ConversationTaskSheet visible tasks={[]} onClose={() => {}} />
    <ConversationMarkdown value={'$$x^2$$'} desktopId="fixture" conversationId="fixture-conversation" request={jest.fn()} />
  </ThemeProvider>);});
  expect(nativeAppearance).toHaveBeenCalledWith('dark');
  expect(jest.mocked(MathRenderer.Render).mock.calls.some(call => call[0] === 'x^2' && call[2]?.color === palettes.dark.text)).toBe(true);
  const editor = root.root.findAllByType(NativeTextInput).find(node => node.props.value === 'kept draft')!;
  expect(StyleSheet.flatten(editor.props.style).backgroundColor).toBe(palettes.dark.surfaceMuted);
  expect(editor.props.placeholderTextColor).not.toBe(StyleSheet.flatten(editor.props.style).color);
  expect(root.root.findAllByType(Text).every(node => node.props.allowFontScaling !== false)).toBe(true);
  await act(async () => latest.setMode('light'));
  expect(editor.props.value).toBe('kept draft');
  await act(async () => latest.setMode('system'));
  expect(nativeAppearance).toHaveBeenLastCalledWith('unspecified');
  await act(async () => root.unmount());
});


it('keeps white primary ink distinct from dark surfaces and checks contrast', () => {
  expect(resolveThemeColor('#fff', true, 'backgroundColor')).toBe(palettes.dark.surface);
  expect(resolveThemeColor('#FFFFFF', true)).toBe('#FFFFFF');
  expect(resolveThemeColor('#C96849', true)).toBe(palettes.dark.primary);
  const luminance = (hex: string) => hex.slice(1).match(/.{2}/g)!.map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a: string, b: string) => {const x = [luminance(a), luminance(b)].sort((left, right) => right - left); return (x[0] + 0.05) / (x[1] + 0.05);};
  for (const palette of Object.values(palettes)) {
    expect(contrast(palette.text, palette.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.muted, palette.surfaceMuted)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.primary, palette.primarySoft)).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast('#FFFFFF', resolveThemeColor('#C96849', true, 'backgroundColor'))).toBeGreaterThanOrEqual(4.5);
});
