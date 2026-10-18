import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
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

import type {
  RemoteRequest,
  WorkspaceAgent,
  WorkspaceAgentCatalog,
  WorkspaceAgentDetail,
  WorkspaceAgentOptions,
  WorkspaceAgentRoutes,
} from '../remote/api';
import {SafeAreaView} from 'react-native-safe-area-context';

import {AppIcon} from './AppIcon';
import {ProviderSettings} from './ProviderSettings';
import {ManagementSettings} from './ManagementSettings';
import {TaskSettings} from './TaskSettings';
import {SimpleManagementSettings} from './SimpleManagementSettings';
import {useThemedStyles} from './theme';

const C = {
  background: '#FAF8F3',
  surface: '#FFFFFF',
  surfaceMuted: '#F2F0E9',
  text: '#292724',
  muted: '#79746C',
  line: '#E7E1D8',
  primary: '#C96849',
  primarySoft: '#F9E5DB',
  success: '#478561',
  overlay: 'rgba(39, 36, 31, 0.34)',
  danger: '#B84E52',
};

export type SettingsSection =
  | 'agents'
  | 'providers'
  | 'mcp'
  | 'skills'
  | 'tasks'
  | 'general'
  | 'about';

const sections: Array<{id: SettingsSection; title: string; icon: string}> = [
  {id: 'agents', title: 'Agent', icon: 'agents'},
  {id: 'providers', title: '服务商', icon: 'providers'},
  {id: 'mcp', title: 'MCP', icon: 'mcp'},
  {id: 'skills', title: 'Skill', icon: 'skills'},
  {id: 'tasks', title: '定时任务', icon: 'tasks'},
  {id: 'general', title: '通用设置', icon: 'general'},
  {id: 'about', title: '关于', icon: 'about'},
];

export function settingsTitle(section: SettingsSection): string {
  return `设置-${sections.find(item => item.id === section)?.title || 'Agent'}`;
}

export function GlobalSettings({
  desktopId,
  request,
  onChanged,
  onSectionChange,
  refreshSignal,
}: {
  desktopId: string;
  request: RemoteRequest;
  onChanged: () => void;
  onSectionChange: (section: SettingsSection) => void;
  refreshSignal: number;
}) {
  const s = useThemedStyles(styles);
  const [section, setSection] = useState<SettingsSection>('agents');

  useEffect(() => onSectionChange(section), [onSectionChange, section]);

  return (
    <View style={s.root}>
      <ScrollView
        horizontal
        style={s.sectionScroll}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.sectionTabs}
      >
        {sections.map(item => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={item.title}
            style={[s.sectionIcon, section === item.id && s.sectionIconActive]}
            onPress={() => setSection(item.id)}
          >
            <AppIcon
              name={item.icon}
              size={21}
              color={section === item.id ? C.primary : C.muted}
            />
          </Pressable>
        ))}
      </ScrollView>
      {section === 'agents' ? (
        <AgentSettings
          desktopId={desktopId}
          request={request}
          onChanged={onChanged}
          refreshSignal={refreshSignal}
        />
      ) : section === 'providers' ? (
        <ProviderSettings
          desktopId={desktopId}
          request={request}
          onChanged={onChanged}
          refreshSignal={refreshSignal}
        />
      ) : section === 'tasks' ? (
        <TaskSettings
          desktopId={desktopId}
          request={request}
          onChanged={onChanged}
          refreshSignal={refreshSignal}
        />
      ) : ['mcp', 'skills', 'general'].includes(section) ? (
        <SimpleManagementSettings
          section={section as 'mcp' | 'skills' | 'general'}
          desktopId={desktopId}
          request={request}
          onChanged={onChanged}
          refreshSignal={refreshSignal}
        />
      ) : section === 'about' ? (
        <ManagementSettings
          section="about"
          desktopId={desktopId}
          request={request}
          onChanged={onChanged}
          refreshSignal={refreshSignal}
        />
      ) : null}
    </View>
  );
}

type AgentForm = {
  name: string;
  enabled: boolean;
  model: string;
  type: WorkspaceAgent['type'];
  showMode: WorkspaceAgent['showMode'];
  systemPrompt: string;
  stream: boolean;
  reasoningEffort: string;
  saveTarget: string;
  voice: string;
  mcpServerIds: string[];
  skillIds: string[];
  tags: string[];
};

type AgentEditorState = {
  creating: boolean;
  original: WorkspaceAgentDetail | null;
  form: AgentForm;
};

type PickerState = {
  title: string;
  options: Array<{value: string; label: string}>;
  selected: string | string[];
  multiple?: boolean;
  onConfirm: (value: string | string[]) => void;
};

function formForAgent(agent?: WorkspaceAgentDetail | null): AgentForm {
  const saveTarget = !agent || !agent.autoSaveChat
    ? '__none__'
    : agent.defaultProjectId || '__ungrouped__';
  return {
    name: agent?.name || '',
    enabled: agent?.enabled ?? true,
    model: agent?.model || '',
    type: agent?.type || 'general',
    showMode: agent?.showMode || 'window',
    systemPrompt: agent?.systemPrompt || '',
    stream: agent?.stream ?? true,
    reasoningEffort: agent?.reasoningEffort || 'default',
    saveTarget,
    voice: agent?.voice || '',
    mcpServerIds: agent?.mcpServerIds || [],
    skillIds: agent?.skillIds || [],
    tags: agent?.tags || [],
  };
}

function AgentSettings({
  desktopId,
  request,
  onChanged,
  refreshSignal,
}: {
  desktopId: string;
  request: RemoteRequest;
  onChanged: () => void;
  refreshSignal: number;
}) {
  const s = useThemedStyles(styles);
  const [catalog, setCatalog] = useState<WorkspaceAgentCatalog | null>(null);
  const [selectedTag, setSelectedTag] = useState('__all__');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<AgentEditorState | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [tagComposer, setTagComposer] = useState(false);
  const [tagName, setTagName] = useState('');
  const [routesEditor, setRoutesEditor] = useState<{routes: WorkspaceAgentRoutes; revision: string} | null>(null);


  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const next = await request<WorkspaceAgentCatalog>(
        desktopId,
        'workspace.agent.catalog',
      );
      setCatalog(next);
      if (selectedTag !== '__all__' && !next.tags.includes(selectedTag)) {
        setSelectedTag('__all__');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取 Agent 失败，请刷新重试。');
    } finally {
      setBusy(false);
    }
  }, [desktopId, request, selectedTag]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load, refreshSignal]);

  const agents = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN');
    return [...(catalog?.agents || [])]
      .filter(agent =>
        selectedTag === '__all__' ? true : agent.tags.includes(selectedTag),
      )
      .filter(agent =>
        !keyword || agent.name.toLocaleLowerCase('zh-CN').includes(keyword),
      )
      .sort(
        (left, right) =>
          Number(right.enabled) - Number(left.enabled) ||
          left.name.localeCompare(right.name, 'zh-CN'),
      );
  }, [catalog?.agents, query, selectedTag]);

  const openAgent = async (code: string) => {
    setBusy(true);
    setError('');
    try {
      const detail = await request<{
        ok: true;
        agent: WorkspaceAgentDetail;
        options: WorkspaceAgentOptions;
      }>(desktopId, 'workspace.agent.get', {code});
      setCatalog(current =>
        current ? {...current, options: detail.options} : current,
      );
      setEditor({creating: false, original: detail.agent, form: formForAgent(detail.agent)});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取 Agent 详情。');
    } finally {
      setBusy(false);
    }
  };

  const createAgent = () => {
    setEditor({creating: true, original: null, form: formForAgent()});
  };

  const mutateTag = async (operation: 'create' | 'delete', name: string) => {
    setBusy(true);
    setError('');
    try {
      await request(
        desktopId,
        'workspace.agent.tags.mutate',
        {
          operation,
          name,
          ...(operation === 'delete' ? {confirmed: true} : {}),
        },
        60_000,
      );
      setTagComposer(false);
      setTagName('');
      if (operation === 'delete') setSelectedTag('__all__');
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '标签操作失败。');
    } finally {
      setBusy(false);
    }
  };

  const deleteTag = () => {
    if (selectedTag === '__all__') return;
    Alert.alert(
      `删除标签“${selectedTag}”？`,
      '只会解除 Agent 与此标签的关联，不会删除任何 Agent 或会话。',
      [
        {text: '取消', style: 'cancel'},
        {text: '删除标签', style: 'destructive', onPress: () => mutateTag('delete', selectedTag)},
      ],
    );
  };

  const toggleAgent = async (agent: WorkspaceAgent) => {
    setBusy(true);
    setError('');
    try {
      await request(
        desktopId,
        'workspace.agent.mutate',
        {
          operation: 'patch',
          code: agent.code,
          expectedRevision: agent.revision,
          patch: {enabled: !agent.enabled},
        },
        60_000,
      );
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法更新 Agent 开关。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.agentRoot}>
      <View style={s.agentTop}>
        <ScrollView
          horizontal
          style={s.agentTagsScroll}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.agentTags}
        >
          <TagButton
            label="全部"
            active={selectedTag === '__all__'}
            onPress={() => setSelectedTag('__all__')}
          />
          {(catalog?.tags || []).map(tag => (
            <TagButton
              key={tag}
              label={tag}
              active={selectedTag === tag}
              removable={selectedTag === tag}
              onRemove={deleteTag}
              onPress={() => setSelectedTag(tag)}
            />
          ))}
        </ScrollView>
        <View style={s.agentSearch}>
          <AppIcon name="search" size={18} color={C.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索 Agent"
            placeholderTextColor={C.muted}
            style={s.agentSearchInput}
          />
        </View>
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {busy && !catalog ? <ActivityIndicator color={C.primary} /> : null}
      <ScrollView style={s.agentScroll} contentContainerStyle={s.agentList} keyboardShouldPersistTaps="handled">
        {agents.map(agent => (
          <Pressable
            key={agent.code}
            style={s.agentCard}
            onPress={() => openAgent(agent.code)}
          >
            <AgentAvatar agent={agent} />
            <View style={s.agentCardCopy}>
              <Text numberOfLines={1} style={s.agentCardName}>{agent.name}</Text>
              <Text numberOfLines={1} style={s.agentCardMeta}>
                {agent.tags.length ? agent.tags.join(' · ') : '未分类'}
              </Text>
            </View>
            <Switch
              value={agent.enabled}
              disabled={busy}
              trackColor={{false: C.line, true: '#B9D8C3'}}
              thumbColor={agent.enabled ? C.success : C.surface}
              onValueChange={() => toggleAgent(agent)}
            />
          </Pressable>
        ))}
        {!busy && catalog && agents.length === 0 ? (
          <View style={s.emptyCard}>
            <Text style={s.emptyTitle}>没有匹配的 Agent</Text>
            <Text style={s.emptyText}>切换标签、调整搜索词，或新建一个 Agent。</Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={s.agentBottomActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建标签"
          style={s.agentBottomButton}
          onPress={() => {
            setTagName('');
            setTagComposer(true);
          }}
        >
          <AppIcon name="＋" size={18} color={C.primary} />
          <Text style={s.agentBottomText}>新建标签</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="默认Agent路由"
          style={s.agentBottomButton}
          onPress={() => setRoutesEditor({routes: catalog?.routes || emptyRoutes, revision: catalog?.routesRevision || ''})}
        >
          <AppIcon name="模型" size={18} color={C.primary} />
          <Text style={s.agentBottomText}>默认路由</Text>
        </Pressable>
        <Pressable style={s.agentBottomPrimary} onPress={createAgent}>
          <AppIcon name="＋" size={19} color="#FFFFFF" />
          <Text style={s.agentBottomPrimaryText}>新增Agent</Text>
        </Pressable>
      </View>
      <TagComposer
        visible={tagComposer}
        value={tagName}
        busy={busy}
        onChange={setTagName}
        onClose={() => setTagComposer(false)}
        onSubmit={() => {
          const name = tagName.trim();
          if (name) mutateTag('create', name);
        }}
      />
      <AgentEditor
        state={editor}
        options={catalog?.options || emptyOptions}
        allTags={catalog?.tags || []}
        busy={busy}
        onClose={() => setEditor(null)}
        onPick={setPicker}
        onSave={async nextForm => {
          if (!editor || !nextForm.name.trim()) return;
          const patch = agentPatch(editor, nextForm);
          if (!Object.keys(patch).length && !editor.creating) {
            setEditor(null);
            return;
          }
          setBusy(true);
          setError('');
          try {
            await request(
              desktopId,
              'workspace.agent.mutate',
              {
                operation: editor.creating ? 'create' : 'patch',
                ...(editor.creating ? {} : {code: editor.original?.code, expectedRevision: editor.original?.revision}),
                patch,
              },
              60_000,
            );
            setEditor(null);
            await load();
            onChanged();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : '保存 Agent 失败。');
          } finally {
            setBusy(false);
          }
        }}
        onDelete={() => {
          if (!editor?.original) return;
          Alert.alert('删除此 Agent？', '将删除此 Agent 配置，并从所有标签中解除关联。', [
            {text: '取消', style: 'cancel'},
            {
              text: '删除',
              style: 'destructive',
              onPress: async () => {
                setBusy(true);
                try {
                  await request(
                    desktopId,
                    'workspace.agent.mutate',
                    {
                      operation: 'delete',
                      code: editor.original?.code,
                      expectedRevision: editor.original?.revision,
                      confirmed: true,
                    },
                    60_000,
                  );
                  setEditor(null);
                  await load();
                  onChanged();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : '删除 Agent 失败。');
                } finally {
                  setBusy(false);
                }
              },
            },
          ]);
        }}
      />
      <AgentRoutesEditor
        state={routesEditor}
        models={catalog?.options.models || []}
        busy={busy}
        onClose={() => setRoutesEditor(null)}
        onSave={async routes => {
          if (!routesEditor) return;
          setBusy(true);
          setError('');
          try {
            await request(
              desktopId,
              'workspace.agent.routes.mutate',
              {expectedRevision: routesEditor.revision, routes},
              60_000,
            );
            setRoutesEditor(null);
            await load();
            onChanged();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : '保存默认Agent路由失败。');
          } finally {
            setBusy(false);
          }
        }}
      />

      <PickerSheet state={picker} onClose={() => setPicker(null)} />
    </View>
  );
}

const emptyOptions: WorkspaceAgentOptions = {
  models: [],
  projects: [],
  mcpServers: [],
  skills: [],
  voices: [],
};

function agentPatch(state: AgentEditorState, form: AgentForm): Record<string, unknown> {
  const base = state.original ? formForAgent(state.original) : null;
  const patch: Record<string, unknown> = {};
  const fields: Array<keyof AgentForm> = [
    'name',
    'enabled',
    'model',
    'type',
    'showMode',
    'systemPrompt',
    'stream',
    'reasoningEffort',
    'voice',
    'mcpServerIds',
    'skillIds',
    'tags',
  ];
  for (const field of fields) {
    const changed = !base || JSON.stringify(base[field]) !== JSON.stringify(form[field]);
    if (!changed) continue;
    const apiKey: Record<keyof AgentForm, string> = {
      name: 'name',
      enabled: 'enabled',
      model: 'model',
      type: 'type',
      showMode: 'showMode',
      systemPrompt: 'systemPrompt',
      stream: 'stream',
      reasoningEffort: 'reasoningEffort',
      saveTarget: 'defaultProjectId',
      voice: 'voice',
      mcpServerIds: 'mcpServerIds',
      skillIds: 'skillIds',
      tags: 'tags',
    };
    patch[apiKey[field]] = form[field];
  }
  if (!base || base.saveTarget !== form.saveTarget) {
    patch.autoSaveChat = form.saveTarget !== '__none__';
    patch.defaultProjectId =
      form.saveTarget === '__none__' || form.saveTarget === '__ungrouped__'
        ? ''
        : form.saveTarget;
  }
  return patch;
}

function AgentAvatar({agent}: {agent: WorkspaceAgent}) {
  const s = useThemedStyles(styles);
  const source = agent.iconDataUrl || agent.icon;
  return source ? (
    <Image source={{uri: source}} style={s.agentAvatar} />
  ) : (
    <View style={s.agentAvatarFallback}>
      <Text style={s.agentAvatarText}>{agent.name.trim().slice(0, 1).toUpperCase() || 'A'}</Text>
    </View>
  );
}

function TagButton({
  label,
  active,
  removable = false,
  onPress,
  onRemove,
}: {
  label: string;
  active: boolean;
  removable?: boolean;
  onPress: () => void;
  onRemove?: () => void;
}) {
  const s = useThemedStyles(styles);
  return (
    <View style={[s.tagButton, active && s.tagButtonActive]}>
      <Pressable style={s.tagPress} onPress={onPress}>
        <Text style={[s.tagButtonText, active && s.tagButtonTextActive]}>{label}</Text>
      </Pressable>
      {removable && onRemove ? (
        <Pressable accessibilityLabel={`删除标签 ${label}`} style={s.tagRemove} onPress={onRemove}>
          <Text style={s.tagRemoveText}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function TagComposer({
  visible,
  value,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const s = useThemedStyles(styles);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={s.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={s.smallSheet}>
          <Text style={s.sheetTitle}>新建标签</Text>
          <TextInput
            autoFocus
            value={value}
            maxLength={80}
            onChangeText={onChange}
            placeholder="例如：研究、写作"
            placeholderTextColor={C.muted}
            style={s.input}
          />
          <Pressable
            disabled={busy || !value.trim()}
            style={[s.primaryButton, (busy || !value.trim()) && s.disabled]}
            onPress={onSubmit}
          >
            <Text style={s.primaryButtonText}>创建标签</Text>
          </Pressable>
          <Pressable style={s.secondaryButton} onPress={onClose}>
            <Text style={s.secondaryButtonText}>取消</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function AgentEditor({
  state,
  options,
  allTags,
  busy,
  onClose,
  onPick,
  onSave,
  onDelete,
}: {
  state: AgentEditorState | null;
  options: WorkspaceAgentOptions;
  allTags: string[];
  busy: boolean;
  onClose: () => void;
  onPick: (picker: PickerState) => void;
  onSave: (form: AgentForm) => void;
  onDelete: () => void;
}) {
  const s = useThemedStyles(styles);
  const [form, setForm] = useState<AgentForm>(() => formForAgent());

  useEffect(() => {
    if (state) setForm(state.form);
  }, [state]);

  if (!state) return null;
  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) =>
    setForm(current => ({...current, [key]: value}));
  const original = state.original;
  const agentForAvatar: WorkspaceAgent = original || {
    code: '',
    name: form.name,
    enabled: form.enabled,
    icon: '',
    iconDataUrl: '',
    model: form.model,
    type: form.type,
    showMode: form.showMode,
    tags: form.tags,
    stream: form.stream,
    reasoningEffort: form.reasoningEffort,
    autoSaveChat: false,
    defaultProjectId: '',
    defaultProjectName: '',
    voice: form.voice,
    mcpServerIds: form.mcpServerIds,
    skillIds: form.skillIds,
    revision: '',
  };
  const select = (
    title: string,
    choices: Array<{value: string; label: string}>,
    selected: string | string[],
    onConfirm: (value: string | string[]) => void,
    multiple = false,
  ) => onPick({title, options: choices, selected, onConfirm, multiple});

  return (
    <Modal visible animationType="slide" onRequestClose={() => !busy && onClose()}>
      <SafeAreaView style={s.editorSafe} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={s.editorScreen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={s.editorHeader}>
            <Text style={s.editorTitle}>{state.creating ? '新增Agent' : '编辑Agent'}</Text>
          </View>
          <ScrollView style={s.editorScroll} contentContainerStyle={s.editorPage} keyboardShouldPersistTaps="handled">
          <View style={s.agentIdentity}>
            <AgentAvatar agent={agentForAvatar} />
            <View style={s.agentIdentityFields}>
              <View style={s.inlineField}>
                <TextInput
                  value={form.name}
                  maxLength={160}
                  onChangeText={value => set('name', value)}
                  placeholder="Agent 名称"
                  placeholderTextColor={C.muted}
                  style={[s.input, s.agentNameInput]}
                />
                <Switch
                  value={form.enabled}
                  disabled={busy}
                  trackColor={{false: C.line, true: '#B9D8C3'}}
                  thumbColor={form.enabled ? C.success : C.surface}
                  onValueChange={value => set('enabled', value)}
                />
              </View>
              <SelectRow
                label="模型"
                value={options.models.find(item => item.value === form.model)?.label || '未选择模型'}
                onPress={() => select('选择模型', options.models, form.model, value => set('model', String(value)))}
              />
            </View>
          </View>
          <View style={s.editorTwoColumn}>
            <View style={s.editorHalf}>
              <SelectRow
                label="类型"
                value={{general: '通用', over: '文本', img: '截图', files: '文件'}[form.type]}
                onPress={() => select('选择类型', [
                  {value: 'general', label: '通用'},
                  {value: 'over', label: '文本'},
                  {value: 'img', label: '截图'},
                  {value: 'files', label: '文件'},
                ], form.type, value => set('type', value as AgentForm['type']))}
              />
            </View>
            <View style={s.editorHalf}>
              <SelectRow
                label="显示模式"
                value={form.showMode === 'window' ? '独立窗口' : '快捷输入'}
                onPress={() => select('选择显示模式', [
                  {value: 'window', label: '独立窗口'},
                  {value: 'fastinput', label: '快捷输入'},
                ], form.showMode, value => set('showMode', value as AgentForm['showMode']))}
              />
            </View>
          </View>
          <Text style={s.fieldLabel}>系统提示词</Text>
          <TextInput
            multiline
            maxLength={64 * 1024}
            value={form.systemPrompt}
            onChangeText={value => set('systemPrompt', value)}
            placeholder="定义 Agent 的工作方式"
            placeholderTextColor={C.muted}
            textAlignVertical="top"
            style={[s.input, s.promptInput]}
          />
          <ToggleRow label="流式响应" value={form.stream} disabled={busy} onChange={value => set('stream', value)} />
          <SelectRow
            label="思考预算"
            value={{default: '自动', none: '关闭', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高'}[form.reasoningEffort] || form.reasoningEffort}
            onPress={() => select('选择思考预算', [
              {value: 'default', label: '自动'},
              {value: 'none', label: '关闭'},
              {value: 'low', label: '低'},
              {value: 'medium', label: '中'},
              {value: 'high', label: '高'},
              {value: 'xhigh', label: '很高'},
              {value: 'max', label: '最高'},
            ], form.reasoningEffort, value => set('reasoningEffort', String(value)))}
          />
          <SelectRow
            label="自动保存聊天"
            value={form.saveTarget === '__none__' ? '不自动保存' : form.saveTarget === '__ungrouped__' ? '保存到未分组' : options.projects.find(project => project.projectId === form.saveTarget)?.name || '不自动保存'}
            onPress={() => select('默认保存项目', [
              {value: '__none__', label: '不自动保存'},
              {value: '__ungrouped__', label: '保存到未分组'},
              ...options.projects.map(project => ({value: project.projectId, label: project.name})),
            ], form.saveTarget, value => set('saveTarget', String(value)))}
          />
          <SelectRow
            label="默认声音"
            value={form.voice || '默认 / 关闭'}
            onPress={() => select('默认声音', [
              {value: '', label: '默认 / 关闭'},
              ...options.voices.map(voice => ({value: voice, label: voice})),
            ], form.voice, value => set('voice', String(value)))}
          />
          <SelectRow
            label="MCP"
            value={form.mcpServerIds.length ? `已选 ${form.mcpServerIds.length} 项` : '未选择'}
            onPress={() => select('选择 MCP', [...options.mcpServers].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')).map(item => ({value: item.id, label: item.name})), form.mcpServerIds, value => set('mcpServerIds', value as string[]), true)}
          />
          <SelectRow
            label="Skill"
            value={form.skillIds.length ? `已选 ${form.skillIds.length} 项` : '未选择'}
            onPress={() => select('选择 Skill', [...options.skills].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')).map(item => ({value: item.id, label: item.name})), form.skillIds, value => set('skillIds', value as string[]), true)}
          />
          <SelectRow
            label="标签"
            value={form.tags.length ? form.tags.join(' · ') : '未分类'}
            onPress={() => select('选择标签', allTags.map(tag => ({value: tag, label: tag})), form.tags, value => set('tags', value as string[]), true)}
          />
          {!state.creating ? (
            <Pressable style={s.deleteAgent} disabled={busy} onPress={onDelete}>
              <Text style={s.deleteAgentText}>删除本Agent</Text>
            </Pressable>
          ) : null}
          </ScrollView>
          <View style={s.editorBottomActions}>
            <Pressable style={s.editorBottomSecondary} disabled={busy} onPress={onClose}>
              <Text style={s.secondaryButtonText}>取消</Text>
            </Pressable>
            <Pressable
              style={[s.editorBottomPrimary, (busy || !form.name.trim()) && s.disabled]}
              disabled={busy || !form.name.trim()}
              onPress={() => onSave(form)}
            >
              <Text style={s.primaryButtonText}>{busy ? '保存中…' : '保存'}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function SelectRow({label, value, onPress}: {label: string; value: string; onPress: () => void}) {
  const s = useThemedStyles(styles);
  return (
    <Pressable style={s.selectRow} onPress={onPress}>
      <Text style={s.selectLabel}>{label}</Text>
      <View style={s.selectValueWrap}>
        <Text numberOfLines={1} style={s.selectValue}>{value}</Text>
        <AppIcon name="›" size={18} color={C.muted} />
      </View>
    </Pressable>
  );
}

function ToggleRow({label, value, disabled, onChange}: {label: string; value: boolean; disabled: boolean; onChange: (value: boolean) => void}) {
  const s = useThemedStyles(styles);
  return (
    <View style={s.toggleRow}>
      <Text style={s.selectLabel}>{label}</Text>
      <Switch value={value} disabled={disabled} onValueChange={onChange} trackColor={{false: C.line, true: '#B9D8C3'}} thumbColor={value ? C.success : C.surface} />
    </View>
  );
}

const emptyRoutes: WorkspaceAgentRoutes = {general: '', superior: '', fast: ''};

function AgentRoutesEditor({
  state,
  models,
  busy,
  onClose,
  onSave,
}: {
  state: {routes: WorkspaceAgentRoutes; revision: string} | null;
  models: Array<{value: string; label: string}>;
  busy: boolean;
  onClose: () => void;
  onSave: (routes: WorkspaceAgentRoutes) => void;
}) {
  const s = useThemedStyles(styles);
  const [routes, setRoutes] = useState<WorkspaceAgentRoutes>(emptyRoutes);
  const [picker, setPicker] = useState<keyof WorkspaceAgentRoutes | null>(null);
  useEffect(() => {
    if (state) {
      setRoutes(state.routes);
      setPicker(null);
    }
  }, [state]);
  if (!state) return null;
  const labels: Record<keyof WorkspaceAgentRoutes, string> = {
    superior: '高级路由',
    general: '通用路由',
    fast: '快速路由',
  };
  const options = [{value: '', label: '未选择模型'}, ...models];
  const valueLabel = (value: string) =>
    models.find(model => model.value === value)?.label || '未选择模型';
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={s.routesSheet}>
          {picker ? (
            <>
              <View style={s.pickerHeader}>
                <Text style={s.sheetTitle}>选择{labels[picker]}</Text>
                <Pressable onPress={() => setPicker(null)}><Text style={s.link}>返回</Text></Pressable>
              </View>
              <ScrollView contentContainerStyle={s.pickerList}>
                {options.map(option => (
                  <Pressable
                    key={option.value || '__empty__'}
                    style={[s.optionRow, routes[picker] === option.value && s.optionRowActive]}
                    onPress={() => {
                      setRoutes(current => ({...current, [picker]: option.value}));
                      setPicker(null);
                    }}
                  >
                    <Text style={s.optionText}>{option.label}</Text>
                    {routes[picker] === option.value ? <Text style={s.optionCheck}>✓</Text> : null}
                  </Pressable>
                ))}
              </ScrollView>
            </>
          ) : (
            <>
              <Text style={s.sheetTitle}>默认Agent路由</Text>
              <Text style={s.routesHint}>用于 Desktop 的通用、高级与快速默认模型路由。</Text>
              {(Object.keys(labels) as Array<keyof WorkspaceAgentRoutes>).map(route => (
                <SelectRow
                  key={route}
                  label={labels[route]}
                  value={valueLabel(routes[route])}
                  onPress={() => setPicker(route)}
                />
              ))}
              <View style={s.routesActions}>
                <Pressable style={s.editorBottomSecondary} disabled={busy} onPress={onClose}>
                  <Text style={s.secondaryButtonText}>取消</Text>
                </Pressable>
                <Pressable style={[s.editorBottomPrimary, busy && s.disabled]} disabled={busy} onPress={() => onSave(routes)}>
                  <Text style={s.primaryButtonText}>{busy ? '保存中…' : '保存'}</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}


function PickerSheet({state, onClose}: {state: PickerState | null; onClose: () => void}) {
  const s = useThemedStyles(styles);
  const [selection, setSelection] = useState<string[]>([]);
  useEffect(() => {
    if (!state) return;
    setSelection(Array.isArray(state.selected) ? state.selected : [state.selected]);
  }, [state]);
  if (!state) return null;
  const choose = (value: string) => {
    if (!state.multiple) {
      state.onConfirm(value);
      onClose();
      return;
    }
    setSelection(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value]);
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={s.pickerSheet}>
          <View style={s.pickerHeader}>
            <Text style={s.sheetTitle}>{state.title}</Text>
            <Pressable onPress={onClose}><Text style={s.link}>完成</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={s.pickerList}>
            {state.options.map(option => {
              const active = selection.includes(option.value);
              return (
                <Pressable key={option.value} style={[s.optionRow, active && s.optionRowActive]} onPress={() => choose(option.value)}>
                  <Text style={s.optionText}>{option.label}</Text>
                  {active ? <Text style={s.optionCheck}>✓</Text> : null}
                </Pressable>
              );
            })}
            {!state.options.length ? <Text style={s.emptyText}>当前没有可选项。</Text> : null}
          </ScrollView>
          {state.multiple ? (
            <Pressable style={s.primaryButton} onPress={() => { state.onConfirm(selection); onClose(); }}>
              <Text style={s.primaryButtonText}>确认选择</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, minHeight: 0, backgroundColor: C.background},
  sectionScroll: {height: 64, flexGrow: 0, flexShrink: 0},

  sectionTabs: {height: 64, alignItems: 'center', paddingHorizontal: 14, gap: 10},
  sectionIcon: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: C.surfaceMuted},
  sectionIconActive: {backgroundColor: C.primarySoft},
  agentRoot: {flex: 1, minHeight: 0},
  agentTop: {flexShrink: 0, paddingTop: 3, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  agentTagsScroll: {height: 42, flexGrow: 0, flexShrink: 0},

  agentTags: {height: 42, alignItems: 'center', paddingHorizontal: 16, gap: 8},
  tagButton: {minHeight: 32, flexDirection: 'row', alignItems: 'center', borderRadius: 999, backgroundColor: C.surfaceMuted, overflow: 'hidden'},
  tagButtonActive: {backgroundColor: C.primarySoft},
  tagPress: {paddingHorizontal: 13, paddingVertical: 8},
  tagButtonText: {fontSize: 13, color: C.muted, fontWeight: '700'},
  tagButtonTextActive: {color: C.primary},
  tagRemove: {paddingRight: 10, paddingVertical: 8},
  tagRemoveText: {color: C.primary, fontSize: 17, lineHeight: 17, fontWeight: '700'},
  agentSearch: {height: 46, flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, borderWidth: 1, borderColor: C.line, borderRadius: 15, backgroundColor: C.surface, paddingHorizontal: 12},
  agentSearchInput: {flex: 1, minWidth: 0, color: C.text, paddingVertical: 8},
  agentScroll: {flex: 1, minHeight: 0},
  agentList: {padding: 16, paddingTop: 12, gap: 10, paddingBottom: 14},
  agentCard: {minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface, padding: 12},
  agentAvatar: {width: 48, height: 48, borderRadius: 24, backgroundColor: C.surfaceMuted},
  agentAvatarFallback: {width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primarySoft},
  agentAvatarText: {fontSize: 20, color: C.primary, fontWeight: '800'},
  agentCardCopy: {flex: 1, minWidth: 0, gap: 4},
  agentCardName: {fontSize: 16, color: C.text, fontWeight: '800'},
  agentCardMeta: {fontSize: 12, color: C.muted},
  agentBottomActions: {flexShrink: 0, flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.background},
  agentBottomButton: {flex: 1, minWidth: 0, minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 14, backgroundColor: C.surfaceMuted, paddingHorizontal: 6},
  agentBottomText: {fontSize: 12, color: C.text, fontWeight: '700'},
  agentBottomPrimary: {flex: 1.18, minWidth: 0, minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 14, backgroundColor: C.primary, paddingHorizontal: 7},
  agentBottomPrimaryText: {color: '#FFFFFF', fontSize: 13, fontWeight: '800'},
  emptyCard: {padding: 22, borderRadius: 18, backgroundColor: C.surfaceMuted, gap: 5},
  emptyTitle: {fontSize: 17, color: C.text, fontWeight: '800'},
  emptyText: {fontSize: 13, color: C.muted, lineHeight: 20},
  error: {color: C.danger, paddingHorizontal: 16, paddingBottom: 6},
  overlay: {flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay},
  smallSheet: {backgroundColor: C.background, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, gap: 12},
  sheetTitle: {fontSize: 21, color: C.text, fontWeight: '800'},
  input: {color: C.text, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 12, minHeight: 46},
  primaryButton: {minHeight: 48, borderRadius: 16, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16},
  primaryButtonText: {color: '#FFFFFF', fontWeight: '800', fontSize: 15},
  secondaryButton: {minHeight: 46, borderRadius: 15, backgroundColor: C.surfaceMuted, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14},
  secondaryButtonText: {color: C.text, fontWeight: '700'},
  disabled: {opacity: 0.45},
  editorSafe: {flex: 1, backgroundColor: C.background},
  editorScreen: {flex: 1, minHeight: 0, backgroundColor: C.background},
  editorHeader: {height: 54, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  editorTitle: {fontSize: 20, fontWeight: '800', color: C.text},
  editorScroll: {flex: 1, minHeight: 0},
  editorPage: {padding: 18, paddingBottom: 24, gap: 13},
  agentIdentity: {flexDirection: 'row', gap: 14, alignItems: 'center'},
  agentIdentityFields: {flex: 1, minWidth: 0, gap: 10},
  inlineField: {flexDirection: 'row', alignItems: 'center', gap: 10},
  agentNameInput: {flex: 1, minWidth: 0},
  editorTwoColumn: {flexDirection: 'row', gap: 10, width: '100%'},
  editorHalf: {flex: 1, minWidth: 0},
  fieldLabel: {color: C.text, fontSize: 14, fontWeight: '800', marginTop: 4},
  promptInput: {minHeight: 150, maxHeight: 220, paddingTop: 12},
  toggleRow: {minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  selectRow: {minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  selectLabel: {flexShrink: 1, color: C.text, fontSize: 15, fontWeight: '700'},
  selectValueWrap: {flex: 1, minWidth: 0, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 3},
  selectValue: {flexShrink: 1, color: C.muted, fontSize: 14, textAlign: 'right'},
  deleteAgent: {alignItems: 'center', paddingVertical: 14, marginTop: 4},
  deleteAgentText: {color: C.danger, fontWeight: '800'},
  editorBottomActions: {flexShrink: 0, flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.background},
  editorBottomSecondary: {flex: 1, minHeight: 48, borderRadius: 16, backgroundColor: C.surfaceMuted, alignItems: 'center', justifyContent: 'center'},
  editorBottomPrimary: {flex: 1, minHeight: 48, borderRadius: 16, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center'},
  pickerSheet: {maxHeight: '72%', backgroundColor: C.background, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, gap: 12},
  pickerHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  pickerList: {gap: 7, paddingBottom: 8},
  optionRow: {minHeight: 46, borderRadius: 14, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.surfaceMuted},
  optionRowActive: {backgroundColor: C.primarySoft},
  optionText: {flex: 1, color: C.text, fontSize: 14},
  optionCheck: {color: C.primary, fontSize: 18, fontWeight: '800'},
  routesSheet: {backgroundColor: C.background, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, gap: 8},
  routesHint: {color: C.muted, fontSize: 13, lineHeight: 19, marginBottom: 3},
  routesActions: {flexDirection: 'row', gap: 10, marginTop: 8},
  link: {color: C.primary, fontWeight: '800'},
});
