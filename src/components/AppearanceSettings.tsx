import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {AppIcon} from './AppIcon';
import {useTheme, useThemedStyles, type ThemeMode} from './theme';

const options: Array<{mode: ThemeMode; label: string; description: string; icon: string}> = [
  {mode: 'system', label: '跟随系统', description: '随设备外观自动切换', icon: 'system'},
  {mode: 'light', label: '浅色', description: '柔和明亮的暖色表面', icon: 'sun'},
  {mode: 'dark', label: '深色', description: '低亮度分层表面与清晰文字', icon: 'moon'},
];
export function AppearanceSettings({visible, onClose}: {visible: boolean; onClose: () => void}) {
  const theme = useTheme();
  const s = useThemedStyles(styles);
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={s.overlay}>
      <Pressable accessibilityLabel="关闭外观设置背景" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={s.sheet} accessibilityLabel="外观设置">
        <View style={s.handle} />
        <View style={s.header}><Text style={s.title}>外观</Text><Pressable accessibilityLabel="关闭外观设置" style={s.close} onPress={onClose}><AppIcon name="×" /></Pressable></View>
        {options.map(option => <Pressable key={option.mode} accessibilityRole="radio" accessibilityState={{checked: theme.mode === option.mode}} accessibilityLabel={`外观 ${option.label}`} onPress={() => { theme.setMode(option.mode).catch(() => undefined); }} style={[s.row, theme.mode === option.mode && s.active]}>
          <AppIcon name={option.icon} size={20} color={theme.colors.text} />
          <View style={s.copy}><Text style={s.label}>{option.label}</Text><Text style={s.description}>{option.description}</Text></View>
          {theme.mode === option.mode ? <AppIcon name="✓" size={18} /> : null}
        </Pressable>)}
        {theme.error ? <Text accessibilityLabel="外观保存提示" style={s.error}>{theme.error}</Text> : null}
      </View>
    </View>
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(39,36,31,0.34)'},
  sheet: {backgroundColor: '#FAF8F3', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, paddingBottom: 32, gap: 8},
  handle: {width: 32, height: 4, borderRadius: 2, backgroundColor: '#79746C', alignSelf: 'center', marginBottom: 6},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  title: {fontSize: 18, fontWeight: '600', color: '#292724'}, close: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  row: {minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', padding: 12, borderRadius: 16, borderWidth: 1, borderColor: '#E7E1D8'},
  active: {backgroundColor: '#F9E5DB', borderColor: '#C96849'}, copy: {flex: 1}, label: {fontSize: 14, fontWeight: '600', color: '#292724'}, description: {fontSize: 12, marginTop: 3, color: '#79746C'},
  hint: {fontSize: 12, lineHeight: 18, color: '#79746C', paddingTop: 10}, error: {fontSize: 12, color: '#B84E52'},
});
