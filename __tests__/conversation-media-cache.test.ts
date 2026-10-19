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
  const request = jest.fn(async (_desktopId: string, method: string, params?: Record<string, unknown>) => {
    expect(method).toBe('conversation.media.get');
    expect(params).toMatchObject({conversationId, mediaId});
    return {
      ok: true,
      mediaId,
      mimeType: 'audio/mpeg',
      totalBytes: 3,
      offset: 0,
      byteLength: 3,
      data: 'YWJj',
    };
  }) as RemoteRequest;
  const cache = await getConversationMediaCache({
    desktopId: 'desktop-cache-fixture',
    conversationId,
    mediaId,
    request,
  });
  expect(cache.uri).toContain(mediaId);
  expect(cache.mimeType).toBe('audio/mpeg');
  expect(request).toHaveBeenCalledTimes(1);
  expect(FileSystem.writeFile).toHaveBeenCalled();
});
