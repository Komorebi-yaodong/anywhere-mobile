import {FileSystem} from 'react-native-file-access';
import {cacheRemoteHttpsResource} from '../src/services/remoteImageCache';
import {modelNameForLogo, resolveModelLogo, verifiedLogoSvg} from '../src/services/modelLogo';
jest.mock('../src/services/remoteImageCache', () => ({cacheRemoteHttpsResource: jest.fn()}));
const cache = cacheRemoteHttpsResource as jest.Mock;
const read = FileSystem.readFile as jest.Mock;
const xml = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="a"><stop stop-color="#000" /></linearGradient></defs><path fill="url(#a)" d="M0 0h24v24H0z"/></svg>';
beforeEach(() => jest.clearAllMocks());
it('uses the Desktop model naming convention without provider identifiers', () => {
 expect(modelNameForLogo('private-provider|gpt-4o')).toBe('gpt-4o');
 expect(modelNameForLogo('  claude-sonnet-4-5  ')).toBe('claude-sonnet-4-5');
});
it('accepts native vector logos but rejects scripts, external resources, cycles and invalid XML', () => {
 expect(verifiedLogoSvg(xml)).toBe(xml);
 for (const body of ['<script/>', '<image href="https://evil.test/x"/>', '<path fill="url(https://evil.test/x)"/>', '<path onclick="alert(1)"/>', '<foreignObject/>', '<style>@import "evil";</style>', '<use href="#cycle"/>']) expect(() => verifiedLogoSvg(`<svg>${body}</svg>`)).toThrow();
 expect(() => verifiedLogoSvg('<!DOCTYPE svg><svg/>')).toThrow();
 expect(() => verifiedLogoSvg('<svg><path></svg>')).toThrow();
});

it('coalesces per-model requests and reads SVG only from the verified private cache', async () => {
 cache.mockImplementation(async ({url}) => ({uri: url.includes('/v1/resolve') ? 'file:///cache/metadata' : 'file:///cache/icon.svg', version: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', mimeType: url.includes('/v1/resolve') ? 'application/json' : 'image/svg+xml'}));
 (FileSystem.exists as jest.Mock).mockResolvedValue(true);
 read.mockImplementation(async path => path === '/cache/metadata' ? JSON.stringify({resolved: {logo: 'https://logos.example/icon.svg'}}) : xml);
 const [a, b] = await Promise.all([resolveModelLogo('provider-private|coalesce-fixture'), resolveModelLogo('other-provider|coalesce-fixture')]);
 expect(a).toEqual(b); expect(a?.xml).toBe(xml); expect(cache).toHaveBeenCalledTimes(2);
 expect(cache.mock.calls[0][0]).toEqual({url: 'https://llm-model.141277.xyz/v1/resolve?model=coalesce-fixture', namespace: 'model-logo', maxBytes: 65536});
 await resolveModelLogo('coalesce-fixture'); expect(cache).toHaveBeenCalledTimes(2);
});
it('returns no logo for insecure URLs, missing matches, unsafe SVG or network failures', async () => {
 cache.mockResolvedValue({uri: 'file:///cache/meta', mimeType: 'application/json', version: 'fixture'});
 for (const [i, logo] of ['http://logos.example/icon.png', 'file:///secret', 'https://user:secret@logos.example/x', ''].entries()) {
  read.mockResolvedValue(JSON.stringify({resolved: {logo}})); expect(await resolveModelLogo(`unsafe-${i}`)).toBeNull();
 }
 cache.mockRejectedValue(new Error('offline')); expect(await resolveModelLogo('offline-fixture')).toBeNull();
});
it('revalidates a hot logo on schedule and refetches a damaged local file', async () => {
 const clock = jest.spyOn(Date, 'now').mockReturnValue(10000);
 (FileSystem.exists as jest.Mock).mockResolvedValue(true);
 cache.mockImplementation(async ({url}) => ({uri: url.includes('/v1/resolve') ? 'file:///cache/meta-hot' : 'file:///cache/hot.png', version: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', mimeType: 'image/png'}));
 read.mockResolvedValue(JSON.stringify({resolved: {logo: 'https://logos.example/hot.png'}}));
 await resolveModelLogo('hot-fixture'); expect(cache).toHaveBeenCalledTimes(2);
 clock.mockReturnValue(130000); await resolveModelLogo('hot-fixture'); expect(cache).toHaveBeenCalledTimes(2);
 clock.mockReturnValue(320001); await resolveModelLogo('hot-fixture'); expect(cache).toHaveBeenCalledTimes(4);
 (FileSystem.exists as jest.Mock).mockResolvedValue(false); await resolveModelLogo('hot-fixture'); expect(cache).toHaveBeenCalledTimes(6);
 clock.mockRestore();
});
it('drops queued work when its picker unmounts without cancelling another consumer', async () => {
 const releases: Array<() => void> = []; cache.mockImplementation(() => new Promise(resolve => releases.push(() => resolve({uri: 'file:///cache/empty', version: 'fixture'})))); read.mockResolvedValue('{}');
 const blockers = Array.from({length: 4}, (_, i) => resolveModelLogo(`blocker-${i}`));
 const controller = new AbortController(); const removed = resolveModelLogo('removed-fixture', controller.signal); controller.abort();
 const survivor = new AbortController(); const shared = resolveModelLogo('shared-fixture', survivor.signal); resolveModelLogo('shared-fixture'); survivor.abort();
 for (let i = 0; i < 5; i++) {releases[i](); for (let tick = 0; tick < 10; tick++) await Promise.resolve();}
 await Promise.all([...blockers, removed, shared]); expect(cache).toHaveBeenCalledTimes(5);
 expect(await resolveModelLogo('already-aborted', controller.signal)).toBeNull();
});

it('limits resolution/download work to four models concurrently', async () => {
 const releases: Array<() => void> = [];
 cache.mockImplementation(() => new Promise(resolve => releases.push(() => resolve({uri: 'file:///cache/empty', version: 'fixture'}))));
 read.mockResolvedValue('{}');
 const jobs = Array.from({length: 7}, (_, i) => resolveModelLogo(`concurrency-${i}`));
 expect(cache).toHaveBeenCalledTimes(4);
 for (let i = 0; i < 7; i++) {expect(releases[i]).toBeDefined(); releases[i](); for (let tick = 0; tick < 8; tick++) await Promise.resolve();}
 expect(await Promise.all(jobs)).toEqual(Array(7).fill(null));
});
