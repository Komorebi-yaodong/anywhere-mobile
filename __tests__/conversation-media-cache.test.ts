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


test('downloads negotiated media in adaptive chunks and writes exactly the requested contiguous bytes', async () => {
  const total = 4 * 1024 * 1024 + 17;
  const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const lengths: number[] = []; let next = 0, clock = 1000;
  const time = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  (FileSystem.readFile as jest.Mock).mockResolvedValue('');
  (FileSystem.exists as jest.Mock).mockResolvedValue(false);
  (FileSystem.stat as jest.Mock).mockResolvedValue({size: total, type: 'file'});
  const rpc = jest.fn(async (_desktop, _method, params: any = {}) => {
    const length = Number(params.length); clock += 50;
    if (length) {expect(params.offset).toBe(next); next += length; lengths.push(length);}
    return {ok: true, adaptive: true, maxChunkBytes: 8 * 1024 * 1024, mediaId: params.mediaId, mimeType: 'audio/wav', totalBytes: total, sha256, offset: params.offset, byteLength: length, data: length ? require('../src/remote/protocol').encodeBase64Url(new Uint8Array(length)) : ''};
  });
  try {
    await expect(getConversationMediaCache({desktopId: 'desktop-adaptive-cache', conversationId, mediaId: 'media_adaptive_cache_0001', request: rpc as RemoteRequest})).resolves.toMatchObject({totalBytes: total});
    expect(lengths[0]).toBe(512 * 1024); expect(lengths[1]).toBe(512 * 1024);
    expect(lengths.some(length => length >= 1024 * 1024)).toBe(true);
    expect(next).toBe(total);
  } finally {time.mockRestore();}
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
