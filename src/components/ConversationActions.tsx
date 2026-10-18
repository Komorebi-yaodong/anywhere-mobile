import {useEffect, useRef, useState} from 'react';
import {Alert, Modal, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
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
  const [draft, setDraft] = useState(action.method === 'conversation.rename' ? action.title : action.method === 'conversation.message.edit' ? action.content : '');
  const [pendingId, setPendingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const controller = useRef(new AbortController());
  useEffect(() => () => controller.current.abort(), []);
  const destructive = action.method === 'conversation.delete' || action.method === 'conversation.message.delete';
  const isMessageDelete = action.method === 'conversation.message.delete';
  const label = action.method === 'conversation.rename' ? '重命名会话' : action.method === 'conversation.delete' ? '删除整个会话' : action.method === 'conversation.message.edit' ? '编辑消息' : '删除消息';
  const title = isMessageDelete ? '确认删除？' : label;
  const submit = async (recover = false) => {
    if (busy || (pendingId && !recover)) return;
    setBusy(true);
    setNotice('正在等待 Desktop Writer 完成…');
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
      setNotice('Desktop 已确认完成。');
      onCompleted(state);
    } catch (error) {
      if (controller.current.signal.aborted) return;
      if (error instanceof RemoteCommandPendingError) {
        setPendingId(error.requestId);
        setNotice(error.message);
      } else {
        setPendingId('');
        setNotice(error instanceof Error ? error.message : '操作失败。');
      }
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  };
  const confirm = () => Alert.alert(`${label}？`, destructive
    ? '此操作会改变 Desktop 的真实历史记录，不能通过本页撤销。确认后将交由 Desktop 唯一 Writer 执行。'
    : '将修改 Desktop 当前会话的持久化内容，请确认。', [
    {text: '取消', style: 'cancel'},
    {text: '确认', style: destructive ? 'destructive' : 'default', onPress: () => submit()},
  ]);
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View style={styles.panel}>
        <Text style={styles.title}>{title}</Text>
        {isMessageDelete ? <Text style={styles.subtitle}>删除后将无法找回</Text> : null}
        {!destructive ? <TextInput multiline={action.method === 'conversation.message.edit'} style={styles.input} value={draft} onChangeText={setDraft} editable={!busy && !pendingId} placeholder={action.method === 'conversation.message.edit' ? '输入消息内容' : '会话名称'} placeholderTextColor="#A9A29A" maxLength={action.method === 'conversation.rename' ? 240 : 131072} /> : null}
        {destructive && !isMessageDelete ? <Text style={styles.subtitle}>删除后将无法找回</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {pendingId ? <Text selectable style={styles.notice}>原请求：{pendingId}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            disabled={busy || (!destructive && !draft.trim())}
            style={[styles.button, styles.primaryButton, (busy || (!destructive && !draft.trim())) && styles.disabled]}
            onPress={pendingId ? () => submit(true) : isMessageDelete ? () => submit() : confirm}
          >
            <Text style={styles.primaryText}>{busy ? '等待确认…' : pendingId ? '查询原请求' : '确认'}</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.secondaryButton]} onPress={onClose}>
            <Text style={styles.secondaryText}>{pendingId ? '关闭' : '取消'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}
const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(41,39,36,0.42)', justifyContent: 'center', alignItems: 'center', padding: 24},
  panel: {width: '100%', maxWidth: 340, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 18, backgroundColor: '#FFFFFF', borderRadius: 22, borderWidth: 1, borderColor: '#E7E1D8', gap: 12},
  title: {color: '#292724', fontSize: 18, fontWeight: '800', textAlign: 'center'},
  subtitle: {color: '#79746C', fontSize: 14, lineHeight: 20, textAlign: 'center'},
  input: {color: '#292724', backgroundColor: '#F2F0E9', minHeight: 76, maxHeight: 260, padding: 12, textAlignVertical: 'top', borderRadius: 14, fontSize: 15},
  notice: {color: '#79746C', fontSize: 12, lineHeight: 18, textAlign: 'center'},
  actions: {flexDirection: 'row', gap: 10, marginTop: 4},
  button: {flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 15},
  primaryButton: {backgroundColor: '#C96849'},
  secondaryButton: {backgroundColor: '#F2F0E9'},
  primaryText: {color: '#FFFFFF', fontSize: 15, fontWeight: '800'},
  secondaryText: {color: '#504B43', fontSize: 15, fontWeight: '700'},
  disabled: {opacity: 0.45},
});
