import {FileSystem} from 'react-native-file-access';

import {getConversationMediaCache} from '../src/services/conversationMediaCache';
import type {RemoteRequest} from '../src/remote/api';

const mediaId = 'opaque_media_fixture_0001';
const conversationId = 'conversation-cache-fixture-0001';

beforeEach(() => {
  jest.clearAllMocks();
  (FileSystem.stat as unknown as jest.Mock).mockResolvedValue({size: 3, type: 'file'});
});

test('concurrent first image loads share mkdir instead of failing Android EEXIST', async () => {
  let exists = false;
  (FileSystem.exists as jest.Mock).mockImplementation(async path => path === '/cache/anywhere-conversation-media' && exists);
  (FileSystem.mkdir as jest.Mock).mockImplementation(async () => {if (exists) throw Object.assign(new Error('exists'), {code: 'EEXIST'}); exists = true; return '/cache/anywhere-conversation-media';});
  (FileSystem.readFile as jest.Mock).mockRejectedValue(new Error('empty cache'));
  const request = jest.fn(async (_desktop, _method, params = {}) => ({ok: true, mediaId: params.mediaId, mimeType: 'image/png', totalBytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', offset: params.offset, byteLength: params.length ? 3 : 0, data: params.length ? 'YWJj' : ''})) as RemoteRequest;
  const images = await Promise.all(['first_concurrent_image_001', 'first_concurrent_image_002', 'first_concurrent_image_003'].map(id => getConversationMediaCache({desktopId: 'desktop-concurrent-fixture', conversationId, mediaId: id, request})));
  expect(images).toHaveLength(3); expect(FileSystem.mkdir).toHaveBeenCalledTimes(1);
  expect(FileSystem.mv).toHaveBeenCalledTimes(3);
  expect((FileSystem.writeFile as jest.Mock).mock.calls.filter(([, , encoding]) => encoding === 'base64').every(([path]) => path.endsWith('.part'))).toBe(true);
  (FileSystem.exists as jest.Mock).mockResolvedValue(false); (FileSystem.mkdir as jest.Mock).mockResolvedValue('/cache'); (FileSystem.readFile as jest.Mock).mockResolvedValue('');
});

test('failed downloads discard their partial file and can be retried without accepting corrupt bytes', async () => {
  const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  let fail = true;
  const rpc = jest.fn(async (_desktop, _method, params) => {
    if (params.length && fail) throw new Error('synthetic connection lost');
    return {ok: true, mediaId: params.mediaId, mimeType: 'image/png', totalBytes: 3, sha256, offset: params.offset, byteLength: params.length ? 3 : 0, data: params.length ? 'YWJj' : ''};
  });
  const args = {desktopId: 'desktop-retry-cache', conversationId, mediaId: 'retry_cache_image_0001', request: rpc as RemoteRequest};
  await expect(getConversationMediaCache(args)).rejects.toThrow('connection lost');
  expect(FileSystem.unlink).toHaveBeenCalledWith(expect.stringMatching(/\.part$/)); expect(FileSystem.mv).not.toHaveBeenCalled();
  fail = false;
  await expect(getConversationMediaCache(args)).resolves.toMatchObject({sha256}); expect(FileSystem.mv).toHaveBeenCalledTimes(1);
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
