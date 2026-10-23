import {uploadAttachment, validateAttachment} from '../src/remote/attachments';
import {sha256Base64Url} from '../src/remote/crypto';
import {decodeBase64Url} from '../src/remote/protocol';
import {RemoteCommandPendingError, startCommand, waitForCommand} from '../src/remote/commands';
import type {RemoteRequest, RemoteTrackedRequest} from '../src/remote/api';

const desktopId = 'desktop-operations-fixture-0001';
const uploadId = 'upload-operations-fixture-0001';

describe('Remote attachment protocol', () => {
  it('hashes in chunks and sends only basename metadata plus ordered Base64URL chunks', async () => {
    const data = Uint8Array.from({length: 150000}, (_, i) => i % 251);
    let metadata: Record<string, unknown> = {};
    let received = 0;
    let next = 0;
    const calls: string[] = [];
    const rpc = jest.fn(async (_desktopId: string, method: string, params: Record<string, unknown> = {}) => {
      calls.push(method);
      if (method === 'attachment.begin') metadata = params;
      if (method === 'attachment.chunk') {
        expect(params.index).toBe(next);
        const chunk = decodeBase64Url(params.data);
        expect(chunk).toEqual(data.slice(received, received + chunk.length));
        received += chunk.length;
        next += 1;
      }
      return {ok: true, upload: {
        ...metadata, uploadId, receivedBytes: received, nextChunkIndex: next,
        maxChunkBytes: 65536,
        state: method === 'attachment.complete' ? 'completed' : 'uploading',
      }};
    });
    const completed = await uploadAttachment({desktopId, request: rpc as RemoteRequest,
      source: {name: 'fixture.bin', type: 'application/octet-stream', size: data.length,
        read: async (offset, length) => data.slice(offset, offset + length)},
    });
    expect(metadata).toEqual({name: 'fixture.bin', type: 'application/octet-stream', size: data.length, sha256: sha256Base64Url(data)});
    expect(completed.state).toBe('completed');
    expect(calls).toEqual(['attachment.begin', 'attachment.chunk', 'attachment.chunk', 'attachment.chunk', 'attachment.complete']);
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/file:\/\/|content:\/\/|localUri/);
  });

  it.each([65536, 512 * 1024])('keeps only three ordered %i-byte chunks in flight and finishes only after every validated receipt', async chunkSize => {
    const data = new Uint8Array(chunkSize * 6 + 17).fill(7); const sha = sha256Base64Url(data);
    const receipts: Array<() => void> = []; const indices: number[] = []; let completed = false;
    const metadata = {name: 'large.jpg', type: 'image/jpeg', size: data.length, sha256: sha};
    const rpc = jest.fn((_id, method, params = {}) => {
      if (method === 'attachment.chunk') {
        const index = (params as any).index; indices.push(index);
        return new Promise(resolve => receipts.push(() => resolve({ok: true, upload: {...metadata, uploadId, receivedBytes: Math.min(data.length, (index + 1) * chunkSize), nextChunkIndex: index + 1}})));
      }
      if (method === 'attachment.complete') completed = true;
      return Promise.resolve({ok: true, upload: {...metadata, uploadId, maxChunkBytes: chunkSize, receivedBytes: completed ? data.length : 0, nextChunkIndex: 0, state: completed ? 'completed' : 'uploading'}});
    });
    const nativeHash = jest.fn(async () => sha); const read = jest.fn(async () => new Uint8Array());
    const upload = uploadAttachment({desktopId, request: rpc as RemoteRequest, source: {...metadata, read, hash: nativeHash, readBase64: async (offset, length) => require('base64-js').fromByteArray(data.slice(offset, offset + length))}});
    const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
    await flush(); expect(indices).toEqual([0, 1, 2]); expect(completed).toBe(false); expect(read).not.toHaveBeenCalled();
    for (let index = 0; index < Math.ceil(data.length / chunkSize); index++) {
      receipts[index](); await flush();
      expect(indices.length - index - 1).toBeLessThanOrEqual(3);
    }
    await expect(upload).resolves.toMatchObject({state: 'completed'});
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6]); expect(nativeHash).toHaveBeenCalledTimes(1);
  });

  it.each([128 * 1024, 512 * 1024])('honors the peer chunk size %i, including older Desktops, without changing the file cap', async chunkSize => {
    const data = new Uint8Array(512 * 1024 + 1).fill(9);
    const lengths: number[] = [];
    const read = jest.fn(async (offset: number, length: number) => {
      expect(length).toBeLessThanOrEqual(512 * 1024);
      return data.slice(offset, offset + length);
    });
    let metadata: Record<string, unknown> = {}; let received = 0; let next = 0;
    const rpc = jest.fn(async (_id, method, params: Record<string, unknown> = {}) => {
      if (method === 'attachment.begin') metadata = params;
      if (method === 'attachment.chunk') {
        const bytes = decodeBase64Url(params.data);
        expect(params.index).toBe(next++); expect(bytes.length).toBeLessThanOrEqual(chunkSize);
        lengths.push(bytes.length); received += bytes.length;
      }
      return {ok: true, upload: {...metadata, uploadId, maxChunkBytes: chunkSize, receivedBytes: received, nextChunkIndex: next, state: method === 'attachment.complete' ? 'completed' : 'uploading'}};
    });
    await expect(uploadAttachment({desktopId, request: rpc as RemoteRequest, source: {name: 'boundary.wav', type: 'audio/wav', size: data.length, read}})).resolves.toMatchObject({state: 'completed'});
    expect(lengths).toEqual([...Array(512 * 1024 / chunkSize).fill(chunkSize), 1]);
    expect(() => validateAttachment({name: 'limit.bin', type: 'application/octet-stream', size: 25 * 1024 * 1024})).not.toThrow();
    expect(() => validateAttachment({name: 'limit.bin', type: 'application/octet-stream', size: 25 * 1024 * 1024 + 1})).toThrow();
  });

  it('rejects a peer advertising more than 512 KiB before reading or sending upload chunks', async () => {
    const read = jest.fn(async () => new Uint8Array());
    const rpc = jest.fn(async () => ({upload: {uploadId, maxChunkBytes: 512 * 1024 + 1, receivedBytes: 0, nextChunkIndex: 0}}));
    await expect(uploadAttachment({desktopId, request: rpc as RemoteRequest, source: {name: 'fixture.bin', type: 'application/octet-stream', size: 1, read, hash: async () => sha256Base64Url(new Uint8Array([1]))}})).rejects.toMatchObject({code: 'remote_upload_response_invalid'});
    expect(read).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenLastCalledWith(desktopId, 'attachment.abort', {uploadId});
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('drains in-flight chunks before aborting a refused upload and never retries', async () => {
    const data = new Uint8Array(200000).fill(3); const sha = sha256Base64Url(data); const calls: string[] = [];
    const rpc = jest.fn(async (_id, method, params = {}) => {
      calls.push(method);
      if (method === 'attachment.chunk' && (params as any).index === 1) throw new Error('synthetic chunk refusal');
      const index = Number((params as any).index) || 0;
      return {ok: true, upload: {uploadId, maxChunkBytes: 65536, receivedBytes: method === 'attachment.begin' ? 0 : (index + 1) * 65536, nextChunkIndex: method === 'attachment.begin' ? 0 : index + 1}};
    });
    await expect(uploadAttachment({desktopId, request: rpc as RemoteRequest, source: {name: 'fixture.jpg', type: 'image/jpeg', size: data.length, hash: async () => sha, read: async (offset, length) => data.slice(offset, offset + length)}})).rejects.toThrow('chunk refusal');
    expect(calls.at(-1)).toBe('attachment.abort'); expect(calls).not.toContain('attachment.complete');
    const indices = rpc.mock.calls.filter(([, method]) => method === 'attachment.chunk').map(([, , params]) => (params as any).index);
    expect(new Set(indices).size).toBe(indices.length);
  });


  it('aborts if source changes or upload is cancelled after begin', async () => {
    const controller = new AbortController();
    const rpc = jest.fn(async () => {
      controller.abort();
      return {upload: {uploadId, maxChunkBytes: 128 * 1024, receivedBytes: 0, nextChunkIndex: 0}};
    });
    await expect(uploadAttachment({desktopId, request: rpc as RemoteRequest, signal: controller.signal,
      source: {name: 'fixture.txt', type: 'text/plain', size: 3, read: async () => new Uint8Array([1, 2, 3])},
    })).rejects.toMatchObject({code: 'remote_upload_cancelled'});
    expect(rpc).toHaveBeenLastCalledWith(desktopId, 'attachment.abort', {uploadId});
  });

  it('rejects local paths, zero/oversized files and invalid MIME', () => {
    for (const name of ['../secret', 'folder/file', 'folder\\file']) {
      expect(() => validateAttachment({name, type: 'text/plain', size: 1})).toThrow();
    }
    expect(() => validateAttachment({name: 'test', type: 'text/plain', size: 0})).toThrow();
    expect(() => validateAttachment({name: 'test', type: 'text/plain', size: 26 * 1024 * 1024})).toThrow();
    expect(() => validateAttachment({name: 'test', type: 'invalid', size: 1})).toThrow();
  });
});

describe('Renderer command completion boundary', () => {
  it('waits for terminal state after ACK, never dispatching twice', async () => {
    const tracked = jest.fn(() => ({requestId: 'request-operation-0001', response: Promise.resolve({ok: true})}));
    const request = jest.fn()
      .mockResolvedValueOnce({terminal: false, event: 'conversation.command.accepted'})
      .mockResolvedValueOnce({terminal: true, event: 'conversation.operation.completed', result: {revision: 4}});
    const state = await waitForCommand({desktopId, requestId: 'request-operation-0001', request: request as RemoteRequest, intervalMs: 0});
    expect(state.result?.revision).toBe(4);
    const receipt = startCommand({desktopId, method: 'conversation.rename', params: {conversationId: 'conversation-fixture-0001', title: 'test'},
      request: jest.fn().mockResolvedValue({terminal: true, event: 'conversation.operation.completed'}) as RemoteRequest,
      requestTracked: tracked as RemoteTrackedRequest,
    });
    await receipt.completion;
    expect(tracked).toHaveBeenCalledTimes(1);
  });

  it('preserves original request ID when response/state are unavailable', async () => {
    const tracked = jest.fn(() => ({requestId: 'request-operation-0002', response: Promise.reject(Object.assign(new Error(), {code: 'remote_request_timeout'}))}));
    const receipt = startCommand({desktopId, method: 'conversation.delete', params: {conversationId: 'conversation-fixture-0001', confirmed: true},
      requestTracked: tracked as RemoteTrackedRequest,
      request: jest.fn().mockRejectedValue(new Error('offline')) as RemoteRequest,
    });
    await expect(receipt.completion).rejects.toMatchObject({requestId: 'request-operation-0002'});
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(new RemoteCommandPendingError('test').code).toBe('remote_command_pending');
  });

  it('surfaces terminal Desktop failures rather than reporting success', async () => {
    await expect(waitForCommand({desktopId, requestId: 'request-operation-0003',
      request: jest.fn().mockResolvedValue({terminal: true, event: 'conversation.operation.failed', result: {code: 'remote_operation_failed'}}) as RemoteRequest,
    })).rejects.toMatchObject({code: 'remote_operation_failed'});
  });
});
