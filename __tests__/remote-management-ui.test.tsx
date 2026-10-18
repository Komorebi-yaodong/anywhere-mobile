import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Alert, Text, TextInput} from 'react-native';
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


  it('hides business secrets until explicitly revealed and preserves expectedRevision on save', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const request = jest.fn(async (_id: string, method: string, params?: Record<string, unknown>) => ({
      section: 'general', revision: method.endsWith('replace') ? 'revision-new' : 'revision-original',
      bytes: 25, value: params?.value ?? {language: 'zh', fixtureSecret: 'synthetic'},
    }));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<RemoteSettings desktopId="desktop-fixture-0001" conversationId="conversation-fixture-0001"
      request={request as RemoteRequest} requestTracked={jest.fn() as RemoteTrackedRequest}
      onClose={() => undefined} onChanged={() => undefined} />); });
    await act(async () => button(root, '全部业务配置').props.onPress());
    await act(async () => button(root, '读取选中分区').props.onPress());
    expect(root.root.findAllByType(TextInput)).toHaveLength(0);
    await act(async () => button(root, '显示并编辑秘密').props.onPress());
    const editor = root.root.findByType(TextInput);
    expect(editor.props.autoCorrect).toBe(false);
    await act(async () => editor.props.onChangeText('{"language":"en"}'));
    await act(async () => button(root, '替换此业务配置分区').props.onPress());
    expect(request.mock.calls.filter(call => call[1] === 'business.config.replace')).toHaveLength(0);
    await act(async () => { alert.mock.calls[0][2]?.find(item => item.style === 'destructive')?.onPress?.(); });
    expect(request).toHaveBeenCalledWith('desktop-fixture-0001', 'business.config.replace', {
      section: 'general', expectedRevision: 'revision-original', value: {language: 'en'},
    });
    await act(async () => root.unmount());
    alert.mockRestore();
  });
});
