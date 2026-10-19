import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Text, TextInput} from 'react-native';

import {SimpleManagementSettings} from '../src/components/SimpleManagementSettings';
import type {RemoteRequest} from '../src/remote/api';

function hasText(root: TestRenderer.ReactTestRenderer, label: string) {
  return root.root.findAllByType(Text).some(node => node.props.children === label);
}

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

  expect(hasText(root, '全部标签')).toBe(true);
  expect(hasText(root, 'Research')).toBe(true);
  expect(hasText(root, '研究 MCP')).toBe(true);
  expect(hasText(root, '文件 MCP')).toBe(true);

  await act(async () => {
    root.root.findByProps({accessibilityLabel: '筛选 MCP 标签 Research'}).props.onPress();
  });
  expect(hasText(root, '研究 MCP')).toBe(true);
  expect(hasText(root, '文件 MCP')).toBe(false);

  await act(async () => {
    root.root.findByProps({accessibilityLabel: '筛选全部 MCP 标签'}).props.onPress();
    root.root.findByType(TextInput).props.onChangeText('文件');
  });
  expect(hasText(root, '研究 MCP')).toBe(false);
  expect(hasText(root, '文件 MCP')).toBe(true);
  expect(JSON.stringify(root.toJSON())).not.toContain('PRIVATE_COMMAND_MUST_NOT_RENDER');
  expect(request).toHaveBeenCalledWith(
    'desktop-management-tags-fixture',
    'workspace.management.details.get',
    {section: 'mcp'},
  );

  await act(async () => root.unmount());
});
