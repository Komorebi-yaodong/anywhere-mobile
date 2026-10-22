import {FileSystem} from 'react-native-file-access';

import {cacheRemoteHttpsResource} from '../src/services/remoteImageCache';

const url = 'https://media.example.test/fixture.png';
const hashAbc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const hashTampered = '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7c0aafe9d1fdfd0';

function response(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    getHeader: (name: string) => headers[name.toLowerCase()],
  };
}

function installMemoryFiles() {
  const files = new Map<string, string>();
  const native = (uri: string) => uri.replace(/^file:\/\//, '');
  let bodyDownloads = 0;
  let headRequests = 0;
  let headMode: 'unchanged' | 'changed' = 'unchanged';
  (FileSystem.exists as unknown as jest.Mock).mockImplementation(async (path: string) =>
    path === '/cache/anywhere-https-resources' || files.has(path),
  );
  (FileSystem.mkdir as unknown as jest.Mock).mockImplementation(async (path: string) => path);
  (FileSystem.readFile as unknown as jest.Mock).mockImplementation(async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error('missing');
    return value;
  });
  (FileSystem.writeFile as unknown as jest.Mock).mockImplementation(async (path: string, value: string) => {
    files.set(path, value);
  });
  (FileSystem.stat as unknown as jest.Mock).mockImplementation(async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error('missing');
    return {size: value === 'YWJj' || value === 'AQ==' ? 1 + (value === 'YWJj' ? 2 : 0) : value.length, type: 'file', lastModified: Date.now()};
  });
  (FileSystem.hash as unknown as jest.Mock).mockImplementation(async (path: string) =>
    files.get(path) === 'YWJj' ? hashAbc : hashTampered,
  );
  (FileSystem.mv as unknown as jest.Mock).mockImplementation(async (source: string, target: string) => {
    const value = files.get(source);
    if (value === undefined) throw new Error('missing');
    files.set(target, value);
    files.delete(source);
  });
  (FileSystem.unlink as unknown as jest.Mock).mockImplementation(async (path: string) => {
    files.delete(path);
  });
  (FileSystem.fetch as unknown as jest.Mock).mockImplementation(async (_url: string, init: {method?: string; path?: string}) => {
    if (init.method === 'HEAD') {
      headRequests += 1;
      return headMode === 'unchanged'
        ? response(304, {etag: '"fixture-v1"'})
        : response(200, {etag: '"fixture-v2"'});
    }
    bodyDownloads += 1;
    if (!init.path) throw new Error('path required for body');
    files.set(init.path, 'YWJj');
    return response(200, {'content-type': 'image/png', etag: '"fixture-v1"'});
  });
  return {
    files,
    native,
    getBodyDownloads: () => bodyDownloads,
    getHeadRequests: () => headRequests,
    setHeadMode: (value: 'unchanged' | 'changed') => { headMode = value; },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('reuses an HTTPS resource after conditional validator confirmation without downloading bytes', async () => {
  const memory = installMemoryFiles();
  const first = await cacheRemoteHttpsResource({url, namespace: 'media'});
  expect(memory.getBodyDownloads()).toBe(1);
  expect(first.version).toBe(hashAbc);

  const second = await cacheRemoteHttpsResource({url, namespace: 'media'});
  expect(second.uri).toBe(first.uri);
  expect(memory.getHeadRequests()).toBe(1);
  expect(memory.getBodyDownloads()).toBe(1);
});

test('model logo cache keeps version validation and hash checks for SVG and resolver metadata', async () => {
 const memory = installMemoryFiles();
 (FileSystem.fetchManaged as jest.Mock).mockImplementation((remote, init) => ({cancel: jest.fn(), result: (FileSystem.fetch as jest.Mock)(remote, init)}));
 const first = await cacheRemoteHttpsResource({url, namespace: 'model-logo', maxBytes: 4096});
 const second = await cacheRemoteHttpsResource({url, namespace: 'model-logo', maxBytes: 4096});
 expect(first.uri).toBe(second.uri); expect(memory.getBodyDownloads()).toBe(1); expect(memory.getHeadRequests()).toBe(1);
 memory.files.set(memory.native(first.uri), 'AQ==');
 await cacheRemoteHttpsResource({url, namespace: 'model-logo', maxBytes: 4096});
 expect(memory.getBodyDownloads()).toBe(2);
});

test('model logo downloads time out and cancel instead of holding resolution slots forever', async () => {
 jest.useFakeTimers(); installMemoryFiles(); const cancel = jest.fn(async () => undefined);
 (FileSystem.fetchManaged as jest.Mock).mockImplementation(() => ({cancel, result: new Promise(() => undefined)}));
 const pending = cacheRemoteHttpsResource({url: 'https://logos.example/slow.svg', namespace: 'model-logo', maxBytes: 4096});
 const checked = pending.catch(error => error.message);
 await jest.advanceTimersByTimeAsync(10001); expect(await checked).toBe('https_resource_timeout'); expect(cancel).toHaveBeenCalledTimes(1); jest.useRealTimers();
});

test('does not reuse an existing cache larger than a new caller limit', async () => {
 const memory = installMemoryFiles(); await cacheRemoteHttpsResource({url, namespace: 'avatar', maxBytes: 4096});
 await expect(cacheRemoteHttpsResource({url, namespace: 'avatar', maxBytes: 1})).rejects.toThrow();
 expect(memory.getHeadRequests()).toBe(0);
});


test('does not reuse a tampered HTTPS cache file even when the stored remote version matches', async () => {
  const memory = installMemoryFiles();
  const first = await cacheRemoteHttpsResource({url, namespace: 'media'});
  memory.files.set(memory.native(first.uri), 'AQ==');
  memory.setHeadMode('changed');

  const second = await cacheRemoteHttpsResource({url, namespace: 'media'});
  expect(second.version).toBe(hashAbc);
  expect(memory.getHeadRequests()).toBe(0);
  expect(memory.getBodyDownloads()).toBe(2);
});
