import {sha256} from '@noble/hashes/sha2.js';
import {decodeBase64Url, decodeUtf8, remoteError} from './protocol';

export const RESULT_TRANSFER_CAPABILITY = 'remote.transfer.v1';
const maxResultBytes = 32 * 1024 * 1024;
const maxActiveBytes = 64 * 1024 * 1024;
const chunkBytes = 48 * 1024;
const deadlineMs = 120_000;
type Request = (method: string, params: Record<string, unknown>) => Promise<any>;
type Reference = {id: string; totalBytes: number; sha256: string; chunkBytes: number};
const invalid = () => remoteError('remote_transfer_invalid');

/** Reads immutable JSON, never re-dispatches the originating operation. */
export function createResultTransferReader(request: Request) {
  let closed = false;
  let activeBytes = 0;
  const pending = new Map<string, Promise<unknown>>();
  function reference(value: unknown): Reference {
    const ref = value as Reference;
    if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(ref.id) ||
        !Number.isSafeInteger(ref.totalBytes) || ref.totalBytes < 1 || ref.totalBytes > maxResultBytes ||
        typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.chunkBytes !== chunkBytes) throw invalid();
    return ref;
  }
  async function read(value: unknown): Promise<unknown> {
    const ref = reference(value);
    if (closed) throw remoteError('remote_client_closed');
    // Include all version metadata: an ID reused with a changed digest is not a cache hit.
    const key = `${ref.id}:${ref.totalBytes}:${ref.sha256}`;
    const existing = pending.get(key);
    if (existing) return existing;
    if (activeBytes + ref.totalBytes > maxActiveBytes) throw remoteError('remote_transfer_capacity');
    activeBytes += ref.totalBytes;
    const started = Date.now();
    const check = () => {
      if (closed) throw remoteError('remote_client_closed');
      if (Date.now() - started >= deadlineMs) throw remoteError('remote_transfer_timeout');
    };
    const run = (async () => {
      const bytes = new Uint8Array(ref.totalBytes);
      try {
        for (let offset = 0; offset < bytes.length;) {
          check();
          let reply;
          // Retry only an identical read. Never retry a command or allocate a new snapshot.
          for (let attempt = 0; ; attempt++) {
            try {reply = await request('remote.transfer.chunk', {id: ref.id, offset}); break;}
            catch (cause) {check(); if (attempt || (cause as {code?: string})?.code !== 'remote_request_timeout') throw cause;}
          }
          check();
          const length = Math.min(chunkBytes, bytes.length - offset);
          if (reply?.id !== ref.id || reply.offset !== offset || reply.totalBytes !== ref.totalBytes ||
              reply.sha256 !== ref.sha256 || reply.byteLength !== length) throw invalid();
          const chunk = decodeBase64Url(reply.data, 'transfer.data', {minBytes: length, maxBytes: length});
          bytes.set(chunk, offset); chunk.fill(0); offset += length;
        }
        check();
        const digest = Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
        if (digest !== ref.sha256) throw invalid();
        let result;
        try {result = JSON.parse(decodeUtf8(bytes));} catch {throw invalid();}
        check();
        return result;
      } finally {
        bytes.fill(0);
        if (!closed) request('remote.transfer.release', {id: ref.id}).catch(() => undefined);
      }
    })();
    pending.set(key, run);
    try {return await run;} finally {activeBytes -= ref.totalBytes; pending.delete(key);}
  }
  return {read, close: () => {closed = true;}};
}
