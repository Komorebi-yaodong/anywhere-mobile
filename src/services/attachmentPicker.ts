import {errorCodes, isErrorWithCode, keepLocalCopy, pick} from '@react-native-documents/picker';
import {FileSystem} from 'react-native-file-access';
import {attachmentFileSource} from './attachmentFileSource';
import type {RemoteRequest} from '../remote/api';
import {randomBase64Url} from '../remote/crypto';
import {RemoteUpload, uploadAttachment, validateAttachment} from '../remote/attachments';
import {uploadNativeImage, type ImageProgress} from './nativeImageUpload';
import {controlledErrorCode} from '../remote/transportTrace';

/** Reads only a document explicitly selected by the user. Never forwards its URI. */
export async function pickAndUploadAttachment({desktopId, request, signal, onProgress}: {
  desktopId: string;
  request: RemoteRequest;
  signal?: AbortSignal;
  onProgress?: (progress: ImageProgress) => void;
}): Promise<RemoteUpload | null> {
  const picker = await pick({mode: 'open', allowMultiSelection: false, allowVirtualFiles: false}).catch(error => {
    if (isErrorWithCode(error) && error.code === errorCodes.OPERATION_CANCELED) return null;
    throw new Error('无法打开系统文档选择器，请重新编译应用并检查权限。');
  });
  if (!picker) return null;
  const selected = picker[0];
  if (signal?.aborted) return null;
  const name = selected.name || 'attachment.bin';
  const type = selected.type || 'application/octet-stream';
  if (selected.size != null) validateAttachment({name, type, size: selected.size});
  const [copy] = await keepLocalCopy({
    destination: 'cachesDirectory',
    files: [{uri: selected.uri, fileName: `remote-upload-${randomBase64Url(18)}.tmp`}],
  });
  if (copy.status !== 'success') throw new Error('无法创建所选文档的临时副本。');
  const path = copy.localUri.startsWith('file://')
    ? decodeURIComponent(copy.localUri.slice('file://'.length))
    : copy.localUri;
  try {
    if (type.startsWith('image/')) return await uploadNativeImage({desktopId, request, path, name, type, signal, onProgress});

    const stat = await FileSystem.stat(path);
    return await uploadAttachment({
      desktopId, request, signal, onProgress,
      source: attachmentFileSource(path, {name, type, size: stat.size}),
    });
  } catch (error) {
    // Native errors may contain local paths: expose only controlled protocol codes.
    throw new Error(controlledErrorCode(error));
  } finally {
    // Only this function's generated cache copy is removed; never delete the source.
    await FileSystem.unlink(path).catch(() => undefined);
  }
}
