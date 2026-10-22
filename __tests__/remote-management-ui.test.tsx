import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Alert, Text} from 'react-native';
import {ConversationActions} from '../src/components/ConversationActions';
import {RemoteSettings} from '../src/components/RemoteSettings';
import type {RemoteRequest, RemoteTrackedRequest} from '../src/remote/api';

function button(root: TestRenderer.ReactTestRenderer, label: string) {
  const text = root.root.findAllByType(Text).find(node =>
    Array.isArray(node.props.children)
      ? node.props.children.join('') === label : node.props.children === label,
  );
  let target = text?.parent;
  while (target && typeof target.props.onPress !== 'function') target = target.parent;
  if (!target) throw new Error(`Missing button: ${label}`);
  return target;
}

describe('Remote destructive confirmation and business revision UI', () => {
  it('does not delete until local confirmation, and waits for terminal Writer result', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const tracked = jest.fn(() => ({requestId: 'request-delete-ui-0001', response: Promise.resolve({ok: true})}));
    const request = jest.fn().mockResolvedValue({terminal: true, event: 'conversation.operation.completed', result: {deleted: true}});
    const completed = jest.fn();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<ConversationActions
      desktopId="desktop-fixture-0001" conversationId="conversation-fixture-0001"
      action={{method: 'conversation.delete'}} request={request as RemoteRequest}
      requestTracked={tracked as RemoteTrackedRequest} onClose={() => undefined} onCompleted={completed}
    />); });
    await act(async () => { button(root, '确认').props.onPress(); });
    expect(tracked).not.toHaveBeenCalled();
    const confirm = alert.mock.calls[0][2]?.find(item => item.style === 'destructive');
    await act(async () => { confirm?.onPress?.(); });
    expect(tracked).toHaveBeenCalledWith('desktop-fixture-0001', 'conversation.delete', {
      conversationId: 'conversation-fixture-0001', confirmed: true,
    }, 30000);
    expect(completed).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    alert.mockRestore();
  });

  it('deletes a message from a single centered confirmation without a nested Alert', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const tracked = jest.fn(() => ({requestId: 'request-message-delete-0001', response: Promise.resolve({ok: true})}));
    const request = jest.fn().mockResolvedValue({terminal: true, event: 'conversation.operation.completed', result: {deleted: true}});
    const completed = jest.fn();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<ConversationActions
      desktopId="desktop-fixture-0001" conversationId="conversation-fixture-0001"
      action={{method: 'conversation.message.delete', uiMessageId: 'ui-message-fixture-0001'}}
      request={request as RemoteRequest} requestTracked={tracked as RemoteTrackedRequest}
      onClose={() => undefined} onCompleted={completed}
    />); });
    const texts = root.root.findAllByType(Text).flatMap(node =>
      typeof node.props.children === 'string' ? [node.props.children] : [],
    );
    expect(texts).toContain('确认删除？');
    expect(texts).toContain('删除后将无法找回');
    expect(texts).toContain('取消');
    await act(async () => { button(root, '确认').props.onPress(); });
    expect(alert).not.toHaveBeenCalled();
    expect(tracked).toHaveBeenCalledWith('desktop-fixture-0001', 'conversation.message.delete', {
      conversationId: 'conversation-fixture-0001', uiMessageId: 'ui-message-fixture-0001',
    }, 30000);
    await act(async () => root.unmount());
    alert.mockRestore();
  });


  it('blocks same-frame double confirmation, never displays the request ID, and completes only once', async () => {
    let release!: (value: unknown) => void;
    const tracked = jest.fn(() => ({requestId: 'request-internal-delete-secret', response: new Promise(resolve => { release = resolve; })}));
    const request = jest.fn().mockResolvedValue({terminal: true, event: 'conversation.operation.completed'});
    const completed = jest.fn();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<ConversationActions desktopId="desktop-fixture" conversationId="conversation-fixture" action={{method: 'conversation.message.delete', uiMessageId: 'ui-fixture'}} request={request as RemoteRequest} requestTracked={tracked as RemoteTrackedRequest} onClose={() => undefined} onCompleted={completed} />); });
    const confirm = button(root, '确认').props.onPress;
    await act(async () => { confirm(); confirm(); });
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(root.toJSON())).not.toContain('request-internal-delete-secret');
    expect(root.root.findAllByType(Text).filter(node => node.props.children === '正在删除')).toHaveLength(1);
    expect(JSON.stringify(root.toJSON())).not.toContain('正在删除消息');
    expect(JSON.stringify(root.toJSON())).not.toContain('正在等待');
    expect(JSON.stringify(root.toJSON())).not.toContain('原请求');
    await act(async () => { release({ok: true}); });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(button(root, '已完成').props.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it('automatically queries the same pending delete without another mutation or user-visible request ID', async () => {
    jest.useFakeTimers();
    const tracked = jest.fn(() => ({requestId: 'request-pending-delete-internal', response: Promise.resolve({ok: true})}));
    const request = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({terminal: true, event: 'conversation.operation.completed'});
    const completed = jest.fn();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<ConversationActions desktopId="desktop-fixture" conversationId="conversation-fixture" action={{method: 'conversation.message.delete', uiMessageId: 'ui-fixture'}} request={request as RemoteRequest} requestTracked={tracked as RemoteTrackedRequest} onClose={() => undefined} onCompleted={completed} />); });
    await act(async () => button(root, '确认').props.onPress());
    expect(JSON.stringify(root.toJSON())).not.toContain('request-pending-delete-internal');
    expect(button(root, '正在删除').props.disabled).toBe(true);
    await act(async () => {jest.advanceTimersByTime(2500);});
    expect(request).toHaveBeenLastCalledWith('desktop-fixture', 'conversation.request.get', {requestId: 'request-pending-delete-internal'});
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    jest.useRealTimers();
  });

  it('does not offer another destructive confirmation after a terminal failure', async () => {
    const tracked = jest.fn(() => ({requestId: 'request-failed-delete', response: Promise.resolve({ok: true})}));
    const request = jest.fn().mockResolvedValue({terminal: true, event: 'conversation.operation.failed', result: {code: 'remote_message_state_changed'}});
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<ConversationActions desktopId="desktop-fixture" conversationId="conversation-fixture" action={{method: 'conversation.message.delete', uiMessageId: 'ui-fixture'}} request={request as RemoteRequest} requestTracked={tracked as RemoteTrackedRequest} onClose={() => undefined} onCompleted={jest.fn()} />); });
    await act(async () => button(root, '确认').props.onPress());
    expect(button(root, '请关闭后刷新').props.disabled).toBe(true);
    await act(async () => button(root, '请关闭后刷新').props.onPress());
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(root.toJSON())).not.toContain('remote_message_state_changed');
    await act(async () => root.unmount());
  });


  it('replaces the raw secret partition editor with safe structured settings', async () => {
    const request = jest.fn(async (_desktopId: string, _method: string) => ({ok: true, items: [], sections: [], agents: [], models: [], options: {}}));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<RemoteSettings desktopId="desktop-fixture-0001" conversationId="conversation-fixture-0001"
      request={request as RemoteRequest} requestTracked={jest.fn() as RemoteTrackedRequest}
      onClose={() => undefined} onChanged={() => undefined} />); });
    await act(async () => button(root, '全部业务配置').props.onPress());
    const {GlobalSettings} = require('../src/components/GlobalSettings');
    expect(root.root.findAllByType(GlobalSettings)).toHaveLength(1);
    expect(request.mock.calls.some(call => ['business.config.get', 'business.config.replace'].includes(String(call[1])))).toBe(false);
    expect(JSON.stringify(root.toJSON())).not.toContain('显示并编辑秘密');
    await act(async () => root.unmount());
  });
});
