import {Dirs, FileSystem} from 'react-native-file-access';

const cacheRoot = `${Dirs.CacheDir}/anywhere-remote-images`;
const ttlMs = 30 * 24 * 60 * 60 * 1000;
const maxBytes = 512 * 1024;
const pending = new Map<string, Promise<string>>();

function hash(value: string): string {
  let state = 0;
  for (let index = 0; index < value.length; index += 1) {
    state = (state * 31 + value.charCodeAt(index)) % 2147483647;
  }
  return Math.abs(state).toString(16);
}

function pathFor(value: string): string {
  return `${cacheRoot}/${hash(value)}.img`;
}

/** Caches only public HTTPS avatar URLs in Mobile-private cache for one month. */
export async function cacheRemoteImage(url: string): Promise<string> {
  const safeUrl = typeof url === 'string' ? url.trim() : '';
  if (!/^https:\/\//i.test(safeUrl)) return '';
  const existing = pending.get(safeUrl);
  if (existing) return existing;
  const run = (async () => {
    const path = pathFor(safeUrl);
    const meta = `${path}.json`;
    try {
      const raw = await FileSystem.readFile(meta, 'utf8');
      const data = JSON.parse(raw) as {expiresAt?: string};
      if (Date.parse(data.expiresAt || '') > Date.now() && await FileSystem.exists(path)) return `file://${path}`;
    } catch {
      // cache miss
    }
    if (!(await FileSystem.exists(cacheRoot))) await FileSystem.mkdir(cacheRoot);
    const result = await FileSystem.fetch(safeUrl, {path});
    const stat = await FileSystem.stat(path).catch(() => null);
    if (!result.ok || result.status >= 400 || !stat || stat.size < 1 || stat.size > maxBytes) {
      await FileSystem.unlink(path).catch(() => undefined);
      return '';
    }
    await FileSystem.writeFile(meta, JSON.stringify({expiresAt: new Date(Date.now() + ttlMs).toISOString()}), 'utf8');
    return `file://${path}`;
  })();
  pending.set(safeUrl, run);
  try { return await run; } finally { pending.delete(safeUrl); }
}
