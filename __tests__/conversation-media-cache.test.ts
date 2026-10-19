import {FileSystem} from 'react-native-file-access';

import {getConversationMediaCache} from '../src/services/conversationMediaCache';
import type {RemoteRequest} from '../src/remote/api';

const mediaId = 'opaque_media_fixture_0001';
const conversationId = 'conversation-cache-fixture-0001';

beforeEach(() => {
  jest.clearAllMocks();
  (FileSystem.stat as unknown as jest.Mock).mockResolvedValue({size: 3, type: 'file'});
});

test('downloads opaque local media only through the conversation-bound chunk API', async () => {
  const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const requestMock = jest.fn(async (_desktopId: string, method: string, params?: Record<string, unknown>) => {
    expect(method).toBe('conversation.media.get');
    expect(params).toMatchObject({conversationId, mediaId});
    if (params?.length === 0) return {
      ok: true,
      mediaId,
      mimeType: 'audio/mpeg',
      totalBytes: 3,
      sha256,
      offset: 0,
      byteLength: 0,
      data: '',
    };
    return {
      ok: true,
      mediaId,
      mimeType: 'audio/mpeg',
      totalBytes: 3,
      sha256,
      offset: 0,
      byteLength: 3,
      data: 'YWJj',
    };
  });
  const request = requestMock as unknown as RemoteRequest;
  const cache = await getConversationMediaCache({
    desktopId: 'desktop-cache-fixture',
    conversationId,
    mediaId,
    request,
  });
  expect(cache.uri).toContain(mediaId);
  expect(cache.mimeType).toBe('audio/mpeg');
  expect(requestMock).toHaveBeenCalledTimes(2);
  expect(requestMock.mock.calls[0][2]).toMatchObject({offset: 0, length: 0});
  expect(FileSystem.writeFile).toHaveBeenCalled();
  expect(FileSystem.hash).toHaveBeenCalledWith(expect.any(String), 'SHA-256');
});
