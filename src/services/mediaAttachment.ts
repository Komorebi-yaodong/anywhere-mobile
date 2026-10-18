import type { RemoteRequest } from '../remote/api';
import {
  uploadAttachment,
  validateAttachment,
  type RemoteUpload,
} from '../remote/attachments';
import { MediaCapture, type AudioCapture } from '../native/MediaCapture';

export async function pickPhotoUpload({
  desktopId,
  request,
  uri,
  name,
  type,
}: {
  desktopId: string;
  request: RemoteRequest;
  uri: string;
  name: string;
  type: string;
}): Promise<RemoteUpload> {
  const { keepLocalCopy } = await import('@react-native-documents/picker');
  const { FileSystem } = await import('react-native-file-access');
  const { toByteArray } = await import('base64-js');
  const { randomBase64Url } = await import('../remote/crypto');
  const [copy] = await keepLocalCopy({
    destination: 'cachesDirectory',
    files: [{ uri, fileName: `remote-photo-${randomBase64Url(18)}.tmp` }],
  });
  if (copy.status !== 'success') throw new Error('照片缓存失败。');
  const path = copy.localUri.startsWith('file://')
    ? decodeURIComponent(copy.localUri.slice(7))
    : copy.localUri;
  try {
    const stat = await FileSystem.stat(path);
    return await uploadAttachment({
      desktopId,
      request,
      source: {
        name,
        type,
        size: stat.size,
        read: async (offset, length) =>
          toByteArray(
            await FileSystem.readFileChunk(path, offset, length, 'base64'),
          ),
      },
    });
  } finally {
    await FileSystem.unlink(path).catch(() => undefined);
  }
}

/** Uploads only an app-private recorded capture, then removes its cache file. */
export async function uploadAudioCapture({
  desktopId,
  request,
  capture,
  signal,
  onProgress,
}: {
  desktopId: string;
  request: RemoteRequest;
  capture: AudioCapture;
  signal?: AbortSignal;
  onProgress?: (value: {
    stage: 'hashing' | 'uploading';
    bytes: number;
    total: number;
  }) => void;
}): Promise<RemoteUpload> {
  try {
    validateAttachment({
      name: capture.name,
      type: capture.type,
      size: capture.size,
    });
    return await uploadAttachment({
      desktopId,
      request,
      signal,
      onProgress,
      source: {
        name: capture.name,
        type: capture.type,
        size: capture.size,
        read: (offset, length) =>
          MediaCapture.readChunk(capture.captureId, offset, length),
      },
    });
  } finally {
    await MediaCapture.deleteCapture(capture.captureId).catch(() => undefined);
  }
}

/** Uploads a VisionCamera temporary photo and removes it after the encrypted upload. */
export async function uploadCapturedPhoto({
  desktopId,
  request,
  path,
  signal,
  onProgress,
}: {
  desktopId: string;
  request: RemoteRequest;
  path: string;
  signal?: AbortSignal;
  onProgress?: (value: {
    stage: 'hashing' | 'uploading';
    bytes: number;
    total: number;
  }) => void;
}): Promise<RemoteUpload> {
  const { FileSystem } = await import('react-native-file-access');
  const { toByteArray } = await import('base64-js');
  const safePath = String(path || '');
  if (!safePath || safePath.includes('..')) throw new Error('拍摄照片不可用。');
  try {
    const stat = await FileSystem.stat(safePath);
    const name = `照片-${Date.now()}.jpg`;
    return await uploadAttachment({
      desktopId,
      request,
      signal,
      onProgress,
      source: {
        name,
        type: 'image/jpeg',
        size: stat.size,
        read: async (offset, length) =>
          toByteArray(
            await FileSystem.readFileChunk(safePath, offset, length, 'base64'),
          ),
      },
    });
  } finally {
    await FileSystem.unlink(safePath).catch(() => undefined);
  }
}
