import type { RemoteRequest } from '../remote/api';

import {uploadNativeImage, type ImageProgress} from './nativeImageUpload';

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
  onProgress,

  signal,
}: {
  desktopId: string;
  request: RemoteRequest;
  uri: string;
  name: string;
  type: string;

  signal?: AbortSignal;
  onProgress?: (progress: ImageProgress) => void;
}): Promise<RemoteUpload> {
  const { keepLocalCopy } = await import('@react-native-documents/picker');
  const { FileSystem } = await import('react-native-file-access');
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
    return await uploadNativeImage({desktopId, request, path, name, type, signal, onProgress});
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
  onProgress?: (value: ImageProgress) => void;
}): Promise<RemoteUpload> {
  const { FileSystem } = await import('react-native-file-access');
  const safePath = String(path || '');
  if (!safePath || safePath.includes('..')) throw new Error('拍摄照片不可用。');
  try {
    const name = `照片-${Date.now()}.jpg`;
    return await uploadNativeImage({desktopId, request, signal, onProgress, path: safePath, name, type: 'image/jpeg'});
  } finally {
    await FileSystem.unlink(safePath).catch(() => undefined);
  }
}
