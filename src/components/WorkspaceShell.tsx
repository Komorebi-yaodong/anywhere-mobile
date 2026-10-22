import {TextInput, ActivityIndicator} from './ThemedNative';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackHandler,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,

  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { DesktopRuntime } from '../hooks/useDesktops';
import type {AvatarCache} from '../domain/pairing';
import { useConversationWorkspace } from '../hooks/useConversationWorkspace';
import { useAttachmentQueue } from '../hooks/useAttachmentQueue';
import type {
  AvatarResourceMetadata,
  ConversationSummary,
  OpenedConversationSession,
  RemoteMessage,
  RemoteAssistant,
  RemoteRequest,
  RemoteTrackedRequest,
  WorkspaceBootstrap,
  WorkspaceProject,
} from '../remote/api';
import type { RemoteEventMessage } from '../remote/client';
import {
  startCommand,
  type ConversationConfigResult,
} from '../remote/commands';
import { PhotoCapture } from './PhotoCapture';
import { useAudioRecording } from '../hooks/useAudioRecording';
import {
  GlobalSettings,
  settingsTitle,
  type SettingsSection,
} from './GlobalSettings';

import { AppIcon } from './AppIcon';
import {KeyboardDock} from './KeyboardDock';


import {ConversationMessageList, MessageLayoutInteractionContext, type ConversationMessageListHandle} from './ConversationMessageList';

import {ConversationMenu} from './ConversationMenu';

import {sortByName} from './nameSort';

import {mcpTransportSearchTerms} from './mcpPresentation';

import {ContextUsageBar} from './ContextUsageBar';

import {sessionSettingsPatch} from './sessionSettings';
import { useThemedStyles } from './theme';
import Clipboard from '@react-native-clipboard/clipboard';
import { SlidingDrawer } from './SlidingDrawer';
import { launchImageLibrary } from 'react-native-image-picker';
import { uploadAudioCapture } from '../services/mediaAttachment';
import {ConversationMarkdown, hasRenderableConversationContent} from './ConversationMarkdown';

import {extractedFileNotice, fileNotice, conversationFiles, editableConversationText, withoutConversationFiles} from './conversationFileNotice';
import {ConversationTaskSheet} from './ConversationTaskSheet';
import {cacheRemoteHttpsResource, cacheRemoteImage} from '../services/remoteImageCache';
import {
  ensureAvatarResource,
  isAvatarCacheValid,
  removeAvatarCache,
} from '../services/avatarResourceCache';
import {
  ConversationActions,
  type ConversationAction,
} from './ConversationActions';

const C = {
  background: '#FAF8F3',
  surface: '#FFFFFF',
  surfaceMuted: '#F2F0E9',
  text: '#292724',
  muted: '#79746C',
  line: '#E7E1D8',
  primary: '#C96849',
  primarySoft: '#F9E5DB',
  assistant: '#F1EFE8',
  success: '#478561',
  overlay: 'rgba(39, 36, 31, 0.34)',
  danger: '#B84E52',
  user: '#F7DFD6',
  icon: '#504B43',
};

function sameStringRecords(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every(key => left[key] === right[key]);
}

function sameAvatarCacheRecords(left: Record<string, AvatarCache>, right: Record<string, AvatarCache>): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every(key =>
    left[key]?.uri === right[key]?.uri &&
    left[key]?.version === right[key]?.version &&
    left[key]?.expiresAt === right[key]?.expiresAt,
  );
}

type Props = {
  desktop: DesktopRuntime;
  request: RemoteRequest;
  requestTracked: RemoteTrackedRequest;
  subscribeEvents: (
    listener: (desktopId: string, event: RemoteEventMessage) => void,
  ) => () => void;
  updateProfile?: (
    desktopId: string,
    profile: Pick<DesktopRuntime, 'profileName' | 'avatarCache'>,
  ) => Promise<void>;
  onHome: () => void;
  onReconnect?: () => Promise<void>;
  visible?: boolean;
};

type ViewMode = 'router' | 'chat' | 'settings';


function workspaceNotice(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : String(error || '');
  const messages: Record<string, string> = {
    remote_client_closed: '连接被重置，正在恢复。',
    remote_transport_closed: '连接已关闭，正在恢复。',
    remote_transport_error: '安全连接暂时不可用，正在重连。',

    remote_response_too_large: 'Desktop 返回的数据过大，当前请求未完成；连接仍保留。',
    remote_response_invalid: 'Desktop 返回的数据格式异常，当前请求未完成；连接仍保留。',
    remote_conversation_busy: '此操作需要会话空闲，请等待本轮结束后再操作；普通配置可在生成中保存。',
    remote_mobile_takeover_timeout: 'Desktop 尚未确认接管，控制权未变更；请稍后重试。',
    remote_mobile_takeover_failed: 'Desktop 未完成接管，控制权未变更；请刷新后重试。',
    remote_desktop_takeover_in_progress: 'Desktop 正在接管该会话，Mobile 即将切为只读。',
    remote_conversation_takeover_required: '该会话已由 Desktop 控制，Mobile 当前只读；请先接管后再修改。',
    remote_context_resolve_failed: '未能获取当前模型的上下文长度，已保留原值；可以手动填写。',
    remote_context_model_missing: '当前会话未选择模型，已保留原值；请先选择模型。',
    remote_context_model_not_found: '检索服务尚未收录当前模型，已保留原值；可手动填写。',
    remote_context_service_auth_failed: 'Desktop 上下文检索服务认证失败，已保留原值；请检查 Desktop 服务配置。',
    remote_context_service_unavailable: '上下文检索服务暂不可用，已保留原值；请稍后重试。',
    remote_context_response_invalid: '上下文检索服务返回无效长度，已保留原值。',
    remote_context_lookup_timeout: 'Desktop 检索上下文长度超时，已保留原值。',
    remote_context_network_unavailable: 'Desktop 无法连接上下文检索服务，已保留原值；请检查 Desktop 网络或代理。',
    remote_model_changed: '检索期间模型已切换，请在当前模型下重新获取。',
    remote_context_resolve_unavailable: '当前 Desktop 尚不支持上下文检索，请更新并重启 Desktop。',
    remote_all_paired_endpoints_unreachable: '已配对的连接地址暂不可用，请确认 Desktop 远程服务仍在运行。',
  };
  return messages[code] || (error instanceof Error ? error.message : fallback);
}

export type SessionMcpQuickFilter = 'all' | 'selected' | 'preset';

export function filterSessionMcpServers(
  servers: ConversationConfigResult['options']['mcpServers'],
  selectedIds: string[],
  {
    query = '',
    quickFilter = 'all',
  }: {
    query?: string;
    quickFilter?: SessionMcpQuickFilter;
  } = {},
) {
  const selected = new Set(selectedIds);
  const keyword = query.trim().toLocaleLowerCase('zh-CN');
  return sortByName(servers).filter(item => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    if (quickFilter === 'selected' && !selected.has(item.id)) return false;
    if (quickFilter === 'preset' && !item.preset) return false;
    if (!keyword) return true;
    return [item.name, item.id, ...tags, ...mcpTransportSearchTerms(item.transport || (/builtin/i.test([item.id, item.name, ...tags].join(' ')) ? 'builtin' : ''))]
      .join(' ')
      .toLocaleLowerCase('zh-CN')
      .includes(keyword);
  });
}

export function keyboardFrameNeedsComposerScroll(previousTop: number | null, screenY: number, height: number): boolean {
  return Number.isFinite(screenY) && Number.isFinite(height) && height > 0 &&
    (previousTop == null || screenY < previousTop);
}



export {isPinnedToBottom} from './conversationScroll';

export function adjacentMessageIndex(current: number, length: number, direction: -1 | 1): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(length - 1, current + direction));
}

export function filterSessionSkills(
  skills: ConversationConfigResult['options']['skills'],
  query = '',
) {
  const keyword = query.trim().toLocaleLowerCase('zh-CN');
  return sortByName(skills).filter(item =>
    !keyword || item.name.toLocaleLowerCase('zh-CN').includes(keyword),
  );
}



export function WorkspaceShell({
  desktop,
  request,
  requestTracked,
  subscribeEvents,
  updateProfile,
  onHome,
  onReconnect,
  visible = true,
}: Props) {
  const styles = useThemedStyles(baseStyles);
  const workspace = useConversationWorkspace({
    desktopId: desktop.id,
    desktopStatus: desktop.status,
    request,
    requestTracked,
    subscribeEvents,
  });
  const attachments = useAttachmentQueue(desktop.id, request);
  const releaseWorkspaceConversation = workspace.releaseSelectedConversation;
  const releaseSelectedConversation = useCallback(
    () => releaseWorkspaceConversation?.(),
    [releaseWorkspaceConversation],
  );
  const [mode, setMode] = useState<ViewMode>('router');
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (drawerOpen) setDrawerOpen(false);
      else if (mode !== 'router') {
        releaseSelectedConversation();
        setMode('router');
      } else {
        releaseSelectedConversation();
        onHome();
      }
      return true;
    });
    return () => sub.remove();
  }, [drawerOpen, mode, onHome, releaseSelectedConversation, visible]);
  const [bootstrap, setBootstrap] = useState<WorkspaceBootstrap | null>(null);
  const [routeAssistants, setRouteAssistants] = useState<RemoteAssistant[]>([]);

  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [notice, setNotice] = useState('');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('agents');
  const [settingsRefreshSignal, setSettingsRefreshSignal] = useState(0);

  const [draft, setDraft] = useState('');
  const [assistantAvatar, setAssistantAvatar] = useState('');
  const [agentAvatarResources, setAgentAvatarResources] = useState<Record<string, AvatarResourceMetadata>>({});
  const [agentAvatarCaches, setAgentAvatarCaches] = useState<Record<string, AvatarCache>>({});
  const [agentAvatarSources, setAgentAvatarSources] = useState<Record<string, string>>({});

  const currentConversation = useRef(workspace.selectedConversationId);
  currentConversation.current = workspace.selectedConversationId;

  const [audioProgress, setAudioProgress] = useState('');

  const audio = useAudioRecording(async capture => {
    const conversationId = workspace.selectedConversationId;
    if (!conversationId || !workspace.canControlConversation(conversationId)) {
      const { MediaCapture } = await import('../native/MediaCapture');
      await MediaCapture.deleteCapture(capture.captureId);
      return;
    }
    setAudioProgress('正在准备录音上传…');
    let upload;
    try {
      upload = await uploadAudioCapture({desktopId: desktop.id, request, capture,
        onProgress: progress => setAudioProgress(progress.stage === 'hashing' ? '正在准备录音上传…' : `录音上传中 ${Math.min(100, Math.round(progress.bytes / Math.max(1, progress.total) * 100))}%`),
      });
    } catch (cause) {setAudioProgress(''); throw cause;}
    setAudioProgress('录音已上传，正在发送…');
    try {
      if (currentConversation.current !== conversationId) {
        attachments.addCapturedUpload(upload);
        setNotice('会话已切换，录音已保留为待发附件。');
        return;
      }
      await workspace.sendMessage('', [upload.uploadId]);
    } catch (error) {
      attachments.addCapturedUpload(upload);
      throw error;
    } finally {setAudioProgress('');}
  }, setNotice);
  const { recording, cancel: cancelAudio } = audio;

  useEffect(() => {
    if (!visible) {
      releaseSelectedConversation();
      cancelAudio();
      setDrawerOpen(false);
      setSheet(null);
      setShowCamera(false);
    }
  }, [visible, cancelAudio, releaseSelectedConversation]);

  const [sheet, setSheet] = useState<
    'session' | 'model' | 'reasoning' | 'voice' | 'tasks' | 'opened' | 'composer' | 'project' | 'management' | 'attachment' | null
  >(null);
  const [showCamera, setShowCamera] = useState(false);
  const [conversationMenu, setConversationMenu] = useState<ConversationSummary | null>(null);

  const [messageAction, setMessageAction] = useState<ConversationAction | null>(
    null,
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingProject, setEditingProject] = useState<WorkspaceProject | null>(null);
  const [projectName, setProjectName] = useState('');

  const [sessionConfig, setSessionConfig] = useState<any>(null);
  const [sessionOptions, setSessionOptions] = useState<
    ConversationConfigResult['options'] | null
  >(null);
  const sessionScope = useRef('');
  const sessionBaseline = useRef<ConversationConfigResult['config'] | null>(null);
  const sessionOperation = useRef(false);
  const [sessionNotice, setSessionNotice] = useState('');
  const [sessionTab, setSessionTab] = useState<
    'prompt' | 'mcp' | 'skill' | 'compact'
  >('prompt');
  const [sessionBusy, setSessionBusy] = useState(false);
  const [configExecutionBusy, setConfigExecutionBusy] = useState(false);
  const [sessionReadError, setSessionReadError] = useState('');

  const [contextUsage, setContextUsage] = useState<ConversationConfigResult['contextUsage']>(null);
  const [contextLengthDraft, setContextLengthDraft] = useState('');
  const [contextLengthEdited, setContextLengthEdited] = useState(false);
  const [triggerRatioDraft, setTriggerRatioDraft] = useState('');
  const [mcpQuery, setMcpQuery] = useState('');
  const [skillQuery, setSkillQuery] = useState('');
  const [mcpQuickFilter, setMcpQuickFilter] = useState<'all' | 'selected' | 'preset'>('all');

  const refreshWorkspace = useCallback(async () => {
    if (desktop.status !== '在线') return;
    setLoadingWorkspace(true);
    try {
      const [value, routes, assistantMetadata] = await Promise.all([
        request<WorkspaceBootstrap>(desktop.id, 'workspace.bootstrap.get'),
        request<{ok: true; assistants: RemoteAssistant[]}>(desktop.id, 'conversation.assistants.list'),
        request<{ok: true; assistants: WorkspaceBootstrap['assistants']}>(desktop.id, 'workspace.assistants.list'),
      ]);
      const cachedAvatar = desktop.avatarCache;
      let nextAvatarCache: AvatarCache | undefined;
      if (value.profile.avatar) {
        try {
          nextAvatarCache = await ensureAvatarResource({
            desktopId: desktop.id,
            resource: value.profile.avatar,
            request,
            previous: cachedAvatar,
            displayName: value.profile.displayName,
          });
        } catch {
          // A standalone avatar cache miss must never prevent workspace use.
          nextAvatarCache = undefined;
        }
      } else if (/^https:\/\//i.test(value.profile.avatarUrl || '')) {
        try {
          nextAvatarCache = await cacheRemoteHttpsResource({
            url: value.profile.avatarUrl,
            namespace: 'avatar',
            maxBytes: 512 * 1024,
          });
        } catch {
          nextAvatarCache = cachedAvatar;
        }
      } else if (cachedAvatar) {
        await removeAvatarCache(cachedAvatar);
      }
      if (
        updateProfile &&
        (value.profile.displayName !== desktop.profileName ||
          nextAvatarCache?.version !== cachedAvatar?.version ||
          nextAvatarCache?.uri !== cachedAvatar?.uri)
      ) {
        await updateProfile(desktop.id, {
          profileName: value.profile.displayName,
          avatarCache: nextAvatarCache,
        });
      }

      const workspaceByCode = new Map(value.assistants.map(item => [item.code, item]));
      const mergedRoutes = (routes.assistants || []).map(item => {
        const workspaceAssistant = workspaceByCode.get(item.code);
        return {
          ...item,
          icon: item.icon || workspaceAssistant?.icon || '',
          avatar: item.avatar || workspaceAssistant?.avatar || null,
        };
      });
      const resources: Record<string, AvatarResourceMetadata> = {};
      for (const item of assistantMetadata.assistants) {
        if (item.avatar?.kind === 'agent' && item.avatar.code === item.code) resources[item.code] = item.avatar;
      }
      for (const item of value.assistants) {
        if (item.avatar?.kind === 'agent' && item.avatar.code === item.code) resources[item.code] = item.avatar;
      }
      for (const item of mergedRoutes) {
        if (item.avatar?.kind === 'agent' && item.avatar.code === item.code) resources[item.code] = item.avatar;
      }
      const resolved = await Promise.all(mergedRoutes.map(async item => {
        const resource = resources[item.code];
        if (!resource) {
          const source = await cacheRemoteImage(item.icon || '');
          return {code: item.code, cache: undefined, source};
        }
        try {
          const cache = await ensureAvatarResource({
            desktopId: desktop.id,
            resource,
            request,
            previous: agentAvatarCaches[item.code],
            displayName: item.name,
          });
          return {code: item.code, cache, source: cache?.uri || item.icon || ''};
        } catch {
          return {code: item.code, cache: undefined, source: item.icon || ''};
        }
      }));
      // Preserve verified caches for historical/non-router Agents. A message
      // header may lazily resolve one of these after the initial route list has
      // loaded; refreshing the route must not discard it and trigger a state
      // oscillation or a redundant validation request.
      const nextAgentCaches: Record<string, AvatarCache> = Object.fromEntries(
        Object.entries(agentAvatarCaches).filter(([code, cache]) =>
          resources[code]?.version === cache.version,
        ),
      );
      const nextAgentSources: Record<string, string> = Object.fromEntries(
        Object.entries(agentAvatarSources).filter(([code]) => Boolean(nextAgentCaches[code])),
      );
      for (const item of resolved) {
        if (item.cache) nextAgentCaches[item.code] = item.cache;
        if (item.source) nextAgentSources[item.code] = item.source;
      }
      setAgentAvatarResources(resources);
      setAgentAvatarCaches(current => sameAvatarCacheRecords(current, nextAgentCaches) ? current : nextAgentCaches);
      setAgentAvatarSources(current => sameStringRecords(current, nextAgentSources) ? current : nextAgentSources);
      setBootstrap(value);
      setRouteAssistants(mergedRoutes);
      setNotice('');
    } catch (error) {
      setNotice(workspaceNotice(error, '无法读取 Desktop 工作区。'));
    } finally {
      setLoadingWorkspace(false);
    }
  }, [
    agentAvatarCaches,
    agentAvatarSources,
    desktop.avatarCache,
    desktop.id,
    desktop.profileName,
    desktop.status,
    request,
    updateProfile,
  ]);

  useEffect(() => {
    refreshWorkspace().catch(() => undefined);
  }, [refreshWorkspace]);


  const conversationsByProject = useMemo(() => {
    const groups = new Map<string, ConversationSummary[]>();
    for (const item of workspace.catalog) {
      const key = item.project?.projectId || '__ungrouped__';
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return groups;
  }, [workspace.catalog]);

  const openAssistant = async (assistant: RemoteAssistant) => {
    audio.cancel();
    try {
      await workspace.createConversation(assistant.code);
      refreshWorkspace().catch(() => undefined);
      setMode('chat');
      setDrawerOpen(false);
    } catch (error) {
      Alert.alert(
        '无法新建会话',
        error instanceof Error ? error.message : '请稍后重试。',
      );
    }
  };

  const selectConversation = (id: string) => {
    audio.cancel();
    workspace.selectConversation(id);
    setMode('chat');
    setDrawerOpen(false);
  };

  const createProject = async () => {
    const name = projectName.trim();
    if (!name || creatingProject) return;
    setCreatingProject(true);
    try {
      await request(desktop.id, 'workspace.project.create', { name }, 60_000);
      setProjectName('');
      setSheet(null);
      await refreshWorkspace();
      await workspace.refreshCatalog();
    } catch (error) {
      Alert.alert(
        '无法新建目录',
        error instanceof Error ? error.message : '请稍后重试。',
      );
    } finally {
      setCreatingProject(false);
    }
  };

  const beginProjectRename = (project: WorkspaceProject) => {
    setEditingProject(project);
    setProjectName(project.name);
    setSheet('project');
  };

  const saveProjectRename = async () => {
    const project = editingProject;
    const name = projectName.trim();
    if (!project || !name || creatingProject) return;
    setCreatingProject(true);
    try {
      await request(desktop.id, 'workspace.project.update', {
        projectId: project.projectId,
        name,
      }, 60_000);
      setProjectName('');
      setEditingProject(null);
      setSheet(null);
      await refreshWorkspace();
      await workspace.refreshCatalog();
    } catch (error) {
      Alert.alert('无法修改项目', error instanceof Error ? error.message : '请稍后重试。');
    } finally {
      setCreatingProject(false);
    }
  };

  const removeProject = (project: WorkspaceProject) => {
    Alert.alert(
      `删除“${project.name}”？`,
      '项目下的会话不会删除，会转为未分组。',
      [
        {text: '取消', style: 'cancel'},
        {
          text: '删除项目',
          onPress: () =>
            request(desktop.id, 'workspace.project.remove', {
              projectId: project.projectId,
              confirmed: true,
            }, 60_000)
              .then(async () => {
                await refreshWorkspace();
                await workspace.refreshCatalog();
              })
              .catch(error =>
                Alert.alert('无法删除项目', error instanceof Error ? error.message : '请稍后重试。'),
              ),
        },
      ],
    );
  };


  const leaveConversation = () => {
    releaseSelectedConversation();
  };

  const openManagement = () => {
    leaveConversation();
    setMode('settings');
    setDrawerOpen(false);
  };

  const connected = desktop.status === '在线';
  const controlledByMobile = workspace.canControlConversation(workspace.selectedConversationId);
  const selectedOpenedSession = workspace.openedSessions.find(item => item.conversationId === workspace.selectedConversationId);
  const selectedTurn = workspace.activeTurn?.conversationId === workspace.selectedConversationId ? workspace.activeTurn : null;
  const executionBusy = workspace.authoritativeRuntime
    ? workspace.authoritativeRuntime.execution.state !== 'idle'
    : Boolean((selectedTurn && !selectedTurn.terminal) || configExecutionBusy || (!selectedTurn?.terminal && selectedOpenedSession?.busy));
  const canEditSession = connected && controlledByMobile && !sessionBusy;
  useEffect(() => {
    setConfigExecutionBusy(selectedOpenedSession?.busy === true);
    if (workspace.activeTurn?.conversationId === workspace.selectedConversationId && workspace.activeTurn.terminal) {
      setConfigExecutionBusy(false);
    }
  }, [selectedOpenedSession, workspace.activeTurn, workspace.selectedConversationId]);
  const requireControl = () => {
    if (!connected) { setNotice('正在连接，请稍候'); return false; }
    if (controlledByMobile) return true;
    setNotice('该会话正在由 Desktop 控制，请先点击“接管会话”。');
    return false;
  };

  const openSessionSettings = async (
    target: 'session' | 'model' | 'reasoning' | 'voice' = 'session',
  ) => {
    if (!workspace.selectedConversationId || !connected) return;
    const requestedConversation = workspace.selectedConversationId;
    if (sessionOperation.current) return;
    sessionScope.current = requestedConversation;
    sessionBaseline.current = null;
    setSessionNotice('');
    setSessionReadError('');
    setContextUsage(null);

    setContextLengthEdited(false);
    setSessionConfig(null);
    setSessionOptions(null);
    setMcpQuery('');
    setSkillQuery('');
    setMcpQuickFilter('all');
    if (target === 'session') setSessionTab('prompt');
    setSheet(target);
    setSessionBusy(true);
    try {
      const receipt = startCommand({
        desktopId: desktop.id,
        method: 'conversation.config.get',
        params: { conversationId: workspace.selectedConversationId },
        request,
        requestTracked,
        timeoutMs: 60_000,
      });
      const state = await receipt.completion;
      const result = state.result as ConversationConfigResult | undefined;
      if (result?.config) {
        if (sessionScope.current !== requestedConversation) return;
        sessionBaseline.current = result.config;
        setSessionConfig(result.config);
        setSessionOptions(result.options);

        setContextUsage(result.contextUsage || null);
        setConfigExecutionBusy(result.busy === true);
        setContextLengthDraft(String(result.config.compact?.contextLength || ''));
        setTriggerRatioDraft(String(result.config.compact?.triggerRatio ?? 0.9));
      }
    } catch (error) {
      setSessionReadError(workspaceNotice(error, '无法读取会话设置，请稍后重试。'));
    } finally {
      setSessionBusy(false);
    }
  };

  const compactNow = async () => {
    if (!requireControl() || !canEditSession || executionBusy || !workspace.selectedConversationId) return;
    setSessionBusy(true);
    try {
      const receipt = startCommand({
        desktopId: desktop.id,
        method: 'conversation.compact',
        params: { conversationId: workspace.selectedConversationId },
        request,
        requestTracked,
        timeoutMs: 120000,
      });
      await receipt.completion;
      setSheet(null);
      await workspace.refreshMessages();
    } catch {
      setNotice('压缩未完成，请刷新状态后重试。');
    } finally {
      setSessionBusy(false);
    }
  };

  const saveSessionPatch = async (patch: Record<string, unknown>, closeAfterSave = true) => {
    if (!requireControl() || !canEditSession ||
      !workspace.selectedConversationId ||
      sessionScope.current !== workspace.selectedConversationId ||
      !sessionConfig ||
      sessionBusy || sessionOperation.current
    ) return;
    const conversationId = workspace.selectedConversationId;
    sessionOperation.current = true;
    setSessionNotice('');
    setSessionBusy(true);
    try {
      const receipt = startCommand({
        desktopId: desktop.id,
        method: 'conversation.config.patch',
        params: {conversationId: workspace.selectedConversationId, patch},
        request,
        requestTracked,
        timeoutMs: 60_000,
      });
      const state = await receipt.completion;
      if (sessionScope.current !== conversationId) return;
      const result = state.result as ConversationConfigResult | undefined;
      if (!result?.config) throw new Error('Desktop 未返回保存后的会话设置，请刷新检查。');
      sessionBaseline.current = result.config;
      setSessionConfig(result.config);
      setSessionOptions(result.options);
      setContextUsage(result.contextUsage || null);
      setContextLengthEdited(false);
      if (result.deferred) setNotice('已保存，下轮生效');
      if (closeAfterSave) setSheet(null);
    } catch (error) {
      setSessionNotice(workspaceNotice(error, '保存会话设置失败。'));
    } finally {
      sessionOperation.current = false;
      setSessionBusy(false);
    }
  };

  const saveSessionSettings = async () => {
    if (!sessionConfig || !sessionBaseline.current || !canEditSession || sessionOperation.current) return;
    try {
      const patch = sessionSettingsPatch(sessionConfig, sessionBaseline.current, {contextLengthDraft, contextLengthEdited, triggerRatioDraft});
      if (!Object.keys(patch).length) { setSheet(null); return; }
      await saveSessionPatch(patch);
    } catch (error) {
      setSessionNotice(workspaceNotice(error, '保存会话设置失败。'));
    }
  };

  const refreshContextLength = async () => {
    if (!canEditSession || executionBusy || !sessionConfig || !requireControl() || sessionOperation.current) return;
    const conversationId = workspace.selectedConversationId;
    sessionOperation.current = true;
    setSessionNotice('');
    setSessionBusy(true);
    try {
      const receipt = startCommand({
        desktopId: desktop.id, method: 'conversation.context.refresh',
        params: {conversationId}, request, requestTracked, timeoutMs: 60_000,
      });
      const state = await receipt.completion;
      if (sessionScope.current !== conversationId) return;
      const result = state.result as ConversationConfigResult;
      const compact = result?.config?.compact;
      if (!compact || compact.contextLengthSource !== 'api' || !Number.isInteger(compact.contextLength) || compact.contextLength < 4096 || compact.contextLength > 10_000_000) {
        throw new Error('Desktop 未返回有效的 API 上下文长度，已保留原值。');
      }
      if (sessionBaseline.current) sessionBaseline.current = {...sessionBaseline.current, compact: {...sessionBaseline.current.compact, contextLength: compact.contextLength, contextLengthSource: 'api', contextLengthManual: false}};
      setSessionConfig((current: any) => current ? {...current, compact: {...current.compact, contextLength: compact.contextLength, contextLengthSource: 'api', contextLengthManual: false}} : current);
      setContextLengthDraft(String(compact.contextLength));
      setContextLengthEdited(false);
      setSessionNotice('上下文长度已更新');
    } catch (error) {
      setSessionNotice(workspaceNotice(error, '上下文检索失败，已保留原值。'));
    } finally { sessionOperation.current = false; setSessionBusy(false); }
  };


  const pickPhoto = async () => {
    if (!requireControl()) return;
    setSheet(null);
    try {
      const result = await launchImageLibrary({
        mediaType: 'photo',
        selectionLimit: 1,
        includeBase64: false,
      });
      const asset = result.assets?.[0];
      if (!asset?.uri) return;
      const { pickPhotoUpload } = await import('../services/mediaAttachment');
      const upload = await pickPhotoUpload({
        desktopId: desktop.id,
        request,
        uri: asset.uri,
        name: asset.fileName || '照片.jpg',
        type: asset.type || 'image/jpeg',
      });
      attachments.addCapturedUpload(upload);
    } catch {
      setNotice('照片选择或上传失败。');
    }
  };

  const uploadCapturedPhoto = async (path: string) => {
    if (!requireControl()) {
      setShowCamera(false);
      return;
    }
    setShowCamera(false);
    try {
      const { uploadCapturedPhoto: uploadPhoto } = await import(
        '../services/mediaAttachment'
      );
      const upload = await uploadPhoto({
        desktopId: desktop.id,
        request,
        path,
        onProgress: value =>
          setNotice(
            `${
              value.stage === 'hashing' ? '校验照片' : '上传照片'
            } ${Math.round((value.bytes / value.total) * 100)}%`,
          ),
      });
      attachments.addCapturedUpload(upload);
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '照片上传失败。');
    }
  };

  const send = async () => {
    if (!requireControl()) return;
    const text = draft.trim();
    if (
      (!text && attachments.uploads.length === 0) ||
      !workspace.selectedConversationId
    )
      return;
    setDraft('');
    try {
      await workspace.sendMessage(
        text,
        attachments.uploads.map(item => item.uploadId),
      );
      attachments.markSubmitted();
    } catch (error) {
      setDraft(text);
      setNotice(error instanceof Error ? error.message : '发送失败。');
    }
  };

  const takeoverSelectedConversation = async () => {
    if (!workspace.selectedConversationId || !connected) return;
    // Cached progress may outlive a Desktop request/window. The Desktop writer
    // remains responsible for rejecting takeover while real work is running.
    try {
      await workspace.takeoverConversation(workspace.selectedConversationId);
      setConfigExecutionBusy(false);
      setNotice('');
    } catch (error) {
      setNotice(workspaceNotice(error, '暂时无法接管会话。'));
    }
  };
  const handoffSelectedConversation = async () => {
    if (!workspace.selectedConversationId || !connected) return;
    if (executionBusy) { setNotice('本轮仍在生成或执行工具，结束后可交还；也可以先停止生成。'); return; }
    if (recording || attachments.busy) {
      setNotice('请先完成或取消录音、附件上传，再交还 Desktop。');
      return;
    }
    try {
      await workspace.handoffConversation(workspace.selectedConversationId);
      setNotice('');
    } catch (error) {
      setNotice(workspaceNotice(error, '当前会话仍在执行，暂时无法交还。'));
    }
  };

  const closeOpenedSession = (item: OpenedConversationSession) => {
    if (!connected) return;
    const title = item.title || '未命名会话';
    Alert.alert(
      `关闭“${title}”？`,
      item.busy
        ? '将停止当前生成，保存已完成内容后关闭 Desktop 会话窗口。聊天历史、附件和设置都会保留。'
        : '将关闭 Desktop 会话窗口。聊天历史、附件和设置都会保留。',
      [
        {text: '取消', style: 'cancel'},
        {
          text: '关闭会话',
          style: 'destructive',
          onPress: () => {
            workspace.closeConversation(item.conversationId)
              .then(() => {
                if (workspace.selectedConversationId === item.conversationId) setMode('router');
                setSheet(null);
                setNotice(`已关闭“${title}”的 Desktop 会话窗口，历史已保留。`);
              })
              .catch(error => setNotice(workspaceNotice(error, '会话未关闭；请稍后重试。')));
          },
        },
      ],
    );
  };



  const takeoverOpenedSession = async (item: OpenedConversationSession) => {
    if (!connected) return;
    try {
      await workspace.takeoverConversation(item.conversationId);
      setNotice(`已接管“${item.title || '未命名会话'}”，Desktop 将实时观察更新。`);
    } catch (error) {
      setNotice(workspaceNotice(error, '暂时无法接管会话。'));
    }
  };
  const handoffOpenedSession = async (item: OpenedConversationSession) => {
    if (!connected) return;
    try {
      await workspace.handoffConversation(item.conversationId);
      setNotice(`已将“${item.title || '未命名会话'}”交还 Desktop。`);
    } catch (error) {
      setNotice(workspaceNotice(error, '当前会话仍在执行，暂时无法交还。'));
    }
  };

  const enterOpenedSession = (item: OpenedConversationSession) => {
    audio.cancel();
    workspace.selectConversation(
      item.conversationId,
      item.title || '未命名会话',
    );
    setMode('chat');
    setDrawerOpen(false);
    setSheet(null);
  };


  const activeTurn =
    workspace.activeTurn?.conversationId === workspace.selectedConversationId
      ? workspace.activeTurn
      : null;
  const activeAssistantIdentity = workspace.conversationAssistant || {code: '', name: '', avatarUrl: ''};
  useEffect(() => {
    let active = true;
    const code = activeAssistantIdentity.code;
    const resource = code ? agentAvatarResources[code] : undefined;
    const fallbackUrl = activeAssistantIdentity.avatarUrl;
    if (resource) {
      ensureAvatarResource({
        desktopId: desktop.id,
        resource,
        request,
        previous: agentAvatarCaches[code],
        displayName: activeAssistantIdentity.name,
      }).then(cache => {
        if (!active) return;
        const source = cache?.uri || fallbackUrl || '';
        setAssistantAvatar(source);
        if (cache) {
          setAgentAvatarCaches(current => current[code]?.version === cache.version && current[code]?.uri === cache.uri ? current : {...current, [code]: cache});
          setAgentAvatarSources(current => current[code] === source ? current : {...current, [code]: source});
        }
      }).catch(() => { if (active) setAssistantAvatar(fallbackUrl || ''); });
      return () => { active = false; };
    }
    if (!fallbackUrl) {
      setAssistantAvatar('');
      return () => { active = false; };
    }
    cacheRemoteImage(fallbackUrl).then(value => { if (active) setAssistantAvatar(value); }).catch(() => { if (active) setAssistantAvatar(''); });
    return () => { active = false; };
  }, [
    activeAssistantIdentity.avatarUrl,
    activeAssistantIdentity.code,
    activeAssistantIdentity.name,
    agentAvatarCaches,
    agentAvatarResources,
    desktop.id,
    request,
  ]);


  const visibleSessionMcpServers = useMemo(
    () => filterSessionMcpServers(
      sessionOptions?.mcpServers || [],
      sessionConfig?.mcpServerIds || [],
      {query: mcpQuery, quickFilter: mcpQuickFilter},
    ),
    [mcpQuery, mcpQuickFilter, sessionConfig?.mcpServerIds, sessionOptions?.mcpServers],
  );


  const visibleSessionSkills = useMemo(
    () => filterSessionSkills(sessionOptions?.skills || [], skillQuery),
    [sessionOptions?.skills, skillQuery],
  );



  const conversationTasks = Array.isArray(workspace.tasks) ? workspace.tasks : [];


  const selectedTitle = workspace.selectedConversation?.title || '新聊天';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topbar}>
        <IconButton icon="⌂" label="Home" onPress={() => { leaveConversation(); onHome(); }} />
        <IconButton
          icon="☰"
          label="打开侧边栏"
          onPress={() => setDrawerOpen(true)}
        />
        <Pressable
          style={styles.titlePress}
          onPress={() => {
            if (mode !== 'chat') return;
            if (!requireControl()) return;
            setMessageAction({
              method: 'conversation.rename',
              title: selectedTitle,
            });
          }}
        >
          <Text numberOfLines={1} style={styles.title}>
            {mode === 'chat'
              ? selectedTitle
              : mode === 'settings'
              ? settingsTitle(settingsSection)
              : desktop.name}
          </Text>
          {mode !== 'settings' && mode !== 'chat' ? <Text numberOfLines={1} style={styles.subtitle}>{desktop.status === '在线' ? '已连接' : desktop.status}</Text> : null}
        </Pressable>
        <IconButton
          icon="↻"
          label="刷新"
          onPress={() => {
            if (!connected) {
              onReconnect?.().catch(error => setNotice(workspaceNotice(error, '重连失败，请稍后重试。')));
              return;
            }
            if (mode === 'chat') workspace.refreshMessages();
            else if (mode === 'settings') setSettingsRefreshSignal(current => current + 1);
            else refreshWorkspace();
          }}
        />
        {mode === 'chat' ? (
          <>
            <IconButton
              icon="⚙"
              label="会话设置"
              onPress={() => openSessionSettings('session')}
            />
            <View style={styles.taskTopAction}>
              <IconButton
                icon="tasks"
                label="当前会话任务"
                onPress={() => setSheet('tasks')}
              />
              {conversationTasks.length ? <View style={styles.taskBadge}><Text style={styles.taskBadgeText}>{conversationTasks.length > 9 ? '9+' : conversationTasks.length}</Text></View> : null}
            </View>
          </>
        ) : null}
      </View>

      {workspace.error || attachments.error || audioProgress || (audio.processing ? '正在处理录音，请稍候…' : '') || attachments.progress ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            {audioProgress || (audio.processing ? '正在处理录音，请稍候…' : '') || workspace.error || attachments.error || attachments.progress}
          </Text>
        </View>
      ) : null}

      {notice ? (
        <Pressable style={styles.notice} onPress={() => setNotice('')}>
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      ) : null}
      {!connected ? <View accessibilityLabel="连接恢复状态" style={styles.connectionBanner}><Text style={styles.connectionBannerText}>{desktop.detail || '正在连接…'}</Text></View> : null}
      <View style={styles.retainedWorkspace} pointerEvents={!connected && mode !== 'chat' ? 'none' : 'auto'}>
      {!connected && !bootstrap && mode !== 'chat' && mode !== 'settings' ? (
        <Empty
          title="正在连接 Desktop"
          text={desktop.detail || '请确认远程服务仍在运行。'}
        />
      ) : !workspace.configured ? (
        <Empty
          title="Desktop 尚未配置会话目录"
          text="请先在 Desktop 完成会话保存位置配置。"
        />
      ) : mode === 'router' ? (
        <AssistantRouter
          assistants={routeAssistants}
          avatarSources={agentAvatarSources}
          loading={loadingWorkspace}
          onSelect={openAssistant}
          onRefresh={refreshWorkspace}
        />
      ) : mode === 'settings' ? (
        <GlobalSettings
          desktopId={desktop.id}
          request={request}
          onChanged={refreshWorkspace}
          onSectionChange={setSettingsSection}
          refreshSignal={settingsRefreshSignal}
        />
      ) : (
        <ChatPage
          key={workspace.selectedConversationId}
          title={selectedTitle}
          desktopId={desktop.id}
          conversationId={workspace.selectedConversationId}
          request={request}
          userName={bootstrap?.profile.displayName || desktop.profileName || '你'}
          userAvatar={desktop.avatarCache && isAvatarCacheValid(desktop.avatarCache) ? desktop.avatarCache.uri : bootstrap?.profile.avatarUrl}
          assistantName={activeAssistantIdentity.name}
          assistantAvatar={assistantAvatar}
          model={workspace.conversationModel}
          messages={workspace.messages}
          activeTurn={activeTurn}
          onRefresh={workspace.refreshMessages}
          onModelSettings={() => openSessionSettings('model')}
          onReasoningSettings={() => openSessionSettings('reasoning')}
          onVoiceSettings={() => openSessionSettings('voice')}
          onOlder={workspace.loadOlderMessages}
          hasOlder={workspace.messagePage?.hasMore === true}
          onReask={async id => { if (!requireControl()) return; await workspace.reaskLastAssistant(id); }}
          onResendUser={async id => { if (!requireControl()) return; await workspace.resendLastUser(id); }}
          onEdit={message => {
            if (!requireControl()) return;
            setMessageAction({
              method: 'conversation.message.edit',
              uiMessageId: message.uiMessageId,
              content: editableConversationText(message.payload.content),
            });
          }}
          onDelete={message => {
            if (!requireControl()) return;
            setMessageAction({method: 'conversation.message.delete', uiMessageId: message.uiMessageId});
          }}
          writable={connected && controlledByMobile}
          connected={connected}
          onTakeover={takeoverSelectedConversation}
          onHandoff={handoffSelectedConversation}
          attachments={attachments}
          draft={draft}
          onDraft={setDraft}
          onSend={send}
          queuedSends={workspace.queuedSends.filter(
            item => item.conversationId === workspace.selectedConversationId,
          )}
          onRemoveQueued={workspace.removeQueuedSend}
          recording={recording}

          audioProcessing={audio.processing}
          onRecordStart={audio.start}
          onRecordEnd={audio.finish}
          onRecordCancel={audio.cancel}
          onAttachmentPress={() => setSheet('attachment')}
          pendingChoices={workspace.pendingChoices}
          onSubmitChoice={workspace.submitChoice}
          onStop={() => workspace.cancelActiveTurn().catch(() => undefined)}
        />
      )}
      </View>

      {messageAction ? (
        <ConversationActions
          desktopId={desktop.id}
          conversationId={workspace.selectedConversationId}
          action={messageAction}
          request={request}
          requestTracked={requestTracked}
          onClose={() => setMessageAction(null)}
          onCompleted={() => {
            const completedAction = messageAction;
            setMessageAction(null);
            if (completedAction.method === 'conversation.message.delete') {
              workspace.removeMessageFromView(completedAction.uiMessageId);
            }
            workspace.refreshCatalog();
            workspace.refreshMessages();
          }}
        />
      ) : null}

      {conversationMenu ? <ConversationMenu key={conversationMenu.conversationId} desktopId={desktop.id} conversation={conversationMenu} projects={bootstrap?.projects || []} request={request} requestTracked={requestTracked} onClose={() => setConversationMenu(null)} onCompleted={deleted => {
        if (deleted) workspace.removeConversationFromView(conversationMenu.conversationId);
        setConversationMenu(null);
        refreshWorkspace();
        if (!deleted || conversationMenu.conversationId !== workspace.selectedConversationId) workspace.refreshMessages();
        workspace.refreshOpenedSessions();
      }} /> : null}


      <Drawer
        visible={drawerOpen}
        profile={bootstrap?.profile}
        avatarCache={desktop.avatarCache}
        projects={bootstrap?.projects || []}
        byProject={conversationsByProject}
        currentConversationId={workspace.selectedConversationId}
        onClose={() => setDrawerOpen(false)}
        onSelectConversation={selectConversation}

        onConversationMenu={(item: ConversationSummary) => {setDrawerOpen(false); setConversationMenu(item);}}
        onNewChat={() => {
          leaveConversation();
          setMode('router');
          setDrawerOpen(false);
        }}
        onNewProject={() => {
          setDrawerOpen(false);
          setEditingProject(null);
          setProjectName('');
          setSheet('composer');
        }}
        onEditProject={beginProjectRename}
        onDeleteProject={removeProject}
        onOpenedSessions={() => {
          workspace.refreshOpenedSessions().catch(() => undefined);
          setSheet('opened');
        }}
        onSettings={openManagement}
      />

      <Sheet
        visible={sheet === 'opened'}
        onClose={() => setSheet(null)}
        title="已打开会话"
      >
        <View style={styles.openedSessionList}>
          {workspace.openedSessions.length ? workspace.openedSessions.map((item: OpenedConversationSession) => (
            <View key={item.conversationId} style={styles.openedSessionCard}>
              <Pressable
                style={styles.openedSessionCopy}
                onPress={() => enterOpenedSession(item)}
                accessibilityRole="button"
                accessibilityLabel={`打开会话 ${item.title || '未命名会话'}`}
              >
                <Text numberOfLines={1} style={styles.openedSessionTitle}>{item.title || '未命名会话'}</Text>
                <Text style={styles.openedSessionMeta}>
                  {item.controlledByThisDevice ? 'Mobile 正在控制' : item.mobileControlled ? '其他设备正在控制' : 'Desktop 正在控制'}
                  {item.visible ? ' · 桌面已打开' : ''}
                  {item.busy ? ' · 处理中' : ''}
                </Text>
              </Pressable>
              {item.controlledByThisDevice ? (
                <View style={[styles.openedSessionControl, item.busy && styles.disabled]}>
                  <Pressable
                    accessibilityLabel="关闭会话"
                    disabled={item.busy}
                    onPress={() => closeOpenedSession(item)}
                    style={({pressed}) => [styles.openedSessionSegment, pressed && {backgroundColor: C.primarySoft}]}
                  >
                    <Text style={styles.openedSessionCloseText}>关闭</Text>
                  </Pressable>
                  <View style={styles.openedSessionDivider} />
                  <Pressable
                    accessibilityLabel="交还 Desktop"
                    disabled={item.busy}
                    onPress={() => handoffOpenedSession(item)}
                    style={({pressed}) => [styles.openedSessionSegment, pressed && {backgroundColor: C.primarySoft}]}
                  >
                    <Text style={styles.openedSessionSegmentText}>交还 Desktop</Text>
                  </Pressable>
                </View>
              ) : item.mobileControlled ? null : (
                <Pressable
                  accessibilityLabel="接管"
                  disabled={item.busy}
                  onPress={() => takeoverOpenedSession(item)}
                  style={[styles.openedSessionTakeover, item.busy && styles.disabled]}
                >
                  <Text style={styles.openedSessionSegmentText}>接管</Text>
                </Pressable>
              )}
            </View>
          )) : <Empty title="暂无已打开会话" text="在 Desktop 打开一个已保存的会话后，会显示在这里。" />}
        </View>
      </Sheet>


      <ConversationTaskSheet
        visible={sheet === 'tasks'}
        tasks={conversationTasks}
        onClose={() => setSheet(null)}
      />


      <Sheet
        visible={sheet === 'composer'}
        onClose={() => setSheet(null)}
        title="新建目录"
      >
        <TextInput
          value={projectName}
          onChangeText={setProjectName}
          style={styles.input}
          placeholder="例如：研究计划"
          placeholderTextColor={C.muted}
          autoFocus
        />
        <Action
          label={creatingProject ? '正在创建…' : '创建目录'}
          onPress={createProject}
          disabled={!projectName.trim() || creatingProject}
        />
      </Sheet>
      <Sheet
        visible={sheet === 'project'}
        onClose={() => {
          setSheet(null);
          setEditingProject(null);
          setProjectName('');
        }}
        title="修改项目名称"
      >
        <TextInput
          value={projectName}
          onChangeText={setProjectName}
          style={styles.input}
          placeholder="项目名称"
          placeholderTextColor={C.muted}
          autoFocus
        />
        <Action
          label={creatingProject ? '正在保存…' : '保存修改'}
          onPress={saveProjectRename}
          disabled={!projectName.trim() || creatingProject}
        />
      </Sheet>

      <Sheet
        visible={sheet === 'attachment'}
        onClose={() => setSheet(null)}
        title="添加附件"
      >
        <Pressable style={styles.mediaChoice} onPress={pickPhoto}>
          <AppIcon name="◉" />
          <Text style={styles.settingsListTitle}>从照片选择</Text>
        </Pressable>
        <Pressable
          style={styles.mediaChoice}
          onPress={() => {
            setSheet(null);
            attachments.add();
          }}
        >
          <Text style={styles.mediaChoiceIcon}>▤</Text>
          <View>
            <Text style={styles.settingsListTitle}>选择文件</Text>
          </View>
        </Pressable>
        <Pressable
          style={styles.mediaChoice}
          onPress={() => {
            setSheet(null);
            setShowCamera(true);
          }}
        >
          <Text style={styles.mediaChoiceIcon}>◉</Text>
          <View>
            <Text style={styles.settingsListTitle}>拍照发送</Text>
          </View>
        </Pressable>
      </Sheet>
      <Modal
        visible={showCamera}
        animationType="slide"
        onRequestClose={() => setShowCamera(false)}
      >
        {showCamera ? (
          <PhotoCapture
            onCancel={() => setShowCamera(false)}
            onCaptured={uploadCapturedPhoto}
          />
        ) : null}
      </Modal>

      <Sheet
        visible={sheet === 'session'}
        onClose={() => { if (!sessionOperation.current && !sessionBusy) setSheet(null); }}
        onConfirm={sessionConfig && connected && controlledByMobile ? saveSessionSettings : undefined}
        confirmLabel={sessionConfig && connected && controlledByMobile ? '完成' : '关闭'}
        confirmDisabled={sessionBusy}
        title="会话设置"
      >
        {sessionNotice ? <Text accessibilityLabel="会话设置操作结果" style={styles.sessionHint}>{sessionNotice}</Text> : null}

        {sessionReadError ? <Text style={styles.sessionHint}>{sessionReadError}</Text> : null}

        {sessionBusy && !sessionConfig ? (
          <ActivityIndicator color={C.primary} />
        ) : sessionConfig ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sessionTabs}>
              <Tag label="系统提示词" active={sessionTab === 'prompt'} onPress={() => setSessionTab('prompt')} />
              <Tag label="MCP" active={sessionTab === 'mcp'} onPress={() => setSessionTab('mcp')} />
              <Tag label="Skill" active={sessionTab === 'skill'} onPress={() => setSessionTab('skill')} />
              <Tag label="上下文" active={sessionTab === 'compact'} onPress={() => setSessionTab('compact')} />
            </ScrollView>
            {!controlledByMobile ? <Text style={styles.sessionHint}>接管后可编辑</Text> : null}
            {sessionTab === 'prompt' ? <View style={styles.sessionSection}>
              <SheetTextInput value={sessionConfig.systemPrompt || ''} editable={canEditSession} onChangeText={systemPrompt => setSessionConfig({...sessionConfig, systemPrompt})} multiline style={[styles.input, styles.systemPromptInput]} placeholder="输入本次会话的系统提示词" placeholderTextColor={C.muted} textAlignVertical="top" />
            </View> : null}
            {sessionTab === 'mcp' ? <View style={styles.sessionSection}>
              <View style={styles.sessionMcpSearch}><AppIcon name="search" size={17} color={C.muted} /><SheetTextInput accessibilityLabel="搜索会话 MCP" value={mcpQuery} onChangeText={setMcpQuery} placeholder="搜索名称、ID 或标签" placeholderTextColor={C.muted} style={styles.sessionMcpSearchInput} /></View>
              <View style={styles.sessionMcpFilters}>
                <Text style={styles.sessionMcpFilterLabel}>快速筛选</Text>
                <View style={styles.sessionMcpFilterRow}>
                  <Tag label="全部" active={mcpQuickFilter === 'all'} onPress={() => setMcpQuickFilter('all')} />
                  <Tag label="已选择" active={mcpQuickFilter === 'selected'} onPress={() => setMcpQuickFilter('selected')} />
                  <Tag label="预设" active={mcpQuickFilter === 'preset'} onPress={() => setMcpQuickFilter('preset')} />
                </View>
              </View>
              <View style={styles.toolSelectList}>{visibleSessionMcpServers.map(item => {
                const active = (sessionConfig.mcpServerIds || []).includes(item.id);
                const tags = Array.isArray(item.tags) ? item.tags : [];
                return <Pressable key={item.id} accessibilityLabel={`选择会话 MCP ${item.name || item.id}`} disabled={!canEditSession} style={[styles.toolSelectRow, active && styles.toolSelectRowActive]} onPress={() => setSessionConfig({...sessionConfig, mcpServerIds: toggleId(sessionConfig.mcpServerIds || [], item.id)})}><View style={styles.toolSelectIcon}><AppIcon name="mcp" size={17} color={active ? C.primary : C.muted} /></View><View style={styles.toolSelectCopy}><Text numberOfLines={1} style={styles.toolSelectName}>{item.name || item.id}</Text>{(item.preset || tags.length) ? <View style={styles.toolSelectTagRow}>{item.preset ? <Chip label="预设" /> : null}{tags.map(tag => <Chip key={tag} label={tag} />)}</View> : null}</View><Text style={styles.toolSelectCheck}>{active ? '✓' : ''}</Text></Pressable>;
              })}</View>
              {!visibleSessionMcpServers.length ? <View style={styles.sessionMcpEmpty}><Text style={styles.sessionHint}>没有匹配的 MCP 服务。</Text></View> : null}
            </View> : null}
            {sessionTab === 'skill' ? <View style={styles.sessionSection}>
              <View style={styles.sessionMcpSearch}><AppIcon name="search" size={17} color={C.muted} /><SheetTextInput accessibilityLabel="搜索会话 Skill" value={skillQuery} onChangeText={setSkillQuery} placeholder="搜索 Skill 名称" placeholderTextColor={C.muted} style={styles.sessionMcpSearchInput} /></View>
              <View style={styles.toolSelectList}>{visibleSessionSkills.map(item => {
                const active = (sessionConfig.skillIds || []).includes(item.id);
                return <Pressable key={item.id} accessibilityLabel={`选择会话 Skill ${item.name}`} disabled={!canEditSession} style={[styles.toolSelectRow, active && styles.toolSelectRowActive]} onPress={() => setSessionConfig({...sessionConfig, skillIds: toggleId(sessionConfig.skillIds || [], item.id)})}><View style={styles.toolSelectIcon}><AppIcon name="skills" size={17} color={active ? C.primary : C.muted} /></View><Text numberOfLines={1} style={styles.toolSelectName}>{item.name}</Text><Text style={styles.toolSelectCheck}>{active ? '✓' : ''}</Text></Pressable>;
              })}</View>
              {!visibleSessionSkills.length ? <View style={styles.sessionMcpEmpty}><Text style={styles.sessionHint}>没有匹配的 Skill。</Text></View> : null}
            </View> : null}
            {sessionTab === 'compact' ? <View style={styles.sessionSection}>

              <ContextUsageBar usage={contextUsage} capacity={Number(contextLengthDraft) || sessionConfig.compact?.contextLength || 1} ratio={Number(triggerRatioDraft)} preview={contextLengthEdited || Number(triggerRatioDraft) !== sessionConfig.compact?.triggerRatio} autoCompact={sessionConfig.compact?.autoCompactEnabled !== false} />
              <View style={styles.compactAction}><Text style={styles.sessionSectionTitle}>上下文</Text><Action compact label="立即压缩" onPress={compactNow} disabled={!canEditSession || executionBusy} /></View>
              <View style={styles.contextInfo}><Text style={styles.contextInfoLabel}>上下文长度</Text><Text style={styles.contextInfoValue}>{formatContextLength(sessionConfig.compact?.contextLength)} · {contextLengthEdited ? '手动（待保存）' : contextSourceLabel(sessionConfig.compact?.contextLengthSource)}</Text></View>
              <SheetTextInput accessibilityLabel="会话上下文长度" keyboardType="number-pad" value={contextLengthDraft} editable={canEditSession} onChangeText={value => { setContextLengthDraft(value); setContextLengthEdited(true); }} style={styles.input} placeholder="输入 4096–10000000" placeholderTextColor={C.muted} />
              <Action label={sessionBusy ? '正在获取…' : '一键获取上下文长度'} onPress={refreshContextLength} disabled={!canEditSession || executionBusy} />
              <ToggleRow label="自动压缩" disabled={!canEditSession} value={sessionConfig.compact?.autoCompactEnabled !== false} onChange={autoCompactEnabled => setSessionConfig({...sessionConfig, compact: {...sessionConfig.compact, autoCompactEnabled}})} />
              <View style={styles.sessionGrid}><View style={styles.field}><Text style={styles.fieldLabel}>触发比例 (0.1–0.99)</Text><SheetTextInput accessibilityLabel="压缩触发比例" keyboardType="decimal-pad" editable={canEditSession} value={triggerRatioDraft} onChangeText={setTriggerRatioDraft} style={styles.input} placeholder="例如 0.9" placeholderTextColor={C.muted} /></View><Field label="保留轮数" editable={canEditSession} value={String(sessionConfig.compact?.keepRecentRounds ?? 0)} onChange={raw => { const keepRecentRounds = Number(raw); if (Number.isFinite(keepRecentRounds)) setSessionConfig({...sessionConfig, compact: {...sessionConfig.compact, keepRecentRounds}}); }} /></View>
              <View style={styles.field}><Text style={styles.fieldLabel}>压缩提示词</Text><SheetTextInput value={sessionConfig.compact?.compactPrompt || ''} editable={canEditSession} onChangeText={compactPrompt => setSessionConfig({...sessionConfig, compact: {...sessionConfig.compact, compactPrompt}})} multiline style={[styles.input, styles.textarea]} placeholder="留空使用默认提示词" placeholderTextColor={C.muted} /></View>
            </View> : null}
            <Action label={sessionBusy ? '正在保存…' : '保存'} onPress={saveSessionSettings} disabled={!canEditSession} />
          </>
        ) : null}
      </Sheet>
      <Sheet visible={sheet === 'model'} onClose={() => setSheet(null)} title="选择模型">
        {sessionNotice ? <Text style={styles.sessionHint}>{sessionNotice}</Text> : null}
        {sessionReadError ? <Text style={styles.sessionHint}>{sessionReadError}</Text> : null}

        {sessionBusy && !sessionConfig ? <ActivityIndicator color={C.primary} /> : <View style={styles.sessionSelectList}>{(sessionOptions?.models || []).map(item => <Pressable key={item.value} style={[styles.sessionSelectRow, sessionConfig?.model === item.value && styles.sessionSelectRowActive]} disabled={!canEditSession} onPress={() => { setSessionConfig({...sessionConfig, model: item.value}); saveSessionPatch({model: item.value}).catch(() => undefined); }}><Text numberOfLines={1} style={styles.sessionSelectTitle}>{formatModelOption(item.label)}</Text><Text style={styles.toolSelectCheck}>{sessionConfig?.model === item.value ? '✓' : ''}</Text></Pressable>)}</View>}
      </Sheet>
      <Sheet visible={sheet === 'reasoning'} onClose={() => setSheet(null)} title="思维深度">
        {sessionNotice ? <Text style={styles.sessionHint}>{sessionNotice}</Text> : null}
        {sessionReadError ? <Text style={styles.sessionHint}>{sessionReadError}</Text> : null}

        {sessionBusy && !sessionConfig ? <ActivityIndicator color={C.primary} /> : <View style={styles.sessionSelectList}>{(sessionOptions?.reasoningEfforts || []).map(value => <Pressable key={value} style={[styles.sessionSelectRow, sessionConfig?.reasoningEffort === value && styles.sessionSelectRowActive]} disabled={!canEditSession} onPress={() => { setSessionConfig({...sessionConfig, reasoningEffort: value}); saveSessionPatch({reasoningEffort: value}).catch(() => undefined); }}><Text style={styles.sessionSelectTitle}>{reasoningLabel(value)}</Text><Text style={styles.toolSelectCheck}>{sessionConfig?.reasoningEffort === value ? '✓' : ''}</Text></Pressable>)}</View>}
      </Sheet>
      <Sheet visible={sheet === 'voice'} onClose={() => setSheet(null)} title="语音">
        {sessionNotice ? <Text style={styles.sessionHint}>{sessionNotice}</Text> : null}
        {sessionReadError ? <Text style={styles.sessionHint}>{sessionReadError}</Text> : null}

        {sessionBusy && !sessionConfig ? <ActivityIndicator color={C.primary} /> : <View style={styles.sessionSelectList}>{['', ...(sessionOptions?.voices || [])].map(value => <Pressable key={value || '__default_voice__'} style={[styles.sessionSelectRow, sessionConfig?.voice === value && styles.sessionSelectRowActive]} disabled={!canEditSession} onPress={() => { setSessionConfig({...sessionConfig, voice: value}); saveSessionPatch({voice: value}).catch(() => undefined); }}><Text style={styles.sessionSelectTitle}>{value || '关闭'}</Text><Text style={styles.toolSelectCheck}>{sessionConfig?.voice === value ? '✓' : ''}</Text></Pressable>)}</View>}
      </Sheet>
    </SafeAreaView>
  );
}

function AssistantRouter({
  assistants,
  avatarSources,
  loading,
  onSelect,
  onRefresh,
}: {
  assistants: RemoteAssistant[];
  avatarSources: Record<string, string>;
  loading: boolean;
  onSelect: (item: RemoteAssistant) => void;
  onRefresh: () => void;
}) {
  const styles = useThemedStyles(baseStyles);
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN');
    return assistants.filter(item => !keyword || [item.name, item.code, item.model, item.defaultProjectName].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [assistants, query]);
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.routerTopline}>
        <View style={styles.routerCopy}><Text style={styles.heroTitle}>开始新的聊天</Text><Text style={styles.heroText}>选择一个 Agent 开始对话。</Text></View>
        <Pressable style={styles.routerRefresh} accessibilityLabel="刷新助手路由" onPress={onRefresh}><AppIcon name="↻" size={18} color={C.primary} /></Pressable>
      </View>
      <View style={styles.routerSearch}><AppIcon name="search" size={17} color={C.muted} /><TextInput value={query} onChangeText={setQuery} placeholder="搜索 Agent、模型或项目" placeholderTextColor={C.muted} style={styles.routerSearchInput} /></View>
      {loading ? <ActivityIndicator color={C.primary} /> : null}
      <View style={styles.assistantGrid}>
        {visible.map(item => (
          <Pressable key={item.code} style={styles.assistantCard} onPress={() => onSelect(item)}>
            <View style={styles.assistantCardTop}><Avatar source={avatarSources[item.code] || item.icon} label={item.name} /><View style={styles.assistantCardCode}><Text numberOfLines={1} style={styles.assistantCodeText}>{item.name}</Text></View></View>
            <Text numberOfLines={2} style={styles.assistantMeta}>{item.model || '默认模型'}</Text>
            {(item.mcpCount || item.skillCount) ? <View style={styles.chipRow}>
              {item.mcpCount ? <Chip label={`${item.mcpCount} MCP`} /> : null}
              {item.skillCount ? <Chip label={`${item.skillCount} Skill`} /> : null}
            </View> : null}
          </Pressable>
        ))}
      </View>
      {!loading && !visible.length ? <Empty title={query.trim() ? '没有匹配的助手' : '没有可用助手'} text={query.trim() ? '换一个关键词试试。' : '请在 Desktop 启用至少一个窗口模式的快捷助手。'} /> : null}
    </ScrollView>
  );
}

const ChatPage = React.forwardRef<
  ConversationMessageListHandle,
  {
    title: string;
    desktopId: string;
    conversationId: string;
    request: RemoteRequest;
    userName: string;
    userAvatar?: string;
    assistantName: string;
    assistantAvatar?: string;
    model: string;
    messages: RemoteMessage[];
    activeTurn: any;
    onRefresh: () => void;
    onModelSettings: () => void;
    onReasoningSettings: () => void;
    onVoiceSettings: () => void;
    onOlder: () => void;
    hasOlder: boolean;
    onReask: (id: string) => Promise<void>;
    onResendUser: (id: string) => Promise<void>;
    onEdit: (message: RemoteMessage) => void;
    onDelete: (message: RemoteMessage) => void;
    writable: boolean;
    connected?: boolean;
    onTakeover: () => void;
    onHandoff: () => void;
    attachments: any;
    draft: string;
    onDraft: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    queuedSends: Array<{ requestId: string; text: string; position: number }>;
    onRemoveQueued: (requestId: string) => Promise<void>;
    recording: boolean;
    audioProcessing?: boolean;
    onRecordStart: () => void;
    onRecordEnd: () => void;
    onRecordCancel: () => void;
    onAttachmentPress: () => void;
    pendingChoices: Record<string, {conversationId: string; questions: Array<{question: string; header: string; options: Array<{label: string; description: string}>}>}>;
    onSubmitChoice: (toolCallId: string, responses: Array<Record<string, unknown>>) => Promise<void>;
  }
>(
  (
    {
      desktopId,
      conversationId,
      request,
      userName,
      userAvatar,
      assistantName,
      assistantAvatar,
      model,
      messages,
      activeTurn,
      onReask,
      onResendUser,
      onEdit,
      onDelete,
      writable,
      connected = true,
      onTakeover,
      onHandoff,
      attachments,
      draft,
      onDraft,
      onSend,
      onStop,
      queuedSends,
      onRemoveQueued,
      recording,
      audioProcessing,
      onRecordStart,
      onRecordEnd,
      onRecordCancel,
      onAttachmentPress,
      pendingChoices,
      onSubmitChoice,
      onModelSettings,
      onReasoningSettings,
      onVoiceSettings,
      onOlder,
      hasOlder,
    },
    ref,
  ) => {
    const styles = useThemedStyles(baseStyles);
    const [voiceMode, setVoiceMode] = useState(false);
    const list = useRef<ConversationMessageListHandle>(null);
    const [pinned, setPinned] = useState(true);
    React.useImperativeHandle(ref, () => list.current!);
    const lastVisibleMessage = [...messages]
      .reverse()
      .find(message => message.role === 'user' || message.role === 'assistant');
    const lastAssistant = lastVisibleMessage?.role === 'assistant' ? lastVisibleMessage.uiMessageId : '';
    const lastUser = lastVisibleMessage?.role === 'user' ? lastVisibleMessage.uiMessageId : '';
    // Desktop already chose message boundaries. Never merge them into a live
    // request preview or reinterpret canonical IDs as duplicate UI messages.
    const rows = useMemo(() => messages.filter(shouldRenderMessage), [messages]);
    const actions = useRef({onEdit, onDelete, onReask, onResendUser, onSubmitChoice});
    actions.current = {onEdit, onDelete, onReask, onResendUser, onSubmitChoice};
    const navigate = (target: 'top' | 'previous' | 'next' | 'bottom') => {
      if (target === 'top') list.current?.top();
      else if (target === 'bottom') list.current?.bottom();
      else list.current?.adjacent(target === 'previous' ? -1 : 1);
    };
      const liveChoices = Object.entries(pendingChoices || {})
      .filter(([toolCallId, pending]) =>
        pending.conversationId === conversationId &&
        !rows.some(message => message.payload.toolCalls?.some(tool => tool.id === toolCallId)),
      );
    return (
      <KeyboardDock>
        <View style={styles.chatViewport}>
        <ConversationMessageList
          ref={list}
          messages={rows}
          style={styles.chatMessages}
          contentContainerStyle={styles.messageList}
          onPinnedChange={setPinned}

          onOlder={onOlder}
          hasOlder={hasOlder}
          header={
            hasOlder ? (
              <Pressable onPress={onOlder}>
                <Text style={styles.link}>加载更早消息</Text>
              </Pressable>
            ) : null
          }
          renderMessage={item => (
            <MessageCard
              message={item}
              desktopId={desktopId}
              conversationId={conversationId}
              request={request}
              userName={userName}
              userAvatar={userAvatar}
              assistantName={assistantName}
              assistantAvatar={assistantAvatar}
              model={model}
              pendingChoices={pendingChoices}
              onSubmitChoice={(...args) => actions.current.onSubmitChoice(...args)}
              onEdit={() => actions.current.onEdit(item)}
              onDelete={() => actions.current.onDelete(item)}
              writable={writable && (!activeTurn || activeTurn.terminal)}
              choiceWritable={writable}
              reask={
                writable && (!activeTurn || activeTurn.terminal) && item.uiMessageId === lastAssistant
                  ? () => actions.current.onReask(item.uiMessageId).catch(() => undefined)
                  : undefined
              }
              resend={
                writable && (!activeTurn || activeTurn.terminal) && item.uiMessageId === lastUser
                  ? () => actions.current.onResendUser(item.uiMessageId).catch(() => undefined)
                  : undefined
              }
            />
          )}
        />
        <View pointerEvents="box-none" accessibilityLabel="消息导航居中区域" style={styles.chatNavigatorDock}>
        <View style={styles.chatNavigator}>
          <Pressable accessibilityLabel="跳到顶部" style={styles.chatNavigatorButton} onPress={() => navigate('top')}><AppIcon name="top" size={17} color={C.primary} /></Pressable>
          <Pressable accessibilityLabel="上一条消息" style={styles.chatNavigatorButton} onPress={() => navigate('previous')}><AppIcon name="↑" size={17} color={C.primary} /></Pressable>
          <Pressable accessibilityLabel="下一条消息" style={styles.chatNavigatorButton} onPress={() => navigate('next')}><AppIcon name="↓" size={17} color={C.primary} /></Pressable>
          <Pressable accessibilityLabel="跳到底部" style={[styles.chatNavigatorButton, pinned && styles.chatNavigatorButtonActive]} onPress={() => navigate('bottom')}><AppIcon name="bottom" size={17} color={C.primary} /></Pressable>
        </View>
        </View>
        </View>

        {liveChoices.map(([toolCallId, pending]) => (
          <LiveChoiceCard
            key={toolCallId}
            toolCallId={toolCallId}
            pending={pending}
            writable={writable}
            onSubmit={onSubmitChoice}
          />
        ))}
        {queuedSends.map(item => (
          <View key={item.requestId} style={styles.queueItem}>
            <Text numberOfLines={1} style={styles.queueText}>
              等待发送 {item.position} · {item.text || '附件消息'}
            </Text>
            <Pressable
              disabled={!writable}
              onPress={() =>
                writable && onRemoveQueued(item.requestId).catch(() => undefined)
              }
            >
              <Text style={styles.link}>移除</Text>
            </Pressable>
          </View>
        ))}
        {attachments.uploads.map((item: any) => (
          <View key={item.uploadId} style={styles.attachment}>
            <Text style={styles.attachmentText}>📎 {item.name}</Text>
            <Pressable disabled={!writable} onPress={() => writable && attachments.remove(item.uploadId)}>
              <Text style={styles.link}>移除</Text>
            </Pressable>
          </View>
        ))}
        {connected && !writable ? (
          <View style={styles.observerBanner}>
            <Text style={styles.observerText}>桌面端控制中</Text>
          </View>
        ) : null}
        <View style={[styles.composer, !writable && styles.composerReadOnly]}>
          {voiceMode ? (
            <Pressable
              style={styles.recordingPanel}
              disabled={!writable || audioProcessing}
              onPressIn={() => writable && !audioProcessing && onRecordStart()}
              onPressOut={() => writable && onRecordEnd()}
              onTouchMove={event => {
                if (event.nativeEvent.locationY < -34) onRecordCancel();
              }}
            >
              <Text style={styles.recordingText}>
                {audioProcessing ? '录音上传发送中…' : recording ? '正在录音 · 松手发送 · 上滑取消' : '按住说话'}
              </Text>
            </Pressable>
          ) : (
            <TextInput
              value={draft}
              onChangeText={onDraft}
              editable={writable}
              multiline
              placeholder="输入消息与 AI 聊天"
              placeholderTextColor={C.muted}
              style={styles.composerInput}
            />
          )}
          <View style={styles.composerActions}>
            <Pressable
              style={styles.iconAction}
              disabled={!writable}
              onPress={
                writable ? (attachments.busy ? attachments.cancel : onAttachmentPress) : undefined
              }
            >
              <Text style={styles.iconActionText}>
                {attachments.busy ? '×' : '＋'}
              </Text>
            </Pressable>
            <View style={styles.statusPills}>
              <Pressable style={styles.composerConfigButton} accessibilityLabel="选择模型" disabled={!writable} onPress={writable ? onModelSettings : undefined}>
                <AppIcon name="模型" />
              </Pressable>
              <Pressable style={styles.composerConfigButton} accessibilityLabel="思维深度" disabled={!writable} onPress={writable ? onReasoningSettings : undefined}>
                <AppIcon name="思维" />
              </Pressable>
              <Pressable style={styles.composerConfigButton} accessibilityLabel="语音配置" disabled={!writable} onPress={writable ? onVoiceSettings : undefined}>
                <AppIcon name="语音" />
              </Pressable>
            </View>
            <Pressable
              style={[styles.iconAction, recording && styles.iconActionActive]}
              disabled={!writable}
              accessibilityLabel={voiceMode ? '切换键盘' : '切换语音'}
              onPress={() => {
                if (!writable) return;
                onRecordCancel();
                setVoiceMode(current => !current);
              }}
            >
              <AppIcon name={voiceMode ? '⌨' : '●'} />
            </Pressable>
            {activeTurn && !activeTurn.terminal ? (
              <Action compact label="停止" onPress={onStop} danger disabled={!writable} />
            ) : null}
            <Action
              compact
              label={activeTurn && !activeTurn.terminal ? '排队' : '发送'}
              onPress={onSend}
              disabled={
                !writable ||
                attachments.busy ||
                recording ||
                (!draft.trim() && !attachments.uploads.length)
              }
            />
          </View>
        </View>
        <Pressable
          style={[styles.conversationControl, !connected && styles.disabled]}
          disabled={!connected}
          onPress={writable ? onHandoff : onTakeover}
          accessibilityLabel={writable ? '交还 Desktop' : '接管会话'}
        >
          <Text style={styles.conversationControlText}>{writable ? '交还 Desktop' : '接管会话'}</Text>
        </Pressable>
      </KeyboardDock>
    );
  },
);

function Drawer({
  visible,
  profile,
  avatarCache,
  projects,
  byProject,
  currentConversationId,
  onClose,
  onSelectConversation,
  onConversationMenu,
  onNewChat,
  onNewProject,
  onEditProject,
  onDeleteProject,
  onOpenedSessions,
  onSettings,
}: any) {
  const styles = useThemedStyles(baseStyles);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const groupItems = (projectId: string) =>
    [...(byProject.get(projectId) || [])]
      .filter((item: ConversationSummary) =>
        !normalizedQuery || item.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery),
      )
      .sort((left: ConversationSummary, right: ConversationSummary) =>
        Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''),
      );
  const groupCollapsed = (projectId: string) =>
    normalizedQuery ? false : collapsed[projectId] !== false;
  const toggleGroup = (projectId: string) =>
    setCollapsed(current => ({...current, [projectId]: !groupCollapsed(projectId)}));
  const avatarSource =
    avatarCache && isAvatarCacheValid(avatarCache)
      ? avatarCache.uri
      : profile?.avatarUrl;
  const renderProject = (project: WorkspaceProject) => {
    const items = groupItems(project.projectId);
    const totalCount = (byProject.get(project.projectId) || []).length;
    if (normalizedQuery && !items.length) return null;
    const isCollapsed = groupCollapsed(project.projectId);
    return (
      <View key={project.projectId} style={styles.projectCard}>
        <View style={styles.projectCardHeader}>
          <Pressable
            style={styles.projectToggle}
            accessibilityRole="button"
            accessibilityLabel={`${project.name}${isCollapsed ? '，展开' : '，收起'}`}
            onPress={() => toggleGroup(project.projectId)}
          >
            <Text numberOfLines={1} style={styles.projectTitle}>{project.name}</Text>
            <Text style={styles.projectCount}>{totalCount}</Text>
          </Pressable>
          <Pressable
            style={styles.projectIconButton}
            accessibilityRole="button"
            accessibilityLabel={`编辑项目 ${project.name}`}
            onPress={() => onEditProject(project)}
          >
            <AppIcon name="edit" size={17} color={C.icon} />
          </Pressable>
          <Pressable
            style={styles.projectIconButton}
            accessibilityRole="button"
            accessibilityLabel={`删除项目 ${project.name}`}
            onPress={() => onDeleteProject(project)}
          >
            <AppIcon name="delete" size={17} color={C.icon} />
          </Pressable>
        </View>
        {!isCollapsed
          ? items.map((item: ConversationSummary) => (
              <ConversationRow
                key={item.conversationId}
                item={item}
                active={item.conversationId === currentConversationId}
                onPress={() => onSelectConversation(item.conversationId)}

                onLongPress={() => onConversationMenu(item)}
              />
            ))
          : null}
      </View>
    );
  };
  const ungrouped = groupItems('__ungrouped__');
  const ungroupedTotalCount = (byProject.get('__ungrouped__') || []).length;
  return (
    <SlidingDrawer visible={visible} onClose={onClose}>
      <View style={styles.drawerOverlay}>
        <SafeAreaView
          style={[styles.drawer, styles.fullDrawer]}
          edges={['top', 'bottom']}
        >
          <View style={styles.profile}>
            <Avatar source={avatarSource} label={profile?.displayName || 'User'} />
            <View style={styles.profileCopy}>
              <Text numberOfLines={1} style={styles.profileName}>
                {profile?.displayName || 'User'}
              </Text>
              <Text style={styles.profileGreeting}>欢迎回来 👋</Text>
            </View>
          </View>
          <View style={styles.drawerActions}>
            <Pressable style={styles.drawerAction} onPress={onNewProject}>
              <AppIcon name="▱" size={19} color={C.icon} />
              <Text style={styles.drawerActionText}>新建目录</Text>
            </Pressable>
            <Pressable style={styles.drawerAction} onPress={onNewChat}>
              <AppIcon name="chat" size={19} color={C.icon} />
              <Text style={styles.drawerActionText}>新的聊天</Text>
            </Pressable>
          </View>
          <View style={styles.drawerSearchRow}>
            <View style={[styles.searchBox, styles.drawerSearchBox]}>
              <AppIcon name="search" size={18} color={C.muted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="搜索会话"
                placeholderTextColor={C.muted}
                style={styles.searchInput}
              />
            </View>
            <Pressable style={styles.openedSessionsEntry} onPress={onOpenedSessions} accessibilityLabel="已打开会话">
              <AppIcon name="chat" size={16} color={C.primary} />
              <Text numberOfLines={1} style={styles.openedSessionsEntryText}>已打开会话</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.drawerScroll} keyboardShouldPersistTaps="handled">
            {sortByName<WorkspaceProject>(projects).map(project => renderProject(project))}
            {ungrouped.length ? (
              <View style={styles.projectCard}>
                <View style={styles.projectCardHeader}>
                  <Pressable
                    style={styles.projectToggle}
                    accessibilityRole="button"
                    accessibilityLabel={`未分组${groupCollapsed('__ungrouped__') ? '，展开' : '，收起'}`}
                    onPress={() => toggleGroup('__ungrouped__')}
                  >
                    <Text numberOfLines={1} style={styles.projectTitle}>未分组</Text>
                    <Text style={styles.projectCount}>{ungroupedTotalCount}</Text>
                  </Pressable>
                </View>
                {!groupCollapsed('__ungrouped__')
                  ? ungrouped.map((item: ConversationSummary) => (
                      <ConversationRow
                        key={item.conversationId}
                        item={item}
                        active={item.conversationId === currentConversationId}
                        onPress={() => onSelectConversation(item.conversationId)}

                        onLongPress={() => onConversationMenu(item)}
                      />
                    ))
                  : null}
              </View>
            ) : null}
          </ScrollView>
          <View style={styles.drawerFooter}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="全局配置"
              style={styles.settingsEntry}
              onPress={onSettings}
            >
              <AppIcon name="general" size={21} color={C.icon} />
            </Pressable>
          </View>
        </SafeAreaView>
      </View>
    </SlidingDrawer>
  );
}

function ConversationRow({
  item,
  active,
  onPress,
  onLongPress,
}: {
  item: ConversationSummary;
  active: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const styles = useThemedStyles(baseStyles);
  return (
    <Pressable
      style={[styles.conversationRow, active && styles.conversationRowActive]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityLabel={item.title || '未命名会话'}
    >
      <Text numberOfLines={1} style={styles.conversationRowTitle}>
        {item.title || '未命名会话'}
      </Text>
      <Text numberOfLines={1} style={styles.conversationRowMeta}>
        {formatTime(item.createdAt)}
      </Text>
    </Pressable>
  );
}

function Field({
  label,
  value,
  onChange,
  editable = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  editable?: boolean;
}) {
  const styles = useThemedStyles(baseStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <SheetTextInput
        value={value || ''}
        editable={editable}
        onChangeText={onChange}
        style={styles.input}
        placeholderTextColor={C.muted}
      />
    </View>
  );
}
function ToggleRow({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const styles = useThemedStyles(baseStyles);
  return (
    <Pressable disabled={disabled} style={[styles.toggleRow, disabled && styles.disabled]} onPress={() => !disabled && onChange(!value)}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.switch, value && styles.switchOn]}>
        <View style={[styles.switchDot, value && styles.switchDotOn]} />
      </View>
    </Pressable>
  );
}

export function shouldRenderMessage(message: RemoteMessage): boolean {
  if (message.role !== 'assistant') return true;
  const content = renderText(message.payload.content);
  const reasoning = String(message.payload.reasoningContent || '').trim();
  const toolCalls = Array.isArray(message.payload.toolCalls) ? message.payload.toolCalls : [];
  // Keep thought and tool-only cards, but never reserve a blank content bubble
  // for stripped or unsupported markup.
  return Boolean(hasRenderableConversationContent(content) || reasoning || toolCalls.length);
}

export function hasMessageBubble(message: RemoteMessage): boolean {
  return hasRenderableConversationContent(renderText(withoutConversationFiles(message.payload.content)));
}


function LiveChoiceCard({
  toolCallId,
  pending,
  writable = true,
  onSubmit,
}: {
  toolCallId: string;
  pending: {conversationId: string; questions: Array<{question: string; header: string; options: Array<{label: string; description: string}>}>};
  writable?: boolean;
  onSubmit: (toolCallId: string, responses: Array<Record<string, unknown>>) => Promise<void>;
}) {
  const styles = useThemedStyles(baseStyles);
  const [answers, setAnswers] = useState<Record<number, {type: 'options' | 'custom' | 'discuss'; value?: string}>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const complete = pending.questions.every((question, index) => {
    const answer = answers[index];
    return Boolean(answer && (answer.type !== 'custom' || answer.value?.trim()));
  });
  const submit = async () => {
    if (!writable || !complete || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onSubmit(toolCallId, pending.questions.map((question, questionIndex) => {
        const answer = answers[questionIndex];
        if (answer.type === 'custom') return {questionIndex, type: 'custom', customText: answer.value?.trim() || '', question: question.question};
        if (answer.type === 'discuss') return {questionIndex, type: 'discuss', question: question.question};
        return {questionIndex, type: 'options', selected: [answer.value || ''], question: question.question};
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交选择失败。');
    } finally {
      setSubmitting(false);
    }
  };
  return <View style={styles.liveChoiceCard}>
    {pending.questions.map((question, questionIndex) => {
      const answer = answers[questionIndex];
      return <View key={`${question.question}-${questionIndex}`} style={styles.liveChoiceQuestion}>
        <View style={styles.choiceHeading}>{question.header ? <Text style={styles.choiceTag}>{question.header}</Text> : null}<Text style={styles.choiceText}>{question.question}</Text></View>
        {question.options.map((option, optionIndex) => <Pressable key={option.label} disabled={!writable} style={[styles.choiceOption, answer?.type === 'options' && answer.value === option.label && styles.choiceOptionActive]} onPress={() => writable && setAnswers(current => ({...current, [questionIndex]: {type: 'options', value: option.label}}))}><View style={styles.choiceBadge}><Text style={styles.choiceBadgeText}>{String.fromCharCode(65 + optionIndex)}</Text></View><View style={styles.choiceOptionCopy}><Text style={styles.choiceOptionLabel}>{option.label}</Text>{option.description ? <Text style={styles.choiceOptionDesc}>{option.description}</Text> : null}</View></Pressable>)}
        <Pressable disabled={!writable} style={[styles.choiceCustom, answer?.type === 'custom' && styles.choiceCustomActive]} onPress={() => writable && setAnswers(current => ({...current, [questionIndex]: {type: 'custom', value: current[questionIndex]?.value || ''}}))}>
          <Text style={styles.choiceCustomTitle}>其他想法（自己输入）</Text>
          {answer?.type === 'custom' ? <TextInput editable={writable} value={answer.value || ''} onChangeText={value => writable && setAnswers(current => ({...current, [questionIndex]: {type: 'custom', value}}))} placeholder="输入你的想法…" placeholderTextColor={C.muted} multiline style={styles.choiceCustomInput} /> : null}
        </Pressable>
        <Pressable disabled={!writable} style={[styles.choiceDiscuss, answer?.type === 'discuss' && styles.choiceOptionActive]} onPress={() => writable && setAnswers(current => ({...current, [questionIndex]: {type: 'discuss'}}))}><Text style={styles.choiceDiscussText}>聊聊这个（继续讨论）</Text></Pressable>
      </View>;
    })}
    {error ? <Text style={styles.toolError}>{error}</Text> : null}
    <Action label={submitting ? '正在提交…' : '提交选择'} onPress={submit} disabled={!writable || !complete || submitting} />
  </View>;
}


const MessageCard = React.memo(function MessageCardView({
  message,
  desktopId,
  conversationId,
  request,
  userName,
  userAvatar,
  assistantName,
  assistantAvatar,
  model,
  pendingChoices,
  onSubmitChoice,
  reask,
  resend,
  onEdit,
  onDelete,
  writable,
  choiceWritable,
}: {
  message: RemoteMessage;
  desktopId: string;
  conversationId: string;
  request: RemoteRequest;
  userName: string;
  userAvatar?: string;
  assistantName: string;
  assistantAvatar?: string;
  model: string;
  pendingChoices: Record<string, {conversationId: string; questions: Array<{question: string; header: string; options: Array<{label: string; description: string}>}>}>;
  onSubmitChoice: (toolCallId: string, responses: Array<Record<string, unknown>>) => Promise<void>;
  reask?: () => void;
  resend?: () => void;
  choiceWritable?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  writable: boolean;
}) {
  const styles = useThemedStyles(baseStyles);
  const isUser = message.role === 'user';
  const editableMessage = message.role === 'user' || message.role === 'assistant';
  const files = conversationFiles(message.payload.content);
  const content = renderText(withoutConversationFiles(message.payload.content));
  const displayName = isUser ? userName || '你' : assistantName || message.payload.aiName || 'Assistant';
  const timestamp = message.payload.timestamp || message.payload.completedTimestamp;
  const formattedTimestamp = formatTime(timestamp || '');
  const toolOnly = !isUser && !hasMessageBubble(message) && !String(message.payload.reasoningContent || '').trim() && Boolean(message.payload.toolCalls?.length);
  const copyText = content || (message.payload.toolCalls || []).map(tool => `调用 ${tool.name || '工具'}`).join('\n');
  return (
    <View style={[styles.messageWrap, isUser ? styles.messageRight : styles.messageLeft, toolOnly && styles.toolOnlyWrap]}>
      <View style={[styles.messageIdentity, isUser && styles.messageIdentityRight]}>
        {!isUser ? <Avatar source={assistantAvatar} label={displayName} /> : null}
        <View style={[styles.messageIdentityCopy, isUser && styles.messageIdentityCopyRight]}>
          <View style={[styles.messageNameLine, isUser && styles.messageNameLineRight]}><Text style={styles.messageRole}>{displayName}</Text>{!isUser && (model || message.payload.voiceName) ? <Text numberOfLines={1} style={styles.messageModel}>{model || message.payload.voiceName}</Text> : null}</View>
          {formattedTimestamp ? <Text accessibilityLabel={isUser ? '用户消息时间' : 'AI 回复时间'} style={[styles.messageTime, isUser && styles.messageTimeRight]}>{formattedTimestamp}</Text> : null}
        </View>
        {isUser ? <Avatar source={userAvatar} label={displayName} /> : null}
      </View>
      {message.payload.reasoningContent ? <FoldCard title="思考过程" text={message.payload.reasoningContent} /> : null}
      {hasMessageBubble(message) ? <View testID={`message-bubble-${message.uiMessageId}`} collapsable={false} style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}><ConversationMarkdown value={content} desktopId={desktopId} conversationId={conversationId} request={request} color={C.text} /></View> : null}
      {files.length ? <View accessibilityLabel="消息文件附件" style={styles.toolList}>{files.map((file, index) => <View key={`${index}-${file.name}`} style={styles.toolCard}><View style={styles.fileHeader}><AppIcon name="▤" size={17} color={C.primary} /><Text numberOfLines={2} selectable style={styles.toolName}>{file.name || '文件'}</Text></View></View>)}</View> : null}

      {message.payload.toolCalls?.length ? <View style={[styles.toolList, toolOnly && styles.toolListFullWidth]}>{message.payload.toolCalls.map(tool => <ToolCallCard key={tool.id || tool.name} tool={tool} pending={pendingChoices[tool.id]} writable={choiceWritable ?? writable} onSubmit={onSubmitChoice} />)}</View> : null}
      <View style={[styles.messageTools, isUser && styles.messageToolsRight]}>
        <Pressable accessibilityLabel="复制消息" onPress={() => Clipboard.setString(copyText)}><AppIcon name="copy" size={17} /></Pressable>
        {editableMessage ? <Pressable disabled={!writable} accessibilityLabel="编辑消息" onPress={onEdit}><AppIcon name="edit" size={17} /></Pressable> : null}
        {editableMessage ? <Pressable disabled={!writable} accessibilityLabel="删除消息" onPress={onDelete}><AppIcon name="delete" size={17} /></Pressable> : null}
        {reask ? <Pressable onPress={reask} accessibilityLabel="重答"><AppIcon name="reask" size={17} /></Pressable> : null}
        {resend ? <Pressable onPress={resend} accessibilityLabel="重发送"><AppIcon name="reask" size={17} /></Pressable> : null}
      </View>
    </View>
  );
}, (previous, next) => previous.message === next.message &&
  previous.desktopId === next.desktopId && previous.conversationId === next.conversationId &&
  previous.request === next.request && previous.userName === next.userName && previous.userAvatar === next.userAvatar &&
  previous.assistantName === next.assistantName && previous.assistantAvatar === next.assistantAvatar && previous.model === next.model &&
  previous.pendingChoices === next.pendingChoices && previous.writable === next.writable && previous.choiceWritable === next.choiceWritable &&
  Boolean(previous.reask) === Boolean(next.reask) && Boolean(previous.resend) === Boolean(next.resend));

function FoldCard({title, text}: {title: string; text: string}) {
  const styles = useThemedStyles(baseStyles);
  const [open, setOpen] = useState(false);
  const beforeLayoutChange = React.useContext(MessageLayoutInteractionContext);
  return <View style={styles.foldCard}><Pressable style={styles.foldHeader} onPress={() => { beforeLayoutChange(); setOpen(current => !current); }}><Text style={styles.foldTitle}>{title}</Text><Text style={styles.foldChevron}>{open ? '收起' : '展开'}</Text></Pressable>{open ? <Text selectable style={styles.foldText}>{text}</Text> : null}</View>;
}

function ToolCallCard({tool, pending, writable = true, onSubmit}: {tool: RemoteMessage['payload']['toolCalls'][number]; pending?: {conversationId: string; questions: Array<{question: string; header: string; options: Array<{label: string; description: string}>}>}; writable?: boolean; onSubmit: (toolCallId: string, responses: Array<Record<string, unknown>>) => Promise<void>}) {
  const styles = useThemedStyles(baseStyles);
  const [open, setOpen] = useState(false);
  const beforeLayoutChange = React.useContext(MessageLayoutInteractionContext);
  return <View style={styles.toolCard}>
    <Pressable accessibilityLabel={`查看工具 ${tool.name || '工具'} 详情`} style={styles.toolHeader} onPress={() => { beforeLayoutChange(); setOpen(current => !current); }}><View style={styles.toolHeaderCopy}><AppIcon name="mcp" size={16} color={C.primary} /><Text numberOfLines={1} style={styles.toolName}>调用 {tool.name || '工具'}</Text></View><Text style={styles.toolState}>{tool.status === 'choosing' || pending ? '等待选择' : tool.status || (tool.result !== undefined ? '已完成' : '处理中')}</Text></Pressable>
    {open ? <View style={styles.toolBody}>
      {pending ? <LiveChoiceCard toolCallId={tool.id} pending={pending} writable={writable} onSubmit={onSubmit} /> : <ScrollView accessibilityLabel={`工具 ${tool.name || '工具'} 输入输出`} nestedScrollEnabled showsVerticalScrollIndicator style={styles.toolDetailScroll} contentContainerStyle={styles.toolDetailContent} keyboardShouldPersistTaps="handled"><Text style={styles.toolLabel}>输入参数</Text><Text selectable style={styles.toolCode}>{tool.arguments === '[参数已隐藏]' ? '加载中…' : formatObject(tool.arguments)}</Text>{tool.result !== undefined ? <><Text style={styles.toolLabel}>输出结果</Text><Text selectable style={styles.toolCode}>{formatObject(tool.result)}</Text></> : <Text style={styles.toolPending}>执行中…</Text>}</ScrollView>}
    </View> : null}
  </View>;
}

function formatObject(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return '[无法显示]'; }
}

function Avatar({ source, label }: { source?: string; label: string }) {
  const styles = useThemedStyles(baseStyles);
  return source ? (
    <Image source={{ uri: source }} style={styles.avatar} />
  ) : (
    <View style={styles.avatarFallback}>
      <Text style={styles.avatarText}>{label.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}
function IconButton({
  icon,
  label,
  onPress,
}: {
  icon: string;
  label: string;
  onPress: () => void;
}) {
  const styles = useThemedStyles(baseStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.topIcon}
      onPress={onPress}
    >
      <AppIcon name={icon} />
    </Pressable>
  );
}
function Chip({ label }: { label: string }) {
  const styles = useThemedStyles(baseStyles);
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
}
function Tag({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  const styles = useThemedStyles(baseStyles);
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      style={[styles.tag, active && styles.tagActive]}
    >
      <Text style={[styles.tagText, active && styles.tagTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}
function Action({
  label,
  onPress,
  disabled,
  compact,
  danger,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
  danger?: boolean;
}) {
  const styles = useThemedStyles(baseStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      disabled={disabled}
      accessibilityRole="button"
      onPress={onPress}
      style={[
        styles.action,
        compact && styles.actionCompact,
        danger && styles.actionDanger,
        disabled && styles.disabled,
      ]}
    >
      {compact && ['发送', '排队', '停止'].includes(label) ? <AppIcon name={label === '停止' ? 'stop' : 'send'} size={18} color="#FFFFFF" /> : <Text style={styles.actionText}>{label}</Text>}
    </Pressable>
  );
}
const SheetFocusContext = React.createContext<((target: number | null) => void) | null>(null);

function SheetTextInput(props: React.ComponentProps<typeof TextInput>) {
  const reveal = React.useContext(SheetFocusContext);
  return <TextInput {...props} onFocus={event => {
    props.onFocus?.(event);
    reveal?.(event.nativeEvent.target);
  }} onBlur={event => { props.onBlur?.(event); reveal?.(null); }} />;
}

function Sheet({
  visible,
  title,
  children,
  onClose,
  onConfirm,
  confirmLabel = '完成',
  confirmDisabled = false,
}: {
  visible: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  confirmDisabled?: boolean;
}) {
  const styles = useThemedStyles(baseStyles);
  const scroll = useRef<ScrollView>(null);
  const focusedTarget = useRef<number | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealInput = useCallback((target: number | null) => {
    focusedTarget.current = target;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    if (target == null) return;
    scrollTimer.current = setTimeout(() => {
      scroll.current?.scrollResponderScrollNativeHandleToKeyboard?.(target, 24, true);
      scrollTimer.current = null;
    }, 120);
  }, []);
  useEffect(() => {
    if (!visible) { focusedTarget.current = null; return; }
    const show = Keyboard.addListener('keyboardDidShow', () => {
      if (focusedTarget.current != null) revealInput(focusedTarget.current);
    });
    return () => {
      show.remove();
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
  }, [visible, revealInput]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView accessibilityLabel={`键盘避让面板 ${title}`} style={styles.sheetOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable accessibilityLabel={`${title}${confirmLabel}`} disabled={confirmDisabled} onPress={onConfirm || onClose}>
              <Text style={[styles.link, confirmDisabled && styles.disabled]}>{confirmDisabled ? '处理中…' : confirmLabel}</Text>
            </Pressable>
          </View>
          <ScrollView
            ref={scroll}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            automaticallyAdjustKeyboardInsets={false}
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetScrollContent}
          >
            <SheetFocusContext.Provider value={revealInput}>{children}</SheetFocusContext.Provider>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  const styles = useThemedStyles(baseStyles);
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}
function renderText(value: unknown): string {
  if (typeof value === 'string') return extractedFileNotice(value) || value;
  if (Array.isArray(value)) return value.map(item => renderBlock(item)).filter(Boolean).join('\n');
  return renderBlock(value);
}

function renderBlock(value: unknown): string {
  if (typeof value === 'string') return extractedFileNotice(value) || value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const item = value as Record<string, any>;
  if (['file', 'document', 'input_file'].includes(item.type)) {
    return fileNotice(item.name || item.file?.filename || item.filename);
  }
  if (typeof item.text === 'string') return extractedFileNotice(item.text) || item.text;
  // Deterministic image shapes from the Desktop DTO: either an opaque media
  // URL that Mobile can download, or an attachment reference it can describe.
  const type = typeof item.type === 'string' ? item.type : '';
  if (type === 'image' || type === 'image_url' || type === 'imageUrl') {
    const raw = item.url ?? item.image_url ?? item.image ?? item.src;
    const url = typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && typeof raw.url === 'string'
      ? raw.url
      : '';
    if (url) return `![图片](${url})`;
    if (typeof item.attachmentId === 'string' && item.attachmentId) {
      return `[图片附件${item.name ? `：${String(item.name)}` : ''}]`;
    }
    if (typeof item.sourcePath === 'string' && item.sourcePath) return `![图片](${item.sourcePath})`;
    return '[图片]';
  }
  if (typeof item.attachmentId === 'string' && item.attachmentId) {
    const name = typeof item.name === 'string' ? item.name : '';
    return `[附件${name ? `：${name}` : ''}]`;
  }
  if (type) return `[${type} 附件]`;
  return '';
}
function formatModelOption(label: string): string {
  return String(label || '').replace(/\s*·\s*/g, ' | ') || '未命名模型';
}

function formatContextLength(value: unknown): string {
  const length = Number(value);
  if (!Number.isFinite(length) || length < 1) return '自动检测中';
  return `${Math.round(length / 1024)}K tokens`;
}

function contextSourceLabel(value: unknown): string {
  return value === 'api' ? '自动检索' : value === 'manual' ? '已保存' : '默认';
}

function reasoningLabel(value: string): string {
  return ({none: '关闭', default: '自动', low: '快速', medium: '均衡', high: '深入', xhigh: '强化', max: '极致'} as Record<string, string>)[value] || value;
}


function toggleId(values: string[], id: string): string[] {
  return values.includes(id)
    ? values.filter(value => value !== id)
    : [...values, id];
}

function formatTime(value: string): string {
  const source = value.trim();
  // Desktop UI may persist a local sv-SE value (YYYY-MM-DD HH:mm[:ss]).
  // Hermes does not reliably parse that non-ISO variant, so construct a local
  // Date from the Desktop-provided fields without creating a new timestamp.
  const local = /^(\d{4})[-/](\d{2})[-/](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(source);
  const time = local
    ? new Date(
        Number(local[1]),
        Number(local[2]) - 1,
        Number(local[3]),
        Number(local[4]),
        Number(local[5]),
        Number(local[6] || 0),
      ).getTime()
    : Date.parse(source);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const two = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
const baseStyles = StyleSheet.create({
  sheetScroll: {maxHeight: 520, flexShrink: 1},
  sheetScrollContent: {paddingBottom: 24},
  fullDrawer: { width: '100%', maxWidth: 340 },
  safe: { flex: 1, backgroundColor: C.background },
  topbar: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
    backgroundColor: C.background,
  },
  topIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
  },
  topIconText: { fontSize: 18, color: C.icon, fontWeight: '600' },
  titlePress: { flex: 1, alignItems: 'center', minWidth: 0 },
  title: { fontSize: 16, color: C.text, fontWeight: '600' },
  subtitle: { fontSize: 10, color: C.muted, marginTop: 1 },
  notice: {
    backgroundColor: C.primarySoft,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  noticeText: { color: '#8C432F', fontSize: 12 },
  page: { padding: 18, paddingBottom: 42, gap: 14 },
  hero: { gap: 6, paddingVertical: 12 },
  heroTitle: { fontSize: 22, fontWeight: '600', color: C.text },
  heroText: { fontSize: 14, lineHeight: 21, color: C.muted },
  assistantGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  assistantCard: {
    width: '47%',
    borderRadius: 22,
    padding: 12,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.line,
    gap: 7,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.surfaceMuted,
  },
  avatarFallback: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: C.primary, fontSize: 17, fontWeight: '600' },
  assistantName: { fontSize: 15, color: C.text, fontWeight: '600' },
  assistantMeta: { fontSize: 12, color: C.muted },
  chipRow: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  chip: {
    backgroundColor: C.surfaceMuted,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 99,
  },
  chipText: { fontSize: 10, color: C.muted, fontWeight: '600' },
  ghostButton: { alignItems: 'center', padding: 12 },
  ghostText: { color: C.primary, fontWeight: '600' },
  empty: {
    margin: 24,
    padding: 22,
    borderRadius: 22,
    backgroundColor: C.surfaceMuted,
    gap: 8,
  },
  emptyTitle: { fontSize: 16, color: C.text, fontWeight: '600' },
  emptyText: { fontSize: 14, color: C.muted, lineHeight: 21 },
  drawerOverlay: { flex: 1, backgroundColor: C.overlay, flexDirection: 'row' },
  drawer: {
    width: '82%',
    maxWidth: 340,
    backgroundColor: C.background,
    padding: 14,
    gap: 12,
  },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  profileCopy: { flex: 1, minWidth: 0 },

  profileName: { fontSize: 18, fontWeight: '600', color: C.text },
  profileGreeting: { fontSize: 13, color: C.muted, marginTop: 4 },
  drawerActions: {flexDirection: 'row', gap: 10},
  drawerAction: {
    flex: 1,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    paddingHorizontal: 10,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.line,
    gap: 8,
  },
  drawerActionText: {color: C.text, fontWeight: '600', fontSize: 14},
  searchBox: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.surfaceMuted,
    paddingHorizontal: 13,
  },
  searchInput: {flex: 1, color: C.text, paddingVertical: 9, fontSize: 14},
  drawerSearchRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  drawerSearchBox: {flex: 1, minWidth: 0},
  openedSessionsEntry: {
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.surface,
  },
  openedSessionsEntryText: {minWidth: 0, color: C.primary, fontSize: 12, fontWeight: '600'},

  drawerScroll: {flex: 1, marginTop: 3},
  projectCard: {
    overflow: 'hidden',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 20,
    backgroundColor: C.surface,
  },
  projectCardHeader: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 7,
  },
  projectToggle: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10},
  projectTitle: {flex: 1, color: C.text, fontSize: 16, fontWeight: '600'},
  projectCount: {color: C.muted, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums']},
  projectIconButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
    backgroundColor: C.surfaceMuted,
  },
  conversationRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.line,
  },
  conversationRowActive: {backgroundColor: C.primarySoft},
  conversationRowTitle: {flex: 1, color: C.text, fontSize: 14},
  conversationRowMeta: {maxWidth: 138, color: C.muted, fontSize: 11, textAlign: 'right', fontVariant: ['tabular-nums']},
  drawerFooter: {alignItems: 'flex-end', paddingTop: 0},
  settingsEntry: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: C.surfaceMuted,
  },
  taskTopAction: {position: 'relative'},
  taskBadge: {position: 'absolute', top: 1, right: 0, minWidth: 15, height: 15, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primary},
  taskBadgeText: {fontSize: 9, color: '#fff', fontWeight: '600'},

  chatViewport: {flex: 1, minHeight: 0, position: 'relative'},
  chatMessages: {flex: 1, minHeight: 0},
  messageList: {padding: 16, paddingBottom: 14, gap: 16},
  messageWrap: {width: '94%', maxWidth: '94%', minWidth: 0, flexGrow: 0, flexShrink: 0, gap: 7},
  messageLeft: {alignSelf: 'flex-start'},

  toolOnlyWrap: {alignSelf: 'stretch', maxWidth: '100%', gap: 7},

  chatNavigatorDock: {position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 12},
  chatNavigator: { gap: 7, zIndex: 3, padding: 6, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, backgroundColor: C.surface, shadowColor: '#372C26', shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: {width: 0, height: 3}, elevation: 3},
  chatNavigatorButton: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: C.surfaceMuted},
  chatNavigatorButtonActive: {backgroundColor: C.primarySoft, borderWidth: StyleSheet.hairlineWidth, borderColor: '#E6B9A7'},


  toolListFullWidth: {alignSelf: 'stretch', width: '100%'},

  messageRight: {alignSelf: 'flex-end'},
  messageIdentity: {flexDirection: 'row', alignItems: 'center', gap: 8},
  messageIdentityRight: {justifyContent: 'flex-end'},
  messageIdentityCopy: {gap: 1, minWidth: 0},
  messageIdentityCopyRight: {alignItems: 'flex-end'},
  messageNameLine: {flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 280},
  messageNameLineRight: {justifyContent: 'flex-end'},
  messageRole: {fontSize: 13, color: C.text, fontWeight: '600'},
  messageModel: {maxWidth: 150, color: C.muted, fontSize: 10},
  messageTime: {fontSize: 10, color: C.muted, fontVariant: ['tabular-nums']},
  messageTimeRight: {textAlign: 'right'},
  messageBubble: {width: '100%', minWidth: 0, flexGrow: 0, flexShrink: 0, borderRadius: 20, padding: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line},
  userBubble: {backgroundColor: C.user, borderTopRightRadius: 6},
  assistantBubble: {backgroundColor: C.surface, borderTopLeftRadius: 6},
  foldCard: {borderRadius: 14, overflow: 'hidden', backgroundColor: C.surfaceMuted},
  foldHeader: {minHeight: 35, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 11},
  foldTitle: {color: C.text, fontSize: 12, fontWeight: '600'},
  foldChevron: {color: C.primary, fontSize: 11, fontWeight: '600'},
  foldText: {paddingHorizontal: 11, paddingBottom: 11, color: C.muted, fontSize: 12, lineHeight: 18},
  toolList: {gap: 7},
  toolCard: {borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, borderRadius: 15, overflow: 'hidden', backgroundColor: C.surfaceMuted},
  toolHeader: {minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 11},
  fileHeader: {flexDirection: 'row', alignItems: 'center', minWidth: 0, flexGrow: 0, flexShrink: 0, gap: 7, padding: 11},

  toolHeaderCopy: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7},
  toolName: {flex: 1, color: C.text, fontSize: 12, fontWeight: '600'},
  toolState: {color: C.muted, fontSize: 10},
  toolBody: {padding: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.surface},
  toolDetailScroll: {height: 184, flexGrow: 0, borderRadius: 10, backgroundColor: C.surfaceMuted},
  toolDetailContent: {gap: 7, padding: 9},
  toolLabel: {color: C.muted, fontSize: 10, fontWeight: '600'},
  toolCode: {color: C.text, fontFamily: 'monospace', fontSize: 11, lineHeight: 16, flexShrink: 0},
  toolPending: {color: C.muted, fontSize: 12, lineHeight: 18, paddingTop: 4},
  toolError: {color: C.danger, fontSize: 12},
  choiceWrap: {gap: 10, paddingTop: 3},
  choiceQuestion: {gap: 6},
  choiceHeading: {flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap'},
  choiceTag: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 7, overflow: 'hidden', backgroundColor: C.primarySoft, color: C.primary, fontSize: 10, fontWeight: '600'},
  choiceText: {flex: 1, color: C.text, fontSize: 13, lineHeight: 19, fontWeight: '600'},
  choiceOption: {flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 9, borderRadius: 11, backgroundColor: C.surfaceMuted, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line},
  choiceOptionActive: {backgroundColor: C.primarySoft, borderColor: C.primary},
  choiceRadio: {width: 17, height: 17, marginTop: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderWidth: 1.5, borderColor: C.muted},
  choiceRadioDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: C.primary},
  choiceOptionCopy: {flex: 1, minWidth: 0, gap: 2},
  choiceOptionLabel: {color: C.text, fontSize: 13, fontWeight: '600'},
  choiceOptionDesc: {color: C.muted, fontSize: 11, lineHeight: 16},
  messageTools: {flexDirection: 'row', gap: 12, paddingHorizontal: 4},
  messageToolsRight: {justifyContent: 'flex-end'},
  messageTool: {fontSize: 12, color: C.muted},
  composer: {
    margin: 10,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 24,
    backgroundColor: C.surface,
    padding: 10,
    gap: 8,
  },
  observerBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginHorizontal: 10,
    marginTop: 8,
    padding: 10,
    borderRadius: 16,
    backgroundColor: C.primarySoft,
  },
  observerText: {flex: 1, color: '#8C432F', fontSize: 12, lineHeight: 18},
  composerReadOnly: {opacity: 0.62},
  conversationControl: {
    position: 'absolute',
    right: 18,
    bottom: 104,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.surface,
    shadowColor: '#372C26',
    shadowOpacity: 0.14,
    shadowRadius: 9,
    shadowOffset: {width: 0, height: 3},
    elevation: 4,
  },
  conversationControlText: {color: C.primary, fontSize: 12, fontWeight: '600'},

  composerInput: {
    minHeight: 46,
    maxHeight: 110,
    color: C.text,
    fontSize: 15,
    textAlignVertical: 'top',
    paddingHorizontal: 6,
  },
  composerConfigButton: {minWidth: 36, minHeight: 40, alignItems: 'center', justifyContent: 'center'},
  composerActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  iconAction: {
    width: 40,
    height: 40,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primarySoft,
  },
  iconActionText: { fontSize: 20, color: C.primary },
  iconActionActive: { backgroundColor: '#F6DADD' },
  recordingPanel: {
    minHeight: 46,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    backgroundColor: C.primarySoft,
  },
  recordingText: { color: '#8C432F', fontWeight: '600' },
  statusPills: { flex: 1, flexDirection: 'row', gap: 2, overflow: 'hidden', alignItems: 'center' },
  action: {
    backgroundColor: C.primary,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    paddingHorizontal: 18,
  },
  actionCompact: { minHeight: 40, borderRadius: 20, paddingHorizontal: 12 },
  actionDanger: { backgroundColor: C.danger },
  actionText: { color: '#fff', fontWeight: '600' },
  attachment: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: 16,
    padding: 9,
    backgroundColor: C.surfaceMuted,
    borderRadius: 12,
  },
  attachmentText: { color: C.text, fontSize: 12 },
  queueItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: 16,
    padding: 9,
    backgroundColor: C.primarySoft,
    borderRadius: 12,
    gap: 8,
  },
  queueText: { color: '#8C432F', fontSize: 12, flex: 1 },
  link: { color: C.primary, fontWeight: '600' },
  sheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: C.overlay,
  },
  sheet: {
    maxHeight: '92%',
    flexShrink: 1,
    backgroundColor: C.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 16,
    paddingBottom: 28,
    gap: 12,
  },
  sheetHandle: {
    width: 46,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#8E887D',
    alignSelf: 'center',
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sheetTitle: { fontSize: 18, fontWeight: '600', color: C.text },
  sheetText: { color: C.muted, fontSize: 14, lineHeight: 21 },
  input: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 14,
    color: C.text,
    backgroundColor: C.surface,
    padding: 12,
    minHeight: 48,
  },
  routerTopline: {flexDirection: 'row', alignItems: 'center', gap: 12},
  routerCopy: {flex: 1, minWidth: 0},
  routerRefresh: {width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surfaceMuted},
  routerSearch: {minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, borderRadius: 16, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface},
  routerSearchInput: {flex: 1, minWidth: 0, color: C.text, fontSize: 14, paddingVertical: 8},
  assistantCardTop: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between'},
  assistantCardCode: {maxWidth: 74, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 8, backgroundColor: C.surfaceMuted},
  assistantCodeText: {color: C.muted, fontSize: 9, fontWeight: '600'},
  sessionIntro: {padding: 13, borderRadius: 16, backgroundColor: C.primarySoft, gap: 3},
  sessionIntroTitle: {color: '#8C432F', fontSize: 15, fontWeight: '600'},
  sessionIntroText: {color: '#8C432F', fontSize: 12, lineHeight: 18},
  sessionTabs: {gap: 7, paddingVertical: 2},
  sessionSection: {gap: 11, paddingVertical: 4},
  sessionSectionTitle: {color: C.text, fontSize: 16, fontWeight: '600'},
  sessionLabel: {color: C.muted, fontSize: 12, fontWeight: '600'},
  sessionHint: {color: C.muted, fontSize: 12, lineHeight: 18},
  modelGroups: {gap: 10},
  modelGroup: {gap: 6, padding: 11, borderRadius: 15, backgroundColor: C.surfaceMuted},
  reasoningTrack: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 4},
  reasoningNode: {flex: 1, minWidth: 0, alignItems: 'center', gap: 5},
  reasoningDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: '#A9A197'},
  reasoningDotActive: {backgroundColor: C.primary, transform: [{scale: 1.35}]},
  reasoningLabel: {fontSize: 9, color: C.muted, textAlign: 'center'},
  reasoningLabelActive: {color: C.primary, fontWeight: '600'},
  toolTabs: {flexDirection: 'row', gap: 7},
  sessionMcpSearch: {minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, borderRadius: 16, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface},
  sessionMcpSearchInput: {flex: 1, minWidth: 0, paddingVertical: 8, color: C.text, fontSize: 14},
  sessionMcpFilters: {gap: 6},
  sessionMcpFilterLabel: {color: C.muted, fontSize: 12, fontWeight: '600'},
  sessionMcpFilterRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 7},
  sessionMcpEmpty: {padding: 13, borderRadius: 14, backgroundColor: C.surfaceMuted},
  toolSelectList: {gap: 7},
  toolSelectRow: {minHeight: 53, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, borderRadius: 15, backgroundColor: C.surfaceMuted, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line},
  toolSelectRowActive: {backgroundColor: C.primarySoft, borderColor: C.primary},
  toolSelectIcon: {width: 29, height: 29, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface},
  toolSelectCopy: {flex: 1, minWidth: 0, gap: 4},
  toolSelectName: {minWidth: 0, color: C.text, fontSize: 14, fontWeight: '600'},
  toolSelectTagRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 4},
  toolSelectCheck: {width: 18, color: C.primary, fontSize: 17, fontWeight: '600', textAlign: 'right'},
  compactAction: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},

  contextInfo: {minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 13, borderRadius: 15, backgroundColor: C.surfaceMuted},
  contextInfoLabel: {color: C.text, fontSize: 14, fontWeight: '600'},
  contextInfoValue: {color: C.muted, fontSize: 13},
  sessionSelectList: {gap: 8},
  sessionSelectRow: {minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 13, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, backgroundColor: C.surfaceMuted},
  sessionSelectRowActive: {borderColor: C.primary, backgroundColor: C.primarySoft},
  sessionSelectTitle: {flex: 1, minWidth: 0, color: C.text, fontSize: 14, fontWeight: '600'},
  openedSessionList: {gap: 9},
  openedSessionCard: {
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
    backgroundColor: C.surfaceMuted,
  },
  openedSessionCopy: {flex: 1, minWidth: 0, gap: 4, minHeight: 48, justifyContent: 'center'},
  openedSessionTitle: {color: C.text, fontSize: 14, fontWeight: '600'},
  openedSessionControl: {flexDirection: 'row', alignItems: 'center', overflow: 'hidden', borderWidth: 1, borderColor: '#E5CFC0', borderRadius: 12, backgroundColor: C.surface},
  openedSessionSegment: {minHeight: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 11},
  openedSessionDivider: {height: 18, width: StyleSheet.hairlineWidth, backgroundColor: '#E5CFC0'},
  openedSessionTakeover: {minWidth: 72, minHeight: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderWidth: 1, borderColor: '#E5CFC0', borderRadius: 12, backgroundColor: C.primarySoft},
  openedSessionSegmentText: {color: C.primary, fontSize: 12, fontWeight: '600'},
  openedSessionCloseText: {color: C.danger, fontSize: 12, fontWeight: '600'},
  retainedWorkspace: {flex: 1, minHeight: 0},
  connectionBanner: {paddingHorizontal: 16, paddingVertical: 10, backgroundColor: C.surfaceMuted},
  connectionBannerText: {color: C.muted, fontSize: 12, lineHeight: 18},

  openedSessionMeta: {color: C.muted, fontSize: 11, lineHeight: 16},

  liveChoiceCard: {marginHorizontal: 16, marginBottom: 10, gap: 12, padding: 13, borderRadius: 19, borderWidth: 1, borderColor: C.primary, backgroundColor: C.surface},
  liveChoiceQuestion: {gap: 8},
  choiceBadge: {width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: C.surfaceMuted},
  choiceBadgeText: {color: C.text, fontSize: 12, fontWeight: '600'},
  choiceCustom: {gap: 7, padding: 11, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, backgroundColor: C.surfaceMuted},
  choiceCustomActive: {borderColor: C.primary, backgroundColor: C.primarySoft},
  choiceCustomTitle: {color: C.text, fontSize: 13, fontWeight: '600'},
  choiceCustomInput: {minHeight: 42, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: C.primary, backgroundColor: C.surface, color: C.text, textAlignVertical: 'top'},
  choiceDiscuss: {minHeight: 42, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 13, backgroundColor: C.surfaceMuted},
  choiceDiscussText: {color: C.text, fontSize: 13, fontWeight: '600'},
  sessionGrid: {gap: 9},
  systemPromptInput: {minHeight: 190, textAlignVertical: 'top'},

  tagRow: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },
  tagScroll: { gap: 8, paddingVertical: 4 },
  tag: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 99,
    backgroundColor: C.surfaceMuted,
  },
  tagActive: { backgroundColor: C.primarySoft },
  tagText: { color: C.muted, fontWeight: '600' },
  tagTextActive: { color: C.primary },
  settingsCard: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 16,
    gap: 13,
    borderWidth: 1,
    borderColor: C.line,
  },
  settingsHeading: { fontSize: 17, color: C.text, fontWeight: '600' },
  infoRow: {
    gap: 3,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  infoLabel: { fontSize: 12, color: C.muted },
  infoValue: { fontSize: 14, color: C.text },
  settingsListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  settingsListText: { flex: 1, gap: 3 },
  settingsListTitle: { fontSize: 15, color: C.text, fontWeight: '600' },
  settingsListMeta: { fontSize: 12, color: C.muted },
  chevron: { fontSize: 21, color: C.muted },
  managementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
  },
  managementIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primarySoft,
  },
  managementIconText: { color: C.primary, fontSize: 17 },
  mediaChoice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: 16,
    backgroundColor: C.surfaceMuted,
  },
  mediaChoiceIcon: { fontSize: 26, color: C.primary },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, color: C.text, fontWeight: '600' },
  textarea: { minHeight: 110, textAlignVertical: 'top' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  switch: {
    width: 44,
    height: 26,
    borderRadius: 13,
    padding: 3,
    backgroundColor: C.line,
  },
  switchOn: { backgroundColor: C.primary },
  switchDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: C.surface,
  },
  switchDotOn: { alignSelf: 'flex-end' },
  disabled: { opacity: 0.45 },
});
