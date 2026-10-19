import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {Image, Text} from 'react-native';
import { WorkspaceShell } from '../src/components/WorkspaceShell';

import {hasMessageBubble, shouldRenderMessage} from '../src/components/WorkspaceShell';
import type { DesktopRuntime } from '../src/hooks/useDesktops';
import type { RemoteRequest, RemoteTrackedRequest } from '../src/remote/api';

const mockCreate = jest.fn(async () => undefined);
const mockCancel = jest.fn(async () => undefined);
const mockSend = jest.fn(async () => undefined);
const mockSelectConversation = jest.fn();
const mockTakeoverConversation = jest.fn(async () => undefined);
const mockHandoffConversation = jest.fn(async () => undefined);
const mockRefreshOpenedSessions = jest.fn(async () => undefined);
let mockOpenedSessions: Array<Record<string, unknown>> = [];
let mockWorkspaceMessages: Array<Record<string, any>> = [];
let mockConversationModel = '';
let mockConversationAssistant = {code: '', name: '', avatarUrl: ''};
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
    catalog: [],
    messages: mockWorkspaceMessages,
    activeTurn: null,
    queuedSends: [],
    selectedConversationId: 'conversation-shell-fixture',
    selectedConversation: { title: 'Fixture Chat' },
    createConversation: mockCreate,
    cancelActiveTurn: mockCancel,
    sendMessage: mockSend,
    refreshCatalog: jest.fn(),
    refreshMessages: jest.fn(),
    removeQueuedSend: jest.fn(),
    reaskLastAssistant: jest.fn(),
    messagePage: {hasMore: false},
    conversationModel: mockConversationModel,
    conversationAssistant: mockConversationAssistant,
    tasks: [],
    pendingChoices: {},
    openedSessions: mockOpenedSessions,
    canControlConversation: () => true,
    selectConversation: mockSelectConversation,
    takeoverConversation: mockTakeoverConversation,
    handoffConversation: mockHandoffConversation,
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

  mockWorkspaceMessages = [];
  mockConversationModel = '';
  mockConversationAssistant = {code: '', name: '', avatarUrl: ''};
  mockSelectConversation.mockClear();
  mockTakeoverConversation.mockClear();
  mockHandoffConversation.mockClear();
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
