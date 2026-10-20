import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Alert, Image, Text, View} from 'react-native';

import {ConversationMarkdown} from '../src/components/ConversationMarkdown';
import type {RemoteRequest} from '../src/remote/api';


jest.mock('../src/services/remoteImageCache', () => ({
  cacheRemoteHttpsResource: jest.fn(async ({url}: {url: string}) => ({
    uri: url,
    mimeType: '',
    version: 'fixture',
    expiresAt: '',
    byteLength: 1,
  })),
}));

async function render(value: string) {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <ConversationMarkdown
        value={value}
        desktopId="desktop-media-fixture"
        conversationId="conversation-media-fixture-0001"
        request={jest.fn() as RemoteRequest}
      />,
    );
    await Promise.resolve();
  });
  return root;
}

describe('ConversationMarkdown media rendering', () => {
  it('renders HTTPS Markdown image and HTML audio/video with native media views', async () => {
    const root = await render([
      '![angry bird](https://media.example/fixture.png)',
      '<audio controls><source src="https://media.example/fixture.mp3" type="audio/mpeg"></audio>',
      '<video controls><source src="https://media.example/fixture.mp4" type="video/mp4"></video>',
    ].join('\n'));
    const images = root.root.findAllByType(Image);
    const videos = root.root.findAll(node => node.props.controls === false && node.props.source?.uri);
    expect(images).toHaveLength(1);
    expect(images[0].props.source).toEqual({uri: 'https://media.example/fixture.png'});
    expect([...new Set(videos.map(node => node.props.source.uri))]).toEqual([
      'https://media.example/fixture.mp3',
      'https://media.example/fixture.mp4',
    ]);
    expect(root.root.findAllByType(Text).map(node => node.props.children)).not.toContain('!angry bird');
    act(() => root.unmount());
  });

  it('provides a gesture responder canvas and bounded zoom controls in the full-screen image preview', async () => {
    const root = await render('![gesture](https://media.example/gesture.png)');
    const open = root.root.findAll(node => node.props.accessibilityLabel === '打开图片预览')[0];
    await act(async () => open.props.onPress());
    const canvas = root.root.findByProps({accessibilityLabel: '图片预览画布'});
    expect(typeof canvas.props.onStartShouldSetResponder).toBe('function');
    expect(typeof canvas.props.onResponderMove).toBe('function');
    expect(root.root.findAllByType(Text).map(node => node.props.children)).toContain('双指缩放 · 放大后拖动 · 双击复位');

    await act(async () => {
      root.root.findAll(node => node.props.accessibilityLabel === '放大图片')[0].props.onPress();
    });
    expect(root.root.findAllByType(Text).some(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)) === '150%')).toBe(true);
    await act(async () => {
      root.root.findAll(node => node.props.accessibilityLabel === '缩小图片')[0].props.onPress();
    });
    expect(root.root.findAllByType(Text).some(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)) === '100%')).toBe(true);
    act(() => root.unmount());
  });


  it('requires explicit confirmation before exporting a long-pressed image to system pictures', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const {FileSystem} = require('react-native-file-access');
    const root = await render('![save](https://media.example/export.png)');
    const imagePress = root.root.findAll(node => node.props.accessibilityLabel === '打开图片预览')[0];
    await act(async () => imagePress.props.onLongPress());
    expect(alert).toHaveBeenCalledWith('保存图片', expect.any(String), expect.any(Array));
    expect(FileSystem.cpExternal).not.toHaveBeenCalled();
    const actions = alert.mock.calls[0][2] as Array<{text: string; onPress?: () => void}>;
    await act(async () => {
      actions.find(action => action.text === '保存')?.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(FileSystem.cpExternal).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^Anywhere-.*\.png$/), 'images');
    alert.mockRestore();
    act(() => root.unmount());
  });


  it('does not render a native player for a direct local file path', async () => {
    const root = await render('<audio src="file:///C:/fixture.mp3"></audio>');
    expect(root.root.findAllByType(Image)).toHaveLength(0);
    expect(root.root.findAll(node => node.props.controls === false && node.props.source?.uri)).toHaveLength(0);
    expect(root.root.findAllByType(View)).toBeTruthy();
    act(() => root.unmount());
  });
});
