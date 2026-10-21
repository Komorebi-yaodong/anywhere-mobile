import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {Appearance, StyleSheet, useColorScheme} from 'react-native';
import {Dirs, FileSystem} from 'react-native-file-access';

export type ThemeMode = 'system' | 'light' | 'dark';
export const palettes = {
  light: {background: '#FAF8F3', surface: '#FFFFFF', surfaceMuted: '#F2F0E9', text: '#292724', muted: '#706B63', line: '#E7E1D8', primary: '#A14A32', primarySoft: '#F9E5DB', onPrimary: '#FFFFFF', danger: '#B13C48', success: '#386C4B', overlay: 'rgba(27,24,21,0.42)'},
  dark: {background: '#161513', surface: '#211F1C', surfaceMuted: '#2D2A26', text: '#F2EDE5', muted: '#C0B8AC', line: '#48423A', primary: '#F2B39B', primarySoft: '#4B3027', onPrimary: '#FFFFFF', danger: '#FFABB2', success: '#9ED3AD', overlay: 'rgba(0,0,0,0.64)'},
} as const;

const preferencePath = `${Dirs.DocumentDir}/anywhere-appearance.json`;
export const themePreferenceStore = {
  async load(): Promise<ThemeMode> {
    try {
      if (!(await FileSystem.exists(preferencePath))) return 'system';
      const mode = JSON.parse(await FileSystem.readFile(preferencePath, 'utf8'))?.mode;
      return ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
    } catch { return 'system'; }
  },
  async save(mode: ThemeMode) {
    await FileSystem.writeFile(preferencePath, JSON.stringify({version: 1, mode}), 'utf8');
  },
};

const aliases: Record<string, string> = {
  '#FAF8F3': 'background', '#FFFFFF': 'surface', '#F2F0E9': 'surfaceMuted', '#F1EFE8': 'surfaceMuted',
  '#292724': 'text', '#504B43': 'text', '#79746C': 'muted', '#A9A29A': 'muted', '#9A958D': 'muted', '#A9A197': 'muted', '#B5AEA4': 'muted', '#938C82': 'muted', '#B9B1A7': 'muted', '#A49D92': 'muted', '#8E887D': 'muted', '#8290A7': 'muted', '#B9D8C3': 'success',
  '#E7E1D8': 'line', '#DDD6CB': 'line', '#ECDACE': 'line', '#E8DCD1': 'line', '#E5CFC0': 'line',
  '#C96849': 'primary', '#8C432F': 'primary', '#80533E': 'primary', '#9A6A55': 'primary', '#8A5B47': 'primary',
  '#F9E5DB': 'primarySoft', '#F7DFD6': 'primarySoft', '#F6DADD': 'primarySoft', '#E6B9A7': 'primarySoft', '#F6E3E3': 'primarySoft', '#F0D8CA': 'primarySoft',
  '#EAE5DC': 'surfaceMuted', '#EDE8DE': 'surfaceMuted', '#FFF8F1': 'surface',
  '#B84E52': 'danger', '#478561': 'success', '#E5F2E9': 'surfaceMuted',
};

export function resolveThemeColor(value: string, dark: boolean, property = 'color'): string {
  const normalized = value.toUpperCase();
  // White ink is used on fixed accent buttons and dark media overlays. It must
  // not become a surface color, nor inherit the light-mode accent mapping.
  if (['#FFF', '#FFFFFF', '#FFF9F2'].includes(normalized) && property === 'color') return '#FFFFFF';
  if (normalized === '#FFF' || normalized === '#FFF9F2') return palettes[dark ? 'dark' : 'light'].surface;
  const key = aliases[normalized] as keyof typeof palettes.light | undefined;
  if (key) {
    if (property === 'backgroundColor' && (key === 'primary' || key === 'danger' || key === 'success')) {
      return palettes.light[key]; // keep contrast with on-primary white ink
    }
    return palettes[dark ? 'dark' : 'light'][key];
  }
  if (['#372C26', '#000000', '#000'].includes(normalized) && property === 'shadowColor') return '#000000';
  if (/^rgba\(\s*(?:39,\s*36,\s*31)/.test(value)) return palettes[dark ? 'dark' : 'light'].overlay;
  return value;
}

export function themedStyles<T extends Record<string, object>>(styles: T, dark: boolean): T {
  return Object.fromEntries(Object.entries(styles).map(([key, style]) => [key,
    Object.fromEntries(Object.entries(StyleSheet.flatten(style) || {}).map(([property, value]) => [property,
      typeof value === 'string' && (property.toLowerCase().includes('color')) ? resolveThemeColor(value, dark, property) : value,
    ])),
  ])) as T;
}

type ThemeState = {mode: ThemeMode; dark: boolean; ready: boolean; error: string; setMode: (mode: ThemeMode) => Promise<void>};
const ThemeContext = createContext<ThemeState | null>(null);
export function ThemeProvider({children}: {children: React.ReactNode}) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const writeQueue = useRef(Promise.resolve());
  useEffect(() => {
    let active = true;
    const current = revision.current;
    themePreferenceStore.load().then(value => {
      if (active) { if (revision.current === current) setModeState(value); setReady(true); }
    });
    return () => { active = false; };
  }, []);
  const setMode = useCallback(async (next: ThemeMode) => {
    if (!['system', 'light', 'dark'].includes(next)) return;
    const current = ++revision.current;
    setModeState(next);
    setError('');
    const job = writeQueue.current.catch(() => {}).then(() => themePreferenceStore.save(next));
    writeQueue.current = job;
    try { await job; }
    catch { if (revision.current === current) setError('当前外观已切换，但未能保存，请重试。'); }
  }, []);
  useEffect(() => {
    if (ready) Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
  }, [mode, ready]);

  const dark = mode === 'system' ? system === 'dark' : mode === 'dark';
  const value = useMemo(() => ({mode, dark, ready, error, setMode}), [mode, dark, ready, error, setMode]);
  return React.createElement(ThemeContext.Provider, {value}, children);
}

export function useTheme() {
  const context = useContext(ThemeContext);
  const system = useColorScheme();
  const dark = context?.dark ?? (system === 'dark');
  return {...context, mode: context?.mode || 'system' as ThemeMode, dark, colors: palettes[dark ? 'dark' : 'light'],
    setMode: context?.setMode || (async (_mode: ThemeMode) => {}),
    color: (value: string, property = 'color') => resolveThemeColor(value, dark, property)};
}
export function useThemedStyles<T extends Record<string, object>>(styles: T): T {
  const {dark} = useTheme();
  return useMemo(() => themedStyles(styles, dark), [styles, dark]);
}
