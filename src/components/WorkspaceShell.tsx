import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { DesktopRuntime } from '../hooks/useDesktops';
import { useConversationWorkspace } from '../hooks/useConversationWorkspace';
import { useAttachmentQueue } from '../hooks/useAttachmentQueue';
import type {
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
import { useThemedStyles } from './theme';
import Clipboard from '@react-native-clipboard/clipboard';
import { SlidingDrawer } from './SlidingDrawer';
import { launchImageLibrary } from 'react-native-image-picker';
import { uploadAudioCapture } from '../services/mediaAttachment';
import {ConversationMarkdown} from './ConversationMarkdown';
import {ConversationTaskSheet} from './ConversationTaskSheet';
import {cacheRemoteImage} from '../services/remoteImageCache';
import {
  cacheProfileAvatar,
  isAvatarCacheValid,
  removeProfileAvatarCache,
} from '../services/profileAvatarCache';
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
  visible?: boolean;
};

type ViewMode = 'router' | 'chat' | 'settings';


function workspaceNotice(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : String(error || '');
  const messages: Record<string, string> = {
    remote_client_closed: '连接被重置，正在恢复。',
    remote_transport_closed: '连接已关闭，正在恢复。',
    remote_transport_error: '安全连接暂时不可用，正在重连。',
    remote_all_paired_endpoints_unreachable: '已配对的连接地址暂不可用，请确认 Desktop 远程服务仍在运行。',
  };
  return messages[code] || (error instanceof Error ? error.message : fallback);
}

export function WorkspaceShell({
  desktop,
  request,
  requestTracked,
  subscribeEvents,
  updateProfile,
  onHome,
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

  const currentConversation = useRef(workspace.selectedConversationId);
  currentConversation.current = workspace.selectedConversationId;

  const audio = useAudioRecording(async capture => {
    const conversationId = workspace.selectedConversationId;
    if (!conversationId || !workspace.canControlConversation(conversationId)) {
      const { MediaCapture } = await import('../native/MediaCapture');
      await MediaCapture.deleteCapture(capture.captureId);
      return;
    }
    const upload = await uploadAudioCapture({
      desktopId: desktop.id,
      request,
      capture,
    });
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
    }
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
  const [sessionTab, setSessionTab] = useState<
    'prompt' | 'mcp' | 'skill' | 'compact'
  >('prompt');
  const [sessionBusy, setSessionBusy] = useState(false);
  const listRef = useRef<FlatList<RemoteMessage>>(null);

  const refreshWorkspace = useCallback(async () => {
    if (desktop.status !== '在线') return;
    setLoadingWorkspace(true);
    try {
      const [value, routes] = await Promise.all([
        request<WorkspaceBootstrap>(desktop.id, 'workspace.bootstrap.get'),
        request<{ok: true; assistants: RemoteAssistant[]}>(desktop.id, 'conversation.assistants.list'),
      ]);
      const cachedAvatar = desktop.avatarCache;
      const avatarVersion = value.profile.avatarVersion || '';
      let nextAvatarCache = cachedAvatar;
      if (value.profile.avatarDataUrl && avatarVersion) {
        const unchanged =
          cachedAvatar?.version === avatarVersion && isAvatarCacheValid(cachedAvatar);
        if (!unchanged) {
          if (cachedAvatar && !isAvatarCacheValid(cachedAvatar)) {
            await removeProfileAvatarCache(cachedAvatar);
          }
          nextAvatarCache = await cacheProfileAvatar({
            desktopId: desktop.id,
            avatarDataUrl: value.profile.avatarDataUrl,
            avatarVersion,
            displayName: value.profile.displayName,
            previous: cachedAvatar,
          });
        }
      } else if (cachedAvatar) {
        await removeProfileAvatarCache(cachedAvatar);
        nextAvatarCache = undefined;
      }
      if (
        updateProfile &&
        (value.profile.displayName !== desktop.profileName ||
          nextAvatarCache?.version !== cachedAvatar?.version ||
          nextAvatarCache?.expiresAt !== cachedAvatar?.expiresAt)
      ) {
        await updateProfile(desktop.id, {
          profileName: value.profile.displayName,
          avatarCache: nextAvatarCache,
        });
      }
      setBootstrap(value);
      setRouteAssistants(routes.assistants || []);
      setNotice('');
    } catch (error) {
      setNotice(workspaceNotice(error, '无法读取 Desktop 工作区。'));
    } finally {
      setLoadingWorkspace(false);
    }
  }, [
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

  useEffect(() => {
    if (mode === 'chat' && workspace.messages.length) {
      requestAnimationFrame(() =>
        listRef.current?.scrollToEnd({ animated: true }),
      );
    }
  }, [mode, workspace.messages.length]);

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

  const controlledByMobile = workspace.canControlConversation(workspace.selectedConversationId);
  const requireControl = () => {
    if (controlledByMobile) return true;
    setNotice('该会话正在由 Desktop 控制，请先点击“接管会话”。');
    return false;
  };

  const openSessionSettings = async (
    target: 'session' | 'model' | 'reasoning' | 'voice' = 'session',
  ) => {
    if (!workspace.selectedConversationId) return;
    sessionScope.current = workspace.selectedConversationId;
    setSessionConfig(null);
    setSessionOptions(null);
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
        setSessionConfig(result.config);
        setSessionOptions(result.options);
      }
    } catch (error) {
      setNotice(workspaceNotice(error, '无法读取会话设置。'));
      setSheet(null);
    } finally {
      setSessionBusy(false);
    }
  };

  const compactNow = async () => {
    if (!requireControl() || sessionBusy || !workspace.selectedConversationId) return;
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
    if (!requireControl() ||
      !workspace.selectedConversationId ||
      sessionScope.current !== workspace.selectedConversationId ||
      !sessionConfig ||
      sessionBusy
    ) return;
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
      const result = state.result as ConversationConfigResult | undefined;
      if (result?.config) {
        setSessionConfig(result.config);
        setSessionOptions(result.options);
      }
      if (closeAfterSave) setSheet(null);
    } catch (error) {
      setNotice(workspaceNotice(error, '保存会话设置失败。'));
    } finally {
      setSessionBusy(false);
    }
  };

  const saveSessionSettings = async () => {
    if (!sessionConfig) return;
    const patch = sessionTab === 'prompt'
      ? {systemPrompt: sessionConfig.systemPrompt || ''}
      : sessionTab === 'mcp'
        ? {mcpServerIds: sessionConfig.mcpServerIds || []}
        : sessionTab === 'skill'
          ? {skillIds: sessionConfig.skillIds || []}
          : {
              compact: {
                autoCompactEnabled: sessionConfig.compact?.autoCompactEnabled !== false,
                triggerRatio: Number(sessionConfig.compact?.triggerRatio) || 0.9,
                keepRecentRounds: Number(sessionConfig.compact?.keepRecentRounds) || 0,
                compactPrompt: sessionConfig.compact?.compactPrompt || '',
              },
            };
    await saveSessionPatch(patch);
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
    if (!workspace.selectedConversationId) return;
    try {
      await workspace.takeoverConversation(workspace.selectedConversationId);
      setNotice('已接管会话，Desktop 将实时观察更新。');
    } catch (error) {
      setNotice(workspaceNotice(error, '暂时无法接管会话。'));
    }
  };
  const handoffSelectedConversation = async () => {
    if (!workspace.selectedConversationId) return;
    if (recording || attachments.busy) {
      setNotice('请先完成或取消录音、附件上传，再交还 Desktop。');
      return;
    }
    try {
      await workspace.handoffConversation(workspace.selectedConversationId);
      setNotice('已交还 Desktop，会话将继续由 Desktop 控制。');
    } catch (error) {
      setNotice(workspaceNotice(error, '当前会话仍在执行，暂时无法交还。'));
    }
  };

  const takeoverOpenedSession = async (item: OpenedConversationSession) => {
    try {
      await workspace.takeoverConversation(item.conversationId);
      setNotice(`已接管“${item.title || '未命名会话'}”，Desktop 将实时观察更新。`);
    } catch (error) {
      setNotice(workspaceNotice(error, '暂时无法接管会话。'));
    }
  };
  const handoffOpenedSession = async (item: OpenedConversationSession) => {
    try {
      await workspace.handoffConversation(item.conversationId);
      setNotice(`已将“${item.title || '未命名会话'}”交还 Desktop。`);
    } catch (error) {
      setNotice(workspaceNotice(error, '当前会话仍在执行，暂时无法交还。'));
    }
  };


  const activeTurn =
    workspace.activeTurn?.conversationId === workspace.selectedConversationId
      ? workspace.activeTurn
      : null;
  const activeAssistantIdentity = workspace.conversationAssistant || {name: '', avatarUrl: ''};
  useEffect(() => {
    let active = true;
    const url = activeAssistantIdentity.avatarUrl;
    if (!url) {
      setAssistantAvatar('');
      return () => { active = false; };
    }
    cacheRemoteImage(url).then(value => { if (active) setAssistantAvatar(value); }).catch(() => { if (active) setAssistantAvatar(''); });
    return () => { active = false; };
  }, [activeAssistantIdentity.avatarUrl]);


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
          {mode !== 'settings' ? (
            <Text numberOfLines={1} style={styles.subtitle}>
              {mode === 'chat'
                ? controlledByMobile ? '点击重命名会话' : 'Desktop 实时观察中'
                : desktop.status === '在线'
                ? '已连接'
                : desktop.status}
            </Text>
          ) : null}
        </Pressable>
        <IconButton
          icon="↻"
          label="刷新"
          onPress={() => {
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

      {workspace.error || attachments.error || attachments.progress ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            {workspace.error || attachments.error || attachments.progress}
          </Text>
        </View>
      ) : null}

      {notice ? (
        <Pressable style={styles.notice} onPress={() => setNotice('')}>
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      ) : null}
      {desktop.status !== '在线' ? (
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
          ref={listRef}
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
          onEdit={message => {
            if (!requireControl()) return;
            setMessageAction({
              method: 'conversation.message.edit',
              uiMessageId: message.uiMessageId,
              content: renderText(message.payload.content),
            });
          }}
          onDelete={message => {
            if (!requireControl()) return;
            setMessageAction({method: 'conversation.message.delete', uiMessageId: message.uiMessageId});
          }}
          writable={controlledByMobile}
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
          onRecordStart={audio.start}
          onRecordEnd={audio.finish}
          onRecordCancel={audio.cancel}
          onAttachmentPress={() => setSheet('attachment')}
          pendingChoices={workspace.pendingChoices}
          onSubmitChoice={workspace.submitChoice}
          onStop={() => workspace.cancelActiveTurn().catch(() => undefined)}
        />
      )}

      {messageAction ? (
        <ConversationActions
          desktopId={desktop.id}
          conversationId={workspace.selectedConversationId}
          action={messageAction}
          request={request}
          requestTracked={requestTracked}
          onClose={() => setMessageAction(null)}
          onCompleted={() => {
            setMessageAction(null);
            workspace.refreshCatalog();
            workspace.refreshMessages();
          }}
        />
      ) : null}

      <Drawer
        visible={drawerOpen}
        profile={bootstrap?.profile}
        avatarCache={desktop.avatarCache}
        projects={bootstrap?.projects || []}
        byProject={conversationsByProject}
        currentConversationId={workspace.selectedConversationId}
        onClose={() => setDrawerOpen(false)}
        onSelectConversation={selectConversation}
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
        <Text style={styles.sheetText}>
          移动端接管后，桌面端会话进入只读模式，直到移动端交还
        </Text>
        <View style={styles.openedSessionList}>
          {workspace.openedSessions.length ? workspace.openedSessions.map((item: OpenedConversationSession) => (
            <View key={item.conversationId} style={styles.openedSessionCard}>
              <View style={styles.openedSessionCopy}>
                <Text numberOfLines={1} style={styles.openedSessionTitle}>{item.title || '未命名会话'}</Text>
                <Text style={styles.openedSessionMeta}>
                  {item.controlledByThisDevice ? 'Mobile 正在控制' : item.mobileControlled ? '其他设备正在控制' : 'Desktop 正在控制'}
                  {item.hidden ? ' · 隐藏 Writer' : item.visible ? ' · Desktop 已显示' : ''}
                  {item.busy ? ' · 处理中' : ''}
                </Text>
              </View>
              {item.controlledByThisDevice ? (
                <Action compact label="交还 Desktop" onPress={() => handoffOpenedSession(item)} disabled={item.busy} />
              ) : item.mobileControlled ? null : (
                <Action compact label="接管" onPress={() => takeoverOpenedSession(item)} disabled={item.busy} />
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
        <Text style={styles.sheetText}>
          目录会作为 Desktop 项目分组保存，不会创建或暴露真实本地路径。
        </Text>
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
        <Text style={styles.sheetText}>项目仅用于整理 Desktop 会话，不对应本地文件夹。</Text>
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
            <Text style={styles.settingsListMeta}>
              从系统文件选择器添加内容
            </Text>
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
            <Text style={styles.settingsListMeta}>
              拍摄后作为加密图片附件上传
            </Text>
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
        onClose={() => setSheet(null)}
        title="会话设置"
      >
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
            {!controlledByMobile ? <Text style={styles.sessionHint}>当前由 Desktop 控制。设置可查看，接管会话后才可修改。</Text> : null}
            {sessionTab === 'prompt' ? <View style={styles.sessionSection}>
              <TextInput value={sessionConfig.systemPrompt || ''} editable={controlledByMobile} onChangeText={systemPrompt => setSessionConfig({...sessionConfig, systemPrompt})} multiline style={[styles.input, styles.systemPromptInput]} placeholder="输入本次会话的系统提示词" placeholderTextColor={C.muted} textAlignVertical="top" />
            </View> : null}
            {sessionTab === 'mcp' ? <View style={styles.sessionSection}>
              <View style={styles.toolSelectList}>{(sessionOptions?.mcpServers || []).map(item => {
                const active = (sessionConfig.mcpServerIds || []).includes(item.id);
                return <Pressable key={item.id} disabled={!controlledByMobile} style={[styles.toolSelectRow, active && styles.toolSelectRowActive]} onPress={() => setSessionConfig({...sessionConfig, mcpServerIds: toggleId(sessionConfig.mcpServerIds || [], item.id)})}><View style={styles.toolSelectIcon}><AppIcon name="mcp" size={17} color={active ? C.primary : C.muted} /></View><Text style={styles.toolSelectName}>{item.name}</Text><Text style={styles.toolSelectCheck}>{active ? '✓' : ''}</Text></Pressable>;
              })}</View>
            </View> : null}
            {sessionTab === 'skill' ? <View style={styles.sessionSection}>
              <View style={styles.toolSelectList}>{(sessionOptions?.skills || []).map(item => {
                const active = (sessionConfig.skillIds || []).includes(item.id);
                return <Pressable key={item.id} disabled={!controlledByMobile} style={[styles.toolSelectRow, active && styles.toolSelectRowActive]} onPress={() => setSessionConfig({...sessionConfig, skillIds: toggleId(sessionConfig.skillIds || [], item.id)})}><View style={styles.toolSelectIcon}><AppIcon name="skills" size={17} color={active ? C.primary : C.muted} /></View><Text style={styles.toolSelectName}>{item.name}</Text><Text style={styles.toolSelectCheck}>{active ? '✓' : ''}</Text></Pressable>;
              })}</View>
            </View> : null}
            {sessionTab === 'compact' ? <View style={styles.sessionSection}>
              <View style={styles.compactAction}><Text style={styles.sessionSectionTitle}>上下文</Text><Action compact label="立即压缩" onPress={compactNow} disabled={!controlledByMobile || sessionBusy} /></View>
              <View style={styles.contextInfo}><Text style={styles.contextInfoLabel}>上下文长度</Text><Text style={styles.contextInfoValue}>{formatContextLength(sessionConfig.compact?.contextLength)}{sessionConfig.compact?.contextLengthSource ? ` · ${contextSourceLabel(sessionConfig.compact.contextLengthSource)}` : ''}</Text></View>
              <ToggleRow label="自动压缩" disabled={!controlledByMobile} value={sessionConfig.compact?.autoCompactEnabled !== false} onChange={autoCompactEnabled => setSessionConfig({...sessionConfig, compact: {...sessionConfig.compact, autoCompactEnabled}})} />
              <View style={styles.sessionGrid}><Field label="触发比例 (0.1–0.99)" editable={controlledByMobile} value={String(sessionConfig.compact?.triggerRatio ?? 0.9)} onChange={raw => { const triggerRatio = Number(raw); if (Number.isFinite(triggerRatio)) setSessionConfig({...sessionConfig, compact: {...sessionConfig.compact, triggerRatio}}); }} /><Field label="保留轮数" editable={controlledByMobile} value={String(sessionConfig.compact?.keepRecentRounds ?? 0)} onChange={raw => { const keepRecentRounds = Number(raw); if (Number.isFinite(keepRecentRounds)) setSessionConfig({...sessionConfig, compact: {...sessionConfig.compact, keepRecentRounds}}); }} /></View>
              <View style={styles.field}><Text style={styles.fieldLabel}>压缩提示词</Text><TextInput value={sessionConfig.compact?.compactPrompt || ''} editable={controlledByMobile} onChangeText={compactPrompt => setSessionConfig({...sessionConfig, compact: {...sessionConfig, compactPrompt}})} multiline style={[styles.input, styles.textarea]} placeholder="留空使用默认提示词" placeholderTextColor={C.muted} /></View>
            </View> : null}
            <Action label={sessionBusy ? '正在保存…' : '保存'} onPress={saveSessionSettings} disabled={!controlledByMobile || sessionBusy} />
          </>
        ) : null}
      </Sheet>
      <Sheet visible={sheet === 'model'} onClose={() => setSheet(null)} title="选择模型">
        {sessionBusy && !sessionConfig ? <ActivityIndicator color={C.primary} /> : <View style={styles.sessionSelectList}>{(sessionOptions?.models || []).map(item => <Pressable key={item.value} style={[styles.sessionSelectRow, sessionConfig?.model === item.value && styles.sessionSelectRowActive]} disabled={!controlledByMobile || sessionBusy} onPress={() => { setSessionConfig({...sessionConfig, model: item.value}); saveSessionPatch({model: item.value}).catch(() => undefined); }}><Text numberOfLines={1} style={styles.sessionSelectTitle}>{formatModelOption(item.label)}</Text><Text style={styles.toolSelectCheck}>{sessionConfig?.model === item.value ? '✓' : ''}</Text></Pressable>)}</View>}
      </Sheet>
      <Sheet visible={sheet === 'reasoning'} onClose={() => setSheet(null)} title="思维深度">
        {sessionBusy && !sessionConfig ? <ActivityIndicator color={C.primary} /> : <View style={styles.sessionSelectList}>{(sessionOptions?.reasoningEfforts || []).map(value => <Pressable key={value} style={[styles.sessionSelectRow, sessionConfig?.reasoningEffort === value && styles.sessionSelectRowActive]} disabled={!controlledByMobile || sessionBusy} onPress={() => { setSessionConfig({...sessionConfig, reasoningEffort: value}); saveSessionPatch({reasoningEffort: value}).catch(() => undefined); }}><Text style={styles.sessionSelectTitle}>{reasoningLabel(value)}</Text><Text style={styles.toolSelectCheck}>{sessionConfig?.reasoningEffort === value ? '✓' : ''}</Text></Pressable>)}</View>}
      </Sheet>
      <Sheet visible={sheet === 'voice'} onClose={() => setSheet(null)} title="语音">
        {sessionBusy && !sessionConfig ? <ActivityIndicator color={C.primary} /> : <View style={styles.sessionSelectList}>{['', ...(sessionOptions?.voices || [])].map(value => <Pressable key={value || '__default_voice__'} style={[styles.sessionSelectRow, sessionConfig?.voice === value && styles.sessionSelectRowActive]} disabled={!controlledByMobile || sessionBusy} onPress={() => { setSessionConfig({...sessionConfig, voice: value}); saveSessionPatch({voice: value}).catch(() => undefined); }}><Text style={styles.sessionSelectTitle}>{value || '默认语音'}</Text><Text style={styles.toolSelectCheck}>{sessionConfig?.voice === value ? '✓' : ''}</Text></Pressable>)}</View>}
      </Sheet>
    </SafeAreaView>
  );
}

function AssistantRouter({
  assistants,
  loading,
  onSelect,
  onRefresh,
}: {
  assistants: RemoteAssistant[];
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
            <View style={styles.assistantCardTop}><Avatar source={item.icon} label={item.name} /><View style={styles.assistantCardCode}><Text numberOfLines={1} style={styles.assistantCodeText}>{item.name}</Text></View></View>
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
  FlatList<RemoteMessage>,
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
    onEdit: (message: RemoteMessage) => void;
    onDelete: (message: RemoteMessage) => void;
    writable: boolean;
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
      onEdit,
      onDelete,
      writable,
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

    useEffect(() => {
      const scrollToComposer = () => requestAnimationFrame(() => {
        setTimeout(() => (ref as React.RefObject<FlatList<RemoteMessage> | null>)?.current?.scrollToEnd({animated: true}), 80);
      });
      const show = Keyboard.addListener('keyboardDidShow', scrollToComposer);
      const change = Keyboard.addListener('keyboardDidChangeFrame', scrollToComposer);
      return () => { show.remove(); change.remove(); };
    }, [ref]);
    const lastAssistant = [...messages]
      .reverse()
      .find(message => message.role === 'assistant')?.uiMessageId;
    const rows = [
      ...messages.filter(message => shouldRenderMessage(message)),
      ...(activeTurn && !activeTurn.historyLoaded && (activeTurn.text || activeTurn.reasoning)
        ? [{
            messageId: '__live__',
            uiMessageId: '__live__',
            role: 'assistant',
            order: Number.MAX_SAFE_INTEGER,
            payload: {
              content: activeTurn.text,
              reasoningContent: activeTurn.reasoning,
              summary: '',
              summaryPrefix: '',
              timestamp: '',
              completedTimestamp: '',
              aiName: assistantName,
              voiceName: '',
              status: '',
              toolCalls: [],
            },
          } as RemoteMessage]
        : []),
    ];
      const liveChoices = Object.entries(pendingChoices || {})
      .filter(([toolCallId, pending]) =>
        pending.conversationId === conversationId &&
        !messages.some(message => message.payload.toolCalls?.some(tool => tool.id === toolCallId)),
      );
    return (
      <KeyboardAvoidingView
        style={styles.chat}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <FlatList
          ref={ref}
          data={rows}
          keyExtractor={item => item.uiMessageId}
          contentContainerStyle={styles.messageList}
          ListHeaderComponent={
            hasOlder ? (
              <Pressable onPress={onOlder}>
                <Text style={styles.link}>加载更早消息</Text>
              </Pressable>
            ) : null
          }
          renderItem={({ item }) => (
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
              onSubmitChoice={onSubmitChoice}
              onEdit={() => onEdit(item)}
              onDelete={() => onDelete(item)}
              writable={writable}
              reask={
                writable && item.uiMessageId === lastAssistant
                  ? () => onReask(item.uiMessageId).catch(() => undefined)
                  : undefined
              }
            />
          )}
        />
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
        {!writable ? (
          <View style={styles.observerBanner}>
            <Text style={styles.observerText}>Desktop 正在控制此会话；内容会实时同步。</Text>
          </View>
        ) : null}
        <View style={[styles.composer, !writable && styles.composerReadOnly]}>
          {voiceMode ? (
            <Pressable
              style={styles.recordingPanel}
              disabled={!writable}
              onPressIn={() => writable && onRecordStart()}
              onPressOut={() => writable && onRecordEnd()}
              onTouchMove={event => {
                if (event.nativeEvent.locationY < -34) onRecordCancel();
              }}
            >
              <Text style={styles.recordingText}>
                {recording ? '正在录音 · 松手发送 · 上滑取消' : '按住说话'}
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
              <Pressable accessibilityLabel="选择模型" disabled={!writable} onPress={writable ? onModelSettings : undefined}>
                <AppIcon name="模型" />
              </Pressable>
              <Pressable accessibilityLabel="思维深度" disabled={!writable} onPress={writable ? onReasoningSettings : undefined}>
                <AppIcon name="思维" />
              </Pressable>
              <Pressable accessibilityLabel="语音配置" disabled={!writable} onPress={writable ? onVoiceSettings : undefined}>
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
          style={styles.conversationControl}
          onPress={writable ? onHandoff : onTakeover}
          accessibilityLabel={writable ? '交还 Desktop' : '接管会话'}
        >
          <Text style={styles.conversationControlText}>{writable ? '交还 Desktop' : '接管会话'}</Text>
        </Pressable>
      </KeyboardAvoidingView>
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
            {projects.map((project: WorkspaceProject) => renderProject(project))}
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
}: {
  item: ConversationSummary;
  active: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(baseStyles);
  return (
    <Pressable
      style={[styles.conversationRow, active && styles.conversationRowActive]}
      onPress={onPress}
      onLongPress={() => Alert.alert('会话名称', item.title || '未命名会话')}
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
      <TextInput
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

function shouldRenderMessage(message: RemoteMessage): boolean {
  if (message.role !== 'assistant') return true;
  const content = renderText(message.payload.content).trim();
  const reasoning = String(message.payload.reasoningContent || '').trim();
  const toolCalls = Array.isArray(message.payload.toolCalls) ? message.payload.toolCalls : [];
  // Keep tool cards, but omit a message only when it has neither user-visible
  // content nor a tool call to render.
  return Boolean(content || reasoning || toolCalls.length);
}

function hasMessageBubble(message: RemoteMessage): boolean {
  return Boolean(
    renderText(message.payload.content).trim() ||
    String(message.payload.reasoningContent || '').trim(),
  );
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


function MessageCard({
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
  onEdit,
  onDelete,
  writable,
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
  onEdit: () => void;
  onDelete: () => void;
  writable: boolean;
}) {
  const styles = useThemedStyles(baseStyles);
  const isUser = message.role === 'user';
  const editableMessage = message.role === 'user' || message.role === 'assistant';
  const content = renderText(message.payload.content);
  const displayName = isUser ? userName || '你' : assistantName || message.payload.aiName || 'Assistant';
  const timestamp = message.payload.completedTimestamp || message.payload.timestamp;
  const toolOnly = !isUser && !hasMessageBubble(message) && Boolean(message.payload.toolCalls?.length);
  const copyText = content || (message.payload.toolCalls || []).map(tool => `调用 ${tool.name || '工具'}`).join('\n');
  return (
    <View style={[styles.messageWrap, isUser ? styles.messageRight : styles.messageLeft, toolOnly && styles.toolOnlyWrap]}>
      <View style={[styles.messageIdentity, isUser && styles.messageIdentityRight]}>
        {!isUser ? <Avatar source={assistantAvatar} label={displayName} /> : null}
        <View style={[styles.messageIdentityCopy, isUser && styles.messageIdentityCopyRight]}>
          <View style={[styles.messageNameLine, isUser && styles.messageNameLineRight]}><Text style={styles.messageRole}>{displayName}</Text>{!isUser && (model || message.payload.voiceName) ? <Text numberOfLines={1} style={styles.messageModel}>{model || message.payload.voiceName}</Text> : null}</View>
          <Text style={[styles.messageTime, isUser && styles.messageTimeRight]}>{formatTime(timestamp)}</Text>
        </View>
        {isUser ? <Avatar source={userAvatar} label={displayName} /> : null}
      </View>
      {message.payload.reasoningContent ? <FoldCard title="思考过程" text={message.payload.reasoningContent} /> : null}
      {hasMessageBubble(message) ? <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        <ConversationMarkdown value={content} desktopId={desktopId} conversationId={conversationId} request={request} color={C.text} />
      </View> : null}
      {message.payload.toolCalls?.length ? <View style={[styles.toolList, toolOnly && styles.toolListFullWidth]}>{message.payload.toolCalls.map(tool => <ToolCallCard key={tool.id || tool.name} tool={tool} pending={pendingChoices[tool.id]} writable={writable} onSubmit={onSubmitChoice} />)}</View> : null}
      <View style={[styles.messageTools, isUser && styles.messageToolsRight]}>
        <Pressable accessibilityLabel="复制消息" onPress={() => Clipboard.setString(copyText)}><AppIcon name="copy" size={17} /></Pressable>
        {editableMessage ? <Pressable disabled={!writable} accessibilityLabel="编辑消息" onPress={onEdit}><AppIcon name="edit" size={17} /></Pressable> : null}
        {editableMessage ? <Pressable disabled={!writable} accessibilityLabel="删除消息" onPress={onDelete}><AppIcon name="delete" size={17} /></Pressable> : null}
        {reask ? <Pressable onPress={reask} accessibilityLabel="重答"><AppIcon name="reask" size={17} /></Pressable> : null}
      </View>
    </View>
  );
}

function FoldCard({title, text}: {title: string; text: string}) {
  const styles = useThemedStyles(baseStyles);
  const [open, setOpen] = useState(false);
  return <View style={styles.foldCard}><Pressable style={styles.foldHeader} onPress={() => setOpen(current => !current)}><Text style={styles.foldTitle}>{title}</Text><Text style={styles.foldChevron}>{open ? '收起' : '展开'}</Text></Pressable>{open ? <Text selectable style={styles.foldText}>{text}</Text> : null}</View>;
}

function ToolCallCard({tool, pending, writable = true, onSubmit}: {tool: RemoteMessage['payload']['toolCalls'][number]; pending?: {conversationId: string; questions: Array<{question: string; header: string; options: Array<{label: string; description: string}>}>}; writable?: boolean; onSubmit: (toolCallId: string, responses: Array<Record<string, unknown>>) => Promise<void>}) {
  const styles = useThemedStyles(baseStyles);
  const [open, setOpen] = useState(false);
  return <View style={styles.toolCard}>
    <Pressable style={styles.toolHeader} onPress={() => setOpen(current => !current)}><View style={styles.toolHeaderCopy}><AppIcon name="mcp" size={16} color={C.primary} /><Text numberOfLines={1} style={styles.toolName}>调用 {tool.name || '工具'}</Text></View><Text style={styles.toolState}>{tool.status === 'choosing' || pending ? '等待选择' : tool.status || (tool.result !== undefined ? '已完成' : '处理中')}</Text></Pressable>
    {open ? <View style={styles.toolBody}>
      {pending ? <LiveChoiceCard toolCallId={tool.id} pending={pending} writable={writable} onSubmit={onSubmit} /> : <><Text style={styles.toolLabel}>输入参数</Text><Text selectable style={styles.toolCode}>{formatObject(tool.arguments)}</Text>{tool.result !== undefined ? <><Text style={styles.toolLabel}>输出结果</Text><Text selectable style={styles.toolCode}>{formatObject(tool.result)}</Text></> : null}</>}
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
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        compact && styles.actionCompact,
        danger && styles.actionDanger,
        disabled && styles.disabled,
      ]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}
function Sheet({
  visible,
  title,
  children,
  onClose,
}: {
  visible: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const styles = useThemedStyles(baseStyles);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.sheetOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable onPress={onClose}>
              <Text style={styles.link}>完成</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={styles.sheetScroll}
          >
            {children}
          </ScrollView>
        </View>
      </View>
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
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => renderBlock(item)).filter(Boolean).join('\n');
  return renderBlock(value) || '[内容]';
}

function renderBlock(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const item = value as Record<string, any>;
  if (typeof item.text === 'string') return item.text;
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
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const two = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
const baseStyles = StyleSheet.create({
  sheetScroll: { maxHeight: 520 },
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
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
  },
  topIconText: { fontSize: 22, color: C.icon, fontWeight: '600' },
  titlePress: { flex: 1, alignItems: 'center', minWidth: 0 },
  title: { fontSize: 16, color: C.text, fontWeight: '800' },
  subtitle: { fontSize: 10, color: C.muted, marginTop: 1 },
  notice: {
    backgroundColor: C.primarySoft,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  noticeText: { color: '#8C432F', fontSize: 12 },
  page: { padding: 18, paddingBottom: 42, gap: 14 },
  hero: { gap: 6, paddingVertical: 12 },
  heroTitle: { fontSize: 25, fontWeight: '800', color: C.text },
  heroText: { fontSize: 14, lineHeight: 21, color: C.muted },
  assistantGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  assistantCard: {
    width: '47%',
    minHeight: 162,
    borderRadius: 22,
    padding: 14,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.line,
    gap: 7,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.surfaceMuted,
  },
  avatarFallback: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: C.primary, fontSize: 20, fontWeight: '800' },
  assistantName: { fontSize: 15, color: C.text, fontWeight: '800' },
  assistantMeta: { fontSize: 12, color: C.muted },
  chipRow: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  chip: {
    backgroundColor: C.surfaceMuted,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 99,
  },
  chipText: { fontSize: 10, color: C.muted, fontWeight: '700' },
  ghostButton: { alignItems: 'center', padding: 12 },
  ghostText: { color: C.primary, fontWeight: '700' },
  empty: {
    margin: 24,
    padding: 22,
    borderRadius: 22,
    backgroundColor: C.surfaceMuted,
    gap: 8,
  },
  emptyTitle: { fontSize: 18, color: C.text, fontWeight: '800' },
  emptyText: { fontSize: 14, color: C.muted, lineHeight: 21 },
  drawerOverlay: { flex: 1, backgroundColor: C.overlay, flexDirection: 'row' },
  drawer: {
    width: '82%',
    maxWidth: 340,
    backgroundColor: C.background,
    padding: 18,
    gap: 16,
  },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  profileCopy: { flex: 1, minWidth: 0 },

  profileName: { fontSize: 21, fontWeight: '800', color: C.text },
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
  drawerActionText: {color: C.text, fontWeight: '700', fontSize: 14},
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
  openedSessionsEntryText: {minWidth: 0, color: C.primary, fontSize: 12, fontWeight: '800'},

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
  projectTitle: {flex: 1, color: C.text, fontSize: 16, fontWeight: '800'},
  projectCount: {color: C.muted, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums']},
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
  taskBadgeText: {fontSize: 9, color: '#fff', fontWeight: '900'},

  chat: {flex: 1},
  messageList: {padding: 16, paddingBottom: 14, gap: 16},
  messageWrap: {maxWidth: '94%', gap: 7},
  messageLeft: {alignSelf: 'flex-start'},

  toolOnlyWrap: {alignSelf: 'stretch', maxWidth: '100%', gap: 0, marginTop: 2},

  toolListFullWidth: {alignSelf: 'stretch', width: '100%'},

  messageRight: {alignSelf: 'flex-end'},
  messageIdentity: {flexDirection: 'row', alignItems: 'center', gap: 8},
  messageIdentityRight: {justifyContent: 'flex-end'},
  messageIdentityCopy: {gap: 1, minWidth: 0},
  messageIdentityCopyRight: {alignItems: 'flex-end'},
  messageNameLine: {flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 280},
  messageNameLineRight: {justifyContent: 'flex-end'},
  messageRole: {fontSize: 13, color: C.text, fontWeight: '800'},
  messageModel: {maxWidth: 150, color: C.muted, fontSize: 10},
  messageTime: {fontSize: 10, color: C.muted, fontVariant: ['tabular-nums']},
  messageTimeRight: {textAlign: 'right'},
  messageBubble: {borderRadius: 20, padding: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line},
  userBubble: {backgroundColor: C.user, borderTopRightRadius: 6},
  assistantBubble: {backgroundColor: C.surface, borderTopLeftRadius: 6},
  foldCard: {borderRadius: 14, overflow: 'hidden', backgroundColor: C.surfaceMuted},
  foldHeader: {minHeight: 35, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 11},
  foldTitle: {color: C.text, fontSize: 12, fontWeight: '800'},
  foldChevron: {color: C.primary, fontSize: 11, fontWeight: '700'},
  foldText: {paddingHorizontal: 11, paddingBottom: 11, color: C.muted, fontSize: 12, lineHeight: 18},
  toolList: {gap: 7},
  toolCard: {borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, borderRadius: 15, overflow: 'hidden', backgroundColor: C.surfaceMuted},
  toolHeader: {minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 11},
  toolHeaderCopy: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7},
  toolName: {flex: 1, color: C.text, fontSize: 12, fontWeight: '800'},
  toolState: {color: C.muted, fontSize: 10},
  toolBody: {gap: 7, padding: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.surface},
  toolLabel: {color: C.muted, fontSize: 10, fontWeight: '800'},
  toolCode: {maxHeight: 180, padding: 9, borderRadius: 10, backgroundColor: C.surfaceMuted, color: C.text, fontFamily: 'monospace', fontSize: 11, lineHeight: 16},
  toolError: {color: C.danger, fontSize: 12},
  choiceWrap: {gap: 10, paddingTop: 3},
  choiceQuestion: {gap: 6},
  choiceHeading: {flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap'},
  choiceTag: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 7, overflow: 'hidden', backgroundColor: C.primarySoft, color: C.primary, fontSize: 10, fontWeight: '800'},
  choiceText: {flex: 1, color: C.text, fontSize: 13, lineHeight: 19, fontWeight: '700'},
  choiceOption: {flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 9, borderRadius: 11, backgroundColor: C.surfaceMuted, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line},
  choiceOptionActive: {backgroundColor: C.primarySoft, borderColor: C.primary},
  choiceRadio: {width: 17, height: 17, marginTop: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderWidth: 1.5, borderColor: C.muted},
  choiceRadioDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: C.primary},
  choiceOptionCopy: {flex: 1, minWidth: 0, gap: 2},
  choiceOptionLabel: {color: C.text, fontSize: 13, fontWeight: '700'},
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
  conversationControlText: {color: C.primary, fontSize: 12, fontWeight: '800'},

  composerInput: {
    minHeight: 46,
    maxHeight: 110,
    color: C.text,
    fontSize: 16,
    textAlignVertical: 'top',
    paddingHorizontal: 6,
  },
  composerActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  iconAction: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primarySoft,
  },
  iconActionText: { fontSize: 23, color: C.primary },
  iconActionActive: { backgroundColor: '#F6DADD' },
  recordingPanel: {
    minHeight: 46,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 14,
    backgroundColor: C.primarySoft,
  },
  recordingText: { color: '#8C432F', fontWeight: '700' },
  statusPills: { flex: 1, flexDirection: 'row', gap: 4, overflow: 'hidden' },
  action: {
    backgroundColor: C.primary,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    paddingHorizontal: 18,
  },
  actionCompact: { minHeight: 36, borderRadius: 18, paddingHorizontal: 14 },
  actionDanger: { backgroundColor: C.danger },
  actionText: { color: '#fff', fontWeight: '800' },
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
  link: { color: C.primary, fontWeight: '700' },
  sheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: C.overlay,
  },
  sheet: {
    backgroundColor: C.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    paddingBottom: 32,
    gap: 14,
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
  sheetTitle: { fontSize: 22, fontWeight: '800', color: C.text },
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
  assistantCodeText: {color: C.muted, fontSize: 9, fontWeight: '700'},
  sessionIntro: {padding: 13, borderRadius: 16, backgroundColor: C.primarySoft, gap: 3},
  sessionIntroTitle: {color: '#8C432F', fontSize: 15, fontWeight: '800'},
  sessionIntroText: {color: '#8C432F', fontSize: 12, lineHeight: 18},
  sessionTabs: {gap: 7, paddingVertical: 2},
  sessionSection: {gap: 11, paddingVertical: 4},
  sessionSectionTitle: {color: C.text, fontSize: 16, fontWeight: '800'},
  sessionLabel: {color: C.muted, fontSize: 12, fontWeight: '700'},
  sessionHint: {color: C.muted, fontSize: 12, lineHeight: 18},
  modelGroups: {gap: 10},
  modelGroup: {gap: 6, padding: 11, borderRadius: 15, backgroundColor: C.surfaceMuted},
  reasoningTrack: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 4},
  reasoningNode: {flex: 1, minWidth: 0, alignItems: 'center', gap: 5},
  reasoningDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: '#A9A197'},
  reasoningDotActive: {backgroundColor: C.primary, transform: [{scale: 1.35}]},
  reasoningLabel: {fontSize: 9, color: C.muted, textAlign: 'center'},
  reasoningLabelActive: {color: C.primary, fontWeight: '800'},
  toolTabs: {flexDirection: 'row', gap: 7},
  toolSelectList: {gap: 7},
  toolSelectRow: {minHeight: 53, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, borderRadius: 15, backgroundColor: C.surfaceMuted, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line},
  toolSelectRowActive: {backgroundColor: C.primarySoft, borderColor: C.primary},
  toolSelectIcon: {width: 29, height: 29, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface},
  toolSelectName: {flex: 1, color: C.text, fontSize: 14, fontWeight: '700'},
  toolSelectCheck: {width: 18, color: C.primary, fontSize: 17, fontWeight: '900', textAlign: 'right'},
  compactAction: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},

  contextInfo: {minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 13, borderRadius: 15, backgroundColor: C.surfaceMuted},
  contextInfoLabel: {color: C.text, fontSize: 14, fontWeight: '800'},
  contextInfoValue: {color: C.muted, fontSize: 13},
  sessionSelectList: {gap: 8},
  sessionSelectRow: {minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 13, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, backgroundColor: C.surfaceMuted},
  sessionSelectRowActive: {borderColor: C.primary, backgroundColor: C.primarySoft},
  sessionSelectTitle: {flex: 1, minWidth: 0, color: C.text, fontSize: 14, fontWeight: '700'},
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
  openedSessionCopy: {flex: 1, minWidth: 0, gap: 4},
  openedSessionTitle: {color: C.text, fontSize: 14, fontWeight: '800'},
  openedSessionMeta: {color: C.muted, fontSize: 11, lineHeight: 16},

  liveChoiceCard: {marginHorizontal: 16, marginBottom: 10, gap: 12, padding: 13, borderRadius: 19, borderWidth: 1, borderColor: C.primary, backgroundColor: C.surface},
  liveChoiceQuestion: {gap: 8},
  choiceBadge: {width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: C.surfaceMuted},
  choiceBadgeText: {color: C.text, fontSize: 12, fontWeight: '900'},
  choiceCustom: {gap: 7, padding: 11, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, backgroundColor: C.surfaceMuted},
  choiceCustomActive: {borderColor: C.primary, backgroundColor: C.primarySoft},
  choiceCustomTitle: {color: C.text, fontSize: 13, fontWeight: '800'},
  choiceCustomInput: {minHeight: 42, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: C.primary, backgroundColor: C.surface, color: C.text, textAlignVertical: 'top'},
  choiceDiscuss: {minHeight: 42, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 13, backgroundColor: C.surfaceMuted},
  choiceDiscussText: {color: C.text, fontSize: 13, fontWeight: '700'},
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
  tagText: { color: C.muted, fontWeight: '700' },
  tagTextActive: { color: C.primary },
  settingsCard: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 16,
    gap: 13,
    borderWidth: 1,
    borderColor: C.line,
  },
  settingsHeading: { fontSize: 19, color: C.text, fontWeight: '800' },
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
  settingsListTitle: { fontSize: 15, color: C.text, fontWeight: '700' },
  settingsListMeta: { fontSize: 12, color: C.muted },
  chevron: { fontSize: 24, color: C.muted },
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
  fieldLabel: { fontSize: 13, color: C.text, fontWeight: '700' },
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
