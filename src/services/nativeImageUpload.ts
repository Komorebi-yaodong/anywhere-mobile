import type {RemoteRequest} from '../remote/api';
import type {RemoteUpload} from '../remote/attachments';
import {randomBase64Url} from '../remote/crypto';
export type ImageProgress = {stage: 'hashing' | 'creating' | 'waiting_first_ack' | 'uploading' | 'completing'; bytes: number; total: number};
export async function uploadNativeImage({desktopId, request, path, name, type, signal, onProgress}: {
  desktopId: string; request: RemoteRequest; path: string; name: string; type: string;
  signal?: AbortSignal; onProgress?: (value: ImageProgress) => void;
}): Promise<RemoteUpload> {
  if (signal?.aborted) throw new Error('remote_upload_cancelled');
  const taskId = randomBase64Url(24);
  const cancel = () => {request(desktopId, 'local.image.cancel', {taskId}).catch(() => undefined);};
  signal?.addEventListener('abort', cancel);
  try {return await request<RemoteUpload>(desktopId, 'local.image.upload', {path, name, type, taskId, onProgress});}
  finally {signal?.removeEventListener('abort', cancel);}
}
export function imageProgressText(value: ImageProgress): string {
  if (value.stage === 'creating') return '正在建立上传…';
  if (value.stage === 'waiting_first_ack') return '正在上传照片…';
  if (value.stage === 'completing') return '正在完成校验…';
  return `${value.stage === 'hashing' ? '校验照片' : '上传照片'} ${Math.round(value.bytes / value.total * 100)}%`;
}
