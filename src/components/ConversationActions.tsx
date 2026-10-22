import {useThemedStyles} from './theme';
import {TextInput} from './ThemedNative';
import {useEffect, useRef, useState} from 'react';
import {Alert, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import type {ConversationRequestState, RemoteRequest, RemoteTrackedRequest} from '../remote/api';
import {RemoteCommandPendingError, startCommand, waitForCommand} from '../remote/commands';

export type ConversationAction =
  | {method: 'conversation.rename'; title: string}
  | {method: 'conversation.delete'}
  | {method: 'conversation.message.edit'; uiMessageId: string; content: string}
  | {method: 'conversation.message.delete'; uiMessageId: string};

export function ConversationActions({desktopId, conversationId, action, request, requestTracked, onClose, onCompleted}: {
  desktopId: string;
  conversationId: string;
  action: ConversationAction;
  request: RemoteRequest;
  requestTracked: RemoteTrackedRequest;
  onClose: () => void;
  onCompleted: (state: ConversationRequestState) => void;
}) {
  const styles = useThemedStyles(baseStyles);
  const [draft, setDraft] = useState(action.method === 'conversation.rename' ? action.title : action.method === 'conversation.message.edit' ? action.content : '');
  const [pendingId, setPendingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [finished, setFinished] = useState<'' | 'success' | 'failed'>('');
  const settled = useRef(false);
  const submitting = useRef(false);
  const controller = useRef(new AbortController());
  useEffect(() => () => controller.current.abort(), []);
  const destructive = action.method === 'conversation.delete' || action.method === 'conversation.message.delete';
  const isMessageDelete = action.method === 'conversation.message.delete';
  const label = action.method === 'conversation.rename' ? '重命名会话' : action.method === 'conversation.delete' ? '删除整个会话' : action.method === 'conversation.message.edit' ? '编辑消息' : '删除消息';
  const title = isMessageDelete ? '确认删除？' : label;
  const submit = async (recover = false) => {
    if (submitting.current || settled.current || (pendingId && !recover)) return;
    submitting.current = true;
    setBusy(true);
    setNotice('');
    try {
      let completion: Promise<ConversationRequestState>;
      if (recover) {
        completion = waitForCommand({desktopId, requestId: pendingId, request, signal: controller.current.signal});
      } else {
        const params: Record<string, unknown> = {conversationId};
        if ('uiMessageId' in action) params.uiMessageId = action.uiMessageId;
        if (action.method === 'conversation.rename') params.title = draft.trim();
        if (action.method === 'conversation.message.edit') params.content = draft;
        if (action.method === 'conversation.delete') params.confirmed = true;
        const receipt = startCommand({desktopId, method: action.method, params, request, requestTracked, signal: controller.current.signal});
        setPendingId(receipt.requestId);
        completion = receipt.completion;
      }
      const state = await completion;
      if (controller.current.signal.aborted) return;
      setPendingId('');
      setNotice('');
      settled.current = true;
      setFinished('success');
      onCompleted(state);
    } catch (error) {
      if (controller.current.signal.aborted) return;
      if (error instanceof RemoteCommandPendingError) {
        setPendingId(error.requestId);
        setNotice('');
      } else {
        setPendingId('');
        // A failed result can follow an applied mutation (older Desktop builds).
        // Do not offer another destructive submit within the same confirmation.
        if (destructive) { settled.current = true; setFinished('failed'); }
        const code = error instanceof Error ? error.message : '';
        const messages: Record<string, string> = {
          remote_message_state_changed: '消息已变化，请刷新',
          remote_message_not_found: '消息已不存在',
          remote_conversation_save_failed: '保存失败，请刷新检查',
          remote_conversation_busy: '会话处理中',
        };
        setNotice(messages[code] || '操作失败，请刷新检查');
      }
    } finally {
      submitting.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  };
  const retry = useRef(submit);
  retry.current = submit;
  useEffect(() => {
    if (!pendingId || busy || finished) return;
    const timer = setTimeout(() => {retry.current(true);}, 2500);
    return () => clearTimeout(timer);
  }, [pendingId, busy, finished]);

  const confirm = () => Alert.alert(`${label}？`, destructive
    ? '删除后无法恢复。'
    : '确认保存修改？', [
    {text: '取消', style: 'cancel'},
    {text: '确认', style: destructive ? 'destructive' : 'default', onPress: () => submit()},
  ]);
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View style={styles.panel}>
        <Text style={styles.title}>{title}</Text>
        {isMessageDelete && !busy && !pendingId && !finished ? <Text style={styles.subtitle}>删除后将无法找回</Text> : null}
        {!destructive ? <TextInput multiline={action.method === 'conversation.message.edit'} style={styles.input} value={draft} onChangeText={setDraft} editable={!busy && !pendingId} placeholder={action.method === 'conversation.message.edit' ? '输入消息内容' : '会话名称'} placeholderTextColor="#A9A29A" maxLength={action.method === 'conversation.rename' ? 240 : 131072} /> : null}

        {notice && !busy ? <Text style={styles.notice}>{notice}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            disabled={busy || Boolean(pendingId) || Boolean(finished) || (!destructive && !draft.trim())}
            style={[styles.button, styles.primaryButton, (busy || pendingId || finished || (!destructive && !draft.trim())) && styles.disabled]}
            onPress={pendingId ? () => submit(true) : isMessageDelete ? () => submit() : confirm}
          >
            <Text style={styles.primaryText}>{busy || pendingId ? (destructive ? '正在删除' : '正在更新') : finished ? finished === 'success' ? '已完成' : '请关闭后刷新' : '确认'}</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.secondaryButton]} onPress={onClose}>
            <Text style={styles.secondaryText}>{pendingId || finished ? '关闭' : '取消'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}
const baseStyles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(41,39,36,0.42)', justifyContent: 'center', alignItems: 'center', padding: 24},
  panel: {width: '100%', maxWidth: 340, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 18, backgroundColor: '#FFFFFF', borderRadius: 22, borderWidth: 1, borderColor: '#E7E1D8', gap: 12},
  title: {color: '#292724', fontSize: 16, fontWeight: '600', textAlign: 'center'},
  subtitle: {color: '#79746C', fontSize: 14, lineHeight: 20, textAlign: 'center'},
  input: {color: '#292724', backgroundColor: '#F2F0E9', minHeight: 76, maxHeight: 260, padding: 12, textAlignVertical: 'top', borderRadius: 14, fontSize: 15},
  notice: {color: '#79746C', fontSize: 12, lineHeight: 18, textAlign: 'center'},
  actions: {flexDirection: 'row', gap: 10, marginTop: 4},
  button: {flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 15},
  primaryButton: {backgroundColor: '#C96849'},
  secondaryButton: {backgroundColor: '#F2F0E9'},
  primaryText: {color: '#FFFFFF', fontSize: 15, fontWeight: '600'},
  secondaryText: {color: '#504B43', fontSize: 15, fontWeight: '600'},
  disabled: {opacity: 0.45},
});
