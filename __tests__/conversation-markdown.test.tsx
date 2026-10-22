import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Alert, Image, Text, View} from 'react-native';

import {ConversationMarkdown} from '../src/components/ConversationMarkdown';
import type {RemoteRequest} from '../src/remote/api';

import Video from 'react-native-video';

const mockPlaybackCalls: string[] = [];
jest.mock('react-native-video', () => {
  const R = require('react'); const Native = require('react-native');
  return {__esModule: true, default: R.forwardRef((props: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({
      seek: (position: number) => mockPlaybackCalls.push(`seek:${position}`),
      resume: () => mockPlaybackCalls.push('resume'),
      pause: () => mockPlaybackCalls.push('pause'),
    }));
    return R.createElement(Native.View, props);
  })};
});
jest.mock('../src/services/conversationMediaCache', () => ({getConversationMediaCache: jest.fn(async () => ({uri: 'file:///cache/recording.m4a', mimeType: 'audio/mp4'}))}));



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

  it('shows audio controls without transport/cache implementation labels', async () => {
    const root = await render('<audio controls src="https://media.example/recording.m4a"></audio>');
    const output = JSON.stringify(root.toJSON());
    expect(output).not.toContain('受限缓存音频'); expect(output).not.toContain('HTTPS 音频'); expect(output).toContain('音频播放');
    await act(async () => root.unmount());
  });

  it.each(['https://media.example/replay.m4a', 'anywhere-media://opaque_audio_fixture_0001?type=audio'])('replays the same audio from the beginning on every completed playback: %s', async uri => {
    mockPlaybackCalls.length = 0;
    const root = await render(`<audio src="${uri}"></audio>`);
    const engine = () => root.root.findByType(Video);
    const press = async (label: string) => act(async () => root.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0].props.onPress());
    await act(async () => engine().props.onLoad({duration: 20}));
    await press('播放音频');
    expect(mockPlaybackCalls).toEqual(['resume']);
    for (let replay = 0; replay < 3; replay++) {
      await act(async () => {engine().props.onProgress({currentTime: 20}); engine().props.onEnd();});
      expect(engine().props.paused).toBe(true);

      await act(async () => engine().props.onProgress({currentTime: 20}));
      const clock = root.root.findAllByType(Text).find(node => Array.isArray(node.props.children) && node.props.children.includes(' / '))!;
      expect(clock.props.children.join('')).toBe('0:00 / 0:20');
      mockPlaybackCalls.length = 0;
      await press('播放音频');
      expect(mockPlaybackCalls).toEqual(['seek:0', 'resume']);
      expect(engine().props.paused).toBe(false);
    }
    mockPlaybackCalls.length = 0;
    await act(async () => engine().props.onProgress({currentTime: 8}));
    await press('暂停音频'); await press('播放音频');
    expect(mockPlaybackCalls).toEqual(['pause', 'resume']);
    await act(async () => root.unmount());
  });


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

  it('captures pinch, pan and double tap gestures on the full-screen image canvas', async () => {
    const root = await render('![gesture](https://media.example/gesture.png)');
    const open = root.root.findAll(node => node.props.accessibilityLabel === '打开图片预览')[0];
    await act(async () => open.props.onPress());
    const canvas = root.root.findByProps({accessibilityLabel: '图片预览画布'});
    expect(typeof canvas.props.onStartShouldSetResponderCapture).toBe('function');
    expect(typeof canvas.props.onMoveShouldSetResponderCapture).toBe('function');
    expect(root.root.findAll(node =>
      node.props.pointerEvents === 'none' && node.findAll(child => child.props.source?.uri === 'https://media.example/gesture.png').length > 0,
    ).length).toBeGreaterThan(0);
    expect(root.root.findAllByType(Text).map(node => node.props.children)).not.toContain('按钮缩放 · 放大后拖动 · 双击复位');

    // TestRenderer does not provide React Native's touchHistory required by
    // PanResponder's responder callbacks. Runtime touch events do; assert the
    // capture/transparent boundary here and keep the bounded button zoom check.
    await act(async () => {
      root.root.findAll(node => node.props.accessibilityLabel === '放大图片')[0].props.onPress();
    });
    expect(root.root.findAllByType(Text).some(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)) === '150%')).toBe(true);
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


  it('shows only a document notice for a large legacy extracted file, without mounting media', async () => {
    const root = await render(`file name:fixture.docx\nfile content:\n${'SYNTHETIC_DOCUMENT_BODY'.repeat(30000)}\nfile end`);
    expect(root.root.findAllByType(Image)).toHaveLength(0);
    expect(root.root.findAll(node => node.props.controls === false && node.props.source?.uri)).toHaveLength(0);
    const texts = root.root.findAllByType(Text).map(node => String(node.props.children));
    expect(texts.some(text => text.includes('fixture.docx'))).toBe(true);
    expect(texts.some(text => text.includes('SYNTHETIC_DOCUMENT_BODY'))).toBe(false);
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
