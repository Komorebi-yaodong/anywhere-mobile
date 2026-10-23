import {FileSystem} from 'react-native-file-access';
import {toByteArray} from 'base64-js';
import {encodeBase64Url} from '../remote/protocol';
import type {AttachmentSource} from '../remote/attachments';

/** Only called with this app's explicitly selected/copied or captured file. */
export function attachmentFileSource(path: string, metadata: Pick<AttachmentSource, 'name' | 'type' | 'size'>): AttachmentSource {
  return {
    ...metadata,
    read: async (offset, length) => toByteArray(await FileSystem.readFileChunk(path, offset, length, 'base64')),
    readBase64: (offset, length) => FileSystem.readFileChunk(path, offset, length, 'base64'),
    hash: async () => {
      const hex = await FileSystem.hash(path, 'SHA-256');
      if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('附件校验失败。');
      return encodeBase64Url(Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16)));
    },
  };
}
