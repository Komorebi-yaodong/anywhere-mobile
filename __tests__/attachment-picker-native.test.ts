import {FileSystem} from 'react-native-file-access';
import {pick, keepLocalCopy} from '@react-native-documents/picker';
import {pickAndUploadAttachment} from '../src/services/attachmentPicker';
import {uploadNativeImage} from '../src/services/nativeImageUpload';
import {uploadAttachment} from '../src/remote/attachments';
import type {RemoteRequest} from '../src/remote/api';
jest.mock('@react-native-documents/picker', () => ({pick: jest.fn(), keepLocalCopy: jest.fn(), errorCodes: {OPERATION_CANCELED: 'cancelled'}, isErrorWithCode: () => false}));
jest.mock('../src/services/nativeImageUpload', () => ({uploadNativeImage: jest.fn(async () => ({uploadId: 'native-image'}))}));
jest.mock('../src/remote/attachments', () => ({validateAttachment: jest.fn(), uploadAttachment: jest.fn(async () => ({uploadId: 'document'}))}));
const request = jest.fn() as RemoteRequest;
beforeEach(() => {
  jest.clearAllMocks();
  (keepLocalCopy as jest.Mock).mockResolvedValue([{status: 'success', localUri: 'file:///cache/generated-copy.tmp'}]);
});
it('routes image documents through native without JS file hash/read, then removes only its cache copy', async () => {
  (pick as jest.Mock).mockResolvedValue([{name: 'photo.jpg', type: 'image/jpeg', size: 839680, uri: 'content://synthetic-selected'}]);
  const progress = jest.fn();const controller = new AbortController();
  await expect(pickAndUploadAttachment({desktopId: 'synthetic', request, signal: controller.signal, onProgress: progress})).resolves.toEqual({uploadId: 'native-image'});
  expect(uploadNativeImage).toHaveBeenCalledWith({desktopId: 'synthetic', request, path: '/cache/generated-copy.tmp', name: 'photo.jpg', type: 'image/jpeg', signal: controller.signal, onProgress: progress});
  expect(uploadAttachment).not.toHaveBeenCalled();expect(FileSystem.hash).not.toHaveBeenCalled();expect(FileSystem.stat).not.toHaveBeenCalled();
  expect(FileSystem.unlink).toHaveBeenCalledWith('/cache/generated-copy.tmp');
});
it('preserves nonimage attachment policy', async () => {
  (pick as jest.Mock).mockResolvedValue([{name: 'doc.pdf', type: 'application/pdf', uri: 'content://synthetic-selected'}]);
  await expect(pickAndUploadAttachment({desktopId: 'synthetic', request})).resolves.toEqual({uploadId: 'document'});
  expect(uploadNativeImage).not.toHaveBeenCalled();expect(uploadAttachment).toHaveBeenCalledTimes(1);
});
it('retains controlled native failures and cleans the generated file', async () => {
  (pick as jest.Mock).mockResolvedValue([{name: 'photo.jpg', type: 'image/jpeg', uri: 'content://synthetic-selected'}]);
  (uploadNativeImage as jest.Mock).mockRejectedValueOnce({code: 'remote_pong_timeout', message: 'private path'});
  await expect(pickAndUploadAttachment({desktopId: 'synthetic', request})).rejects.toThrow('remote_pong_timeout');
  expect(FileSystem.unlink).toHaveBeenCalledWith('/cache/generated-copy.tmp');
});
