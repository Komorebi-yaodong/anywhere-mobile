import {TextInput, Switch, ActivityIndicator} from './ThemedNative';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,

  Text,

  View,
} from 'react-native';
import type { RemoteRequest } from '../remote/api';
import { useThemedStyles } from './theme';
import { AppIcon } from './AppIcon';
import { version } from '../../package.json';

type Field = {
  key: string;
  label: string;
  type: string;
  options?: string[];
  min?: number;
  max?: number;
};
type Catalog = {
  schema: Field[];
  options: Record<string, Array<{ value: string; label: string }>>;
  items?: Array<{ id: string; name: string; enabled: boolean }>;
  id?: string;
  revision?: string;
  value?: Record<string, unknown>;
  localOnly?: boolean;
};
const names: Record<string, string> = {
  assistants: '快捷助手',
  providers: '服务商',
  mcp: 'MCP',
  skills: 'Skill',
  tasks: '定时任务',
  general: '通用设置',
};
export function StructuredManagement({
  desktopId,
  request,
  onChanged,
  forcedSection,
  refreshSignal = 0,
  hideTabs = false,
  hideSectionHeader = false,
}: {
  desktopId: string;
  request: RemoteRequest;
  onChanged: () => void;
  forcedSection?: 'providers' | 'mcp' | 'skills' | 'tasks' | 'general' | 'about';
  refreshSignal?: number;
  hideTabs?: boolean;
  hideSectionHeader?: boolean;
}) {
  const s = useThemedStyles(baseStyles);
  const [section, setSection] = useState(forcedSection || 'assistants'),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [editing, setEditing] = useState<Catalog | null>(null),
    [creating, setCreating] = useState(false),
    [newId, setNewId] = useState(''),
    [draft, setDraft] = useState<Record<string, unknown>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0);
  useEffect(() => {
    if (!forcedSection || forcedSection === section) return;
    setSection(forcedSection);
    setCatalog(null);
    setEditing(null);
    setDraft({});
  }, [forcedSection, section]);

  const load = useCallback(async () => {
    if (section === 'about') {
      setBusy(false);
      return;
    }
    const e = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      const c = await request<Catalog>(desktopId, 'management.catalog', {
        section,
      });
      if (e !== epoch.current) return;
      setCatalog(c);
      if (section === 'general') {
        setEditing(c);
        setDraft({});
        setCreating(false);
      }
    } catch {
      if (e === epoch.current) setError('读取失败，请刷新重试。');
    } finally {
      if (e === epoch.current) setBusy(false);
    }
  }, [desktopId, section, request]);
  useEffect(() => {
    setCatalog(null);
    setEditing(null);
    load();
    return () => {
      epoch.current += 1;
    };
  }, [load, refreshSignal]);
  const open = async (id: string) => {
    const e = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      const c = await request<Catalog>(desktopId, 'management.catalog', {
        section,
        id,
      });
      if (e !== epoch.current) return;
      setEditing(c);
      setDraft({});
      setCreating(false);
    } catch {
      if (e === epoch.current) setError('无法读取详情。');
    } finally {
      setBusy(false);
    }
  };
  const create = () => {
    setEditing({ ...catalog!, value: {} });
    setCreating(true);
    setNewId('');
    setDraft({ name: '新建' + names[section] });
  };
  const mutate = async (operation: string) => {
    if (busy || !editing) return;
    setBusy(true);
    setError('');
    try {
      await request(
        desktopId,
        'management.mutate',
        {
          section,
          id: creating ? newId : editing.id || '',
          operation,
          ...(!creating ? { expectedRevision: editing.revision } : {}),
          ...(operation === 'delete' ? { confirmed: true } : { patch: draft }),
        },
        60000,
      );
      setEditing(null);
      setDraft({});
      onChanged();
      await load();
    } catch {
      setError(
        '保存失败：可能存在字段错误、重复 ID 或配置冲突，请刷新后重试。',
      );
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const secret = editing?.schema.some(
      f =>
        (f.type === 'secret' || f.type === 'pairs') &&
        Object.hasOwn(draft, f.key),
    );
    if (secret)
      Alert.alert('保存受保护配置？', '将修改 Desktop 密钥或请求头，请确认。', [
        { text: '取消', style: 'cancel' },
        { text: '保存', onPress: () => mutate(creating ? 'create' : 'patch') },
      ]);
    else mutate(creating ? 'create' : 'patch');
  };
  const remove = () =>
    Alert.alert(
      '删除' + names[section] + '？',
      section === 'skills'
        ? '仅移除技能定义，保留目录内附带资源。'
        : '将删除 Desktop 配置中的此项，无法从此界面撤销。',
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => mutate('delete') },
      ],
    );
  const set = (key: string, v: unknown) =>
    setDraft(current => ({ ...current, [key]: v }));
  const value = (f: Field) =>
    Object.hasOwn(draft, f.key) ? draft[f.key] : editing?.value?.[f.key];
  const render = (f: Field) => {
    const v = value(f);
    if (f.type === 'boolean')
      return (
        <View key={f.key} style={s.row}>
          <Text style={s.label}>{f.label}</Text>
          <Switch
            disabled={busy}
            value={v === true}
            onValueChange={n => set(f.key, n)}
          />
        </View>
      );
    const choices =
      f.type === 'select'
        ? f.options?.map(n => ({ value: n, label: n }))
        : editing?.options[f.type];
    if (choices) {
      const multi = ['mcp', 'skills'].includes(f.type);
      return (
        <View key={f.key} style={s.field}>
          <Text style={s.label}>{f.label}</Text>
          <View style={s.choices}>
            {choices.map(n => (
              <Pressable
                disabled={busy}
                key={n.value}
                style={[
                  s.chip,
                  (multi
                    ? Array.isArray(v) && v.includes(n.value)
                    : v === n.value) && s.selected,
                ]}
                onPress={() =>
                  set(
                    f.key,
                    multi
                      ? Array.isArray(v) && v.includes(n.value)
                        ? v.filter(x => x !== n.value)
                        : [...(Array.isArray(v) ? v : []), n.value]
                      : n.value,
                  )
                }
              >
                <Text style={s.text}>{n.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      );
    }
    if (f.type === 'pairs') {
      const entries = Object.entries((v || {}) as Record<string, string>);
      return (
        <View key={f.key} style={s.field}>
          <Text style={s.label}>{f.label}（新值替换已有请求头）</Text>
          {entries.map(([k, n], i) => (
            <View key={i} style={s.row}>
              <TextInput
                style={[s.input, s.flex]}
                value={k}
                placeholder="Header"
                onChangeText={key => {
                  const pairs = Object.fromEntries(
                    entries.map((e, j) => (j === i ? [key, e[1]] : e)),
                  );
                  set(f.key, pairs);
                }}
              />
              <TextInput
                secureTextEntry
                style={[s.input, s.flex]}
                value={n}
                placeholder="值"
                onChangeText={t =>
                  set(f.key, { ...Object.fromEntries(entries), [k]: t })
                }
              />
              <Pressable
                onPress={() =>
                  set(
                    f.key,
                    Object.fromEntries(entries.filter((_, j) => j !== i)),
                  )
                }
              >
                <Text style={s.text}>×</Text>
              </Pressable>
            </View>
          ))}
          <Pressable
            onPress={() =>
              set(f.key, {
                ...Object.fromEntries(entries),
                ['Header-' + entries.length]: '',
              })
            }
          >
            <Text style={s.link}>添加请求头</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View key={f.key} style={s.field}>
        <Text style={s.label}>{f.label}</Text>
        <TextInput
          accessibilityLabel={f.label}
          editable={!busy}
          secureTextEntry={f.type === 'secret'}
          autoCapitalize="none"
          autoCorrect={false}
          multiline={['multiline', 'lines', 'numbers'].includes(f.type)}
          style={[s.input, f.type === 'multiline' && s.multiline]}
          value={
            Array.isArray(v)
              ? v.join(f.type === 'lines' ? '\n' : ',')
              : v == null
              ? ''
              : String(v)
          }
          placeholder={
            f.type === 'time'
              ? 'HH:mm'
              : f.type === 'date'
              ? 'YYYY-MM-DD'
              : f.type === 'secret'
              ? '留空不修改'
              : ''
          }
          keyboardType={f.type === 'number' ? 'numeric' : 'default'}
          onChangeText={t =>
            set(
              f.key,
              f.type === 'number'
                ? Number(t)
                : f.type === 'lines'
                ? t.split('\n').filter(Boolean)
                : f.type === 'numbers'
                ? t
                    .split(/[,，\s]+/)
                    .filter(Boolean)
                    .map(Number)
                : t,
            )
          }
        />
      </View>
    );
  };
  return (
    <View style={s.root}>
      {!hideTabs ? (
        <ScrollView horizontal contentContainerStyle={s.tabs}>
          {[...Object.keys(names), 'about'].map(id => (
            <Pressable
              key={id}
              onPress={() => setSection(id)}
              style={[s.chip, section === id && s.selected]}
            >
              <AppIcon name={id} />
              <Text style={s.text}>{names[id] || '关于'}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <ScrollView contentContainerStyle={[s.page, hideTabs && s.embeddedPage]}>
        {error ? <Text style={s.error}>{error}</Text> : null}
        {busy ? <ActivityIndicator /> : null}
        {!hideSectionHeader ? (
          <View style={s.row}>
            <Text style={s.title}>{names[section]}</Text>
            <Pressable onPress={load}>
              <Text style={s.link}>刷新</Text>
            </Pressable>
            {section === 'about' ? null : section !== 'general' ? (
              <Pressable onPress={create} disabled={!catalog || busy}>
                <Text style={s.link}>＋ 新建</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => catalog && setEditing(catalog)}>
                <Text style={s.link}>编辑</Text>
              </Pressable>
            )}
          </View>
        ) : null}
        {section === 'about' ? (
          <View style={s.card}>
            <Text style={s.name}>Anywhere Mobile</Text>
            <Text style={s.meta}>{version}</Text>
            <Pressable
              onPress={() =>
                Linking.openURL(
                  'https://github.com/Komorebi-yaodong/anywheredesktop',
                ).catch(() => setError('无法打开链接'))
              }
            >
              <Text style={s.link}>Desktop GitHub ↗</Text>
            </Pressable>
            <Text style={s.text}>移动端仓库：即将发布</Text>
          </View>
        ) : null}
        {catalog?.items?.map(item => (
          <Pressable key={item.id} style={s.card} onPress={() => open(item.id)}>
            <Text style={s.name}>{item.name}</Text>
            <Text style={s.meta}>{item.enabled ? '已启用' : '已停用'}　›</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Modal
        visible={Boolean(editing)}
        transparent
        animationType="slide"
        onRequestClose={() => !busy && setEditing(null)}
      >
        <View style={s.overlay}>
          <ScrollView
            contentContainerStyle={s.panel}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={s.title}>
              {creating ? '新建' : '编辑'}
              {names[section]}
            </Text>
            {creating ? (
              <TextInput
                style={s.input}
                value={newId}
                onChangeText={setNewId}
                placeholder="唯一 ID / 助手代码"
              />
            ) : null}
            {editing?.localOnly ? (
              <Text style={s.meta}>
                请在桌面端编辑此 MCP。
              </Text>
            ) : null}
            {editing?.schema.map(render)}
            {error ? <Text style={s.error}>{error}</Text> : null}
            <Pressable
              disabled={
                busy || (creating && !newId) || !Object.keys(draft).length
              }
              style={s.save}
              onPress={save}
            >
              <Text style={s.white}>{busy ? '保存中…' : '保存'}</Text>
            </Pressable>
            {!creating && section !== 'general' ? (
              <Pressable disabled={busy} onPress={remove}>
                <Text style={s.error}>删除此项</Text>
              </Pressable>
            ) : null}
            <Pressable disabled={busy} onPress={() => setEditing(null)}>
              <Text style={s.link}>关闭</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
const baseStyles = StyleSheet.create({
  root: { flex: 1 },
  tabs: { padding: 14, gap: 8 },
  page: { padding: 18, gap: 12 },
  embeddedPage: {paddingTop: 8},

  field: { gap: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    justifyContent: 'space-between',
  },
  flex: { flex: 1 },
  title: { fontSize: 18, fontWeight: '600', color: '#292724' },
  text: { color: '#292724' },
  label: { color: '#504B43', fontWeight: '700' },
  name: { color: '#292724', fontSize: 17, fontWeight: '700' },
  meta: { color: '#79746C' },
  chip: { padding: 10, borderRadius: 18, backgroundColor: '#F2F0E9' },
  selected: { backgroundColor: '#F9E5DB' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  input: {
    backgroundColor: '#fff',
    color: '#292724',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E7E1D8',
  },
  multiline: { minHeight: 110, textAlignVertical: 'top' },
  card: { backgroundColor: '#fff', padding: 16, borderRadius: 18, gap: 6 },
  link: { color: '#C96849', fontWeight: '700' },
  error: { color: '#B84E52' },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  panel: { padding: 22, backgroundColor: '#FAF8F3', borderRadius: 24, gap: 14 },
  save: {
    backgroundColor: '#C96849',
    borderRadius: 16,
    padding: 14,
    alignItems: 'center',
  },
  white: { color: '#fff', fontWeight: '700' },
});
