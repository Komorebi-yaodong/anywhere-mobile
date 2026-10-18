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
