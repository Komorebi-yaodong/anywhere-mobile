import {sha256} from '@noble/hashes/sha2.js';
import {utf8ToBytes} from './utf8';
import type {RemoteRequest} from './api';
import {decodeBase64Url, encodeBase64Url, normalizeIdentifier, remoteError} from './protocol';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_CHUNK_BYTES = 128 * 1024;
const uploadWindow = 3;
export type AttachmentSource = {
  name: string;
  type: string;
  size: number;
  read: (offset: number, length: number) => Promise<Uint8Array>;
  /** App-private immutable file sources can hash/read in native code. */
  hash?: () => Promise<string>;
  readBase64?: (offset: number, length: number) => Promise<string>;
};
export type RemoteUpload = {
  uploadId: string; name: string; type: string; size: number; sha256: string;
  state: string; receivedBytes: number; nextChunkIndex: number;
  maxChunkBytes: number; expiresAt: string;
};
type UploadReply = {ok: true; upload: RemoteUpload};

export function validateAttachment(source: Pick<AttachmentSource, 'name' | 'type' | 'size'>) {
  const name = source.name.trim();
  const hasControl = [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || hasControl || utf8ToBytes(name).length > 255) throw remoteError('remote_upload_name_invalid');
  if (!Number.isSafeInteger(source.size) || source.size < 1 || source.size > MAX_ATTACHMENT_BYTES) throw remoteError('remote_upload_size_invalid');
  const type = source.type.trim().toLowerCase() || 'application/octet-stream';
  if (type.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(type)) throw remoteError('remote_upload_type_invalid');
  return {name, type, size: source.size};
}

export async function uploadAttachment({desktopId, request, source, signal, onProgress}: {
  desktopId: string; request: RemoteRequest; source: AttachmentSource; signal?: AbortSignal;
  onProgress?: (progress: {stage: 'hashing' | 'uploading'; bytes: number; total: number}) => void;
}): Promise<RemoteUpload> {
  const metadata = validateAttachment(source);
  let uploadId = '';
  const inFlight: Array<Promise<{error?: unknown}>> = [];
  const check = () => {if (signal?.aborted) throw remoteError('remote_upload_cancelled');};
  const read = async (offset: number, length: number) => {
    check(); const bytes = await source.read(offset, length); check();
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw remoteError('remote_upload_source_changed');
    return bytes;
  };
  const hash = sha256.create();
  const settle = async () => {
    const result = await inFlight.shift()!;
    if (result.error) throw result.error;
    check();
  };
  try {
    check();
    let sha: string;
    if (source.hash) {
      onProgress?.({stage: 'hashing', bytes: 0, total: metadata.size});
      sha = await source.hash();
      decodeBase64Url(sha, 'sha256', {minBytes: 32, maxBytes: 32});
      check(); onProgress?.({stage: 'hashing', bytes: metadata.size, total: metadata.size});
    } else {
      for (let offset = 0; offset < metadata.size; offset += MAX_ATTACHMENT_CHUNK_BYTES) {
        const length = Math.min(MAX_ATTACHMENT_CHUNK_BYTES, metadata.size - offset);
        const bytes = await read(offset, length);
        try {hash.update(bytes);} finally {bytes.fill(0);}
        onProgress?.({stage: 'hashing', bytes: offset + length, total: metadata.size});
      }
      const digest = hash.digest(); sha = encodeBase64Url(digest); digest.fill(0);
    }
    check();
    const begin = await request<UploadReply>(desktopId, 'attachment.begin', {...metadata, sha256: sha});
    uploadId = normalizeIdentifier(begin.upload.uploadId, 'uploadId', {minLength: 16});
    const chunkSize = begin.upload.maxChunkBytes;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_ATTACHMENT_CHUNK_BYTES || begin.upload.receivedBytes !== 0 || begin.upload.nextChunkIndex !== 0) throw remoteError('remote_upload_response_invalid');
    let acknowledged = 0;
    for (let offset = 0, index = 0; offset < metadata.size; index++) {
      check();
      const length = Math.min(chunkSize, metadata.size - offset);
      let data: string;
      if (source.readBase64) {
        const base64 = await source.readBase64(offset, length); check();
        data = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
        if (!/^[A-Za-z0-9_-]+$/.test(data) || data.length !== Math.ceil(length * 4 / 3)) throw remoteError('remote_upload_source_changed');
      } else {
        const bytes = await read(offset, length);
        try {data = encodeBase64Url(bytes);} finally {bytes.fill(0);}
      }
      offset += length;
      const expectedBytes = offset, expectedIndex = index + 1;
      // Submission order is unchanged; only waiting for receipts is pipelined.
      // Wrap rejections immediately and drain before abort, never retry a chunk.
      inFlight.push(request<UploadReply>(desktopId, 'attachment.chunk', {uploadId, index, data}).then(reply => {
        if (reply.upload.uploadId !== uploadId || reply.upload.receivedBytes !== expectedBytes || reply.upload.nextChunkIndex !== expectedIndex) throw remoteError('remote_upload_response_invalid');
        acknowledged = Math.max(acknowledged, expectedBytes);
        onProgress?.({stage: 'uploading', bytes: acknowledged, total: metadata.size});
        return {};
      }).catch(error => ({error})));
      if (inFlight.length >= uploadWindow) await settle();
    }
    while (inFlight.length) await settle();
    check();
    const {upload} = await request<UploadReply>(desktopId, 'attachment.complete', {uploadId});
    decodeBase64Url(upload.sha256, 'sha256', {minBytes: 32, maxBytes: 32});
    if (upload.uploadId !== uploadId || upload.state !== 'completed' || upload.size !== metadata.size || upload.receivedBytes !== metadata.size || upload.sha256 !== sha) throw remoteError('remote_upload_response_invalid');
    check(); return upload;
  } catch (error) {
    await Promise.all(inFlight);
    if (uploadId) await request(desktopId, 'attachment.abort', {uploadId}).catch(() => undefined);
    throw error;
  } finally {hash.destroy();}
}
