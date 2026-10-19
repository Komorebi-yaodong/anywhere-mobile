import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Image, Text, View} from 'react-native';

import {ConversationMarkdown} from '../src/components/ConversationMarkdown';
import type {RemoteRequest} from '../src/remote/api';

function render(value: string) {
  let root!: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(
      <ConversationMarkdown
        value={value}
        desktopId="desktop-media-fixture"
        conversationId="conversation-media-fixture-0001"
        request={jest.fn() as RemoteRequest}
      />,
    );
  });
  return root;
}

describe('ConversationMarkdown media rendering', () => {
  it('renders HTTPS Markdown image and HTML audio/video with native media views', () => {
    const root = render([
      '![angry bird](https://media.example/fixture.png)',
      '<audio controls><source src="https://media.example/fixture.mp3" type="audio/mpeg"></audio>',
      '<video controls><source src="https://media.example/fixture.mp4" type="video/mp4"></video>',
    ].join('\n'));
    const images = root.root.findAllByType(Image);
    const videos = root.root.findAll(node => node.props.controls === true && node.props.source?.uri);
    expect(images).toHaveLength(1);
    expect(images[0].props.source).toEqual({uri: 'https://media.example/fixture.png'});
    expect([...new Set(videos.map(node => node.props.source.uri))]).toEqual([
      'https://media.example/fixture.mp3',
      'https://media.example/fixture.mp4',
    ]);
    expect(root.root.findAllByType(Text).map(node => node.props.children)).not.toContain('!angry bird');
    act(() => root.unmount());
  });

  it('does not render a native player for a direct local file path', () => {
    const root = render('<audio src="file:///C:/fixture.mp3"></audio>');
    expect(root.root.findAllByType(Image)).toHaveLength(0);
    expect(root.root.findAll(node => node.props.controls === true && node.props.source?.uri)).toHaveLength(0);
    expect(root.root.findAllByType(View)).toBeTruthy();
    act(() => root.unmount());
  });
});
