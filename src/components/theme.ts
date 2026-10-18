import { StyleSheet, useColorScheme } from 'react-native';
const dark: Record<string, string> = {
  '#FAF8F3': '#1E1C19',
  '#FFFFFF': '#2B2823',
  '#fff': '#EEE9DF',
  '#F2F0E9': '#35312B',
  '#292724': '#EEE9DF',
  '#504B43': '#C8C1B5',
  '#79746C': '#B5ADA0',
  '#E7E1D8': '#494238',
  '#F9E5DB': '#52362C',
  '#F1EFE8': '#302D27',
  '#F7DFD6': '#54392E',
  '#8C432F': '#F1B79F',
};
export function useThemedStyles<T extends Record<string, object>>(
  styles: T,
): T {
  const isDark = useColorScheme() === 'dark';
  if (!isDark) return styles;
  return Object.fromEntries(
    Object.entries(styles).map(([key, style]) => [
      key,
      Object.fromEntries(
        Object.entries(StyleSheet.flatten(style) || {}).map(
          ([property, value]) => [
            property,
            typeof value === 'string' &&
            (value === '#fff' || value === '#FFFFFF')
              ? property === 'color'
                ? '#EEE9DF'
                : '#2B2823'
              : typeof value === 'string' && dark[value]
              ? dark[value]
              : value,
          ],
        ),
      ),
    ]),
  ) as T;
}
