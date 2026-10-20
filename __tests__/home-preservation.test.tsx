import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import App from '../App';
jest.mock('react-native-safe-area-context', () => {
  const R=require('react');const Native=require('react-native');
  return {SafeAreaProvider:({children}:{children:React.ReactNode})=>R.createElement(Native.View,null,children),SafeAreaView:({children,...props}:{children:React.ReactNode})=>R.createElement(Native.View,props,children)};
});

let mockStatus = '在线';
const mockReconnect = jest.fn(async () => undefined);
const mockMounted = jest.fn(),
  mockUnmounted = jest.fn();
jest.mock('../src/components/WorkspaceShell', () => ({
  WorkspaceShell: ({ onHome }: { onHome: () => void }) => {
    const R = require('react');
    const Native = require('react-native');
    R.useEffect(() => {
      mockMounted();
      return () => mockUnmounted();
    }, []);
    return R.createElement(
      Native.Pressable,
      { accessibilityLabel: 'fixture-home', onPress: onHome },
      R.createElement(Native.Text, null, 'Workspace'),
    );
  },
}));
jest.mock('../src/hooks/useDesktops', () => ({
  useDesktops: () => ({
    desktops: [
      {
        id: 'desktop-home-fixture',
        name: 'Fixture',
        status: mockStatus,
        tlsMode: 'pinned',
        certificateFingerprint: '',
      },
    ],
    remove: jest.fn(),
    reconnect: mockReconnect,
    pair: jest.fn(),
    rename: jest.fn(async () => undefined),
    updateProfile: jest.fn(async () => undefined),
    request: jest.fn(async () => ({
      ok: true,
      profile: {displayName: 'Fixture', avatarUrl: ''},
      configured: true,
      projects: [],
      assistants: [],
    })), 
    requestTracked: jest.fn(),
    subscribeEvents: jest.fn(),
  }),
}));
function enter(root: TestRenderer.ReactTestRenderer) {
  let node = root.root
    .findAllByType(Text)
    .find(n => n.props.children === '进入桌面')?.parent;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  node!.props.onPress();
}
test.each(['打开或重连 Fixture', '立即重连 Fixture'])('Home offline action %s triggers manual reconnect without restarting the app', async label => {
  mockStatus = '离线'; mockReconnect.mockClear();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<App />); });
  await act(async () => root.root.findAll(node => node.props.accessibilityLabel === label && node.props.onPress)[0].props.onPress());
  expect(mockReconnect).toHaveBeenCalledTimes(1);
  expect(mockReconnect).toHaveBeenCalledWith('desktop-home-fixture');
  await act(async () => root.unmount());
  mockStatus = '在线';
});


test('Home navigation retains the same Workspace instance and generation state', async () => {
  mockMounted.mockClear();
  mockUnmounted.mockClear();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<App />);
  });
  await act(async () => enter(root));
  expect(mockMounted).toHaveBeenCalledTimes(1);
  await act(async () =>
    root.root
      .findAll(
        n =>
          n.props.accessibilityLabel === 'fixture-home' &&
          typeof n.props.onPress === 'function',
      )[0]
      .props.onPress(),
  );
  expect(mockUnmounted).not.toHaveBeenCalled();
  await act(async () => enter(root));
  expect(mockMounted).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  expect(mockUnmounted).toHaveBeenCalledTimes(1);
});
