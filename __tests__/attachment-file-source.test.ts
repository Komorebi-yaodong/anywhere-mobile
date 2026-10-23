import {FileSystem} from 'react-native-file-access';
import {attachmentFileSource} from '../src/services/attachmentFileSource';

it('hashes an app-private file natively and returns Base64 without decoding/re-encoding large chunks', async () => {
 (FileSystem.hash as jest.Mock).mockResolvedValue('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 const read = jest.fn(async () => 'YWJj');
 const prior = FileSystem.readFileChunk; (FileSystem as any).readFileChunk = read;
 try {
  const source = attachmentFileSource('/cache/synthetic-selected-copy', {name: 'fixture.jpg', type: 'image/jpeg', size: 3});
  await expect(source.hash!()).resolves.toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  expect(FileSystem.hash).toHaveBeenCalledWith('/cache/synthetic-selected-copy', 'SHA-256');
  await expect(source.readBase64!(0, 3)).resolves.toBe('YWJj');
  expect(read).toHaveBeenCalledWith('/cache/synthetic-selected-copy', 0, 3, 'base64');
  (FileSystem.hash as jest.Mock).mockResolvedValueOnce('not-a-hash');
  await expect(source.hash!()).rejects.toThrow('校验失败');
 } finally {(FileSystem as any).readFileChunk = prior;}
});
