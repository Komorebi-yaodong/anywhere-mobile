import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Image, ScrollView, StyleSheet, Text, TextInput} from 'react-native';

import {SimpleManagementSettings} from '../src/components/SimpleManagementSettings';
import type {RemoteRequest} from '../src/remote/api';

function hasText(root: TestRenderer.ReactTestRenderer, label: string) {
  return root.root.findAllByType(Text).some(node => node.props.children === label);
}

test('offline general settings retains local appearance and shared saved identity', async () => {
  let root!: TestRenderer.ReactTestRenderer;
  const request = jest.fn(async () => {throw Error('remote_client_closed');});
  await act(async () => {root = TestRenderer.create(<SimpleManagementSettings section="general" desktopId="offline-fixture" profileName="Komorebi" profileAvatar="file:///fixture-avatar.png" request={request as RemoteRequest} onChanged={() => {}} refreshSignal={0} />);});
  expect(hasText(root, 'Komorebi')).toBe(true);
  expect(root.root.findByType(Image).props.source.uri).toBe('file:///fixture-avatar.png');
  const action = root.root.findAll(node => node.props.accessibilityLabel === '外观设置' && typeof node.props.onPress === 'function')[0];
  expect(action).toBeTruthy();expect(action.props.disabled).not.toBe(true);
  await act(async () => action.props.onPress());
  expect(root.root.findByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled');
  expect(StyleSheet.flatten(root.root.findByType(ScrollView).props.contentContainerStyle).padding).toBe(16);
  await act(async () => root.unmount());
});


test.each(['mcp', 'skills'] as const)('sorts global %s by name regardless of enabled state', async section => {
 const request = jest.fn(async () => ({ok: true, section, items: [{id: 'z', name: 'Zebra', enabled: true}, {id: 'a10', name: 'Alpha10', enabled: true}, {id: 'a2', name: 'Alpha2', enabled: false}]}));
 let root!: TestRenderer.ReactTestRenderer;
 await act(async () => {root = TestRenderer.create(<SimpleManagementSettings section={section} desktopId="sort-fixture" request={request as RemoteRequest} onChanged={() => {}} refreshSignal={0} />);});
 const labels = root.root.findAllByType(Text).map(node => node.props.children).filter(value => ['Zebra', 'Alpha10', 'Alpha2'].includes(String(value)));
 expect(labels).toEqual(['Alpha2', 'Alpha10', 'Zebra']);
 await act(async () => root.unmount());
});


test('filters global MCP services by visible configuration tags and keywords only', async () => {
  const request = jest.fn(async () => ({
    ok: true,
    section: 'mcp',
    items: [
      {
        id: 'mcp-research-fixture',
        revision: 'revision-research',
        name: '研究 MCP',
        tags: ['Research', '知识库'],
        enabled: true,
        transport: 'stdio',
        command: 'PRIVATE_COMMAND_MUST_NOT_RENDER',
      },
      {
        id: 'mcp-files-fixture',
        revision: 'revision-files',
        name: '文件 MCP',
        tags: ['文件'],
        enabled: true,
        transport: 'stdio',
      },
      {
        id: 'mcp-builtin-fixture',
        revision: 'revision-builtin',
        name: '工作区工具 MCP',
        tags: ['系统'],
        enabled: true,
        transport: 'builtin',
      },
    ],
  }));
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <SimpleManagementSettings
        section="mcp"
        desktopId="desktop-management-tags-fixture"
        request={request as RemoteRequest}
        onChanged={() => undefined}
        refreshSignal={0}
      />,
    );
  });

  expect(hasText(root, '全部标签')).toBe(false);
  expect(hasText(root, 'Research')).toBe(true);
  expect(hasText(root, '研究 MCP')).toBe(true);
  expect(hasText(root, '文件 MCP')).toBe(true);
  expect(hasText(root, '工作区工具 MCP')).toBe(true);
  expect(hasText(root, '内置')).toBe(true);

  await act(async () => root.root.findByType(TextInput).props.onChangeText('Research'));
  expect(hasText(root, '研究 MCP')).toBe(true);
  expect(hasText(root, '文件 MCP')).toBe(false);
  expect(hasText(root, '工作区工具 MCP')).toBe(false);

  await act(async () => root.root.findByType(TextInput).props.onChangeText('文件'));
  expect(hasText(root, '研究 MCP')).toBe(false);
  expect(hasText(root, '文件 MCP')).toBe(true);

  await act(async () => root.root.findByType(TextInput).props.onChangeText('内置'));
  expect(hasText(root, '工作区工具 MCP')).toBe(true);
  expect(hasText(root, '文件 MCP')).toBe(false);
  await act(async () => root.root.findByType(TextInput).props.onChangeText('builtin'));
  expect(hasText(root, '工作区工具 MCP')).toBe(true);
  expect(JSON.stringify(root.toJSON())).not.toContain('PRIVATE_COMMAND_MUST_NOT_RENDER');
  expect(request).toHaveBeenCalledWith(
    'desktop-management-tags-fixture',
    'workspace.management.details.get',
    {section: 'mcp'},
  );

  await act(async () => root.unmount());
});

function saveButton(root: TestRenderer.ReactTestRenderer) {return root.root.findAll(node => node.props.accessibilityLabel === '保存昵称' && typeof node.props.onPress === 'function')[0];}
test('shows real saved name and avatar, saves only changed nickname with revision and refreshes shared profile', async () => {
  let name = 'Komorebi';const changed = jest.fn(async () => undefined);
  const request = jest.fn(async (_id: string, method: string, params: any) => {
    if (method === 'workspace.management.patch') {name = params.patch.displayName;return {ok: true};}
    return {ok: true, section: 'general', revision: 'revision-profile-fixture', value: {displayName: name}};
  });let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<SimpleManagementSettings section="general" desktopId="profile-fixture" profileName="Komorebi" profileAvatar="file:///cached-avatar.png" request={request as RemoteRequest} onChanged={changed} refreshSignal={0} />);});
  expect(hasText(root, 'Komorebi')).toBe(true);expect(root.root.findByType(Image).props.source.uri).toBe('file:///cached-avatar.png');
  expect(saveButton(root).props.disabled).toBe(true);
  await act(async () => root.root.findByType(TextInput).props.onChangeText('  New name  '));
  expect(hasText(root, 'Komorebi')).toBe(true);expect(hasText(root, 'New name')).toBe(false);
  expect(saveButton(root).props.disabled).toBe(false);
  await act(async () => saveButton(root).props.onPress());
  expect(request).toHaveBeenCalledWith('profile-fixture', 'workspace.management.patch', {section: 'general', id: '', expectedRevision: 'revision-profile-fixture', patch: {displayName: 'New name'}}, 60000);
  expect(changed).toHaveBeenCalledTimes(1);expect(hasText(root, 'New name')).toBe(true);expect(hasText(root, '已保存')).toBe(true);expect(saveButton(root).props.disabled).toBe(true);
  await act(async () => root.root.findByType(Image).props.onError());expect(root.root.findAllByType(Image)).toHaveLength(0);expect(hasText(root, 'N')).toBe(true);
  await act(async () => root.unmount());
});
test('failed save preserves the saved identity and unsaved input without false success', async () => {
  const changed = jest.fn();const request = jest.fn(async (_id: string, method: string) => {
    if (method === 'workspace.management.patch') throw Error('remote_workspace_revision_conflict');
    return {ok: true, section: 'general', revision: 'fixture-revision', value: {displayName: 'Saved Name'}};
  });let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<SimpleManagementSettings section="general" desktopId="failure-fixture" request={request as RemoteRequest} onChanged={changed} refreshSignal={0} />);});
  await act(async () => root.root.findByType(TextInput).props.onChangeText('Unsaved'));
  await act(async () => saveButton(root).props.onPress());
  expect(hasText(root, 'Saved Name')).toBe(true);expect(root.root.findByType(TextInput).props.value).toBe('Unsaved');expect(hasText(root, '已保存')).toBe(false);expect(changed).not.toHaveBeenCalled();
  expect(hasText(root, 'Desktop 配置已更新，请刷新后再修改。')).toBe(true);
  await act(async () => root.unmount());
});
