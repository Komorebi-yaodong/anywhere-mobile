import {TextInput, Switch, ActivityIndicator} from './ThemedNative';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,

  Text,

  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import type {
  RemoteRequest,
  WorkspaceProvider,
  WorkspaceProviderCatalog,
  WorkspaceProviderFolder,
  WorkspaceProviderOptions,
} from '../remote/api';
import {AppIcon} from './AppIcon';
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
  danger: '#B84E52',
  overlay: 'rgba(39, 36, 31, 0.34)',
};

type ProviderHeaderDraft = {
  rowId: string;
  originalName: string;
  name: string;
  value: string;
};

type ProviderForm = {
  name: string;
  enabled: boolean;
  url: string;
  apiType: WorkspaceProvider['apiType'];
  apiKeys: string;
  models: string[];
  retryCount: number;
  folderId: string;
  headers: ProviderHeaderDraft[];
  removedHeaders: string[];
};

type ProviderEditorState = {
  creating: boolean;
  original: WorkspaceProvider | null;
  form: ProviderForm;
};

type FolderDialog = {mode: 'create' | 'rename'; folder?: WorkspaceProviderFolder} | null;

const emptyOptions: WorkspaceProviderOptions = {
  apiTypes: [
    {value: 'chat_completions', label: 'Chat Completions'},
    {value: 'responses', label: 'Responses'},
    {value: 'codex', label: 'Codex'},
    {value: 'claude', label: 'Claude'},
  ],
  folders: [],
};

function formForProvider(provider?: WorkspaceProvider | null): ProviderForm {
  return {
    name: provider?.name || '',
    enabled: provider?.enabled ?? true,
    url: provider?.url || '',
    apiType: provider?.apiType || 'chat_completions',
    apiKeys: '',
    models: provider?.models || [],
    retryCount: provider?.retryCount ?? 3,
    folderId: provider?.folderId || '',
    headers: (provider?.headerNames || []).map((name, index) => ({
      rowId: `existing-${index}-${name}`,
      originalName: name,
      name,
      value: '',
    })),
    removedHeaders: [],
  };
}

export function ProviderSettings({
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
  const [catalog, setCatalog] = useState<WorkspaceProviderCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<ProviderEditorState | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialog>(null);
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setCatalog(await request<WorkspaceProviderCatalog>(desktopId, 'workspace.provider.catalog'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取服务商失败，请刷新重试。');
    } finally {
      setBusy(false);
    }
  }, [desktopId, request]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load, refreshSignal]);

  const moveProvider = async (
    folderId: string,
    providerIds: string[],
    providerId: string,
    direction: -1 | 1,
  ) => {
    if (busy || query.trim()) return;
    const index = providerIds.indexOf(providerId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= providerIds.length) return;
    const next = [...providerIds];
    [next[index], next[target]] = [next[target], next[index]];
    setBusy(true);
    setError('');
    try {
      await request(desktopId, 'workspace.provider.order.mutate', {
        folderId,
        providerIds: next,
      }, 60_000);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '服务商排序保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const mutateFolder = async (
    operation: 'create' | 'rename' | 'toggle' | 'delete',
    input: Record<string, unknown>,
  ) => {
    setBusy(true);
    setError('');
    try {
      await request(
        desktopId,
        'workspace.provider.folders.mutate',
        {operation, ...input, ...(operation === 'delete' ? {confirmed: true} : {})},
        60_000,
      );
      setFolderDialog(null);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '目录操作失败。');
    } finally {
      setBusy(false);
    }
  };



  const toggleProvider = async (provider: WorkspaceProvider) => {
    setBusy(true);
    setError('');
    try {
      await request(
        desktopId,
        'workspace.provider.mutate',
        {
          operation: 'patch',
          id: provider.id,
          expectedRevision: provider.revision,
          patch: {enabled: !provider.enabled},
        },
        60_000,
      );
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法更新服务商开关。');
    } finally {
      setBusy(false);
    }
  };



  const groups = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN');
    const matches = (provider: WorkspaceProvider) =>
      !keyword ||
      provider.name.toLocaleLowerCase('zh-CN').includes(keyword) ||
      provider.url.toLocaleLowerCase('zh-CN').includes(keyword) ||
      provider.models.some(model => model.toLocaleLowerCase('zh-CN').includes(keyword));
    const providers = (catalog?.providers || []).filter(matches);
    const folders = catalog?.folders || [];
    const folderGroups = folders
      .map(folder => ({
        ...folder,
        removable: true,
        providers: providers.filter(provider => provider.folderId === folder.id),
      }))
      .filter(group => !keyword || group.providers.length > 0);
    const ungrouped = {
      id: '',
      name: '未分类',
      collapsed: ungroupedCollapsed,
      removable: false,
      providers: providers.filter(provider =>
        !provider.folderId || !folders.some(folder => folder.id === provider.folderId),
      ),
    };
    return [...folderGroups, ungrouped];
  }, [catalog?.folders, catalog?.providers, query, ungroupedCollapsed]);



  const openProvider = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const detail = await request<{
        ok: true;
        provider: WorkspaceProvider;
        options: WorkspaceProviderOptions;
      }>(desktopId, 'workspace.provider.get', {id});
      setCatalog(current => current ? {...current, options: detail.options} : current);
      setEditor({creating: false, original: detail.provider, form: formForProvider(detail.provider)});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取服务商详情。');
    } finally {
      setBusy(false);
    }
  };

  const saveProvider = async (form: ProviderForm) => {
    if (!editor || !form.name.trim()) return;
    const built = buildProviderPatch(editor, form);
    if (built.error) {
      setError(built.error);
      return;
    }
    if (!editor.creating && !Object.keys(built.patch).length) {
      setEditor(null);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request(
        desktopId,
        'workspace.provider.mutate',
        {
          operation: editor.creating ? 'create' : 'patch',
          ...(editor.creating ? {} : {id: editor.original?.id, expectedRevision: editor.original?.revision}),
          patch: built.patch,
        },
        60_000,
      );
      setEditor(null);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存服务商失败。');
    } finally {
      setBusy(false);
    }
  };

  const deleteProvider = () => {
    const provider = editor?.original;
    if (!provider) return;
    Alert.alert('删除此服务商？', '将删除 Desktop 中的该服务商配置，无法从此界面撤销。', [
      {text: '取消', style: 'cancel'},
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          const current = provider;
          setBusy(true);
          try {
            await request(
              desktopId,
              'workspace.provider.mutate',
              {operation: 'delete', id: current.id, expectedRevision: current.revision, confirmed: true},
              60_000,
            );
            setEditor(null);
            await load();
            onChanged();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : '删除服务商失败。');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const removeFolder = (folder: WorkspaceProviderFolder) => {
    Alert.alert(
      `删除目录“${folder.name}”？`,
      '只会删除目录，目录内服务商会移到“未分类”，不会删除服务商。',
      [
        {text: '取消', style: 'cancel'},
        {text: '删除目录', style: 'destructive', onPress: () => mutateFolder('delete', {id: folder.id})},
      ],
    );
  };

  return (
    <View style={s.root}>
      <View style={s.searchWrap}>
        <AppIcon name="search" size={18} color={C.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索服务商"
          placeholderTextColor={C.muted}
          style={s.searchInput}
        />
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {busy && !catalog ? <ActivityIndicator color={C.primary} /> : null}
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
      >
        {groups.map(group => (
          <ProviderGroup
            key={group.id || '__ungrouped__'}
            group={group}
            busy={busy}
            controlsDisabled={busy}
            searching={Boolean(query.trim())}
            onToggle={() => group.id
              ? mutateFolder('toggle', {id: group.id, collapsed: !group.collapsed})
              : setUngroupedCollapsed(current => !current)}
            onRename={() => group.id && setFolderDialog({mode: 'rename', folder: group})}
            onDelete={() => group.id && removeFolder(group)}
            onMoveProvider={(providerId, direction) => moveProvider(
              group.id,
              group.providers.map(provider => provider.id),
              providerId,
              direction,
            )}
            onOpen={openProvider}
            onSwitch={toggleProvider}
          />
        ))}
        {!busy && catalog && groups.every(group => group.providers.length === 0) ? (
          <View style={s.emptyCard}>
            <Text style={s.emptyTitle}>没有匹配的服务商</Text>
            <Text style={s.emptyText}>调整搜索词，或在底部新增服务商。</Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={s.bottomActions}>
        <Pressable style={s.secondaryAction} disabled={busy} onPress={() => setFolderDialog({mode: 'create'})}>
          <AppIcon name="▱" size={18} color={C.primary} />
          <Text style={s.secondaryActionText}>新建目录</Text>
        </Pressable>
        <Pressable style={s.primaryAction} disabled={busy} onPress={() => setEditor({creating: true, original: null, form: formForProvider()})}>
          <AppIcon name="＋" size={19} color="#FFFFFF" />
          <Text style={s.primaryActionText}>新增服务商</Text>
        </Pressable>
      </View>
      <FolderComposer
        state={folderDialog}
        busy={busy}
        onClose={() => setFolderDialog(null)}
        onSave={(name, folder) => mutateFolder(folder ? 'rename' : 'create', folder ? {id: folder.id, name} : {name})}
      />
      <ProviderEditor
        state={editor}
        options={catalog?.options || emptyOptions}
        busy={busy}
        onClose={() => setEditor(null)}
        onSave={saveProvider}
        onDelete={deleteProvider}
        onFetchModels={async id => {
          const result = await request<{ok: true; models: string[]}>(desktopId, 'workspace.provider.models.fetch', {id}, 60_000);
          return result.models;
        }}
      />
    </View>
  );
}

function ProviderGroup({
  group,
  busy,
  controlsDisabled,
  searching,
  onToggle,
  onRename,
  onDelete,
  onMoveProvider,
  onOpen,
  onSwitch,
}: {
  group: WorkspaceProviderFolder & {removable: boolean; providers: WorkspaceProvider[]};
  busy: boolean;
  controlsDisabled: boolean;
  searching: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMoveProvider: (providerId: string, direction: -1 | 1) => void;
  onOpen: (id: string) => void;
  onSwitch: (provider: WorkspaceProvider) => void;
}) {
  const s = useThemedStyles(styles);
  const expanded = searching || !group.collapsed;
  return (
    <View style={s.groupCard}>
      <View style={s.groupHeader}>
        <Pressable style={s.groupTitlePress} onPress={onToggle} disabled={controlsDisabled}>
          <AppIcon name={expanded ? '⌄' : '›'} size={17} color={C.muted} />
          <Text numberOfLines={1} style={s.groupName}>{group.name}</Text>
          <Text style={s.groupCount}>{group.providers.length}</Text>
        </Pressable>
        {group.removable ? (
          <View style={s.groupActions}>
            <Pressable accessibilityLabel={`重命名目录 ${group.name}`} disabled={controlsDisabled} style={s.iconAction} onPress={onRename}>
              <AppIcon name="edit" size={17} color={C.primary} />
            </Pressable>
            <Pressable accessibilityLabel={`删除目录 ${group.name}`} disabled={controlsDisabled} style={s.iconAction} onPress={onDelete}>
              <AppIcon name="delete" size={17} color={C.danger} />
            </Pressable>
          </View>
        ) : null}
      </View>
      {expanded ? (
        <View style={s.groupProviders}>
          {group.providers.map((provider, index) => (
            <ProviderOrderRow
              key={provider.id}
              provider={provider}
              busy={busy}
              canMoveUp={!searching && index > 0}
              canMoveDown={!searching && index < group.providers.length - 1}
              onMove={direction => onMoveProvider(provider.id, direction)}
              onOpen={() => onOpen(provider.id)}
              onSwitch={() => onSwitch(provider)}
            />
          ))}
          {!group.providers.length ? <Text style={s.emptyGroup}>暂无服务商</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function ProviderOrderRow({
  provider,
  busy,
  canMoveUp,
  canMoveDown,
  onMove,
  onOpen,
  onSwitch,
}: {
  provider: WorkspaceProvider;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onOpen: () => void;
  onSwitch: () => void;
}) {
  const s = useThemedStyles(styles);
  return (
    <View style={s.providerRow}>
      <Pressable style={s.providerCopy} disabled={busy} onPress={onOpen}>
        <Text numberOfLines={1} style={s.providerName}>{provider.name}</Text>
        <Text numberOfLines={1} style={s.providerMeta}>
          {provider.models.length ? `${provider.models.length} 个模型` : '未配置模型'}
        </Text>
      </Pressable>
      <View style={s.providerOrderControls}>
        <Pressable
          accessibilityLabel={`上移服务商 ${provider.name}`}
          disabled={busy || !canMoveUp}
          onPress={() => onMove(-1)}
          style={[s.providerOrderButton, (busy || !canMoveUp) && s.disabled]}
        >
          <AppIcon name="↑" size={16} color={C.text} />
        </Pressable>
        <Pressable
          accessibilityLabel={`下移服务商 ${provider.name}`}
          disabled={busy || !canMoveDown}
          onPress={() => onMove(1)}
          style={[s.providerOrderButton, (busy || !canMoveDown) && s.disabled]}
        >
          <AppIcon name="↓" size={16} color={C.text} />
        </Pressable>
      </View>
      <Switch
        value={provider.enabled}
        disabled={busy}
        trackColor={{false: C.line, true: '#B9D8C3'}}
        thumbColor={provider.enabled ? C.success : C.surface}
        onValueChange={onSwitch}
      />
    </View>
  );
}

function FolderComposer({
  state,
  busy,
  onClose,
  onSave,
}: {
  state: FolderDialog;
  busy: boolean;
  onClose: () => void;
  onSave: (name: string, folder?: WorkspaceProviderFolder) => void;
}) {
  const s = useThemedStyles(styles);
  const [name, setName] = useState('');
  useEffect(() => setName(state?.folder?.name || ''), [state]);
  if (!state) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={s.sheet}>
          <Text style={s.sheetTitle}>{state.mode === 'create' ? '新建目录' : '重命名目录'}</Text>
          <TextInput
            autoFocus
            value={name}
            maxLength={160}
            onChangeText={setName}
            placeholder="目录名称"
            placeholderTextColor={C.muted}
            style={s.input}
          />
          <View style={s.sheetActions}>
            <Pressable style={s.sheetSecondary} disabled={busy} onPress={onClose}><Text style={s.secondaryText}>取消</Text></Pressable>
            <Pressable style={[s.sheetPrimary, (busy || !name.trim()) && s.disabled]} disabled={busy || !name.trim()} onPress={() => onSave(name.trim(), state.folder)}><Text style={s.primaryText}>{busy ? '保存中…' : '保存'}</Text></Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ProviderEditor({
  state,
  options,
  busy,
  onClose,
  onSave,
  onDelete,
  onFetchModels,
}: {
  state: ProviderEditorState | null;
  options: WorkspaceProviderOptions;
  busy: boolean;
  onClose: () => void;
  onSave: (form: ProviderForm) => void;
  onDelete: () => void;
  onFetchModels: (id: string) => Promise<string[]>;
}) {
  const s = useThemedStyles(styles);
  const [form, setForm] = useState<ProviderForm>(formForProvider());
  const [choice, setChoice] = useState<'apiType' | 'folder' | null>(null);
  const [manualModel, setManualModel] = useState(false);
  const [manualModelName, setManualModelName] = useState('');
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [modelError, setModelError] = useState('');

  useEffect(() => {
    if (state) {
      setForm(state.form);
      setChoice(null);
      setManualModel(false);
      setManualModelName('');
      setFetchedModels(null);
      setModelError('');
    }
  }, [state]);

  if (!state) return null;
  const set = <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) =>
    setForm(current => ({...current, [key]: value}));
  const addModel = (model: string) => {
    const value = model.trim();
    if (!value) return;
    set('models', form.models.includes(value) ? form.models : [...form.models, value]);
  };
  const removeHeader = (row: ProviderHeaderDraft) => {
    setForm(current => ({
      ...current,
      headers: current.headers.filter(item => item.rowId !== row.rowId),
      removedHeaders: row.originalName && !current.removedHeaders.includes(row.originalName)
        ? [...current.removedHeaders, row.originalName]
        : current.removedHeaders,
    }));
  };
  const fetchModels = async () => {
    if (!state.original) {
      setModelError('请先保存服务商地址和 API Key，再获取模型。');
      return;
    }
    setFetching(true);
    setModelError('');
    try {
      setFetchedModels(await onFetchModels(state.original.id));
    } catch {
      setModelError('获取模型失败，请确认 Desktop 中的服务地址、密钥和网络配置。');
    } finally {
      setFetching(false);
    }
  };
  const apiTypeLabel = options.apiTypes.find(item => item.value === form.apiType)?.label || form.apiType;
  const folderLabel = !form.folderId
    ? '未分类'
    : options.folders.find(folder => folder.id === form.folderId)?.name || '未分类';

  return (
    <Modal visible animationType="slide" onRequestClose={() => !busy && onClose()}>
      <SafeAreaView style={s.editorSafe} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={s.editorScreen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={s.editorHeader}><Text style={s.editorTitle}>{state.creating ? '新增服务商' : '编辑服务商'}</Text></View>
          <ScrollView style={s.editorScroll} contentContainerStyle={s.editorPage} keyboardShouldPersistTaps="handled">
            <View style={s.identityRow}>
              <TextInput
                value={form.name}
                maxLength={160}
                onChangeText={value => set('name', value)}
                placeholder="服务商名称"
                placeholderTextColor={C.muted}
                style={[s.input, s.nameInput]}
              />
              <Switch
                value={form.enabled}
                disabled={busy}
                trackColor={{false: C.line, true: '#B9D8C3'}}
                thumbColor={form.enabled ? C.success : C.surface}
                onValueChange={value => set('enabled', value)}
              />
            </View>
            <Text style={s.fieldLabel}>服务地址</Text>
            <TextInput
              value={form.url}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={value => set('url', value)}
              placeholder="https://api.example.com/v1"
              placeholderTextColor={C.muted}
              style={s.input}
            />
            <Text style={s.fieldLabel}>API Key {state.original?.apiKeyCount ? `· 已配置 ${state.original.apiKeyCount} 个` : ''}</Text>
            <TextInput
              value={form.apiKeys}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              onChangeText={value => set('apiKeys', value)}
              placeholder={state.original?.apiKeyCount ? '留空不修改；多个 Key 用逗号分隔' : '多个 Key 用逗号分隔'}
              placeholderTextColor={C.muted}
              style={s.input}
            />
            <View style={s.editorTwoColumn}>
              <View style={s.editorHalf}><ProviderSelectRow label="API 类型" value={apiTypeLabel} onPress={() => setChoice('apiType')} /></View>
              <View style={s.editorHalf}><ProviderSelectRow label="目录" value={folderLabel} onPress={() => setChoice('folder')} /></View>
            </View>
            <View style={s.modelActions}>
              <Pressable style={s.modelAction} disabled={busy || fetching} onPress={fetchModels}>
                <AppIcon name="↻" size={17} color={C.primary} />
                <Text style={s.modelActionText}>{fetching ? '获取中…' : '获取模型'}</Text>
              </Pressable>
              <Pressable style={s.modelAction} disabled={busy} onPress={() => { setManualModelName(''); setManualModel(true); }}>
                <AppIcon name="＋" size={17} color={C.primary} />
                <Text style={s.modelActionText}>手动添加模型</Text>
              </Pressable>
            </View>
            {modelError ? <Text style={s.modelError}>{modelError}</Text> : null}
            <Text style={s.fieldLabel}>模型列表 · {form.models.length}</Text>
            <View style={s.modelBox}>
              <ScrollView contentContainerStyle={s.modelList} nestedScrollEnabled>
                {form.models.map(model => (
                  <DraggableModelRow
                    key={model}
                    model={model}
                    models={form.models}
                    disabled={busy}
                    onMove={(name, direction) => {
                      setForm(current => {
                        const index = current.models.indexOf(name);
                        const target = index + direction;
                        if (index < 0 || target < 0 || target >= current.models.length) return current;
                        const next = [...current.models];
                        [next[index], next[target]] = [next[target], next[index]];
                        return {...current, models: next};
                      });
                    }}
                    onRemove={() => set('models', form.models.filter(item => item !== model))}
                  />
                ))}
                {!form.models.length ? <Text style={s.emptyModels}>获取或手动添加模型后会显示在这里。</Text> : null}
              </ScrollView>
            </View>
            <View style={s.retryRow}>
              <Text style={s.selectLabel}>重试次数</Text>
              <View style={s.retryControl}>
                <Pressable style={s.retryButton} disabled={busy || form.retryCount <= 0} onPress={() => set('retryCount', form.retryCount - 1)}><Text style={s.retryText}>−</Text></Pressable>
                <Text style={s.retryValue}>{form.retryCount}</Text>
                <Pressable style={s.retryButton} disabled={busy || form.retryCount >= 10} onPress={() => set('retryCount', form.retryCount + 1)}><Text style={s.retryText}>＋</Text></Pressable>
              </View>
            </View>
            <View style={s.headersHeading}>
              <View>
                <Text style={s.fieldLabel}>自定义请求头</Text>
                <Text style={s.headerHint}>已保存的请求头值不会显示；填写同名键和值可覆盖。</Text>
              </View>
              <Pressable style={s.smallAdd} onPress={() => set('headers', [...form.headers, {rowId: `new-${Date.now()}`, originalName: '', name: '', value: ''}])}>
                <AppIcon name="＋" size={17} color={C.primary} />
              </Pressable>
            </View>
            <View style={s.headersBox}>
              {form.headers.map(row => (
                <View key={row.rowId} style={s.headerRow}>
                  <TextInput
                    value={row.name}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="key"
                    placeholderTextColor={C.muted}
                    style={[s.input, s.headerKey]}
                    onChangeText={value => set('headers', form.headers.map(item => item.rowId === row.rowId ? {...item, name: value} : item))}
                  />
                  <TextInput
                    value={row.value}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    importantForAutofill="no"
                    placeholder={row.originalName ? '保持原值' : 'value'}
                    placeholderTextColor={C.muted}
                    style={[s.input, s.headerValue]}
                    onChangeText={value => set('headers', form.headers.map(item => item.rowId === row.rowId ? {...item, value} : item))}
                  />
                  <Pressable style={s.headerRemove} onPress={() => removeHeader(row)}><AppIcon name="delete" size={17} color={C.danger} /></Pressable>
                </View>
              ))}
              {!form.headers.length ? <Text style={s.emptyHeaders}>暂无自定义请求头</Text> : null}
            </View>
            {!state.creating ? <Pressable style={s.deleteProvider} disabled={busy} onPress={onDelete}><Text style={s.deleteProviderText}>删除本服务商</Text></Pressable> : null}
          </ScrollView>
          <View style={s.editorBottom}>
            <Pressable style={s.bottomSecondary} disabled={busy} onPress={onClose}><Text style={s.secondaryText}>取消</Text></Pressable>
            <Pressable style={[s.bottomPrimary, (busy || !form.name.trim()) && s.disabled]} disabled={busy || !form.name.trim()} onPress={() => onSave(form)}><Text style={s.primaryText}>{busy ? '保存中…' : '保存'}</Text></Pressable>
          </View>
          {choice ? (
            <View style={s.innerOverlay}>
              <View style={s.innerSheet}>
                <View style={s.innerSheetHeader}><Text style={s.sheetTitle}>{choice === 'apiType' ? '选择 API 类型' : '选择目录'}</Text><Pressable onPress={() => setChoice(null)}><Text style={s.link}>关闭</Text></Pressable></View>
                <ScrollView contentContainerStyle={s.choiceList}>
                  {(choice === 'apiType'
                    ? options.apiTypes.map(item => ({value: item.value, label: item.label}))
                    : [{value: '', label: '未分类'}, ...options.folders.map(item => ({value: item.id, label: item.name}))]
                  ).map(item => {
                    const active = choice === 'apiType' ? form.apiType === item.value : form.folderId === item.value;
                    return <Pressable key={item.value || '__ungrouped__'} style={[s.choiceRow, active && s.choiceRowActive]} onPress={() => { if (choice === 'apiType') set('apiType', item.value as ProviderForm['apiType']); else set('folderId', item.value); setChoice(null); }}><Text style={s.choiceText}>{item.label}</Text>{active ? <Text style={s.choiceCheck}>✓</Text> : null}</Pressable>;
                  })}
                </ScrollView>
              </View>
            </View>
          ) : null}
          {manualModel ? (
            <View style={s.innerOverlay}>
              <KeyboardAvoidingView style={s.innerSheet} behavior="height">
                <Text style={s.sheetTitle}>手动添加模型</Text>
                <TextInput value={manualModelName} autoFocus autoCapitalize="none" onChangeText={setManualModelName} placeholder="模型名称" placeholderTextColor={C.muted} style={s.input} />
                <View style={s.sheetActions}><Pressable style={s.sheetSecondary} onPress={() => setManualModel(false)}><Text style={s.secondaryText}>取消</Text></Pressable><Pressable style={[s.sheetPrimary, !manualModelName.trim() && s.disabled]} disabled={!manualModelName.trim()} onPress={() => { addModel(manualModelName); setManualModel(false); }}><Text style={s.primaryText}>添加</Text></Pressable></View>
              </KeyboardAvoidingView>
            </View>
          ) : null}
          {fetchedModels ? (
            <View style={s.innerOverlay}>
              <View style={s.innerSheetLarge}>
                <View style={s.innerSheetHeader}><Text style={s.sheetTitle}>获取到的模型</Text><Pressable onPress={() => setFetchedModels(null)}><Text style={s.link}>完成</Text></Pressable></View>
                <ScrollView contentContainerStyle={s.choiceList}>
                  {fetchedModels.map(model => {
                    const active = form.models.includes(model);
                    return <Pressable key={model} style={[s.choiceRow, active && s.choiceRowActive]} onPress={() => { if (active) set('models', form.models.filter(item => item !== model)); else addModel(model); }}><Text style={s.choiceText}>{model}</Text>{active ? <Text style={s.choiceCheck}>✓</Text> : null}</Pressable>;
                  })}
                  {!fetchedModels.length ? <Text style={s.emptyModels}>服务端没有返回可用模型。</Text> : null}
                </ScrollView>
              </View>
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function ProviderSelectRow({label, value, onPress}: {label: string; value: string; onPress: () => void}) {
  const s = useThemedStyles(styles);
  return <Pressable style={s.selectRow} onPress={onPress}><Text numberOfLines={1} style={s.selectLabel}>{label}</Text><View style={s.selectValueWrap}><Text numberOfLines={1} style={s.selectValue}>{value}</Text><AppIcon name="›" size={17} color={C.muted} /></View></Pressable>;
}

function DraggableModelRow({
  model,
  models,
  disabled,
  onMove,
  onRemove,
}: {
  model: string;
  models: string[];
  disabled: boolean;
  onMove: (name: string, direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const s = useThemedStyles(styles);
  const movedSteps = useRef(0);
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled,
    onMoveShouldSetPanResponder: (_event, gesture) => !disabled && Math.abs(gesture.dy) > 5,
    onPanResponderGrant: () => { movedSteps.current = 0; },
    onPanResponderMove: (_event, gesture) => {
      const targetSteps = Math.trunc(gesture.dy / 48);
      if (targetSteps === 0 || targetSteps === movedSteps.current) return;
      const direction: -1 | 1 = targetSteps > movedSteps.current ? 1 : -1;
      const index = models.indexOf(model);
      if (index + direction < 0 || index + direction >= models.length) return;
      onMove(model, direction);
      movedSteps.current += direction;
    },
  })).current;
  return (
    <View style={s.modelRow}>
      <View {...responder.panHandlers} style={s.dragHandle}><Text style={s.dragText}>≡</Text></View>
      <Text numberOfLines={1} style={s.modelName}>{model}</Text>
      <Pressable accessibilityLabel={`删除模型 ${model}`} style={s.modelRemove} onPress={onRemove}><AppIcon name="delete" size={16} color={C.danger} /></Pressable>
    </View>
  );
}

function buildProviderPatch(state: ProviderEditorState, form: ProviderForm): {patch: Record<string, unknown>; error?: string} {
  const patch: Record<string, unknown> = {};
  const base = state.original ? formForProvider(state.original) : null;
  const fields: Array<keyof Pick<ProviderForm, 'name' | 'enabled' | 'url' | 'apiType' | 'models' | 'retryCount' | 'folderId'>> = ['name', 'enabled', 'url', 'apiType', 'models', 'retryCount', 'folderId'];
  const api: Record<string, string> = {name: 'name', enabled: 'enabled', url: 'url', apiType: 'apiType', models: 'models', retryCount: 'retryCount', folderId: 'folderId'};
  for (const field of fields) {
    if (!base || JSON.stringify(base[field]) !== JSON.stringify(form[field])) patch[api[field]] = form[field];
  }
  if (form.apiKeys.trim()) patch.apiKeys = form.apiKeys.trim();
  const set: Record<string, string> = {};
  const remove = [...form.removedHeaders];
  for (const row of form.headers) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) {
      if (row.originalName) remove.push(row.originalName);
      continue;
    }
    // Existing header values stay private on Desktop. An unchanged key with an
    // empty value means "preserve"; changing/adding a key requires a new value.
    if (row.originalName === name && !value) continue;
    if (!name || !value) return {patch, error: '自定义请求头需要同时填写名称和值。'};
    if (row.originalName && row.originalName !== name) remove.push(row.originalName);
    if (row.originalName !== name || value) set[name] = value;
  }
  if (Object.keys(set).length || remove.length) patch.headerOps = {set, remove: [...new Set(remove)]};
  return {patch};
}

const styles = StyleSheet.create({
  root: {flex: 1, minHeight: 0, backgroundColor: C.background},
  searchWrap: {height: 48, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 8, marginBottom: 10, borderWidth: 1, borderColor: C.line, borderRadius: 15, backgroundColor: C.surface, paddingHorizontal: 13},
  searchInput: {flex: 1, minWidth: 0, color: C.text, paddingVertical: 8},
  scroll: {flex: 1, minHeight: 0},
  list: {padding: 16, paddingTop: 2, gap: 10, paddingBottom: 14},
  groupCard: {borderWidth: 1, borderColor: C.line, borderRadius: 18, overflow: 'hidden', backgroundColor: C.surface},
  groupHeader: {minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 12, paddingRight: 8, backgroundColor: C.surface},
  groupTitlePress: {flex: 1, minWidth: 0, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8},
  groupName: {flex: 1, minWidth: 0, color: C.text, fontSize: 16, fontWeight: '600'},
  groupCount: {minWidth: 24, color: C.muted, fontSize: 14, fontWeight: '600', textAlign: 'right'},
  groupActions: {flexDirection: 'row', gap: 2},
  iconAction: {width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surfaceMuted},
  groupProviders: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, paddingVertical: 3},
  providerRow: {minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 11},
  providerCopy: {flex: 1, minWidth: 0, gap: 4},
  providerOrderControls: {flexDirection: 'row', overflow: 'hidden', borderWidth: 1, borderColor: C.line, borderRadius: 10, backgroundColor: C.surface},
  providerOrderButton: {width: 31, minHeight: 34, alignItems: 'center', justifyContent: 'center'},
  providerName: {color: C.text, fontSize: 15, fontWeight: '600'},
  providerMeta: {color: C.muted, fontSize: 12},
  emptyGroup: {color: C.muted, paddingHorizontal: 15, paddingVertical: 12, fontSize: 13},
  emptyCard: {padding: 22, borderRadius: 18, backgroundColor: C.surfaceMuted, gap: 5},
  emptyTitle: {fontSize: 17, color: C.text, fontWeight: '600'},
  emptyText: {fontSize: 13, color: C.muted, lineHeight: 20},
  error: {color: C.danger, paddingHorizontal: 16, paddingBottom: 5},
  bottomActions: {flexShrink: 0, flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.background},
  secondaryAction: {flex: 1, minHeight: 48, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: C.surfaceMuted},
  secondaryActionText: {color: C.text, fontSize: 14, fontWeight: '600'},
  primaryAction: {flex: 1.25, minHeight: 48, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: C.primary},
  primaryActionText: {color: '#FFFFFF', fontSize: 15, fontWeight: '600'},
  overlay: {flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay},
  sheet: {backgroundColor: C.background, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, gap: 13},
  sheetTitle: {fontSize: 17, color: C.text, fontWeight: '600'},
  sheetActions: {flexDirection: 'row', gap: 10},
  sheetSecondary: {flex: 1, minHeight: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surfaceMuted},
  sheetPrimary: {flex: 1, minHeight: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primary},
  secondaryText: {color: C.text, fontWeight: '600'},
  primaryText: {color: '#FFFFFF', fontSize: 15, fontWeight: '600'},
  disabled: {opacity: 0.45},
  input: {minHeight: 46, color: C.text, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 12},
  editorSafe: {flex: 1, backgroundColor: C.background},
  editorScreen: {flex: 1, minHeight: 0, backgroundColor: C.background},
  editorHeader: {height: 54, alignItems: 'center', justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  editorTitle: {fontSize: 17, color: C.text, fontWeight: '600'},
  editorScroll: {flex: 1, minHeight: 0},
  editorPage: {padding: 18, paddingBottom: 24, gap: 12},
  identityRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  nameInput: {flex: 1, minWidth: 0},
  fieldLabel: {color: C.text, fontSize: 14, fontWeight: '600', marginTop: 3},
  editorTwoColumn: {flexDirection: 'row', gap: 10},
  editorHalf: {flex: 1, minWidth: 0},
  selectRow: {minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  selectLabel: {flexShrink: 1, color: C.text, fontSize: 15, fontWeight: '600'},
  selectValueWrap: {flex: 1, minWidth: 0, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 3},
  selectValue: {flexShrink: 1, color: C.muted, fontSize: 13, textAlign: 'right'},
  modelActions: {flexDirection: 'row', gap: 10, marginTop: 3},
  modelAction: {flex: 1, minHeight: 45, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: C.surfaceMuted},
  modelActionText: {color: C.text, fontSize: 14, fontWeight: '600'},
  modelError: {color: C.danger, fontSize: 12, lineHeight: 18},
  modelBox: {height: 160, borderWidth: 1, borderColor: C.line, borderRadius: 16, backgroundColor: C.surface},
  modelList: {padding: 8, gap: 6},
  modelRow: {minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 11, paddingLeft: 5, backgroundColor: C.surfaceMuted},
  dragHandle: {width: 30, minHeight: 36, alignItems: 'center', justifyContent: 'center'},
  dragText: {color: C.muted, fontSize: 16, fontWeight: '600'},
  modelName: {flex: 1, minWidth: 0, color: C.text, fontSize: 13},
  modelRemove: {width: 34, minHeight: 36, alignItems: 'center', justifyContent: 'center'},
  emptyModels: {color: C.muted, fontSize: 13, textAlign: 'center', padding: 18, lineHeight: 20},
  retryRow: {minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line},
  retryControl: {flexDirection: 'row', alignItems: 'center', overflow: 'hidden', borderWidth: 1, borderColor: C.line, borderRadius: 12},
  retryButton: {width: 34, height: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surfaceMuted},
  retryText: {fontSize: 16, color: C.primary, fontWeight: '600'},
  retryValue: {width: 32, textAlign: 'center', color: C.text, fontWeight: '600'},
  headersHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2},
  headerHint: {maxWidth: 285, color: C.muted, fontSize: 12, lineHeight: 17},
  smallAdd: {width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surfaceMuted},
  headersBox: {gap: 7},
  headerRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  headerKey: {flex: 0.85, minWidth: 0},
  headerValue: {flex: 1.15, minWidth: 0},
  headerRemove: {width: 38, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surfaceMuted},
  emptyHeaders: {color: C.muted, fontSize: 13, paddingVertical: 8},
  deleteProvider: {alignItems: 'center', paddingVertical: 14},
  deleteProviderText: {color: C.danger, fontWeight: '600'},
  editorBottom: {flexShrink: 0, flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.background},
  bottomSecondary: {flex: 1, minHeight: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surfaceMuted},
  bottomPrimary: {flex: 1, minHeight: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primary},
  innerOverlay: {position: 'absolute', inset: 0, justifyContent: 'flex-end', backgroundColor: C.overlay},
  innerSheet: {maxHeight: '62%', backgroundColor: C.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, gap: 11},
  innerSheetLarge: {height: '74%', backgroundColor: C.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, gap: 11},
  innerSheetHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  choiceList: {gap: 7, paddingBottom: 8},
  choiceRow: {minHeight: 46, borderRadius: 14, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.surfaceMuted},
  choiceRowActive: {backgroundColor: C.primarySoft},
  choiceText: {flex: 1, color: C.text, fontSize: 14},
  choiceCheck: {color: C.primary, fontSize: 16, fontWeight: '600'},
  link: {color: C.primary, fontWeight: '600'},
});
