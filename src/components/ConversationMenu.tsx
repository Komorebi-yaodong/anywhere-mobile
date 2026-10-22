import React, {useEffect, useRef, useState} from 'react';
import {Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {ConversationSummary, RemoteRequest, RemoteTrackedRequest, WorkspaceProject} from '../remote/api';
import {RemoteCommandPendingError, startCommand, waitForCommand} from '../remote/commands';
import {useThemedStyles} from './theme';

import {sortByName} from './nameSort';

type Props = {desktopId: string; conversation: ConversationSummary; projects: WorkspaceProject[]; request: RemoteRequest; requestTracked: RemoteTrackedRequest; onClose: () => void; onCompleted: (deleted: boolean) => void};
export function ConversationMenu({desktopId, conversation, projects, request, requestTracked, onClose, onCompleted}: Props) {
  const s = useThemedStyles(styles);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [checking, setChecking] = useState(true);
  const [blocked, setBlocked] = useState('');
  const [projectId, setProjectId] = useState(conversation.project?.projectId || '');

  const [choosingProject, setChoosingProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{requestId: string; deleted: boolean} | null>(null);
  const [finished, setFinished] = useState(false);
  const [activeAction, setActiveAction] = useState<'delete' | 'update' | null>(null);
  const submitting = useRef(false);
  const controller = useRef(new AbortController());
  useEffect(() => {
    let active = true;
    const abortController = controller.current;
    Promise.all([
      request<{capabilities: string[]}>(desktopId, 'remote.status.get'),
      request<{sessions: Array<{conversationId: string; busy: boolean; controlledByThisDevice: boolean; hidden?: boolean; mobileControlled?: boolean}>}>(desktopId, 'conversation.opened.list'),
    ]).then(([status, opened]) => {
      if (!active) return;
      setCapabilities(Array.isArray(status.capabilities) ? status.capabilities : []);
      const session = opened.sessions?.find(item => item.conversationId === conversation.conversationId);
      setBlocked(!conversation.readable ? '此会话需先在 Desktop 迁移。' : session?.busy ? '会话仍在处理中，请结束后再操作。' : session && !session.controlledByThisDevice && !(session.hidden && !session.mobileControlled) ? '请先接管会话' : '');
    }).catch(() => {if (active) setBlocked('加载失败，请重试');})
      .finally(() => {if (active) setChecking(false);});
    return () => {active = false; abortController.abort();};
  }, [conversation.conversationId, conversation.readable, desktopId, request]);
  const submit = async (deleted: boolean, recover = false) => {
    if (submitting.current || finished || checking || blocked || (pending && !recover)) return;
    submitting.current = true;
    setBusy(true);

    setActiveAction(deleted ? 'delete' : 'update');
    setNotice('');
    try {
      const receipt = recover && pending ? null : startCommand({desktopId, request, requestTracked, signal: controller.current.signal,
        method: deleted ? 'conversation.delete' : 'conversation.project.set',
        params: {conversationId: conversation.conversationId, ...(deleted ? {confirmed: true} : {projectId})},
      });
      if (receipt) setPending({requestId: receipt.requestId, deleted});
      const state = await (receipt ? receipt.completion : waitForCommand({desktopId, requestId: pending!.requestId, request, signal: controller.current.signal}));
      if (controller.current.signal.aborted) return;
      if (state.event !== 'conversation.operation.completed' || (deleted && state.result?.deleted !== true)) throw new Error('remote_operation_unconfirmed');
      setPending(null);
      setFinished(true);
      setNotice(deleted ? '会话已删除。' : '所属项目已更新。');
      onCompleted(deleted);
    } catch (cause) {
      if (controller.current.signal.aborted) return;
      if (cause instanceof RemoteCommandPendingError) {
        setPending({requestId: cause.requestId, deleted});
        setNotice('');
      } else {
        setPending(null);
        // A failure can follow a partial persistence on older Desktop. Prevent
        // destructive retries inside the same confirmation.
        if (deleted) setFinished(true);
        const code = cause instanceof Error ? cause.message : '';
        setNotice(code === 'remote_project_not_found' ? '目标项目已不存在，请关闭后刷新。' : code === 'remote_conversation_busy' ? '会话处理中，请稍后重试' : code === 'remote_control_epoch_conflict' || code === 'remote_conversation_takeover_required' || code === 'remote_conversation_controlled_by_other_device' ? '控制权已变化，请先打开会话并接管。' : '未能确认操作完成，请关闭后刷新检查。');
      }
    } finally {submitting.current = false; if (!controller.current.signal.aborted) setBusy(false);}
  };
  const retry = useRef(submit);
  retry.current = submit;
  useEffect(() => {
    if (!pending || busy || finished) return;
    const timer = setTimeout(() => {retry.current(pending.deleted, true);}, 2500);
    return () => clearTimeout(timer);
  }, [pending, busy, finished]);

  const disabled = busy || checking || Boolean(blocked) || Boolean(pending) || finished;
  const canMove = capabilities.includes('conversation.project.set');
  const canDelete = capabilities.includes('conversation.delete');
  return <Modal visible transparent animationType="slide" onRequestClose={() => choosingProject ? setChoosingProject(false) : onClose()}>
    <View style={s.overlay}><View style={s.sheet}>
      <Text style={s.label}>会话</Text><Text selectable style={s.title}>{conversation.title || '未命名会话'}</Text>
      <Text style={s.label}>所属项目 · 当前：{conversation.project?.name || '未分组'}</Text>
      {!checking && !canMove ? <Text style={s.hint}>暂不支持更改项目</Text> : null}
      {choosingProject ? <>
        <Text style={s.title}>选择所属项目</Text>
        <ScrollView style={s.projects} keyboardShouldPersistTaps="handled">
          {[{projectId: '', name: '未分组'}, ...sortByName(projects)].map(project => <Pressable key={project.projectId} accessibilityRole="radio" accessibilityLabel={`项目 ${project.name}`} accessibilityState={{checked: projectId === project.projectId, disabled: disabled || !canMove}} disabled={disabled || !canMove} style={[s.option, projectId === project.projectId && s.selected]} onPress={() => {setProjectId(project.projectId); setChoosingProject(false);}}><Text style={s.text}>{project.name}</Text><Text style={s.text}>{projectId === project.projectId ? '✓' : ''}</Text></Pressable>)}
        </ScrollView>
        <Pressable accessibilityLabel="返回会话操作" style={s.button} onPress={() => setChoosingProject(false)}><Text style={s.text}>返回</Text></Pressable>
      </> : <Pressable accessibilityLabel="选择所属项目" disabled={disabled || !canMove} style={s.option} onPress={() => setChoosingProject(true)}><Text style={s.text}>{projectId ? projects.find(project => project.projectId === projectId)?.name || conversation.project?.name : '未分组'}</Text><Text style={s.text}>⌃</Text></Pressable>}
      {!checking && !busy && (blocked || notice) ? <Text accessibilityLabel="会话操作提示" style={s.hint}>{notice || blocked}</Text> : null}
      {!choosingProject ? <View style={s.actionRow}>
      <Pressable accessibilityLabel="删除会话" disabled={disabled || !canDelete} style={[s.button, s.action, (disabled || !canDelete) && s.disabled]} onPress={() => Alert.alert('删除会话？', `删除“${conversation.title || '未命名会话'}”？删除后无法恢复。`, [{text: '取消', style: 'cancel'}, {text: '删除', style: 'destructive', onPress: () => submit(true)}])}><Text style={s.danger}>{(busy || pending) && activeAction === 'delete' ? '正在删除' : '删除会话'}</Text></Pressable>
        <Pressable accessibilityLabel="保存到项目" disabled={disabled || !canMove || projectId === (conversation.project?.projectId || '')} style={[s.button, s.action, (disabled || !canMove) && s.disabled]} onPress={() => submit(false)}><Text style={s.text}>{(busy || pending) && activeAction === 'update' ? '正在更新' : '保存到项目'}</Text></Pressable>
      </View> : null}
      <Pressable accessibilityLabel="关闭会话操作" style={s.button} onPress={onClose}><Text style={s.text}>关闭</Text></Pressable>
    </View></View>
  </Modal>;
}
const styles = StyleSheet.create({

  actionRow: {flexDirection: 'row', gap: 10}, action: {flex: 1},
  overlay: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(39,36,31,0.34)'},
  sheet: {maxHeight: '90%', backgroundColor: '#FAF8F3', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, paddingBottom: 28, gap: 10},
  title: {fontSize: 17, fontWeight: '600', color: '#292724'}, label: {fontSize: 12, color: '#79746C'}, hint: {fontSize: 12, lineHeight: 18, color: '#79746C'},
  projects: {maxHeight: 240, flexGrow: 0}, option: {minHeight: 44, padding: 10, borderRadius: 12, marginBottom: 5, backgroundColor: '#FFFFFF', flexDirection: 'row', justifyContent: 'space-between'}, selected: {backgroundColor: '#F9E5DB'},
  text: {fontSize: 14, color: '#292724'}, danger: {fontSize: 14, color: '#B84E52'}, button: {minHeight: 44, padding: 10, borderRadius: 12, backgroundColor: '#F2F0E9', alignItems: 'center', justifyContent: 'center'}, disabled: {opacity: 0.45},
});
