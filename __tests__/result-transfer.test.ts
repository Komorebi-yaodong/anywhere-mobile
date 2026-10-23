import {sha256} from '@noble/hashes/sha2.js';
import {canonicalBytes, encodeBase64Url} from '../src/remote/protocol';
import {createResultTransferReader} from '../src/remote/resultTransfer';

function fixture(value: unknown) {
  const bytes = canonicalBytes(value);
  const ref = {id: 'A'.repeat(32), totalBytes: bytes.length, sha256: Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join(''), chunkBytes: 48 * 1024};
  const request = jest.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'remote.transfer.release') return {ok: true};
    const offset = params.offset as number;
    const data = bytes.slice(offset, offset + ref.chunkBytes);
    return {...ref, offset, byteLength: data.length, data: encodeBase64Url(data)};
  });
  return {ref, request, bytes};
}

it('fully restores large multilingual results and tasks without modifying caller data', async () => {
  const original = {text: '完整回复中文😀'.repeat(20000), tasks: Array.from({length: 10}, () => ({content: '中'.repeat(1200), steps: Array.from({length: 6}, () => ({content: '中'.repeat(1200)}))}))};
  const f = fixture(original);
  const reader = createResultTransferReader(f.request);
  await expect(reader.read(f.ref)).resolves.toEqual(original);
  const chunks = f.request.mock.calls.filter(([method]) => method === 'remote.transfer.chunk');
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.map(([, params]) => params.offset)).toEqual(chunks.map((_, i) => i * f.ref.chunkBytes));
  expect(f.request).toHaveBeenLastCalledWith('remote.transfer.release', {id: f.ref.id});
});

it.each(['id', 'offset', 'totalBytes', 'sha256', 'byteLength', 'data'])('rejects a changed chunk %s instead of exposing partial results', async field => {
  const f = fixture({text: 'never partial'}); const base = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params) => method !== 'remote.transfer.chunk' ? base(method, params) : ({...await base(method, params), [field]: field === 'data' ? '!!!!' : 'wrong'}));
  await expect(createResultTransferReader(f.request).read(f.ref)).rejects.toThrow();
  expect(f.request).toHaveBeenLastCalledWith('remote.transfer.release', {id: f.ref.id});
});

it('rejects a valid-length tampered payload using its whole snapshot SHA', async () => {
  const f = fixture({text: 'keep'}); const base = f.request.getMockImplementation()!;
  const changed = canonicalBytes({text: 'fail'});
  f.request.mockImplementation(async (method, params) => method !== 'remote.transfer.chunk' ? base(method, params) : ({...await base(method, params), data: encodeBase64Url(changed)}));
  await expect(createResultTransferReader(f.request).read(f.ref)).rejects.toMatchObject({code: 'remote_transfer_invalid'});
});

it('retries one identical timed-out read, never recreates or replays its originating request', async () => {
  const f = fixture({text: 'read retry'}); const base = f.request.getMockImplementation()!;
  let failed = false;
  f.request.mockImplementation(async (method, params) => {if (method === 'remote.transfer.chunk' && !failed) {failed = true; throw Object.assign(new Error('timeout'), {code: 'remote_request_timeout'});} return base(method, params);});
  await expect(createResultTransferReader(f.request).read(f.ref)).resolves.toEqual({text: 'read retry'});
  expect(f.request.mock.calls.filter(([method]) => method === 'remote.transfer.chunk')).toEqual([
    ['remote.transfer.chunk', {id: f.ref.id, offset: 0}], ['remote.transfer.chunk', {id: f.ref.id, offset: 0}],
  ]);
});

it('does not retry expiry or rerun any originating command', async () => {
  const f = fixture({text: 'expired'});
  f.request.mockImplementation(async method => {if (method === 'remote.transfer.chunk') throw Object.assign(new Error('expired'), {code: 'remote_transfer_expired'}); return {ok: true};});
  await expect(createResultTransferReader(f.request).read(f.ref)).rejects.toMatchObject({code: 'remote_transfer_expired'});
  expect(f.request.mock.calls.map(([method]) => method)).toEqual(['remote.transfer.chunk', 'remote.transfer.release']);
});

it('deduplicates concurrent reads and drops disconnected results', async () => {
  const f = fixture({text: 'shared'}); const base = f.request.getMockImplementation()!;
  let resume!: () => void;
  const wait = new Promise<void>(resolve => {resume = resolve;});
  f.request.mockImplementation(async (method, params) => {if (method === 'remote.transfer.chunk') await wait; return base(method, params);});
  const reader = createResultTransferReader(f.request);
  const a = reader.read(f.ref); const b = reader.read(f.ref);
  expect(f.request).toHaveBeenCalledTimes(1);
  reader.close(); resume();
  await expect(a).rejects.toMatchObject({code: 'remote_client_closed'});
  await expect(b).rejects.toMatchObject({code: 'remote_client_closed'});
  expect(f.request.mock.calls.some(([method]) => method === 'remote.transfer.release')).toBe(false);
});

it('bounds size, chunk size and identifiers before allocating or requesting', async () => {
  const f = fixture({ok: true});
  const reader = createResultTransferReader(f.request);
  for (const ref of [{...f.ref, totalBytes: 32 * 1024 * 1024 + 1}, {...f.ref, totalBytes: 0}, {...f.ref, chunkBytes: 512 * 1024}, {...f.ref, id: '../arbitrary-path'}, {...f.ref, sha256: 'no'}]) {
    await expect(reader.read(ref)).rejects.toMatchObject({code: 'remote_transfer_invalid'});
  }
  expect(f.request).not.toHaveBeenCalled();
});
