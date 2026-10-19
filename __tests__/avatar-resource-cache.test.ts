import {toByteArray} from 'base64-js';
import {FileSystem} from 'react-native-file-access';

import {
  ensureAvatarResource,
  validateAvatarCache,
} from '../src/services/avatarResourceCache';
import type {AvatarResourceMetadata, RemoteRequest} from '../src/remote/api';
import {sha256Base64Url} from '../src/remote/crypto';

const base64 = 'AA==';
const version = sha256Base64Url(new Uint8Array([0]));
const resource: AvatarResourceMetadata = {
  kind: 'agent',
  code: 'CacheAgent',
  version,
  mimeType: 'image/png',
  byteLength: 1,
};

function installMemoryFiles() {
  const files = new Map<string, string>();
  const native = (value: string) => value.replace(/^file:\/\//, '');
  (FileSystem.exists as unknown as jest.Mock).mockImplementation(async (path: string) =>
    path === '/cache/anywhere-avatar-resources' || files.has(path),
  );
  (FileSystem.mkdir as unknown as jest.Mock).mockImplementation(async (path: string) => path);
  (FileSystem.writeFile as unknown as jest.Mock).mockImplementation(async (path: string, value: string) => {
    files.set(path, value);
  });
  (FileSystem.readFile as unknown as jest.Mock).mockImplementation(async (path: string) => files.get(path) || '');
  (FileSystem.stat as unknown as jest.Mock).mockImplementation(async (path: string) => {
    const value = files.get(path);
    if (!value) throw new Error('missing');
    return {size: toByteArray(value).length, type: 'file', lastModified: Date.now()};
  });
  (FileSystem.mv as unknown as jest.Mock).mockImplementation(async (source: string, target: string) => {
    const value = files.get(source);
    if (!value) throw new Error('missing source');
    files.set(target, value);
    files.delete(source);
  });
  (FileSystem.unlink as unknown as jest.Mock).mockImplementation(async (path: string) => {
    files.delete(path);
  });
  (FileSystem.ls as unknown as jest.Mock).mockResolvedValue([]);
  return {files, native};
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('uses a SHA-256 validated Agent avatar cache hit without requesting bytes again', async () => {
  installMemoryFiles();
  const requestMock = jest.fn(async () => ({
    ok: true,
    avatar: resource,
    dataUrl: `data:image/png;base64,${base64}`,
  }));
  const request = requestMock as unknown as RemoteRequest;
  const first = await ensureAvatarResource({
    desktopId: 'desktop-avatar-cache-fixture',
    resource,
    request,
    displayName: 'Cache Agent',
  });
  expect(first?.version).toBe(version);
  expect(requestMock).toHaveBeenCalledTimes(1);

  requestMock.mockClear();
  const second = await ensureAvatarResource({
    desktopId: 'desktop-avatar-cache-fixture',
    resource,
    request,
    previous: first,
    displayName: 'Cache Agent',
  });
  expect(second?.uri).toBe(first?.uri);
  expect(requestMock).not.toHaveBeenCalled();
});

test('rejects a tampered avatar payload whose bytes do not match the advertised SHA-256', async () => {
  installMemoryFiles();
  const request = jest.fn(async () => ({
    ok: true,
    avatar: resource,
    dataUrl: 'data:image/png;base64,AQ==',
  })) as unknown as RemoteRequest;
  await expect(ensureAvatarResource({
    desktopId: 'desktop-avatar-tamper-fixture',
    resource,
    request,
  })).rejects.toThrow('头像完整性校验失败');
});

test('treats a changed local avatar file as a cache miss even when its stored version matches', async () => {
  const {files, native} = installMemoryFiles();
  const requestMock = jest.fn(async () => ({ok: true, avatar: resource, dataUrl: `data:image/png;base64,${base64}`}));
  const request = requestMock as unknown as RemoteRequest;
  const cached = await ensureAvatarResource({desktopId: 'desktop-avatar-local-tamper', resource, request});
  files.set(native(cached!.uri), 'AQ==');
  expect(await validateAvatarCache(cached, resource)).toBe(false);
});
