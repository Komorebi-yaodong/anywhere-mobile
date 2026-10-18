// USB-only synthetic fixture. No Electron user profile, SQLite or AI provider access.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const desktop = path.resolve(process.argv[2] || path.join(root, '..', 'Anywhere_desktop'));
const load = name => import(pathToFileURL(path.join(desktop, 'main/core/remote', name)).href);
const {createRemoteGateway} = await load('index.js');
const {createRemoteSessionManager} = await load('sessionManager.js');
const {createRemoteUploadManager} = await load('uploadManager.js');
const {createRemoteBusinessConfigService} = await load('businessConfig.js');
const dir = await fs.mkdtemp(path.join(root, 'build/remote-v2-check/phone-fixture-'));
const port = 17861;
const memory = new Map();
const localKey = crypto.randomBytes(32);
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', localKey, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  decryptString(value) {
    const data = Buffer.from(value);
    const cipher = crypto.createDecipheriv('aes-256-gcm', localKey, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  },
};
const cid = 'conversation-phone-fixture-0001';
const wid = 'window-phone-fixture';
let title = '手机联调 · 合成会话';
let revision = 1;
let deleted = false;
let config = {
  model: 'fixture|echo', reasoningEffort: 'default', voice: '',
  mcpServerIds: [], skillIds: [], systemPrompt: 'Synthetic test only.',
  compact: {autoCompactEnabled: true, triggerRatio: 0.9, contextLength: 32000,
    keepRecentRounds: 2, hideCompactedMessages: true, compactPrompt: 'Synthetic summary.'},
};
const options = {
  models: [{value: 'fixture|echo', label: '合成 Echo（无外部 AI 请求）'}],
  reasoningEfforts: ['default', 'high'], voices: ['fixture-voice'],
  mcpServers: [{id: 'fixture-mcp', name: '合成 MCP（不执行工具）'}],
  skills: [{id: 'fixture-skill', name: '合成 Skill（不执行工具）'}],
};
let messages = [];
const append = (role, content) => {
  const id = crypto.randomUUID();
  messages.push({messageId: id, uiMessageId: id, role, order: messages.length + 1,
    payload: {content, reasoningContent: '', summary: '', summaryPrefix: '',
      timestamp: new Date().toISOString(), completedTimestamp: '', aiName: 'Fixture',
      voiceName: '', status: '', toolCalls: []}});
};
append('user', '这是仅用于测试的历史消息。');
append('assistant', '这是合成回复，不读取真实历史，也不调用真实模型。');
const windows = [{id: wid, type: 'window', conversationId: cid, rendererReady: true, remoteHidden: false}];
let business = {language: 'zh', remote: {enabled: true, host: '127.0.0.1', port},
  webdav: {localChatPath: '', url: '', password: 'SYNTHETIC_NOT_A_REAL_SECRET'},
  providers: {}, prompts: {}, mcpServers: {}, tasks: {}, skillPath: ''};
const uploads = createRemoteUploadManager({tempRoot: path.join(dir, 'uploads')});
let qr;
const gateway = createRemoteGateway({
  app: {getPath: () => dir, getName: () => 'Anywhere 手机合成测试'}, safeStorage,
  dbStorageGetItem: async (key, fallback) => ({ok: true, value: structuredClone(memory.has(key) ? memory.get(key) : fallback)}),
  dbStorageSetItem: async (key, value) => {memory.set(key, structuredClone(value)); return {ok: true};},
  uploadManager: uploads,
  businessConfigService: createRemoteBusinessConfigService({
    getConfig: async () => ({config: structuredClone(business)}),
    updateConfig: async ({config: next}) => {business = structuredClone(next); return {success: true};},
  }),
  conversationReadService: {
    async listConversations() {return {ok: true, configured: true, projects: [], windows: [],
      conversations: deleted ? [] : [{conversationId: cid, title, revision, format: 'sqlite',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), byteSize: 0,
        project: null, migrationRequired: false, readable: true, window: null}],
      page: {limit: 100, nextCursor: null, hasMore: false}, catalogRevision: String(revision)};},
    async listMessages() {return {ok: true, conversation: {conversationId: cid, title, revision},
      messages: structuredClone(messages), page: {pageSize: 50, nextBeforeUiOrder: null, hasMore: false}};},
    getWindows() {return {ok: true, windows: [], updatedAt: new Date().toISOString()};},
  },
  onPairingCreated: value => {qr = value;},
  logger: {log() {}, warn() {}, error() {}},
});
let active;
const timers = new Set();
const later = (fn, ms) => {
  const timer = setTimeout(() => {timers.delete(timer); fn();}, ms);
  timers.add(timer);
};
const emit = (command, event, payload = {}) => manager.handleRendererEvent({windowRef: wid,
  payload: {conversationId: cid, requestId: command.requestId, event, payload}});
const manager = createRemoteSessionManager({
  getConfig: async () => ({config: {}}),
  openConversation: async () => {throw new Error('fixture_existing_writer_only');},
  openWindow: async () => {throw new Error('fixture_existing_writer_only');},
  listWindows: () => windows,
  getWindowByRef: () => ({isDestroyed: () => false}),
  revealRemoteConversationWindow: () => ({ok: true}), uploadManager: uploads,
  broadcastToDevice: (deviceId, event, payload) => gateway.sendEventToDevice(deviceId, event, payload),
  dispatchRemoteCommandToWindow: async (_windowRef, command) => {
    later(() => {void dispatch(command).catch(() => emit(command, 'conversation.operation.failed', {code: 'remote_fixture_failed'}));}, 30);
    return {ok: true};
  },
});
gateway.setSessionManager(manager);
async function dispatch(command) {
  if (command.type === 'conversation.send' || command.type === 'conversation.message.reask') {
    if (command.type.endsWith('reask')) {
      const last = [...messages].reverse().find(item => item.role === 'assistant');
      if (!last || last.uiMessageId !== command.uiMessageId) {
        emit(command, 'assistant.failed', {code: 'remote_fixture_not_last'}); return;
      }
      messages = messages.filter(item => item !== last);
    } else {
      for (const uploadId of command.uploadIds || []) {
        await uploads.consumeForRenderer({windowRef: wid, requestId: command.requestId, uploadId});
      }
      append('user', command.text || '[合成附件消息]');
    }
    active = command;
    emit(command, 'assistant.started', {startedAt: new Date().toISOString()});
    const parts = ['手机与真实 Desktop v2 网关已完成 E2EE 连接。', '\n这是合成流式回复，无外部模型调用。', '\n测试完成。'];
    parts.forEach((textDelta, i) => later(() => {
      if (active !== command) return;
      emit(command, 'assistant.delta', {textDelta, reasoningDelta: i === 0 ? '合成思考过程。' : '', segmentId: 'fixture'});
      if (i === parts.length - 1) {
        append('assistant', parts.join('')); revision += 1;
        emit(command, 'assistant.completed', {revision, completedAt: new Date().toISOString()}); active = null;
      }
    }, 400 * (i + 1)));
  } else if (command.type === 'conversation.cancel' || command.type === 'remote.shutdown') {
    if (active) {emit(active, 'assistant.cancelled', {revision}); active = null;}
  } else if (command.type.startsWith('conversation.config.')) {
    if (command.patch) {config = {...config, ...command.patch, compact: {...config.compact, ...command.patch.compact}}; revision += 1;}
    emit(command, 'conversation.config.result', {config, options, revision, patched: Object.keys(command.patch || {})});
  } else if (command.type === 'conversation.compact') {
    emit(command, 'conversation.compact.progress', {percent: 50, stage: 'fixture', message: '合成摘要'});
    revision += 1; emit(command, 'conversation.compact.completed', {changed: true, revision});
  } else {
    if (command.type === 'conversation.rename') title = command.title;
    if (command.type === 'conversation.delete') deleted = true;
    if (command.type === 'conversation.message.edit') {
      const message = messages.find(item => item.uiMessageId === command.uiMessageId);
      if (message) message.payload.content = command.content;
    }
    if (command.type === 'conversation.message.delete') messages = messages.filter(item => item.uiMessageId !== command.uiMessageId);
    revision += 1;
    emit(command, 'conversation.operation.completed', {operation: command.type, uiMessageId: command.uiMessageId,
      title, deleted, revision});
  }
}
async function pair() {
  const value = await gateway.createPairing();
  // Public pairing artifacts only. Never write device/root/TLS private keys.
  await fs.writeFile(path.join(dir, 'pairing.json'), JSON.stringify(qr));
  const html = `<!doctype html><meta charset="utf-8"><title>Anywhere 合成手机测试</title><h1>手机合成测试（非真实 Desktop 数据）</h1><img src="${value.qrDataUrl}"><h2>验证码：${value.pairingCode}</h2><p>先 adb reverse tcp:${port} tcp:${port}；此 QR 两分钟有效。</p>`;
  await fs.writeFile(path.join(dir, 'pairing.html'), html);
  console.log(`合成配对页面：${path.join(dir, 'pairing.html')}（有效两分钟；输入 pair 可刷新）`);
}
await gateway.configure({remote: {enabled: true, host: '127.0.0.1', port}});
await pair();
console.log('仅监听 127.0.0.1:17861；命令：pair / devices（仅计数）/ revoke（撤销全部测试设备）/ stop');
const cli = readline.createInterface({input: process.stdin, output: process.stdout});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  timers.forEach(clearTimeout); timers.clear();
  if (active) {emit(active, 'assistant.cancelled', {revision}); active = null;}
  await gateway.stop(); await uploads.stop(); localKey.fill(0); cli.close();
  console.log('合成网关已停止，所有测试信任仅存在本次进程内存。');
}
cli.on('line', line => {void (async () => {
  if (line.trim() === 'pair') await pair();
  if (line.trim() === 'devices') {const result = await gateway.listDevices(); console.log(`测试设备数：${result.devices.length}`);}
  if (line.trim() === 'revoke') {const result = await gateway.listDevices(); for (const device of result.devices) await gateway.revokeDevice(device.deviceId); console.log('已撤销全部测试设备。');}
  if (line.trim() === 'stop') await stop();
})().catch(() => console.error('测试控制命令失败（未输出参数）。'));});
process.on('SIGINT', () => {void stop();});
process.on('SIGTERM', () => {void stop();});
