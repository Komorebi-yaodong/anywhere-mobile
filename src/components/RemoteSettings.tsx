import {TextInput, Switch} from './ThemedNative';
import {useEffect, useRef, useState} from 'react';
import {Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {RemoteRequest, RemoteTrackedRequest} from '../remote/api';

import {GlobalSettings} from './GlobalSettings';

import {sortByName} from './nameSort';
import {
  ConversationConfig,
  ConversationConfigResult, RemoteCommandPendingError, startCommand, waitForCommand,
} from '../remote/commands';

export function RemoteSettings({desktopId, conversationId, request, requestTracked, onClose, onChanged}: {
  desktopId: string;
  conversationId: string;
  request: RemoteRequest;
  requestTracked: RemoteTrackedRequest;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'session' | 'business'>('session');
  const [result, setResult] = useState<ConversationConfigResult | null>(null);
  const [config, setConfig] = useState<ConversationConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [pendingId, setPendingId] = useState('');
  const controller = useRef(new AbortController());
  useEffect(() => () => controller.current.abort(), []);

  const run = async (method: string, params: Record<string, unknown>, recover = false) => {
    if (busy || (pendingId && !recover) || (!conversationId && !recover)) return;
    setBusy(true);
    setNotice('正在等待 Desktop Writer 确认…');
    try {
      const receipt = recover ? null : startCommand({desktopId, method, params, request, requestTracked, signal: controller.current.signal});
      if (receipt) setPendingId(receipt.requestId);
      const state = await (receipt ? receipt.completion : waitForCommand({desktopId, requestId: pendingId, request, signal: controller.current.signal}));
      if (controller.current.signal.aborted) return;
      setPendingId('');
      if (state.event === 'conversation.config.result') {
        const value = state.result as ConversationConfigResult;
        setResult(value);
        setConfig(value.config);
      }
      setNotice('Desktop 已确认完成。');
      onChanged();
    } catch (error) {
      if (!controller.current.signal.aborted) {
        setPendingId(error instanceof RemoteCommandPendingError ? error.requestId : '');
        setNotice(error instanceof RemoteCommandPendingError
          ? `${error.message}\n原请求：${error.requestId}`
          : error instanceof Error ? error.message : '操作失败');
      }
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>远程设置</Text>
          <Button label="关闭" onPress={onClose} />
        </View>
        <View style={styles.row}>
          <Button label="当前会话" onPress={() => setTab('session')} />
          <Button label="全部业务配置" onPress={() => setTab('business')} />
        </View>
        {tab === 'business' ? <BusinessEditor desktopId={desktopId} request={request} /> : (
          <ScrollView contentContainerStyle={styles.page}>
            <Text style={styles.description}>配置命令由 Desktop 唯一 Writer 执行；读取及保存会等待终态，忙碌会话不会强行覆盖。</Text>
            <Button label="读取当前配置" disabled={busy} onPress={() => run('conversation.config.get', {conversationId})} />
            {notice ? <Text selectable style={styles.notice}>{notice}</Text> : null}

            {pendingId ? <Button label="查询原请求（不重发）" disabled={busy} onPress={() => run('', {}, true)} /> : null}
            {config && result ? <>
              <Text style={styles.label}>模型</Text>
              {result.options.models.map(item => <Choice key={item.value} label={item.label} active={config.model === item.value} onPress={() => setConfig({...config, model: item.value})} />)}
              <Text style={styles.label}>思考强度</Text>
              {result.options.reasoningEfforts.map(value => <Choice key={value} label={value || '默认'} active={config.reasoningEffort === value} onPress={() => setConfig({...config, reasoningEffort: value})} />)}
              <Text style={styles.label}>语音</Text>
              {['', ...result.options.voices.filter(Boolean)].map(value => <Choice key={value} label={value || '关闭 / 默认'} active={config.voice === value} onPress={() => setConfig({...config, voice: value})} />)}
              <Text style={styles.label}>MCP</Text>
              {sortByName(result.options.mcpServers).map(item => <Toggle key={item.id} label={item.name} value={config.mcpServerIds.includes(item.id)} onChange={() => setConfig({...config, mcpServerIds: toggleId(config.mcpServerIds, item.id)})} />)}
              <Text style={styles.label}>Skill</Text>
              {sortByName(result.options.skills).map(item => <Toggle key={item.id} label={item.name} value={config.skillIds.includes(item.id)} onChange={() => setConfig({...config, skillIds: toggleId(config.skillIds, item.id)})} />)}
              <Text style={styles.label}>System prompt</Text>
              <TextInput multiline style={styles.textarea} value={config.systemPrompt} onChangeText={systemPrompt => setConfig({...config, systemPrompt})} autoCorrect={false} />
              <Toggle label="自动压缩" value={config.compact.autoCompactEnabled} onChange={autoCompactEnabled => setConfig({...config, compact: {...config.compact, autoCompactEnabled}})} />
              <Toggle label="隐藏已压缩消息" value={config.compact.hideCompactedMessages} onChange={hideCompactedMessages => setConfig({...config, compact: {...config.compact, hideCompactedMessages}})} />
              <NumberField label="触发比例（0.1–0.99）" value={config.compact.triggerRatio} onChange={triggerRatio => setConfig({...config, compact: {...config.compact, triggerRatio}})} />
              <NumberField label="上下文长度（4096–10000000）" value={config.compact.contextLength} onChange={contextLength => setConfig({...config, compact: {...config.compact, contextLength}})} />
              <NumberField label="保留轮数（0–100）" value={config.compact.keepRecentRounds} onChange={keepRecentRounds => setConfig({...config, compact: {...config.compact, keepRecentRounds}})} />
              <Text style={styles.label}>压缩 prompt</Text>
              <TextInput multiline style={styles.textarea} value={config.compact.compactPrompt} onChangeText={compactPrompt => setConfig({...config, compact: {...config.compact, compactPrompt}})} />
              <Button label="保存会话配置" disabled={busy} onPress={() => Alert.alert('保存当前会话配置？', '将更新此会话模型、工具、提示词及压缩设置。', [
                {text: '取消', style: 'cancel'},
                {text: '保存', onPress: () => run('conversation.config.patch', {conversationId, patch: config})},
              ])} />
            </> : null}
            <Button label="立即压缩" disabled={busy} onPress={() => Alert.alert('压缩当前会话？', 'Desktop 将生成摘要并更新会话历史。', [
              {text: '取消', style: 'cancel'},
              {text: '压缩', onPress: () => run('conversation.compact', {conversationId})},
            ])} />
            <Button label="取消正在进行的压缩" onPress={() => request(desktopId, 'conversation.compact.cancel', {conversationId}).catch(error => setNotice(error instanceof Error ? error.message : '取消失败'))} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function BusinessEditor({desktopId, request}: {desktopId: string; request: RemoteRequest}) {
  return <GlobalSettings desktopId={desktopId} request={request} onChanged={() => undefined} onSectionChange={() => undefined} refreshSignal={0} />;
}

function toggleId(values: string[], id: string) { return values.includes(id) ? values.filter(value => value !== id) : [...values, id]; }
function Button({label, onPress, disabled = false}: {label: string; onPress: () => void; disabled?: boolean}) {
  return <Pressable disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}
function Choice({label, active, onPress}: {label: string; active: boolean; onPress: () => void}) {
  return <Button label={`${active ? '●' : '○'} ${label}`} onPress={onPress} />;
}
function Toggle({label, value, onChange}: {label: string; value: boolean; onChange: (value: boolean) => void}) {
  return <View style={styles.toggle}><Text style={styles.label}>{label}</Text><Switch value={value} onValueChange={onChange} /></View>;
}
function NumberField({label, value, onChange}: {label: string; value: number; onChange: (value: number) => void}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <><Text style={styles.label}>{label}</Text><TextInput style={styles.input} value={text} keyboardType="decimal-pad" onChangeText={setText} onEndEditing={() => { if (text.trim() && Number.isFinite(Number(text))) onChange(Number(text)); }} /></>;
}
const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#07111f', paddingTop: 36}, header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16}, title: {flex: 1, color: '#fff', fontSize: 21, fontWeight: '800'}, row: {flexDirection: 'row', gap: 8, padding: 12}, page: {padding: 16, paddingBottom: 50}, description: {color: '#b6cbe8', lineHeight: 21, marginVertical: 12}, label: {color: '#dceaff', marginTop: 15, marginBottom: 7, fontWeight: '700'}, button: {padding: 12, borderRadius: 9, backgroundColor: '#203c60', marginVertical: 4}, buttonText: {color: '#fff', fontWeight: '700'}, textarea: {color: '#fff', minHeight: 120, padding: 12, textAlignVertical: 'top', backgroundColor: '#10213a', borderRadius: 9}, json: {minHeight: 320, fontFamily: 'monospace'}, input: {color: '#fff', padding: 12, backgroundColor: '#10213a', borderRadius: 9}, toggle: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, notice: {color: '#ffd69b', marginVertical: 10}, disabled: {opacity: 0.4},
});
