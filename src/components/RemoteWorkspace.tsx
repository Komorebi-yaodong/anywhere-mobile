import {TextInput, ActivityIndicator} from './ThemedNative';
import {useMemo, useState} from 'react';
import {

  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,

  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import type {DesktopRuntime} from '../hooks/useDesktops';
import {useConversationWorkspace} from '../hooks/useConversationWorkspace';
import {useAttachmentQueue} from '../hooks/useAttachmentQueue';
import type {
  RemoteMessage,
  RemoteAssistant,
  RemoteRequest,
  RemoteTrackedRequest,
} from '../remote/api';
import type {RemoteEventMessage} from '../remote/client';

import {RemoteSettings} from './RemoteSettings';
import {ConversationActions, ConversationAction} from './ConversationActions';

export function RemoteWorkspace({
  desktop,
  request,
  requestTracked,
  subscribeEvents,
  onBack,
}: {
  desktop: DesktopRuntime;
  request: RemoteRequest;
  requestTracked: RemoteTrackedRequest;
  subscribeEvents: (
    listener: (desktopId: string, event: RemoteEventMessage) => void,
  ) => () => void;
  onBack: () => void;
}) {
  const workspace = useConversationWorkspace({
    desktopId: desktop.id,
    desktopStatus: desktop.status,
    request,
    requestTracked,
    subscribeEvents,
  });
  const attachments = useAttachmentQueue(desktop.id, request);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [action, setAction] = useState<ConversationAction | null>(null);
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);
  const [assistants, setAssistants] = useState<RemoteAssistant[]>([]);
  const [assistantsLoading, setAssistantsLoading] = useState(false);
  const [assistantError, setAssistantError] = useState('');
  const [assistantQuery, setAssistantQuery] = useState('');
  const openNewConversation = async () => {
    setShowAssistantPicker(true);
    setAssistants([]);
    setAssistantQuery('');
    setAssistantError('');
    setAssistantsLoading(true);
    try { setAssistants((await workspace.listAssistants()).assistants); }
    catch { setAssistantError('无法读取快捷助手，请确认 Desktop 已更新且在线。'); }
    finally { setAssistantsLoading(false); }
  };
  const createWithAssistant = async (code: string) => {
    setAssistantError('');
    try {
      await workspace.createConversation(code);
      setShowAssistantPicker(false);
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : '新建失败，请刷新列表检查是否已创建，勿连续重复操作。');
    }
  };

  const lastAssistantId = [...workspace.messages].reverse().find(item => item.role === 'assistant')?.uiMessageId;
  const reportError = (error: unknown) => Alert.alert('操作失败', error instanceof Error ? error.message : '请确认 Desktop 状态。');

  const selectedTitle =
    workspace.selectedConversation?.title || '选择一个会话';
  const activeForSelected =
    workspace.activeTurn?.conversationId === workspace.selectedConversationId
      ? workspace.activeTurn
      : null;

  const send = async () => {
    if ((!draft.trim() && attachments.uploads.length === 0) || sending || attachments.busy || activeForSelected && !activeForSelected.terminal) {
      return;
    }
    const text = draft;
    setDraft('');
    setSending(true);
    try {
      await workspace.sendMessage(text, attachments.uploads.map(item => item.uploadId));
      attachments.markSubmitted();
    } catch {
      setDraft(text);
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <Modal visible={showAssistantPicker} animationType="slide" onRequestClose={() => { if (!workspace.creatingConversation) setShowAssistantPicker(false); }}>
        <SafeAreaView style={styles.safe}>
          <View style={styles.topbar}>
            <Text style={styles.chatTitle}>选择快捷助手</Text>
            <Pressable disabled={workspace.creatingConversation} style={styles.smallButton} onPress={() => setShowAssistantPicker(false)}><Text style={styles.smallButtonText}>取消</Text></Pressable>
          </View>
          <TextInput style={styles.assistantSearch} value={assistantQuery} onChangeText={setAssistantQuery} placeholder="搜索 Desktop 快捷助手" placeholderTextColor="#72839f" />
          {assistantsLoading || workspace.creatingConversation ? <ActivityIndicator color="#70a7ff" /> : null}
          {workspace.creatingConversation ? <Text style={styles.chatSubtitle}>正在创建…</Text> : null}
          {assistantError ? <Text style={styles.errorBanner}>{assistantError}</Text> : null}
          <ScrollView>
            {assistants.filter(item => item.name.toLowerCase().includes(assistantQuery.toLowerCase())).map(item => (
              <Pressable key={item.code} disabled={workspace.creatingConversation} style={styles.conversationCard} onPress={() => createWithAssistant(item.code)}>
                <Text style={styles.conversationTitle}>{item.name}</Text>
              </Pressable>
            ))}
            {!assistantsLoading && assistants.length === 0 && !assistantError ? <Text style={styles.chatSubtitle}>Desktop 没有启用的快捷助手。</Text> : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <View style={styles.topbar}>
        <Pressable style={styles.backButton} onPress={onBack}>
          <Text style={styles.backText}>‹ 桌面</Text>
        </Pressable>
        <View style={styles.topbarTitle}>
          <Text style={styles.desktopName}>{desktop.name}</Text>
          <Text style={styles.desktopStatus}>{desktop.status}</Text>
        </View>
        <Pressable style={styles.iconButton} onPress={() => setShowSettings(true)}>
          <Text style={styles.iconText}>设置</Text>
        </Pressable>

        <Pressable style={styles.iconButton} onPress={() => workspace.refreshCatalog()}>
          <Text style={styles.iconText}>刷新</Text>
        </Pressable>
      </View>

      {desktop.status !== '在线' ? (
        <View style={styles.centerCard}>
          <Text style={styles.centerTitle}>正在连接</Text>
          <Text style={styles.centerText}>{desktop.detail || '请确认 Desktop Remote 已开启且设备未被撤销。'}</Text>
        </View>
      ) : !workspace.configured ? (
        <View style={styles.centerCard}>
          <Text style={styles.centerTitle}>Desktop 尚未配置会话目录</Text>
          <Text style={styles.centerText}>请先在桌面端设置会话目录。</Text>
        </View>
      ) : (
        <View style={styles.body}>
          <View style={styles.catalogPane}>
            <Text style={styles.paneTitle}>会话</Text>
            <Pressable style={styles.smallButton} disabled={workspace.creatingConversation} onPress={openNewConversation}>
              <Text style={styles.smallButtonText}>＋ 新建会话</Text>
            </Pressable>
            <ScrollView style={styles.catalogScroll}>
              {workspace.catalog.map(item => (
                <Pressable
                  key={item.conversationId}
                  disabled={!item.readable}
                  onPress={() => workspace.selectConversation(item.conversationId)}
                  style={[
                    styles.conversationCard,
                    item.conversationId === workspace.selectedConversationId &&
                      styles.conversationCardActive,
                    !item.readable && styles.disabled,
                  ]}>
                  <Text numberOfLines={2} style={styles.conversationTitle}>{item.title}</Text>
                  <Text style={styles.conversationMeta}>
                    {item.project?.name || '未分组'} · {formatTime(item.updatedAt)}
                  </Text>
                  {item.window?.generating || item.window?.busy ? (
                    <Text style={styles.busyText}>Desktop 正在处理</Text>
                  ) : null}
                  {item.migrationRequired ? (
                    <Text style={styles.warningText}>需先在 Desktop 迁移</Text>
                  ) : null}
                </Pressable>
              ))}
              {workspace.catalogPage.hasMore ? (
                <Pressable style={styles.moreButton} onPress={() => workspace.loadMoreCatalog()}>
                  <Text style={styles.moreText}>加载更多会话</Text>
                </Pressable>
              ) : null}
              {workspace.catalogLoading ? <ActivityIndicator color="#70a7ff" /> : null}
            </ScrollView>
          </View>

          <View style={styles.chatPane}>
            <View style={styles.chatHeader}>
              <View style={styles.chatTitleWrap}>
                <Text numberOfLines={1} style={styles.chatTitle}>{selectedTitle}</Text>
              </View>
              <Pressable
                disabled={!workspace.selectedConversationId}
                style={styles.smallButton}
                onPress={() =>
                  workspace.showSelectedOnDesktop().catch(() => undefined)
                }>
                <Text style={styles.smallButtonText}>在桌面显示</Text>
              </Pressable>
            </View>

            {workspace.selectedConversationId ? <View style={styles.chatHeader}>
              <Pressable style={styles.smallButton} onPress={() => setAction({method: 'conversation.rename', title: selectedTitle})}><Text style={styles.smallButtonText}>重命名</Text></Pressable>
              <Pressable style={styles.smallButton} onPress={() => setAction({method: 'conversation.delete'})}><Text style={styles.smallButtonText}>删除会话</Text></Pressable>
            </View> : null}


            <ScrollView style={styles.messages} contentContainerStyle={styles.messagesContent}>
              {workspace.messagePage.hasMore ? (
                <Pressable style={styles.moreButton} onPress={() => workspace.loadOlderMessages()}>
                  <Text style={styles.moreText}>加载更早消息</Text>
                </Pressable>
              ) : null}
              {workspace.messagesLoading && workspace.messages.length === 0 ? (
                <ActivityIndicator color="#70a7ff" />
              ) : null}
              {workspace.messages.map(message => (
                <MessageBubble
                  key={message.uiMessageId}
                  message={message}
                  canReask={message.uiMessageId === lastAssistantId}
                  onAction={setAction}
                  onReask={() => Alert.alert('重答最后一条回复？', 'Desktop 将重新生成最后一条 assistant 回复。', [
                    {text: '取消', style: 'cancel'},
                    {text: '重答', onPress: () => workspace.reaskLastAssistant(message.uiMessageId).catch(reportError)},
                  ])}
                />
              ))}
              {activeForSelected && !activeForSelected.historyLoaded && (
                <View style={styles.liveBlock}>
                  {activeForSelected.submittedText ? (
                    <View style={[styles.bubble, styles.userBubble]}>
                      <Text style={styles.bubbleRole}>你 · 正在发送</Text>
                      <Text style={styles.bubbleText}>{activeForSelected.submittedText}</Text>
                    </View>
                  ) : null}
                  <View style={[styles.bubble, styles.assistantBubble, styles.liveBubble]}>
                    <Text style={styles.bubbleRole}>
                      {activeForSelected.terminal ? 'Anywhere' : 'Anywhere · 生成中'}
                    </Text>
                    {activeForSelected.reasoning ? (
                      <>
                        <Pressable onPress={() => setShowReasoning(value => !value)}>
                          <Text style={styles.reasoningToggle}>
                            {showReasoning ? '隐藏思考过程' : '查看思考过程'}
                          </Text>
                        </Pressable>
                        {showReasoning ? (
                          <Text style={styles.reasoningText}>{activeForSelected.reasoning}</Text>
                        ) : null}
                      </>
                    ) : null}
                    <Text style={styles.bubbleText}>
                      {activeForSelected.text || (activeForSelected.terminal ? '本次请求未返回文本。' : '等待回复…')}
                    </Text>
                    {activeForSelected.errorCode ? (
                      <Text style={styles.errorText}>{activeForSelected.errorCode}</Text>
                    ) : null}
                    {activeForSelected.truncated ? (
                      <Text style={styles.warningText}>恢复文本已截断，请刷新历史获取完整消息。</Text>
                    ) : null}
                  </View>
                </View>
              )}
            </ScrollView>

            {workspace.error ? <Text style={styles.errorBanner}>{workspace.error}</Text> : null}
            {attachments.uploads.map(upload => <View key={upload.uploadId} style={styles.chatHeader}>
              <Text style={styles.chatSubtitle}>{upload.name} · {Math.ceil(upload.size / 1024)} KiB</Text>
              <Pressable onPress={() => attachments.remove(upload.uploadId)}><Text style={styles.moreText}>移除附件</Text></Pressable>
            </View>)}
            {attachments.progress ? <Text style={styles.chatSubtitle}>{attachments.progress}</Text> : null}
            {attachments.error ? <Text style={styles.errorBanner}>{attachments.error}</Text> : null}

            <View style={styles.composer}>
              <Pressable style={styles.smallButton} disabled={!workspace.selectedConversationId} onPress={attachments.busy ? attachments.cancel : attachments.add}>
                <Text style={styles.smallButtonText}>{attachments.busy ? '取消上传' : '附件'}</Text>
              </Pressable>

              <TextInput
                value={draft}
                onChangeText={setDraft}
                editable={!!workspace.selectedConversationId}
                multiline
                placeholder="发送到当前会话…"
                placeholderTextColor="#72839f"
                style={styles.composerInput}
              />
              {activeForSelected && !activeForSelected.terminal ? (
                <Pressable
                  style={[styles.sendButton, styles.cancelButton]}
                  onPress={() => workspace.cancelActiveTurn().catch(() => undefined)}>
                  <Text style={styles.sendText}>停止</Text>
                </Pressable>
              ) : (
                <Pressable
                  disabled={(!draft.trim() && attachments.uploads.length === 0) || sending || attachments.busy || !workspace.selectedConversationId}
                  style={[
                    styles.sendButton,
                    ((!draft.trim() && attachments.uploads.length === 0) || sending || attachments.busy || !workspace.selectedConversationId) && styles.disabled,
                  ]}
                  onPress={send}>
                  <Text style={styles.sendText}>发送</Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      )}
      {showSettings ? <RemoteSettings
        desktopId={desktop.id}
        conversationId={workspace.selectedConversationId}
        request={request}
        requestTracked={requestTracked}
        onClose={() => setShowSettings(false)}
        onChanged={() => workspace.refreshCatalog()}
      /> : null}
      {action && workspace.selectedConversationId ? <ConversationActions
        key={`${workspace.selectedConversationId}-${action.method}`}
        desktopId={desktop.id}
        conversationId={workspace.selectedConversationId}
        action={action}
        request={request}
        requestTracked={requestTracked}
        onClose={() => setAction(null)}
        onCompleted={() => {
          setAction(null);
          workspace.refreshCatalog();
          workspace.refreshMessages();
        }}
      /> : null}

    </SafeAreaView>
  );
}

function MessageBubble({message, canReask, onAction, onReask}: {
  message: RemoteMessage;
  canReask: boolean;
  onAction: (action: ConversationAction) => void;
  onReask: () => void;
}) {
  const isUser = message.role === 'user';
  const reasoning = message.payload.reasoningContent;
  const [showReasoning, setShowReasoning] = useState(false);
  const content = useMemo(
    () => renderableContent(message.payload.content),
    [message.payload.content],
  );
  return (
    <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
      <Text style={styles.bubbleRole}>{roleLabel(message.role)}</Text>
      {reasoning ? (
        <>
          <Pressable onPress={() => setShowReasoning(value => !value)}>
            <Text style={styles.reasoningToggle}>{showReasoning ? '隐藏思考' : '查看思考'}</Text>
          </Pressable>
          {showReasoning ? <Text style={styles.reasoningText}>{reasoning}</Text> : null}
        </>
      ) : null}
      <Text selectable style={styles.bubbleText}>{content}</Text>
      {message.payload.toolCalls.length > 0 ? (
        <Text style={styles.toolText}>
          工具：{message.payload.toolCalls.map(tool => `${tool.name || tool.id} (${tool.status || 'unknown'})`).join('、')}
        </Text>
      ) : null}
      {message.role === 'user' || message.role === 'assistant' ? <View>
        {typeof message.payload.content === 'string' ? <Pressable onPress={() => onAction({method: 'conversation.message.edit', uiMessageId: message.uiMessageId, content: message.payload.content as string})}><Text style={styles.moreText}>编辑</Text></Pressable> : null}
        <Pressable onPress={() => onAction({method: 'conversation.message.delete', uiMessageId: message.uiMessageId})}><Text style={styles.moreText}>删除</Text></Pressable>
        {canReask ? <Pressable onPress={onReask}><Text style={styles.moreText}>重答最后回复</Text></Pressable> : null}
      </View> : null}

      <Text style={styles.timestamp}>{formatTime(message.payload.completedTimestamp || message.payload.timestamp)}</Text>
    </View>
  );
}

function renderableContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => renderableBlock(item)).filter(Boolean).join('\n');
  }
  return renderableBlock(value) || '[结构化消息]';
}

function renderableBlock(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  const name = typeof item.filename === 'string'
    ? item.filename
    : typeof item.name === 'string'
      ? item.name
      : '';
  if (item.type === 'audio') return `[音频${name ? `：${name}` : ''}]`;
  if (item.type === 'file') return `[附件${name ? `：${name}` : ''}]`;
  if (item.type === 'image_url' || item.type === 'image') return `[图片${name ? `：${name}` : ''}]`;
  if (typeof item.attachmentId === 'string') return `[附件${name ? `：${name}` : ''}]`;
  return '[结构化内容]';
}

function roleLabel(role: string): string {
  if (role === 'user') return '你';
  if (role === 'assistant') return 'Anywhere';
  if (role === 'system') return '系统提示';
  if (role === 'compaction') return '会话摘要';
  return role;
}

function formatTime(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})
    : '未知时间';
}

const styles = StyleSheet.create({
  assistantSearch: {color: '#fff', height: 48, margin: 12, backgroundColor: '#0d1d31', borderRadius: 10, paddingHorizontal: 12},

  safe: {flex: 1, backgroundColor: '#07111f'}, topbar: {height: 62, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#1c304b', flexDirection: 'row', alignItems: 'center', gap: 10}, backButton: {paddingVertical: 8, paddingRight: 8}, backText: {color: '#88b8ff', fontWeight: '800'}, topbarTitle: {flex: 1}, desktopName: {color: '#fff', fontSize: 17, fontWeight: '800'}, desktopStatus: {color: '#8fa8cc', marginTop: 2, fontSize: 12}, iconButton: {backgroundColor: '#172a44', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8}, iconText: {color: '#dbe9ff', fontWeight: '700'}, centerCard: {margin: 24, backgroundColor: '#10213a', borderRadius: 14, padding: 22}, centerTitle: {color: '#fff', fontWeight: '800', fontSize: 18}, centerText: {color: '#bed0e9', lineHeight: 21, marginTop: 8}, body: {flex: 1, flexDirection: 'row'}, catalogPane: {width: 150, borderRightWidth: 1, borderRightColor: '#1c304b', backgroundColor: '#0a1728'}, paneTitle: {color: '#fff', fontWeight: '800', fontSize: 16, padding: 12}, catalogScroll: {flex: 1, paddingHorizontal: 8}, conversationCard: {padding: 10, borderRadius: 10, marginBottom: 8, backgroundColor: '#10213a'}, conversationCardActive: {backgroundColor: '#1c4678', borderColor: '#6aa7ff', borderWidth: 1}, conversationTitle: {color: '#fff', fontWeight: '700', fontSize: 13}, conversationMeta: {color: '#8fa8c5', fontSize: 10, marginTop: 6}, busyText: {color: '#ffda7a', fontSize: 10, marginTop: 4}, warningText: {color: '#ffc078', fontSize: 11, marginTop: 6}, chatPane: {flex: 1}, chatHeader: {minHeight: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#1c304b'}, chatTitleWrap: {flex: 1}, chatTitle: {color: '#fff', fontWeight: '800', fontSize: 16}, chatSubtitle: {color: '#839aba', fontSize: 11, marginTop: 3}, smallButton: {backgroundColor: '#172a44', borderRadius: 8, padding: 8}, smallButtonText: {color: '#cfe1ff', fontSize: 11, fontWeight: '700'}, messages: {flex: 1}, messagesContent: {padding: 12, paddingBottom: 20}, bubble: {borderRadius: 12, padding: 12, marginBottom: 10, maxWidth: '94%'}, userBubble: {backgroundColor: '#244f82', alignSelf: 'flex-end'}, assistantBubble: {backgroundColor: '#11243d', alignSelf: 'flex-start'}, liveBlock: {marginTop: 4}, liveBubble: {borderWidth: 1, borderColor: '#37699f'}, bubbleRole: {color: '#8fbfff', fontWeight: '800', fontSize: 11, marginBottom: 6}, bubbleText: {color: '#eef5ff', lineHeight: 20}, reasoningToggle: {color: '#9eb8d8', fontSize: 11, marginBottom: 5}, reasoningText: {color: '#adbed5', backgroundColor: '#081627', borderRadius: 8, padding: 8, lineHeight: 18, marginBottom: 8}, toolText: {color: '#a8bdd8', fontSize: 11, marginTop: 9}, timestamp: {color: '#7186a4', fontSize: 10, marginTop: 8}, errorText: {color: '#ff9da7', marginTop: 8}, errorBanner: {color: '#ffd3d7', backgroundColor: '#55252c', padding: 8, fontSize: 11}, composer: {borderTopWidth: 1, borderTopColor: '#1c304b', padding: 10, flexDirection: 'row', alignItems: 'flex-end', gap: 8}, composerInput: {flex: 1, color: '#fff', minHeight: 42, maxHeight: 120, backgroundColor: '#0d1d31', borderRadius: 10, paddingHorizontal: 12, paddingTop: 10, textAlignVertical: 'top'}, sendButton: {height: 42, minWidth: 54, backgroundColor: '#3e7bd1', borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10}, cancelButton: {backgroundColor: '#9c414c'}, sendText: {color: '#fff', fontWeight: '800'}, moreButton: {padding: 9, alignItems: 'center'}, moreText: {color: '#7eaff4', fontWeight: '700', fontSize: 11}, disabled: {opacity: 0.45},
});
