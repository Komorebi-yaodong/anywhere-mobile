import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Text, TextInput} from 'react-native';

import {GlobalSettings, settingsTitle} from '../src/components/GlobalSettings';
import type {RemoteRequest} from '../src/remote/api';

function press(root: TestRenderer.ReactTestRenderer, label: string) {
  const text = root.root.findAllByType(Text).find(node => node.props.children === label);
  let node = text?.parent;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`Missing pressable ${label}`);
  return node;
}

const catalog = {
  ok: true as const,
  tags: ['研究'],
  routes: {general: '', superior: '', fast: ''},
  routesRevision: 'routes-revision-fixture',
  options: {
    models: [{value: 'provider|model', label: 'Provider | model'}],
    projects: [],
    mcpServers: [{id: 'z-mcp', name: 'Zulu MCP'}, {id: 'a-mcp', name: 'Alpha MCP'}],
    skills: [{id: 'z-skill', name: 'Zulu Skill'}, {id: 'a-skill', name: 'Alpha Skill'}],
    voices: [],
  },
  agents: [
    {
      code: 'disabled', name: 'Zulu', enabled: false, icon: '', iconDataUrl: '', model: '', type: 'general' as const,
      showMode: 'window' as const, tags: [], stream: true, reasoningEffort: 'default', autoSaveChat: false,
      defaultProjectId: '', defaultProjectName: '', voice: '', mcpServerIds: [], skillIds: [], revision: 'revision-disabled',
    },
    {
      code: 'enabled', name: 'Alpha', enabled: true, icon: '', iconDataUrl: '', model: '', type: 'general' as const,
      showMode: 'window' as const, tags: ['研究'], stream: true, reasoningEffort: 'default', autoSaveChat: false,
      defaultProjectId: '', defaultProjectName: '', voice: '', mcpServerIds: [], skillIds: [], revision: 'revision-enabled',
    },
  ],
};

test('Agent settings sort, create tags, and patch only changed Mobile fields', async () => {
  const request = jest.fn(async (_desktopId: string, method: string, _params?: Record<string, unknown>) => {
    if (method === 'workspace.agent.catalog') return catalog;
    if (method === 'workspace.agent.get') {
      return {
        ok: true,
        options: catalog.options,
        agent: {...catalog.agents[1], systemPrompt: 'fixture prompt'},
      };
    }
    return {ok: true};
  });
  const section = jest.fn();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <GlobalSettings
        desktopId="desktop-global-settings-fixture"
        request={request as RemoteRequest}
        onChanged={() => undefined}
        onSectionChange={section}
        refreshSignal={0}
      />,
    );
  });
  expect(settingsTitle('agents')).toBe('设置-Agent');
  expect(section).toHaveBeenCalledWith('agents');
  const names = root.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .filter(value => value === 'Alpha' || value === 'Zulu');
  expect(names).toEqual(['Alpha', 'Zulu']);

  await act(async () => press(root, 'Alpha').props.onPress());
  const nameInput = root.root
    .findAllByType(TextInput)
    .find(node => node.props.placeholder === 'Agent 名称');
  await act(async () => nameInput?.props.onChangeText('Renamed Alpha'));
  await act(async () => press(root, '保存').props.onPress());
  const patchCall = request.mock.calls.find(([, method, params]) =>
    method === 'workspace.agent.mutate' && (params as {operation?: string}).operation === 'patch',
  );
  expect(patchCall?.[2]).toMatchObject({
    code: 'enabled',
    expectedRevision: 'revision-enabled',
    patch: {name: 'Renamed Alpha'},
  });
  expect((patchCall?.[2] as {patch: Record<string, unknown>}).patch).not.toHaveProperty('temperature');
  expect((patchCall?.[2] as {patch: Record<string, unknown>}).patch).not.toHaveProperty('isDirectSend_normal');
  await act(async () => root.unmount());
});
