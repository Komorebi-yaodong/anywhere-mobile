import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import type {RemoteRequest} from '../remote/api';
import {AppIcon} from './AppIcon';
import {useThemedStyles} from './theme';
import {version} from '../../package.json';

type Section = 'mcp' | 'skills' | 'general' | 'about';
type Field = {key: string; label: string; type: string; options?: string[]};
type Option = {value: string; label: string};
type Catalog = {
  ok: true;
  section: Section;
  schema: Field[];
  options: Record<string, Option[]>;
  items?: Array<Record<string, unknown>>;
  id?: string;
  revision?: string;
  value?: Record<string, unknown>;
  localOnly?: boolean;
  hasSecrets?: boolean;
};

type Editor = {creating: boolean; detail: Catalog; draft: Record<string, unknown>; id: string} | null;

const C = {
  background: '#FAF8F3',
  surface: '#FFFFFF',
  surfaceMuted: '#F2F0E9',
  text: '#292724',
  muted: '#79746C',
  line: '#E7E1D8',
  primary: '#C96849',
  primarySoft: '#F9E5DB',
  danger: '#B84E52',
  success: '#478561',
  overlay: 'rgba(39, 36, 31, 0.34)',
};

const copy: Record<Section, {title: string; empty: string; add: string; hint: string}> = {
  mcp: {
    title: 'MCP 服务',
    empty: '还没有可在 Mobile 管理的 MCP 服务。',
    add: '新建远程 MCP',
    hint: '本地 / stdio MCP 的命令、环境变量和路径仅能在 Desktop 编辑。',
  },
  skills: {
    title: 'Skill',
    empty: '还没有 Skill。',
    add: '新建 Skill',
    hint: 'Skill 文件路径不会同步到 Mobile；这里只管理安全的技能定义内容。',
  },
  general: {
    title: '通用设置',
    empty: '',
    add: '',
    hint: '仅显示可安全同步的偏好与公开资料，不包含本地路径、WebDAV 或 Remote 密钥。',
  },
  about: {title: '关于 Anywhere', empty: '', add: '', hint: ''},
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function titleForItem(section: Section, item: Record<string, unknown>): string {
  return stringValue(item.name) || stringValue(item.id) || (section === 'skills' ? '未命名 Skill' : '未命名服务');
}

function parseHeaderDraft(value: unknown): Record<string, string> | undefined {
  const raw = stringValue(value).trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    if (entries.length > 64 || entries.some(([key, item]) => !/^[A-Za-z0-9_-]+$/.test(key) || typeof item !== 'string')) return undefined;
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return undefined;
  }
}

function normalizeDraft(detail: Catalog): Record<string, unknown> {
  const source = detail.value || {};
  const result: Record<string, unknown> = {};
  for (const field of detail.schema || []) {
    if (field.type === 'pairs') continue;
    const value = source[field.key];
    if (value !== undefined) result[field.key] = value;
  }
  return result;
}

export function ManagementSettings({
  section,
  desktopId,
  request,
  onChanged,
  refreshSignal,
}: {
  section: Section;
  desktopId: string;
  request: RemoteRequest;
  onChanged: () => void;
  refreshSignal: number;
}) {
  const s = useThemedStyles(styles);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (section === 'about') return;
    setBusy(true);
    setError('');
    try {
      const result = await request<Catalog>(desktopId, 'management.catalog', {section});
      setCatalog(result);
      if (section === 'general') {
        setEditor({creating: false, detail: result, draft: normalizeDraft(result), id: ''});
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取配置失败，请刷新重试。');
    } finally {
      setBusy(false);
    }
  }, [desktopId, request, section]);

  useEffect(() => {
    setCatalog(null);
    setEditor(null);
    load().catch(() => undefined);
  }, [load, refreshSignal]);

  const open = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const detail = await request<Catalog>(desktopId, 'management.catalog', {section, id});
      setEditor({creating: false, detail, draft: normalizeDraft(detail), id});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取配置详情。');
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    const base = catalog;
    if (!base) return;
    setEditor({
      creating: true,
      id: '',
      detail: {...base, value: {}},
      draft: section === 'skills' ? {name: '', description: '', enabled: true, content: '', fork: false} : {name: '', isActive: true, transport: 'http', url: ''},
    });
  };

  const save = async () => {
    const current = editor;
    if (!current || busy) return;
    const name = stringValue(current.draft.name).trim();
    const targetId = current.creating ? stringValue(current.draft.__editorId).trim() : current.id;
    if (section !== 'general' && (!targetId || !name)) {
      setError('请填写唯一 ID 和名称。');
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const field of current.detail.schema || []) {
      if (field.type === 'pairs') {
        const parsed = parseHeaderDraft(current.draft[field.key]);
        if (stringValue(current.draft[field.key]).trim() && !parsed) {
          setError('请求头必须是合法 JSON 对象，例如 {"X-Name":"value"}。');
          return;
        }
        if (parsed) patch[field.key] = parsed;
        continue;
      }
      if (Object.hasOwn(current.draft, field.key)) patch[field.key] = current.draft[field.key];
    }
    if (!Object.keys(patch).length) {
      setEditor(null);
      return;
    }
    const commit = async () => {
      setBusy(true);
      setError('');
      try {
        await request(desktopId, 'management.mutate', {
          section,
          id: section === 'general' ? '' : targetId,
          operation: current.creating ? 'create' : 'patch',
          ...(current.creating ? {} : {expectedRevision: current.detail.revision}),
          patch,
        }, 60_000);
        if (section !== 'general') setEditor(null);
        await load();
        onChanged();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '保存失败，请刷新后重试。');
      } finally {
        setBusy(false);
      }
    };
    if (current.detail.hasSecrets && Object.hasOwn(patch, 'headers')) {
      Alert.alert('保存受保护请求头？', '新的请求头会安全写入 Desktop；已有值不会返回到 Mobile。', [
        {text: '取消', style: 'cancel'},
        {text: '保存', onPress: commit},
      ]);
    } else {
      await commit();
    }
  };

  const remove = () => {
    const current = editor;
    if (!current || current.creating || section === 'general') return;
    const text = section === 'skills'
      ? '仅移除技能定义，附带资源文件不会被此操作读取。'
      : '将删除此远程服务配置，无法从 Mobile 撤销。';
    Alert.alert(`删除“${stringValue(current.draft.name) || current.id}”？`, text, [
      {text: '取消', style: 'cancel'},
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await request(desktopId, 'management.mutate', {
              section,
              id: current.id,
              operation: 'delete',
              expectedRevision: current.detail.revision,
              confirmed: true,
            }, 60_000);
            setEditor(null);
            await load();
            onChanged();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : '删除失败。');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  if (section === 'about') return <AboutCard />;

  const items = (catalog?.items || []) as Array<Record<string, unknown>>;
  return (
    <View style={s.root}>
      <View style={s.headerRow}>
        <View style={s.headerCopy}>
          <Text style={s.pageTitle}>{copy[section].title}</Text>
          <Text style={s.pageHint}>{copy[section].hint}</Text>
        </View>
        <Pressable accessibilityLabel={`刷新${copy[section].title}`} style={s.refresh} onPress={load}>
          <AppIcon name="↻" size={18} color={C.primary} />
        </Pressable>
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {busy && !catalog ? <ActivityIndicator color={C.primary} /> : null}
      {section !== 'general' ? (
        <ScrollView style={s.scroll} contentContainerStyle={s.list} keyboardShouldPersistTaps="handled">
          {items.map(item => {
            const id = stringValue(item.id);
            const enabled = item.enabled !== false;
            const meta = section === 'mcp'
              ? `${stringValue(item.transport) || '远程'} · ${enabled ? '已启用' : '已停用'}`
              : `${stringValue(item.description) || (enabled ? '允许模型调用' : '已停用')}`;
            return (
              <Pressable key={id} style={s.itemCard} onPress={() => open(id)}>
                <View style={s.itemIcon}><AppIcon name={section} size={20} color={C.primary} /></View>
                <View style={s.itemCopy}>
                  <Text numberOfLines={1} style={s.itemTitle}>{titleForItem(section, item)}</Text>
                  <Text numberOfLines={2} style={s.itemMeta}>{meta}</Text>
                </View>
                <View style={[s.statusDot, enabled ? s.statusOn : s.statusOff]} />
                <AppIcon name="›" size={18} color={C.muted} />
              </Pressable>
            );
          })}
          {!busy && catalog && !items.length ? <Empty title={copy[section].empty} /> : null}
        </ScrollView>
      ) : null}
      {section !== 'general' ? (
        <Pressable style={s.bottomPrimary} onPress={create} disabled={busy || !catalog}>
          <AppIcon name="＋" size={19} color="#fff" />
          <Text style={s.bottomPrimaryText}>{copy[section].add}</Text>
        </Pressable>
      ) : null}
      <ManagementEditor
        editor={editor}
        section={section}
        busy={busy}
        onClose={() => section !== 'general' && setEditor(null)}
        onChange={draft => setEditor(current => current ? {...current, draft} : current)}
        onSave={save}
        onDelete={remove}
      />
    </View>
  );
}

function GeneralPreview({draft}: {draft: Record<string, unknown>}) {
  const s = useThemedStyles(styles);
  return (
    <View style={s.generalCard}>
      <View style={s.generalTop}><View style={s.generalAvatar}><Text style={s.generalAvatarText}>{(stringValue(draft.nickname) || 'U').slice(0, 1).toUpperCase()}</Text></View><View><Text style={s.itemTitle}>{stringValue(draft.nickname) || 'User'}</Text><Text style={s.itemMeta}>Desktop 公开资料</Text></View></View>
      <View style={s.divider} />
      <Text style={s.generalLabel}>更改语言、主题与公开资料后，使用下方“保存通用设置”同步到 Desktop。</Text>
    </View>
  );
}

function ManagementEditor({
  editor,
  section,
  busy,
  onClose,
  onChange,
  onSave,
  onDelete,
}: {
  editor: Editor;
  section: Section;
  busy: boolean;
  onClose: () => void;
  onChange: (draft: Record<string, unknown>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const s = useThemedStyles(styles);
  const [picker, setPicker] = useState<Field | null>(null);
  if (!editor) return null;
  const update = (key: string, value: unknown) => onChange({...editor.draft, [key]: value});
  const isGeneral = section === 'general';
  const optionsFor = (field: Field): Option[] => field.options?.map(value => ({value, label: value})) || editor.detail.options?.[field.type] || [];
  const form = (
    <>
      {editor.creating ? (
        <View style={s.field}><Text style={s.label}>唯一 ID</Text><TextInput value={stringValue(editor.draft.__editorId)} onChangeText={id => onChange({...editor.draft, __editorId: id})} placeholder="例如 remote-search" placeholderTextColor={C.muted} style={s.input} autoCapitalize="none" autoCorrect={false} /></View>
      ) : null}
      {editor.detail.localOnly ? <View style={s.localNotice}><AppIcon name="mcp" size={18} color={C.primary} /><Text style={s.localText}>这是本地 MCP。命令、环境变量、路径和凭据不会同步到 Mobile，请在 Desktop 编辑。</Text></View> : null}
      {(editor.detail.schema || []).map(field => {
        const value = editor.draft[field.key];
        if (editor.detail.localOnly && !['name', 'isActive'].includes(field.key)) return null;
        if (field.type === 'boolean') return <Pressable key={field.key} style={s.toggleRow} onPress={() => update(field.key, value !== true)}><Text style={s.label}>{field.label}</Text><Switch value={value === true} disabled={busy} trackColor={{false: C.line, true: '#B9D8C3'}} thumbColor={value === true ? C.success : C.surface} onValueChange={next => update(field.key, next)} /></Pressable>;
        if (field.type === 'select' || optionsFor(field).length) return <Pressable key={field.key} style={s.selectRow} onPress={() => setPicker(field)}><Text style={s.label}>{field.label}</Text><View style={s.selectValue}><Text numberOfLines={1} style={s.itemMeta}>{optionsFor(field).find(option => option.value === value)?.label || stringValue(value) || '请选择'}</Text><AppIcon name="›" size={17} color={C.muted} /></View></Pressable>;
        if (field.type === 'pairs') return <View key={field.key} style={s.field}><Text style={s.label}>{field.label}</Text><Text style={s.protectedHint}>已保存的值不会显示。若需覆盖，请输入 JSON 对象；留空保持不变。</Text><TextInput value={stringValue(value)} onChangeText={text => update(field.key, text)} placeholder='{"X-Header":"new-value"}' placeholderTextColor={C.muted} style={[s.input, s.multiline]} multiline autoCapitalize="none" autoCorrect={false} /></View>;
        const multiline = field.type === 'multiline';
        return <View key={field.key} style={s.field}><Text style={s.label}>{field.label}</Text><TextInput value={value == null ? '' : String(value)} onChangeText={text => update(field.key, text)} secureTextEntry={field.type === 'secret'} placeholder={field.type === 'secret' ? '留空不修改' : field.label} placeholderTextColor={C.muted} style={[s.input, multiline && s.multiline]} multiline={multiline} textAlignVertical={multiline ? 'top' : 'center'} autoCapitalize={field.type === 'url' || field.type === 'secret' ? 'none' : 'sentences'} autoCorrect={false} /></View>;
      })}
    </>
  );
  const body = (
    <KeyboardAvoidingView style={s.editorScreen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {!isGeneral ? <View style={s.editorHeader}><Text style={s.editorTitle}>{editor.creating ? copy[section].add : `编辑${copy[section].title}`}</Text><Pressable onPress={onClose}><Text style={s.link}>关闭</Text></Pressable></View> : null}
      <ScrollView style={s.editorScroll} contentContainerStyle={s.editorPage} keyboardShouldPersistTaps="handled">{form}</ScrollView>
      <View style={s.editorBottom}>
        {!isGeneral ? <Pressable style={s.bottomSecondary} onPress={onClose} disabled={busy}><Text style={s.secondaryText}>取消</Text></Pressable> : null}
        <Pressable style={[s.saveButton, busy && s.disabled]} onPress={onSave} disabled={busy}><Text style={s.saveText}>{busy ? '正在保存…' : isGeneral ? '保存通用设置' : '保存'}</Text></Pressable>
      </View>
      {!editor.creating && !isGeneral ? <Pressable style={s.deleteButton} disabled={busy} onPress={onDelete}><Text style={s.deleteText}>删除此项</Text></Pressable> : null}
      {picker ? <Modal transparent animationType="fade" onRequestClose={() => setPicker(null)}><View style={s.pickerOverlay}><View style={s.picker}><Text style={s.editorTitle}>{picker.label}</Text>{optionsFor(picker).map(option => <Pressable key={option.value} style={[s.option, editor.draft[picker.key] === option.value && s.optionSelected]} onPress={() => { update(picker.key, option.value); setPicker(null); }}><Text style={s.optionText}>{option.label}</Text>{editor.draft[picker.key] === option.value ? <Text style={s.optionCheck}>✓</Text> : null}</Pressable>)}<Pressable style={s.pickerClose} onPress={() => setPicker(null)}><Text style={s.link}>取消</Text></Pressable></View></View></Modal> : null}
    </KeyboardAvoidingView>
  );
  if (isGeneral) return <View style={s.generalEditor}><GeneralPreview draft={editor.draft} />{body}</View>;
  return <Modal visible animationType="slide" transparent onRequestClose={onClose}><SafeAreaView style={s.editorSafe} edges={['top', 'bottom']}>{body}</SafeAreaView></Modal>;
}

function Empty({title}: {title: string}) {
  const s = useThemedStyles(styles);
  return <View style={s.empty}><Text style={s.emptyTitle}>{title}</Text><Text style={s.emptyText}>可通过底部按钮创建，或在 Desktop 中继续配置。</Text></View>;
}

function AboutCard() {
  const s = useThemedStyles(styles);
  return <ScrollView contentContainerStyle={s.aboutPage}><View style={s.aboutHero}><View style={s.aboutIcon}><AppIcon name="about" size={30} color={C.primary} /></View><Text style={s.aboutTitle}>Anywhere Mobile</Text><Text style={s.aboutMeta}>v{version} · Remote v2 · E2EE</Text></View><View style={s.aboutCard}><Text style={s.aboutHeading}>安全的 Desktop 伴侣</Text><Text style={s.aboutText}>配置和会话均通过加密远程通道访问。Desktop Renderer 保持唯一会话数据库写入权，Mobile 不会获取本地路径、服务商密钥、MCP 命令或 Remote 根密钥。</Text></View><View style={s.aboutCard}><Text style={s.aboutHeading}>开源项目</Text><Pressable style={s.githubRow} onPress={() => Linking.openURL('https://github.com/Komorebi-yaodong/anywheredesktop').catch(() => undefined)}><Text style={s.githubText}>Desktop GitHub</Text><AppIcon name="›" size={18} color={C.primary} /></Pressable><Text style={s.aboutText}>移动端仓库将在准备完成后发布。</Text></View></ScrollView>;
}

const styles = StyleSheet.create({
  root: {flex: 1, minHeight: 0, backgroundColor: C.background},
  headerRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10},
  headerCopy: {flex: 1, minWidth: 0, gap: 4},
  pageTitle: {fontSize: 22, fontWeight: '800', color: C.text},
  pageHint: {fontSize: 12, lineHeight: 18, color: C.muted},
  refresh: {width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surfaceMuted},
  error: {paddingHorizontal: 18, color: C.danger, fontSize: 13},
  scroll: {flex: 1, minHeight: 0},
  list: {padding: 16, paddingTop: 3, paddingBottom: 18, gap: 10},
  itemCard: {minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12, borderRadius: 19, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface},
  itemIcon: {width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primarySoft},
  itemCopy: {flex: 1, minWidth: 0, gap: 4},
  itemTitle: {fontSize: 15, color: C.text, fontWeight: '800'},
  itemMeta: {fontSize: 12, lineHeight: 17, color: C.muted},
  statusDot: {width: 8, height: 8, borderRadius: 4},
  statusOn: {backgroundColor: C.success},
  statusOff: {backgroundColor: '#B5AEA4'},
  empty: {marginTop: 12, padding: 22, borderRadius: 19, backgroundColor: C.surfaceMuted, gap: 6},
  emptyTitle: {fontSize: 16, color: C.text, fontWeight: '800'},
  emptyText: {fontSize: 13, lineHeight: 19, color: C.muted},
  bottomPrimary: {minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: 16, marginTop: 6, marginBottom: 13, borderRadius: 17, backgroundColor: C.primary},
  bottomPrimaryText: {color: '#fff', fontSize: 15, fontWeight: '800'},
  generalCard: {gap: 12, padding: 17, borderRadius: 20, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface},
  generalTop: {flexDirection: 'row', alignItems: 'center', gap: 12},
  generalAvatar: {width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primarySoft},
  generalAvatarText: {fontSize: 20, fontWeight: '800', color: C.primary},
  divider: {height: StyleSheet.hairlineWidth, backgroundColor: C.line},
  generalLabel: {fontSize: 13, lineHeight: 20, color: C.muted},
  editorSafe: {flex: 1, backgroundColor: C.background},
  generalEditor: {flex: 1, minHeight: 0, backgroundColor: C.background},
  editorScreen: {flex: 1, minHeight: 0, backgroundColor: C.background},
  editorHeader: {height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  editorTitle: {fontSize: 20, fontWeight: '800', color: C.text},
  editorScroll: {flex: 1, minHeight: 0},
  editorPage: {padding: 18, paddingBottom: 22, gap: 13},
  field: {gap: 7},
  label: {fontSize: 14, color: C.text, fontWeight: '800'},
  input: {minHeight: 47, paddingHorizontal: 12, borderWidth: 1, borderColor: C.line, borderRadius: 14, backgroundColor: C.surface, color: C.text},
  multiline: {minHeight: 118, paddingTop: 11},
  protectedHint: {fontSize: 12, color: C.muted, lineHeight: 18},
  localNotice: {flexDirection: 'row', gap: 9, padding: 13, borderRadius: 15, backgroundColor: C.primarySoft},
  localText: {flex: 1, color: '#8C432F', fontSize: 12, lineHeight: 18},
  toggleRow: {minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  selectRow: {minHeight: 55, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  selectValue: {flex: 1, minWidth: 0, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 3},
  editorBottom: {flexDirection: 'row', gap: 10, padding: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.background},
  bottomSecondary: {flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: C.surfaceMuted},
  secondaryText: {fontWeight: '700', color: C.text},
  saveButton: {flex: 1.25, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: C.primary},
  saveText: {color: '#fff', fontWeight: '800'},
  deleteButton: {alignItems: 'center', paddingBottom: 17},
  deleteText: {color: C.danger, fontWeight: '800'},
  disabled: {opacity: 0.45},
  link: {color: C.primary, fontWeight: '800'},
  pickerOverlay: {flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay},
  picker: {padding: 20, gap: 8, borderTopLeftRadius: 25, borderTopRightRadius: 25, backgroundColor: C.background},
  option: {minHeight: 47, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.surfaceMuted},
  optionSelected: {backgroundColor: C.primarySoft},
  optionText: {color: C.text, fontSize: 14},
  optionCheck: {color: C.primary, fontSize: 18, fontWeight: '800'},
  pickerClose: {alignItems: 'center', paddingTop: 8, paddingBottom: 3},
  aboutPage: {padding: 18, gap: 12},
  aboutHero: {alignItems: 'center', gap: 7, paddingVertical: 20},
  aboutIcon: {width: 62, height: 62, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primarySoft},
  aboutTitle: {fontSize: 24, color: C.text, fontWeight: '800'},
  aboutMeta: {fontSize: 13, color: C.muted},
  aboutCard: {padding: 16, gap: 9, borderRadius: 19, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface},
  aboutHeading: {fontSize: 16, color: C.text, fontWeight: '800'},
  aboutText: {fontSize: 13, lineHeight: 20, color: C.muted},
  githubRow: {minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderRadius: 13, backgroundColor: C.surfaceMuted},
  githubText: {color: C.primary, fontWeight: '800'},
});
