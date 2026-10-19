import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { WorkspaceShell } from '../src/components/WorkspaceShell';
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
let mockOnCapture: ((capture: unknown) => Promise<unknown>) | undefined;
jest.mock('../src/services/mediaAttachment', () => ({
  uploadAudioCapture: jest.fn(async () => ({
    uploadId: 'upload-audio-fixture',
  })),
}));
jest.mock('../src/hooks/useConversationWorkspace', () => ({
  useConversationWorkspace: () => ({
    configured: true,
    catalog: [],
    messages: [],
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
    conversationModel: '',
    conversationAssistant: {name: '', avatarUrl: ''},
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
