import React, {forwardRef} from 'react';
import {ActivityIndicator as NativeActivityIndicator, Switch as NativeSwitch, TextInput as NativeTextInput, type ActivityIndicatorProps, type SwitchProps, type TextInputProps} from 'react-native';
import {useTheme} from './theme';

export const TextInput = forwardRef<NativeTextInput, TextInputProps>((props, ref) => {
  const theme = useTheme();
  return <NativeTextInput {...props} ref={ref}
    keyboardAppearance={theme.dark ? 'dark' : 'light'}
    placeholderTextColor={props.placeholderTextColor ? theme.color(String(props.placeholderTextColor)) : theme.colors.muted}
    selectionColor={theme.colors.primary}
    cursorColor={theme.colors.primary}
    style={[{color: theme.colors.text}, props.style]}
  />;
});
TextInput.displayName = 'ThemedTextInput';

export function Switch(props: SwitchProps) {
  const theme = useTheme();
  return <NativeSwitch {...props} trackColor={{false: theme.colors.line, true: theme.dark ? '#6C4B3B' : '#D6AD9A'}} thumbColor={props.value ? theme.colors.primary : theme.colors.muted} ios_backgroundColor={theme.colors.line} />;
}
export function ActivityIndicator(props: ActivityIndicatorProps) {
  const theme = useTheme();
  return <NativeActivityIndicator {...props} color={props.color ? theme.color(String(props.color)) : theme.colors.primary} />;
}
