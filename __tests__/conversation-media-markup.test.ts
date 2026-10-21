import {
  hasRenderableConversationContent,
  parseConversationContent,
} from '../src/components/conversationMediaMarkup';

const opaqueAudio = 'anywhere-media://opaque_audio_fixture_0001?type=audio';

describe('conversation media markup', () => {
  it('renders HTTPS Markdown images and HTML audio/video as native media blocks', () => {
    const blocks = parseConversationContent([
      '图片前缀',
      '![fixture](https://media.example/fixture.png)',
      '<audio controls><source src="https://media.example/fixture.mp3" type="audio/mpeg"></audio>',
      '<video controls><source src="https://media.example/fixture.mp4" type="video/mp4"></video>',
      '文本后缀',
    ].join('\n'));
    expect(blocks.filter(block => block.kind === 'media').map(block => block.kind === 'media' ? block.media.kind : '')).toEqual(['image', 'audio', 'video']);
    expect(blocks.filter(block => block.kind === 'text').map(block => block.kind === 'text' ? block.value.trim() : '')).toEqual(['图片前缀', '文本后缀']);
  });

  it('accepts Desktop-issued opaque local media while preserving surrounding path text', () => {
    const content = `存储位置：E:\\Fixture\\media.mp3\n![本地媒体](${opaqueAudio})`;
    const blocks = parseConversationContent(content);
    expect(blocks).toContainEqual({kind: 'text', value: '存储位置：E:\\Fixture\\media.mp3\n'});
    expect(blocks).toContainEqual(expect.objectContaining({kind: 'media', media: expect.objectContaining({kind: 'audio', uri: opaqueAudio, opaque: true})}));
  });

  it('does not create native players for untrusted direct schemes', () => {
    for (const value of [
      '![unsafe](http://media.example/fixture.png)',
      '<audio src="file:///C:/fixture.mp3"></audio>',
      '<video src="content://fixture/video.mp4"></video>',
      '<img src="data:image/png;base64,AA==">',
    ]) {
      expect(parseConversationContent(value).some(block => block.kind === 'media')).toBe(false);
      expect(hasRenderableConversationContent(value)).toBe(false);
    }
  });

  it('keeps quoted local document paths as text and never turns Office or PDF tags into media', () => {
    const text = '`E:\\Synthetic\\论文.docx`\n`E:\\Synthetic\\结果.xlsx`\n我正在写论文';
    expect(parseConversationContent(text)).toEqual([{kind: 'text', value: text}]);
    for (const extension of ['docx', 'xlsx', 'pdf', 'pptx', 'zip']) {
      for (const markup of [`![file](https://media.example/fixture.${extension})`, `<video src="https://media.example/fixture.${extension}"></video>`, `<img src="file:///E:/Synthetic/file.${extension}">`]) {
        expect(parseConversationContent(markup).some(block => block.kind === 'media')).toBe(false);
      }
    }
  });


  it('treats media-only content as renderable, preventing an empty message bubble', () => {
    expect(hasRenderableConversationContent('<audio><source src="https://media.example/fixture.mp3"></audio>')).toBe(true);
    expect(hasRenderableConversationContent('<audio src="file:///C:/fixture.mp3"></audio>')).toBe(false);
  });
});
