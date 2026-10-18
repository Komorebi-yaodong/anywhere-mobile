import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { RemoteRequest } from '../remote/api';

type Props = {
  desktopId: string;
  section: string;
  item: Record<string, unknown>;
  request: RemoteRequest;
  onClose: () => void;
  onSaved: () => void;
};

/** Deliberately sends only changed fields; a hidden secret is never round-tripped. */
export function ManagementEditor({
  desktopId,
  section,
  item,
  request,
  onClose,
  onSaved,
}: Props) {
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const value = (key: string) =>
    Object.hasOwn(draft, key) ? draft[key] : item[key];
  const change = (key: string, next: unknown) =>
    setDraft(current => ({ ...current, [key]: next }));
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await request(
        desktopId,
        'workspace.management.patch',
        {
          section,
          id: String(item.id || ''),
          expectedRevision: item.revision,
          patch: draft,
        },
        60_000,
      );
      onSaved();
    } catch {
      setError('保存失败或配置已变更，请关闭后刷新再试。');
    } finally {
      setBusy(false);
    }
  };
  const submit = () =>
    Object.hasOwn(draft, 'apiKey')
      ? Alert.alert('替换服务商密钥？', '此操作将修改 Desktop 的服务商密钥。', [
          { text: '取消', style: 'cancel' },
          { text: '确认替换', onPress: save },
        ])
      : save();
  const field = (
    key: string,
    label: string,
    multiline = false,
    secret = false,
  ) => (
    <View key={key} style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={!busy}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        style={[s.input, multiline && s.multiline]}
        value={typeof value(key) === 'string' ? String(value(key)) : ''}
        placeholder={secret ? '留空不修改；输入新密钥后保存' : ''}
        onChangeText={text => change(key, text)}
      />
    </View>
  );
  return (
    <Modal
      transparent
      animationType="slide"
      onRequestClose={() => !busy && onClose()}
    >
      <View style={s.overlay}>
        <ScrollView
          contentContainerStyle={s.panel}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={s.title}>
            编辑{section === 'general' ? '通用配置' : String(item.name || '')}
          </Text>
          {section === 'general' ? (
            <>
              {field('displayName', '显示名称（最多 12 字）')}
              <Text style={s.label}>语言</Text>
              <View style={s.row}>
                {['zh', 'en'].map(option => (
                  <Pressable
                    key={option}
                    onPress={() => change('language', option)}
                    style={[s.chip, value('language') === option && s.active]}
                  >
                    <Text>{option === 'zh' ? '中文' : 'English'}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={s.label}>Desktop 主题</Text>
              <View style={s.row}>
                {['system', 'light', 'dark'].map(option => (
                  <Pressable
                    key={option}
                    onPress={() => change('themeMode', option)}
                    style={[s.chip, value('themeMode') === option && s.active]}
                  >
                    <Text>
                      {
                        (
                          {
                            system: '跟随系统',
                            light: '浅色',
                            dark: '深色',
                          } as Record<string, string>
                        )[option]
                      }
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <>
              {field('name', '名称')}
              {section === 'providers' ? (
                <>
                  {field('url', '服务地址')}
                  <Text style={s.label}>模型（每行一个）</Text>
                  <TextInput
                    multiline
                    style={[s.input, s.multiline]}
                    value={((value('models') as string[]) || []).join('\n')}
                    onChangeText={text =>
                      change('models', text.split('\n').filter(Boolean))
                    }
                  />
                  {field('apiKey', '替换 API Key', false, true)}
                </>
              ) : null}
              {section === 'tasks'
                ? field('description', '任务内容', true)
                : null}
              {section === 'mcp' || section === 'providers' ? (
                <View style={s.row}>
                  <Text style={s.label}>启用</Text>
                  <Switch
                    value={value('enabled') !== false}
                    onValueChange={enabled => change('enabled', enabled)}
                  />
                </View>
              ) : null}
            </>
          )}
          {error ? <Text style={s.error}>{error}</Text> : null}
          <Pressable
            accessibilityLabel="保存配置"
            disabled={busy || !Object.keys(draft).length}
            style={s.save}
            onPress={submit}
          >
            <Text style={s.saveText}>{busy ? '保存中…' : '保存'}</Text>
          </Pressable>
          <Pressable disabled={busy} onPress={onClose}>
            <Text style={s.close}>取消</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}
const s = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(39,36,31,0.34)',
  },
  panel: {
    backgroundColor: '#FAF8F3',
    padding: 24,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    gap: 14,
  },
  field: { gap: 6 },
  title: { fontSize: 22, color: '#292724', fontWeight: '800' },
  label: { color: '#504B43', fontSize: 14 },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E7E1D8',
    borderRadius: 14,
    color: '#292724',
    padding: 12,
  },
  multiline: { minHeight: 100, textAlignVertical: 'top' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chip: { padding: 10, backgroundColor: '#F2F0E9', borderRadius: 14 },
  active: { backgroundColor: '#F9E5DB' },
  save: {
    backgroundColor: '#C96849',
    borderRadius: 16,
    padding: 14,
    alignItems: 'center',
  },
  saveText: { color: '#fff', fontWeight: '800' },
  close: { color: '#79746C', padding: 10, textAlign: 'center' },
  error: { color: '#B84E52' },
});
