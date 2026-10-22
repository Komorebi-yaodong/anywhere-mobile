import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {Image, ScrollView, Text, TextInput, StyleSheet} from 'react-native';
import {
  filterSessionMcpServers,
  filterSessionSkills,
  keyboardFrameNeedsComposerScroll,
  isPinnedToBottom,
  adjacentMessageIndex,
  hasMessageBubble,
  shouldRenderMessage,
  WorkspaceShell,
} from '../src/components/WorkspaceShell';
import type { DesktopRuntime } from '../src/hooks/useDesktops';
import type { RemoteRequest, RemoteTrackedRequest } from '../src/remote/api';

import {ManagementSettings} from '../src/components/ManagementSettings';

import {ConversationMessageList} from '../src/components/ConversationMessageList';

import {directoryMessage} from '../test-fixtures/directoryTree';

const mockCreate = jest.fn(async () => undefined);
const mockCancel = jest.fn(async () => undefined);
const mockSend = jest.fn(async () => undefined);
const mockResendLastUser = jest.fn(async () => undefined);
const mockSelectConversation = jest.fn();
const mockTakeoverConversation = jest.fn(async () => undefined);
const mockHandoffConversation = jest.fn(async () => undefined);
const mockCloseConversation = jest.fn(async () => undefined);
const mockRefreshOpenedSessions = jest.fn(async () => undefined);
let mockOpenedSessions: Array<Record<string, unknown>> = [];
let mockCatalog: Array<Record<string, any>> = [];
let mockWorkspaceMessages: Array<Record<string, any>> = [];
let mockConversationModel = '';
let mockConversationAssistant = {code: '', name: '', avatarUrl: ''};
let mockActiveTurn: any = null;
let mockOnCapture: ((capture: unknown) => Promise<unknown>) | undefined;
jest.mock('../src/services/avatarResourceCache', () => ({
  ensureAvatarResource: jest.fn(async ({resource}: {resource?: {code?: string; version?: string}}) => resource ? ({
    uri: `file:///cache/${resource.code || 'profile'}-${resource.version || 'fixture'}.png`,
    version: resource.version || 'fixture',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }) : undefined),
  isAvatarCacheValid: jest.fn(() => false),
  removeAvatarCache: jest.fn(async () => undefined),
}));
jest.mock('../src/services/remoteImageCache', () => ({
  cacheRemoteImage: jest.fn(async () => ''),
  cacheRemoteHttpsResource: jest.fn(async () => ({uri: 'file:///cache/profile-https.png', version: 'fixture', expiresAt: '2099-01-01T00:00:00.000Z', mimeType: 'image/png', byteLength: 1})),
}));
jest.mock('../src/services/mediaAttachment', () => ({
  uploadAudioCapture: jest.fn(async () => ({
    uploadId: 'upload-audio-fixture',
  })),
}));
jest.mock('../src/hooks/useConversationWorkspace', () => ({
  useConversationWorkspace: () => ({
    configured: true,
    catalog: mockCatalog,
    messages: mockWorkspaceMessages,
    activeTurn: mockActiveTurn,
    queuedSends: [],
    selectedConversationId: 'conversation-shell-fixture',
    selectedConversation: { title: 'Fixture Chat' },
    createConversation: mockCreate,
    cancelActiveTurn: mockCancel,
    sendMessage: mockSend,
    refreshCatalog: jest.fn(),
    refreshMessages: jest.fn(),
    removeMessageFromView: jest.fn(),
    removeQueuedSend: jest.fn(),
    reaskLastAssistant: jest.fn(),
    resendLastUser: mockResendLastUser,
    messagePage: {hasMore: false},
    conversationModel: mockConversationModel,
    conversationAssistant: mockConversationAssistant,
    tasks: [],
    pendingChoices: {},
    openedSessions: mockOpenedSessions,
    canControlConversation: () => !mockOpenedSessions.length || mockOpenedSessions.some(item => item.controlledByThisDevice),
    selectConversation: mockSelectConversation,
    takeoverConversation: mockTakeoverConversation,
    handoffConversation: mockHandoffConversation,
    closeConversation: mockCloseConversation,
    refreshOpenedSessions: mockRefreshOpenedSessions,
    loadOlderMessages: jest.fn(),
    submitChoice: jest.fn(),
    releaseSelectedConversation: jest.fn(),
  }),
}));
jest.mock('../src/hooks/useAttachmentQueue', () => ({
  useAttachmentQueue: () => ({
    uploads: [],
    busy: false,
    addAudioCapture: jest.fn(),
    markSubmitted: jest.fn(),
  }),
}));
jest.mock('../src/hooks/useAudioRecording', () => ({
  useAudioRecording: (onCapture: typeof mockOnCapture) => {
    mockOnCapture = onCapture;
    return {
      recording: false,
      start: jest.fn(),
      finish: jest.fn(),
      cancel: jest.fn(),
    };
  },
}));

function button(root: TestRenderer.ReactTestRenderer, label: string) {
  const text = root.root
    .findAllByType(Text)
    .find(node => node.props.children === label);
  let node = text?.parent;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
beforeEach(() => {
  mockOpenedSessions = [];

  mockCatalog = [];

  mockWorkspaceMessages = [];
  mockConversationModel = '';
  mockConversationAssistant = {code: '', name: '', avatarUrl: ''};
  mockActiveTurn = null;
  mockResendLastUser.mockClear();
  mockSelectConversation.mockClear();
  mockTakeoverConversation.mockClear();
  mockHandoffConversation.mockClear();
  mockCloseConversation.mockClear();
  mockRefreshOpenedSessions.mockClear();
});

function workspaceProps() {
  return {
    desktop: {id: 'desktop-shell-opened', name: 'Fixture Desktop', status: '在线'} as DesktopRuntime,
    request: jest.fn(async () => ({ok: true, profile: {displayName: 'Fixture'}, configured: true, projects: [], assistants: []})) as RemoteRequest,
    requestTracked: jest.fn() as RemoteTrackedRequest,
    subscribeEvents: () => () => undefined,
    onHome: jest.fn(),
  };
}

test('renders document cards separately and edits only prose, never file labels or extracted content', async () => {
  openConfigSession();
  const props = workspaceProps();
  mockWorkspaceMessages = [{messageId: 'mixed-files', uiMessageId: 'ui-mixed-files', role: 'user', order: 1,
    payload: {content: [{type: 'text', text: '我正在写论文'}, {type: 'file', name: 'fixture.docx', previewable: false}, {type: 'text', text: 'file name:fixture.xlsx\nfile content:\nSYNTHETIC_XLSX_BODY\nfile end'}], reasoningContent: '', timestamp: '', completedTimestamp: '', toolCalls: []}}];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  expect(root.root.findAll(node => node.props.accessibilityLabel === '消息文件附件').length).toBeGreaterThan(0);
  expect(root.root.findAllByType(Text).some(node => node.props.children === 'fixture.docx')).toBe(true);
  expect(root.root.findAllByType(Text).some(node => node.props.children === 'fixture.xlsx')).toBe(true);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '编辑消息' && typeof node.props.onPress === 'function')[0].props.onPress());
  const editor = root.root.findAllByType(TextInput).find(node => node.props.placeholder === '输入消息内容')!;
  expect(editor.props.value).toBe('我正在写论文');
  expect(editor.props.value).not.toContain('fixture');
  await act(async () => root.unmount());
});


test('filters session MCP options by quick filter and keyword, including configuration tags', () => {
  const servers = [
    {id: 'mcp-research-preset', name: '研究 MCP', tags: ['Research', '知识库'], preset: true},
    {id: 'mcp-files-selected', name: '文件 MCP', tags: ['文件'], preset: false},
    {id: 'mcp-research-other', name: '其他研究 MCP', tags: ['Research'], preset: false},
  ];

  expect(filterSessionMcpServers(servers, ['mcp-files-selected'], {
    quickFilter: 'all',
    query: 'Research',
  }).map(item => item.id)).toEqual(['mcp-research-preset', 'mcp-research-other']);
  expect(filterSessionMcpServers(servers, ['mcp-files-selected'], {
    quickFilter: 'selected',
  }).map(item => item.id)).toEqual(['mcp-files-selected']);
  expect(filterSessionMcpServers(servers, ['mcp-files-selected'], {
    quickFilter: 'preset',
    query: '知识库',
  }).map(item => item.id)).toEqual(['mcp-research-preset']);
  expect(filterSessionMcpServers(servers, ['mcp-files-selected'], {
    quickFilter: 'preset',
    query: '文件',
  })).toEqual([]);
});


test('filters session Skill options by safe display name only', () => {
  const skills = [
    {id: 'skill-research', name: 'Research Notes'},
    {id: 'skill-release', name: '发布检查'},
  ];
  expect(filterSessionSkills(skills, 'research').map(item => item.id)).toEqual(['skill-research']);
  expect(filterSessionSkills(skills, '发布').map(item => item.id)).toEqual(['skill-release']);
  expect(filterSessionSkills(skills, 'missing')).toEqual([]);
});

test('only scrolls to the composer while a visible keyboard moves upward, never while it closes', () => {
  expect(keyboardFrameNeedsComposerScroll(null, 480, 320)).toBe(true);
  expect(keyboardFrameNeedsComposerScroll(480, 430, 370)).toBe(true);
  expect(keyboardFrameNeedsComposerScroll(430, 480, 320)).toBe(false);
  expect(keyboardFrameNeedsComposerScroll(430, 800, 0)).toBe(false);
});


test('keeps pinned geometry and message navigation within the visible message range', () => {
  expect(isPinnedToBottom(452, 500, 1000)).toBe(true);
  expect(isPinnedToBottom(450, 500, 1000)).toBe(false);
  expect(isPinnedToBottom(420, 500, 1000, 96)).toBe(true);
  expect(adjacentMessageIndex(0, 3, -1)).toBe(0);
  expect(adjacentMessageIndex(1, 3, 1)).toBe(2);
  expect(adjacentMessageIndex(2, 3, 1)).toBe(2);
  expect(adjacentMessageIndex(0, 0, 1)).toBe(-1);
});


test('keeps the real directory bubble followed by user, tool and assistant messages with one navigator', async () => {
  openConfigSession();
  const props = workspaceProps();
  const payload = {content: directoryMessage, reasoningContent: '', timestamp: '', completedTimestamp: '', toolCalls: []};
  mockWorkspaceMessages = [
    {messageId: 'directory', uiMessageId: 'directory-ui', role: 'assistant', order: 1, payload},
    {messageId: 'after-user', uiMessageId: 'after-user-ui', role: 'user', order: 2, payload: {...payload, content: '后续用户消息'}},
    {messageId: 'after-tool', uiMessageId: 'after-tool-ui', role: 'assistant', order: 3, payload: {...payload, content: '', toolCalls: [{id: 'after-directory-tool', name: 'synthetic_tool', status: 'finished'}]}},
    {messageId: 'after-reply', uiMessageId: 'after-reply-ui', role: 'assistant', order: 4, payload: {...payload, content: '目录之后的回复'}},
  ];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<WorkspaceShell {...props} />);});
  await enterFixtureChat(root);
  const list = root.root.findByType(ConversationMessageList);
  expect(list.props.messages.map((row: any) => row.uiMessageId)).toEqual(['directory-ui', 'after-user-ui', 'after-tool-ui', 'after-reply-ui']);
  expect(JSON.stringify(root.toJSON())).toContain('后续用户消息');
  expect(JSON.stringify(root.toJSON())).toContain('目录之后的回复');
  expect(root.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === '消息导航居中区域')).toHaveLength(1);
  expect(root.root.findAllByType(ScrollView).find(node => node.props.accessibilityLabel === '代码横向滚动')?.props.removeClippedSubviews).toBe(false);
  await act(async () => root.unmount());
});


test('stream notifications never manufacture message cards or regroup the Desktop page', async () => {
  openConfigSession();
  const props = workspaceProps();
  const tool = {id: 'first-tool', name: 'first_tool', status: 'executing', arguments: '[参数已隐藏]'};
  mockActiveTurn = {requestId: 'request-live', conversationId: 'conversation-shell-fixture', segmentId: 'segment-one', text: 'live text not in page', reasoning: 'live thinking not in page', toolCalls: [tool], terminal: false};
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  const list = () => root.root.findByType(ConversationMessageList);
  expect(list().props.messages).toEqual([]);
  const payload = {content: '', reasoningContent: 'Desktop thinking', timestamp: '', completedTimestamp: '', toolCalls: [tool]};
  mockWorkspaceMessages = [
    {messageId: 'canonical-one', uiMessageId: 'real-ui-one', role: 'assistant', order: 1, payload},
    {messageId: 'canonical-two', uiMessageId: 'real-ui-two', role: 'assistant', order: 2, payload: {...payload, toolCalls: [{id: 'second-tool', name: 'second_tool', status: 'executing'}]}},
  ];
  await act(async () => root.update(<WorkspaceShell {...props} />));
  const keys = () => list().props.messages.map((message: any) => message.uiMessageId);
  expect(keys()).toEqual(['real-ui-one', 'real-ui-two']);
  expect(list().props.messages.map((message: any) => message.payload.toolCalls.map((call: any) => call.id))).toEqual([['first-tool'], ['second-tool']]);
  const detailsButton = root.root.findAll(node => node.props.accessibilityLabel === '查看工具 first_tool 详情' && typeof node.props.onPress === 'function')[0];
  await act(async () => detailsButton.props.onPress());
  const details = () => root.root.findAllByType(ScrollView).filter(node => node.props.nestedScrollEnabled && node.props.showsVerticalScrollIndicator);
  expect(details()).toHaveLength(1);
  const mountedPanel = details()[0];
  mockActiveTurn = {...mockActiveTurn, segmentId: 'segment-three', text: 'different live text', toolCalls: [tool, {id: 'third-tool', name: 'not_in_page', status: 'executing'}]};
  await act(async () => root.update(<WorkspaceShell {...props} />));
  expect(keys()).toEqual(['real-ui-one', 'real-ui-two']);
  expect(details()[0]).toBe(mountedPanel);
  mockWorkspaceMessages = [{...mockWorkspaceMessages[0], payload: {...payload, toolCalls: [{...tool, status: 'finished', result: 'Desktop safe result'}]}}, mockWorkspaceMessages[1]];
  mockActiveTurn = {...mockActiveTurn, terminal: true, historyLoaded: true};
  await act(async () => root.update(<WorkspaceShell {...props} />));
  expect(keys()).toEqual(['real-ui-one', 'real-ui-two']);
  expect(details()[0]).toBe(mountedPanel);
  expect(root.root.findAllByType(Text).some(node => node.props.children === 'Desktop safe result')).toBe(true);
  const dock = root.root.findAll(node => node.props.accessibilityLabel === '消息导航居中区域')[0];
  expect(StyleSheet.flatten(dock.props.style)).toMatchObject({top: 0, bottom: 0, justifyContent: 'center'});
  mockWorkspaceMessages = [mockWorkspaceMessages[1]];
  await act(async () => root.update(<WorkspaceShell {...props} />));
  expect(keys()).toEqual(['real-ui-two']);
  expect(details()).toHaveLength(0);
  await act(async () => root.unmount());
});


test('expanding a real earlier tool leaves every later loaded message mounted and ordered', async () => {
  openConfigSession();
  const props = workspaceProps();
  const payload = {content: '', reasoningContent: '', timestamp: '', completedTimestamp: '', toolCalls: [{id: 'earlier-tool', name: 'earlier_tool', status: 'finished', arguments: {items: Array.from({length: 60}, (_, index) => ({text: `safe input ${index}`}))}, result: {text: 'safe output'}}]};
  mockWorkspaceMessages = [
    {messageId: 'first', uiMessageId: 'first', role: 'assistant', order: 0, payload},
    ...Array.from({length: 60}, (_, index) => ({messageId: `later-${index}`, uiMessageId: `later-${index}`, role: index % 2 ? 'user' : 'assistant', order: index + 1, payload: {...payload, content: `later fixture ${index}`, toolCalls: []}})),
  ];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  const tail = () => root.root.findAll(node => node.props.testID === 'message-row-later-59' && node.props.onLayout)[0];
  const mountedTail = tail();
  const toggle = () => root.root.findAll(node => node.props.accessibilityLabel === '查看工具 earlier_tool 详情' && node.props.onPress)[0];
  await act(async () => toggle().props.onPress());
  expect(tail()).toBe(mountedTail);
  const list = root.root.findByType(ConversationMessageList);
  expect(list.props.messages.map((row: any) => row.uiMessageId)).toEqual(['first', ...Array.from({length: 60}, (_, index) => `later-${index}`)]);
  const inner = root.root.findAllByType(ScrollView).find(node => node.props.accessibilityLabel === '工具 earlier_tool 输入输出')!;
  expect(StyleSheet.flatten(inner.props.style)).toMatchObject({height: 184, flexGrow: 0});
  expect(inner.findAllByType(Text).some(node => typeof node.props.children === 'string' && node.props.children.includes('safe output'))).toBe(true);
  expect(inner.props.onContentSizeChange).toBeUndefined(); // Inner tool scroll cannot resize/control the transcript.
  await act(async () => toggle().props.onPress());
  expect(tail()).toBe(mountedTail);
  expect(root.root.findAllByType(ScrollView).some(node => node.props.accessibilityLabel === '工具 earlier_tool 输入输出')).toBe(false);
  await act(async () => root.unmount());
});


test('renders one theme-consistent right navigation rail and resends only the final visible user message', async () => {
  openConfigSession();
  mockWorkspaceMessages = [{
    messageId: 'user-final-fixture', uiMessageId: 'user-final-fixture', role: 'user', order: 1,
    payload: {content: 'send again', reasoningContent: '', summary: '', summaryPrefix: '', timestamp: '', completedTimestamp: '', aiName: '', voiceName: '', status: '', toolCalls: []},
  }];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...workspaceProps()} />); });
  await enterFixtureChat(root);
  for (const label of ['跳到顶部', '上一条消息', '下一条消息', '跳到底部']) {
    expect(root.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')).toHaveLength(1);
  }
  const resend = root.root.findAll(node => node.props.accessibilityLabel === '重发送' && typeof node.props.onPress === 'function');
  expect(resend).toHaveLength(1);
  await act(async () => resend[0].props.onPress());
  expect(mockResendLastUser).toHaveBeenCalledWith('user-final-fixture');
  await act(async () => root.unmount());
});

test('keeps trigger-ratio edit drafts and validates only when saving, and labels empty voice as disabled', async () => {
  openConfigSession();
  const props = configFixture();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  await act(async () => button(root, '上下文').props.onPress());
  const ratio = () => root.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '压缩触发比例')!;
  await act(async () => ratio().props.onChangeText('0.'));
  expect(ratio().props.value).toBe('0.');
  await act(async () => ratio().props.onChangeText('.'));
  expect(ratio().props.value).toBe('.');
  await act(async () => button(root, '保存').props.onPress());
  expect(props.tracked.mock.calls.some(([, method]) => method === 'conversation.config.patch')).toBe(false);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '语音配置')[0].props.onPress());
  expect(root.root.findAllByType(Text).some(node => node.props.children === '关闭')).toBe(true);
  await act(async () => root.unmount());
});

test('shows a fixed-height scrollable safe tool detail panel', async () => {
  openConfigSession();
  mockWorkspaceMessages = [{
    messageId: 'assistant-tool-detail', uiMessageId: 'assistant-tool-detail', role: 'assistant', order: 1,
    payload: {content: '', reasoningContent: '', summary: '', summaryPrefix: '', timestamp: '', completedTimestamp: '', aiName: '', voiceName: '', status: '', toolCalls: [{id: 'safe-tool-detail', name: 'safe_tool', status: 'finished', arguments: {query: 'synthetic'}, result: {value: 'synthetic output'}}]},
  }];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...workspaceProps()} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '查看工具 safe_tool 详情')[0].props.onPress());
  const details = root.root.findAllByType(ScrollView).find(node => node.props.showsVerticalScrollIndicator === true && node.props.nestedScrollEnabled === true);
  expect(StyleSheet.flatten(details?.props.style).height).toBe(184);
  expect(root.root.findAllByType(Text).some(node => node.props.children === '输入参数')).toBe(true);
  expect(root.root.findAllByType(Text).some(node => node.props.children === '输出结果')).toBe(true);
  await act(async () => root.unmount());
});

test('about page lists only the GitHub repositories', async () => {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<ManagementSettings section="about" desktopId="desktop-about" request={jest.fn() as RemoteRequest} onChanged={jest.fn()} refreshSignal={0} />); });
  const text = root.root.findAllByType(Text).map(node => Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children || ''));
  expect(text).toContain('GitHub');
  expect(text).toContain('Anywhere Desktop');
  expect(text).toContain('Anywhere Mobile');
  expect(text.join(' ')).not.toContain('安全的 Desktop 伴侣');
  expect(root.root.findAll(node => node.props.accessibilityLabel === '打开 Anywhere Desktop GitHub' && typeof node.props.onPress === 'function')).toHaveLength(1);
  expect(root.root.findAll(node => node.props.accessibilityLabel === '打开 Anywhere Mobile GitHub' && typeof node.props.onPress === 'function')).toHaveLength(1);
  await act(async () => root.unmount());
});


test('offers a close action only for a session controlled by this Mobile device', async () => {
  mockOpenedSessions = [{
    conversationId: 'conversation-close-shell-fixture-0001', title: 'Closable Fixture',
    visible: false, busy: false, mobileControlled: true, controlledByThisDevice: true,
    hidden: true, hasDesktopObserver: false,
  }];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...workspaceProps()} />); });
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '打开侧边栏')[0].props.onPress());
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '已打开会话')[0].props.onPress());
  const close = root.root.findAll(node =>
    node.props.accessibilityLabel === '关闭会话' &&
    typeof node.props.onPress === 'function',
  );
  const handoff = root.root.findAll(node =>
    node.props.accessibilityLabel === '交还 Desktop' &&
    typeof node.props.onPress === 'function',
  );
  expect(close).toHaveLength(1);
  expect(handoff).toHaveLength(1);
  expect(close[0].parent?.props.style).toBe(handoff[0].parent?.props.style);
  expect(StyleSheet.flatten(close[0].parent?.props.style).borderWidth).toBe(1);
  await act(async () => root.unmount());
});


test('asks Desktop to arbitrate takeover even when Mobile still caches an old busy turn', async () => {
  openConfigSession();
  mockOpenedSessions = [{conversationId: 'conversation-shell-fixture', title: 'Config Fixture', busy: true, mobileControlled: false, controlledByThisDevice: false}];
  mockActiveTurn = {conversationId: 'conversation-shell-fixture', requestId: 'old-stale-request', terminal: false};
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<WorkspaceShell {...workspaceProps()} />);});
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '接管会话' && typeof node.props.onPress === 'function')[0].props.onPress());
  expect(mockTakeoverConversation).toHaveBeenCalledWith('conversation-shell-fixture');
  expect(root.root.findAllByType(Text).some(node => node.props.children === '当前会话仍在处理，待本轮结束后可接管。')).toBe(false);
  await act(async () => root.unmount());
});


test('opens an opened Desktop session without automatically taking it over', async () => {
  mockOpenedSessions = [{
    conversationId: 'conversation-opened-shell-fixture-0001',
    title: 'Opened Fixture',
    visible: true,
    busy: false,
    mobileControlled: false,
    controlledByThisDevice: false,
    hidden: false,
    hasDesktopObserver: false,
  }];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...workspaceProps()} />); });
  await act(async () => {
    root.root.findAll(node => node.props.accessibilityLabel === '打开侧边栏')[0].props.onPress();
  });
  await act(async () => {
    root.root.findAll(node => node.props.accessibilityLabel === '已打开会话')[0].props.onPress();
  });
  await act(async () => {
    root.root.findAll(node => node.props.accessibilityLabel === '打开会话 Opened Fixture')[0].props.onPress();
  });
  expect(mockSelectConversation).toHaveBeenCalledWith(
    'conversation-opened-shell-fixture-0001',
    'Opened Fixture',
  );
  expect(mockTakeoverConversation).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});




test('does not reserve a content bubble for reasoning or tool-only assistant messages', () => {
  const toolOnly = {
    role: 'assistant',
    payload: {content: '<audio src="file:///C:/fixture.mp3"></audio>', reasoningContent: '', toolCalls: [{id: 'tool-fixture', name: 'read_file'}]},
  } as any;
  const reasoningAndTool = {
    role: 'assistant',
    payload: {content: '', reasoningContent: 'synthetic reasoning', toolCalls: [{id: 'tool-fixture', name: 'read_file'}]},
  } as any;
  expect(shouldRenderMessage(toolOnly)).toBe(true);
  expect(hasMessageBubble(toolOnly)).toBe(false);
  expect(shouldRenderMessage(reasoningAndTool)).toBe(true);
  expect(hasMessageBubble(reasoningAndTool)).toBe(false);
});

test('shows the Desktop timestamp for a tool-only assistant message without a content bubble', async () => {
  mockOpenedSessions = [{
    conversationId: 'conversation-tool-time-fixture-0001',
    title: 'Tool Time Fixture',
    visible: true,
    busy: false,
    mobileControlled: false,
    controlledByThisDevice: false,
    hidden: false,
    hasDesktopObserver: false,
  }];
  mockWorkspaceMessages = [{
    uiMessageId: 'assistant-tool-time-fixture',
    messageId: 'assistant-tool-time-fixture',
    role: 'assistant',
    order: 1,
    payload: {
      content: '',
      reasoningContent: '',
      timestamp: '',
      completedTimestamp: '2026-10-20 12:34:00',
      toolCalls: [{id: 'tool-time-fixture', name: 'read_file', status: 'finished'}],
    },
  }];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...workspaceProps()} />); });
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '打开侧边栏')[0].props.onPress());
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '已打开会话')[0].props.onPress());
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '打开会话 Tool Time Fixture')[0].props.onPress());
  const time = root.root.findAll(node => node.props.accessibilityLabel === 'AI 回复时间');
  expect(time.length).toBeGreaterThan(0);
  expect(time.some(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)).match(/2026\/10\/20\s+12:34/))).toBe(true);
  expect(root.root.findAllByType(Text).some(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)) === '调用 read_file')).toBe(true);
  await act(async () => root.unmount());
});


function configFixture(busy = false, contextSource = 'api') {
  const config = {model: 'fixture|model', reasoningEffort: 'default', voice: '', mcpServerIds: [], skillIds: [], systemPrompt: '', compact: {autoCompactEnabled: true, contextLength: 32768, contextLengthSource: 'default', triggerRatio: 0.9, keepRecentRounds: 3, compactPrompt: ''}};
  let lastMethod = '';
  const base = workspaceProps();
  const tracked = jest.fn((_id: string, method: string, _params?: Record<string, unknown>, _timeout?: number) => {
    lastMethod = method;
    return {requestId: 'request-ui-config-fixture', response: Promise.resolve({ok: true})};
  });
  const request = jest.fn(async (id, method, params) => {
    if (method === 'conversation.request.get') return {
      terminal: true, event: 'conversation.config.result',
      result: {busy, contextUsage: {status: 'ready', estimated: true, systemTokens: 100, conversationTokens: 300, toolTokens: 50, updatedAt: 1234}, config: lastMethod === 'conversation.context.refresh' ? {...config, compact: {...config.compact, contextLength: 131072, contextLengthSource: contextSource}} : config, options: {models: [{value: 'fixture|model', label: 'Fixture'}], mcpServers: [], skills: [], reasoningEfforts: [], voices: []}},
    };
    return base.request(id, method, params);
  });
  return {...base, request: request as RemoteRequest, requestTracked: tracked as RemoteTrackedRequest, tracked};
}

async function enterFixtureChat(root: TestRenderer.ReactTestRenderer) {
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '打开侧边栏')[0].props.onPress());
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '已打开会话')[0].props.onPress());
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '打开会话 Config Fixture')[0].props.onPress());
}

function openConfigSession() {
  mockOpenedSessions = [{conversationId: 'conversation-shell-fixture', title: 'Config Fixture', busy: false, controlledByThisDevice: true, mobileControlled: true}];
}

test('long pressing a sidebar row opens the target conversation menu, not a name-only alert', async () => {
  mockCatalog = [{conversationId: 'target-not-current-fixture', title: '长按目标完整名称', readable: true, createdAt: '', project: null}];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<WorkspaceShell {...workspaceProps()} />);});
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '打开侧边栏' && node.props.onPress)[0].props.onPress());
  await act(async () => button(root, '未分组').props.onPress());
  const row = root.root.findAll(node => node.props.accessibilityLabel === '长按目标完整名称' && node.props.onLongPress)[0];
  await act(async () => row.props.onLongPress());
  const {ConversationMenu} = require('../src/components/ConversationMenu');
  expect(root.root.findByType(ConversationMenu).props.conversation.conversationId).toBe('target-not-current-fixture');
  expect(root.root.findAll(node => node.props.accessibilityLabel === '删除会话').length).toBeGreaterThan(0);
  await act(async () => root.unmount());
});

test('context settings render the Desktop usage summary above the controls', async () => {
  openConfigSession();
  const props = configFixture();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<WorkspaceShell {...props} />);});
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置' && node.props.onPress)[0].props.onPress());
  await act(async () => button(root, '上下文').props.onPress());
  const {ContextUsageBar} = require('../src/components/ContextUsageBar');
  expect(root.root.findByType(ContextUsageBar).props.usage).toMatchObject({systemTokens: 100, conversationTokens: 300, toolTokens: 50});
  expect(root.root.findByType(ContextUsageBar).props.capacity).toBe(32768);
  await act(async () => root.unmount());
});


test('saves a manually edited context length and fetches context using the Desktop command', async () => {
  openConfigSession();
  const props = configFixture();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  await act(async () => button(root, '上下文').props.onPress());
  const input = () => root.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '会话上下文长度')!;
  expect(input().props.value).toBe('32768');
  await act(async () => input().props.onChangeText('65536'));
  await act(async () => button(root, '保存').props.onPress());
  expect(props.tracked).toHaveBeenCalledWith(expect.any(String), 'conversation.config.patch', expect.objectContaining({patch: expect.objectContaining({compact: expect.objectContaining({contextLength: 65536})})}), 30_000);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  await act(async () => button(root, '上下文').props.onPress());
  await act(async () => button(root, '一键获取上下文长度').props.onPress());
  expect(input().props.value).toBe('131072');
  expect(props.tracked).toHaveBeenCalledWith(expect.any(String), 'conversation.context.refresh', {conversationId: 'conversation-shell-fixture'}, 30_000);
  await act(async () => root.unmount());
});

test.each(['完成', '保存'])('%s saves changes from all session tabs in one equivalent patch', async action => {
  openConfigSession();
  const props = configFixture();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  const prompt = root.root.findAllByType(TextInput).find(node => node.props.placeholder === '输入本次会话的系统提示词')!;
  await act(async () => prompt.props.onChangeText('saved across tabs'));
  await act(async () => button(root, '上下文').props.onPress());
  const input = root.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '会话上下文长度')!;
  await act(async () => input.props.onChangeText('65536'));
  // Save while a different tab is active; hidden drafts must not disappear.
  await act(async () => button(root, 'Skill').props.onPress());
  const submit = action === '完成'
    ? root.root.findAll(node => node.props.accessibilityLabel === '会话设置完成' && node.props.onPress)[0]
    : button(root, '保存');
  await act(async () => { const first = submit.props.onPress(); const second = submit.props.onPress(); await first; await second; });
  const writes = props.tracked.mock.calls.filter(([, method]) => method === 'conversation.config.patch');
  expect(writes).toHaveLength(1);
  expect(writes[0][2]).toEqual({conversationId: 'conversation-shell-fixture', patch: {systemPrompt: 'saved across tabs', compact: {contextLength: 65536}}});
  await act(async () => root.unmount());
});

test('save failure keeps the draft and reports the error inside the session sheet', async () => {
  openConfigSession();
  const props = configFixture();
  const base = props.tracked.getMockImplementation()!;
  props.tracked.mockImplementation((id, method) => method === 'conversation.config.patch'
    ? {requestId: 'failed-save', response: Promise.reject(Object.assign(new Error('remote_conversation_busy'), {code: 'remote_conversation_busy'}))}
    : base(id, method));
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  const prompt = () => root.root.findAllByType(TextInput).find(node => node.props.placeholder === '输入本次会话的系统提示词')!;
  await act(async () => prompt().props.onChangeText('keep draft'));
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置完成' && node.props.onPress)[0].props.onPress());
  expect(prompt().props.value).toBe('keep draft');
  const status = root.root.findAll(node => node.props.accessibilityLabel === '会话设置操作结果')[0];
  expect(status.props.children).toContain('普通配置可在生成中保存');
  await act(async () => root.unmount());
});

test.each(['remote_context_lookup_timeout', 'remote_context_model_not_found', 'remote_context_network_unavailable'])('context failure %s is visible and preserves manual length', async code => {
  openConfigSession();
  const props = configFixture();
  const base = props.tracked.getMockImplementation()!;
  props.tracked.mockImplementation((id, method) => method === 'conversation.context.refresh'
    ? {requestId: 'failed-context', response: Promise.reject(Object.assign(new Error(code), {code}))}
    : base(id, method));
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  await act(async () => button(root, '上下文').props.onPress());
  const input = () => root.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '会话上下文长度')!;
  await act(async () => input().props.onChangeText('65536'));
  await act(async () => button(root, '一键获取上下文长度').props.onPress());
  expect(input().props.value).toBe('65536');
  const status = root.root.findAll(node => node.props.accessibilityLabel === '会话设置操作结果')[0];
  expect(status.props.children).toContain('已保留原值');
  expect(status.props.children).not.toContain('remote_');
  await act(async () => button(root, '保存').props.onPress());
  expect(props.tracked.mock.calls.find(([, method]) => method === 'conversation.config.patch')?.[2]).toMatchObject({patch: {compact: {contextLength: 65536}}});
  await act(async () => root.unmount());
});

test('successful context lookup preserves other unsaved tabs and API source is not turned into manual on save', async () => {
  openConfigSession();
  const props = configFixture();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  await act(async () => root.root.findAllByType(TextInput).find(node => node.props.placeholder === '输入本次会话的系统提示词')!.props.onChangeText('keep other draft'));
  await act(async () => button(root, '上下文').props.onPress());
  await act(async () => root.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '压缩触发比例')!.props.onChangeText('0.8'));
  await act(async () => button(root, '一键获取上下文长度').props.onPress());
  expect(root.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '会话上下文长度')!.props.value).toBe('131072');
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置完成' && node.props.onPress)[0].props.onPress());
  const patch = props.tracked.mock.calls.find(([, method]) => method === 'conversation.config.patch')?.[2];
  expect(patch).toEqual({conversationId: 'conversation-shell-fixture', patch: {systemPrompt: 'keep other draft', compact: {triggerRatio: 0.8}}});
  await act(async () => root.unmount());
});


test('does not patch unchanged settings and names the read-only header action close', async () => {
  openConfigSession();
  const props = configFixture();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置完成' && node.props.onPress)[0].props.onPress());
  expect(props.tracked.mock.calls.filter(([, method]) => method === 'conversation.config.patch')).toHaveLength(0);
  await act(async () => root.unmount());
  mockOpenedSessions = mockOpenedSessions.map(item => ({...item, controlledByThisDevice: false, mobileControlled: false}));
  const readOnly = configFixture(true);
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...readOnly} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  expect(root.root.findAll(node => node.props.accessibilityLabel === '会话设置关闭' && node.props.onPress)).toHaveLength(1);
  await act(async () => root.unmount());
});

test('rejects a default fallback response without replacing a manually entered length', async () => {
  openConfigSession();
  const props = configFixture(false, 'default');
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  await act(async () => button(root, '上下文').props.onPress());
  const input = () => root.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '会话上下文长度')!;
  await act(async () => input().props.onChangeText('65536'));
  await act(async () => button(root, '一键获取上下文长度').props.onPress());
  expect(input().props.value).toBe('65536');
  expect(root.root.findAll(node => node.props.accessibilityLabel === '会话设置操作结果')[0].props.children).toContain('未返回有效的 API');
  await act(async () => root.unmount());
});


test('keeps session inputs inside a keyboard-avoiding scrollable sheet and reveals focus', async () => {
  openConfigSession();
  const props = configFixture();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  const panel = root.root.findAll(node => node.props.accessibilityLabel === '键盘避让面板 会话设置' && node.props.behavior)[0];
  expect(panel.props.behavior).toMatch(/height|padding/);
  const prompt = root.root.findAllByType(TextInput).find(node => node.props.placeholder === '输入本次会话的系统提示词')!;
  expect(typeof prompt.props.onFocus).toBe('function');
  await act(async () => { prompt.props.onFocus({nativeEvent: {target: 101}}); await new Promise<void>(resolve => setTimeout(resolve, 150)); });
  for (const tab of ['MCP', 'Skill']) {
    await act(async () => button(root, tab).props.onPress());
    const search = root.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === `搜索会话 ${tab}`)!;
    expect(typeof search.props.onFocus).toBe('function');
    await act(async () => { search.props.onFocus({nativeEvent: {target: 102}}); await new Promise<void>(resolve => setTimeout(resolve, 150)); });
  }
  await act(async () => root.unmount());
});


test('allows model configuration while generating without changing the current request', async () => {
  openConfigSession();
  const props = configFixture(true);
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => {
    root.root.findAll(node => node.props.accessibilityLabel === '选择模型')[0].props.onPress();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  expect(props.tracked).toHaveBeenCalledWith(expect.any(String), 'conversation.config.get', {conversationId: 'conversation-shell-fixture'}, 30_000);
  const modelRows = root.root.findAll(node => node.props.disabled === false && typeof node.props.onPress === 'function' && node.findAll(child => child.props.children === 'Fixture').length > 0);
  expect(modelRows.length).toBeGreaterThan(0);
  expect(root.root.findAllByType(Text).some(node => String(node.props.children).includes('下一轮发送时生效'))).toBe(true);
  await act(async () => modelRows[0].props.onPress());
  expect(props.tracked.mock.calls.some(([, method]) => method === 'conversation.config.patch')).toBe(true);
  await act(async () => root.unmount());
});

test('saving session prompt while generating keeps current turn and composer intact', async () => {
  openConfigSession();
  mockActiveTurn = {requestId: 'active-generation', conversationId: 'conversation-shell-fixture', text: 'current reply', terminal: false};
  const turn = mockActiveTurn;
  const props = configFixture(true);
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '会话设置')[0].props.onPress());
  const input = root.root.findAllByType(TextInput).find(node => node.props.placeholder === '输入本次会话的系统提示词')!;
  expect(input.props.editable).toBe(true);
  await act(async () => input.props.onChangeText('next request prompt'));
  await act(async () => button(root, '保存').props.onPress());
  expect(props.tracked.mock.calls.some(([, method]) => method === 'conversation.config.patch')).toBe(true);
  expect(mockActiveTurn).toBe(turn);
  expect(mockActiveTurn.terminal).toBe(false);
  await act(async () => root.unmount());
});


test('forces reconnect from the workspace refresh button while offline', async () => {
  const onReconnect = jest.fn(async () => undefined);
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...workspaceProps()} onReconnect={onReconnect} desktop={{...workspaceProps().desktop, status: '离线'}} />); });
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '刷新' && node.props.onPress)[0].props.onPress());
  expect(onReconnect).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});


test('retains chat and draft during a transport reconnect, with sending disabled', async () => {
  openConfigSession();
  const props = workspaceProps();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...props} />); });
  await enterFixtureChat(root);
  const composer = () => root.root.findAllByType(TextInput).find(node => node.props.placeholder === '输入消息与 AI 聊天')!;
  await act(async () => composer().props.onChangeText('unsent fixture draft'));
  await act(async () => root.update(<WorkspaceShell {...props} desktop={{...props.desktop, status: '离线', detail: '正在恢复连接…'}} />));
  expect(composer().props.value).toBe('unsent fixture draft');
  expect(composer().props.editable).toBe(false);
  expect(root.root.findAll(node => node.props.accessibilityLabel === '连接恢复状态').length).toBeGreaterThan(0);
  await act(async () => root.unmount());
});


test('shows the resolved Agent identity separately from the conversation model', async () => {
  mockOpenedSessions = [{
    conversationId: 'conversation-identity-fixture-0001',
    title: 'Identity Fixture',
    visible: true,
    busy: false,
    mobileControlled: false,
    controlledByThisDevice: false,
    hidden: false,
    hasDesktopObserver: false,
  }];
  mockConversationAssistant = {code: '', name: 'Zero', avatarUrl: ''};
  mockConversationModel = 'CPA | deepseek-v4.1-flash';
  mockWorkspaceMessages = [{
    uiMessageId: 'assistant-identity-fixture',
    messageId: 'assistant-identity-fixture',
    role: 'assistant',
    order: 1,
    payload: {
      content: 'synthetic response',
      reasoningContent: '',
      timestamp: '2026-10-19T00:00:00.000Z',
      completedTimestamp: '',
      toolCalls: [],
    },
  }];
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<WorkspaceShell {...workspaceProps()} />); });
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '打开侧边栏')[0].props.onPress());
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '已打开会话')[0].props.onPress());
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === '打开会话 Identity Fixture')[0].props.onPress());
  const labels = root.root.findAllByType(Text).map(node => node.props.children);
  expect(labels).toContain('Zero');
  expect(labels).toContain('CPA | deepseek-v4.1-flash');
  await act(async () => root.unmount());
});

test('opens the assistant router without creation; explicit assistant selection creates; Home does not cancel', async () => {
  mockCreate.mockClear();
  mockCancel.mockClear();
  const home = jest.fn();
  const request = jest.fn(async () => ({
    ok: true,
    profile: { displayName: 'Fixture', avatarUrl: '' },
    configured: true,
    projects: [],
    assistants: [
      {
        code: 'Code',
        name: 'Test Assistant',
        icon: '',
        model: '',
        defaultProjectName: '',
        mcpCount: 0,
        skillCount: 0,
      },
    ],
  }));
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <WorkspaceShell
        desktop={
          {
            id: 'desktop-shell-fixture',
            name: 'Fixture Desktop',
            status: '在线',
          } as DesktopRuntime
        }
        request={request as RemoteRequest}
        requestTracked={jest.fn() as RemoteTrackedRequest}
        subscribeEvents={() => () => undefined}
        onHome={home}
      />,
    );
  });
  expect(button(root, 'Test Assistant')).toBeTruthy();
  expect(mockCreate).not.toHaveBeenCalled();
  await act(async () => {
    await button(root, 'Test Assistant').props.onPress();
  });
  expect(mockCreate).toHaveBeenCalledWith('Code');
  await act(async () => {
    root.root
      .findAll(
        node =>
          node.props.accessibilityLabel === 'Home' &&
          typeof node.props.onPress === 'function',
      )[0]
      .props.onPress();
  });
  expect(home).toHaveBeenCalledTimes(1);
  expect(mockCancel).not.toHaveBeenCalled();
  await act(async () => {
    await mockOnCapture?.({
      captureId: 'fixture',
      name: '语音.wav',
      type: 'audio/wav',
      size: 44,
      durationMs: 1000,
    });
  });
  expect(mockSend).toHaveBeenCalledWith('', ['upload-audio-fixture']);
  await act(async () => root.unmount());
});

test('uses the same hash-resolved Agent avatar for new-chat cards and conversation headers', async () => {
  mockConversationAssistant = {code: 'DataAgent', name: '数据头像 Agent', avatarUrl: ''};
  mockWorkspaceMessages = [{
    uiMessageId: 'agent-avatar-message',
    messageId: 'agent-avatar-message',
    role: 'assistant',
    order: 1,
    payload: {content: 'synthetic', reasoningContent: '', timestamp: '2026-10-20T00:00:00.000Z', completedTimestamp: '', toolCalls: []},
  }];
  const avatar = {
    kind: 'agent' as const,
    code: 'DataAgent',
    version: 'DataAgentAvatarHash_1234567890',
    mimeType: 'image/png' as const,
    byteLength: 1,
  };
  const request = jest.fn(async () => ({
    ok: true,
    profile: {displayName: 'Fixture', avatarUrl: '', avatar: null},
    configured: true,
    projects: [],
    assistants: [{
      code: 'DataAgent',
      name: '数据头像 Agent',
      icon: '',
      avatar,
      enabled: true,
      model: 'Fixture | model',
      defaultProjectId: '',
      defaultProjectName: '',
      mcpCount: 0,
      skillCount: 0,
      capabilities: ['chat'],
    }],
  }));
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <WorkspaceShell
        desktop={{id: 'desktop-avatar-ui-fixture', name: 'Fixture Desktop', status: '在线'} as DesktopRuntime}
        request={request as RemoteRequest}
        requestTracked={jest.fn() as RemoteTrackedRequest}
        subscribeEvents={() => () => undefined}
        onHome={jest.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  const cardAvatar = root.root.findAllByType(Image).find(node =>
    node.props.source?.uri === 'file:///cache/DataAgent-DataAgentAvatarHash_1234567890.png',
  );
  expect(cardAvatar).toBeTruthy();
  await act(async () => {
    await button(root, '数据头像 Agent').props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
  const headerAvatar = root.root.findAllByType(Image).find(node =>
    node.props.source?.uri === 'file:///cache/DataAgent-DataAgentAvatarHash_1234567890.png',
  );
  expect(headerAvatar).toBeTruthy();
  await act(async () => root.unmount());
});


test.each([
  ['remote_client_closed', '连接被重置，正在恢复。'],
  ['remote_response_too_large', 'Desktop 返回的数据过大，当前请求未完成；连接仍保留。'],
  ['remote_response_invalid', 'Desktop 返回的数据格式异常，当前请求未完成；连接仍保留。'],
])('maps bootstrap error %s to an understandable notice', async (code, notice) => {
  const failingRequest = jest.fn(async () => {
    throw new Error(code);
  });
  let noticeRoot!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    noticeRoot = TestRenderer.create(
      <WorkspaceShell
        desktop={{id: 'desktop-shell-closed', name: 'Fixture Desktop', status: '在线'} as DesktopRuntime}
        request={failingRequest as RemoteRequest}
        requestTracked={jest.fn() as RemoteTrackedRequest}
        subscribeEvents={() => () => undefined}
        onHome={jest.fn()}
      />,
    );
    await Promise.resolve();
  });
  const renderedText = noticeRoot.root.findAllByType(Text).flatMap(node =>
    typeof node.props.children === 'string' ? [node.props.children] : [],
  );
  expect(renderedText).toContain(notice);
  expect(renderedText).not.toContain(code);
  await act(async () => noticeRoot.unmount());
});
