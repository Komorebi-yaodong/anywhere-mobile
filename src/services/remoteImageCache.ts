import {Dirs, FileSystem} from 'react-native-file-access';

import {sha256Base64Url} from '../remote/crypto';
import {utf8ToBytes} from '../remote/utf8';

import {httpsResourceUrl as safeUrl} from './httpsResourceUrl';

const cacheRoot = `${Dirs.CacheDir}/anywhere-https-resources`;
const ttlMs = 30 * 24 * 60 * 60 * 1000;
const maxAvatarBytes = 512 * 1024;
const maxMediaBytes = 25 * 1024 * 1024;
const pending = new Map<string, Promise<HttpsResourceCache>>();

export type HttpsResourceCache = {
  uri: string;
  version: string;
  expiresAt: string;
  mimeType: string;
  byteLength: number;
};

type StoredResource = HttpsResourceCache & {
  url: string;
  etag?: string;
  lastModified?: string;
};


function localPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

function resourceKey(url: string, namespace: string): string {
  return sha256Base64Url(utf8ToBytes(`${namespace}\u0000${url}`));
}

function metaPath(key: string): string {
  return `${cacheRoot}/${key}.json`;
}

function extensionFor(url: string, mimeType: string): string {
  const mime = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  const byMime: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'application/json': 'json',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  };
  if (byMime[mime]) return byMime[mime];
  const match = /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v|mp3|wav|m4a|aac|ogg)(?:[?#]|$)/i.exec(url);
  return match?.[1]?.toLowerCase() === 'jpeg' ? 'jpg' : match?.[1]?.toLowerCase() || 'bin';
}

function header(response: unknown, name: string): string {
  const getHeader = (response as {getHeader?: (key: string) => string | undefined})?.getHeader;
  const value = typeof getHeader === 'function' ? getHeader(name) : '';
  return typeof value === 'string' ? value.trim().slice(0, 512) : '';
}

function sameRemoteVersion(current: StoredResource, response: unknown): boolean {
  const etag = header(response, 'etag');
  const lastModified = header(response, 'last-modified');
  return Boolean((etag && current.etag && etag === current.etag) || (lastModified && current.lastModified && lastModified === current.lastModified));
}

async function contentVersion(path: string): Promise<string> {
  const hash = String(await FileSystem.hash(path, 'SHA-256')).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('https_resource_hash_invalid');
  return hash;
}

async function readVerified(key: string, url: string, maxBytes: number): Promise<StoredResource | null> {
  try {
    const raw = await FileSystem.readFile(metaPath(key), 'utf8');
    const entry = JSON.parse(raw) as StoredResource;
    if (
      entry?.url !== url ||
      typeof entry.uri !== 'string' ||
      !entry.uri.startsWith('file://') ||
      typeof entry.version !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(entry.version) ||
      typeof entry.mimeType !== 'string' ||
      !Number.isInteger(entry.byteLength) ||
      entry.byteLength < 1 || entry.byteLength > maxBytes ||
      !(await FileSystem.exists(localPath(entry.uri)))
    ) return null;
    const stat = await FileSystem.stat(localPath(entry.uri));
    if (stat.size !== entry.byteLength || (await contentVersion(localPath(entry.uri))) !== entry.version) return null;
    return entry;
  } catch {
    return null;
  }
}

async function fetchLogo(url: string, init: {method?: string; path?: string; headers?: Record<string, string>}, maxBytes: number) {
  let rejectLimit!: (reason: Error) => void;
  const exceeded = new Promise<never>((_resolve, reject) => {rejectLimit = reject;});
  const task = FileSystem.fetchManaged(url, init, (bytes, total) => {
    if (bytes > maxBytes || total > maxBytes) {task.cancel().catch(() => undefined); rejectLimit(new Error('https_resource_too_large'));}
  });
  const timer = setTimeout(() => {task.cancel().catch(() => undefined); rejectLimit(new Error('https_resource_timeout'));}, 10_000);
  try {
    const result = await Promise.race([task.result, exceeded]);
    if (result.url && !safeUrl(result.url)) throw new Error('https_resource_redirect_invalid');
    return result;
  } finally {clearTimeout(timer);}
}


async function fetchHead(url: string, entry: StoredResource, logo: boolean, maxBytes: number): Promise<{response: unknown; unchanged: boolean; supported: boolean} | null> {
  const headers: Record<string, string> = {};
  if (entry.etag) headers['If-None-Match'] = entry.etag;
  if (entry.lastModified) headers['If-Modified-Since'] = entry.lastModified;
  try {
    const init = {method: 'HEAD', ...(Object.keys(headers).length ? {headers} : {})};
    const response = await (logo ? fetchLogo(url, init, maxBytes) : FileSystem.fetch(url, init));
    const status = Number((response as {status?: number})?.status) || 0;
    const supported = status === 304 || (status >= 200 && status < 300);
    return {response, supported, unchanged: status === 304 || (supported && sameRemoteVersion(entry, response))};
  } catch {
    return null;
  }
}

/**
 * HTTPS-only Mobile-private cache. The cache compares server validators when
 * available and always recomputes SHA-256 of its local file before reuse.
 * This never proxies an external asset through Desktop.
 */
export async function cacheRemoteHttpsResource({
  url,
  namespace = 'media',
  maxBytes = maxMediaBytes,
}: {
  url: string;
  namespace?: 'avatar' | 'media' | 'model-logo';
  maxBytes?: number;
}): Promise<HttpsResourceCache> {
  const remoteUrl = safeUrl(url);
  if (!remoteUrl || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > maxMediaBytes) throw new Error('https_resource_invalid');
  const key = resourceKey(remoteUrl, namespace);
  const pendingKey = `${key}:${maxBytes}`;
  const existing = pending.get(pendingKey);
  if (existing) return existing;
  const run = (async () => {
    if (!(await FileSystem.exists(cacheRoot))) await FileSystem.mkdir(cacheRoot);
    const previous = await readVerified(key, remoteUrl, maxBytes);
    const now = Date.now();
    if (previous) {
      // A conditional HEAD carries no resource bytes. It keeps remote validators
      // authoritative without turning TTL into the content-version mechanism.
      const head = await fetchHead(remoteUrl, previous, namespace === 'model-logo', maxBytes);
      if (head?.unchanged) {
        const refreshed: StoredResource = {
          ...previous,
          expiresAt: new Date(now + ttlMs).toISOString(),
          ...(header(head.response, 'etag') ? {etag: header(head.response, 'etag')} : {}),
          ...(header(head.response, 'last-modified') ? {lastModified: header(head.response, 'last-modified')} : {}),
        };
        await FileSystem.writeFile(metaPath(key), JSON.stringify(refreshed), 'utf8');
        return refreshed;
      }
      // A network failure must not discard an already SHA-256-verified private
      // cache. If no validators were ever exposed, the 30-day expiry remains
      // the fallback revalidation policy.
      if ((!head || !head.supported) && Date.parse(previous.expiresAt) > now) return previous;
      if (!previous.etag && !previous.lastModified && Date.parse(previous.expiresAt) > now) return previous;
    }

    const temporary = `${cacheRoot}/${key}.${Date.now().toString(36)}.tmp`;
    try {
      const response = await (namespace === 'model-logo' ? fetchLogo(remoteUrl, {path: temporary}, maxBytes) : FileSystem.fetch(remoteUrl, {path: temporary}));
      const stat = await FileSystem.stat(temporary).catch(() => null);
      if (!response.ok || response.status >= 400 || !stat || stat.size < 1 || stat.size > maxBytes) throw new Error('https_resource_fetch_failed');
      const version = await contentVersion(temporary);
      const mimeType = header(response, 'content-type').split(';', 1)[0].trim().toLowerCase();
      const target = `${cacheRoot}/${key}-${version}.${extensionFor(remoteUrl, mimeType)}`;
      // The target name is content-addressed. It may nevertheless be a corrupt
      // leftover from an interrupted prior write, so never trust existence alone.
      await FileSystem.unlink(target).catch(() => undefined);
      await FileSystem.mv(temporary, target);
      const next: StoredResource = {
        url: remoteUrl,
        uri: `file://${target}`,
        version,
        expiresAt: new Date(now + ttlMs).toISOString(),
        mimeType,
        byteLength: stat.size,
        ...(header(response, 'etag') ? {etag: header(response, 'etag')} : {}),
        ...(header(response, 'last-modified') ? {lastModified: header(response, 'last-modified')} : {}),
      };
      await FileSystem.writeFile(metaPath(key), JSON.stringify(next), 'utf8');
      if (previous?.uri && previous.uri !== next.uri) await FileSystem.unlink(localPath(previous.uri)).catch(() => undefined);
      return next;
    } catch (error) {
      await FileSystem.unlink(temporary).catch(() => undefined);
      if (previous) return previous;
      throw error;
    }
  })();
  pending.set(pendingKey, run);
  try {
    return await run;
  } finally {
    pending.delete(pendingKey);
  }
}

/** Caches public HTTPS avatars in Mobile-private storage and returns their URI. */
export async function cacheRemoteImage(url: string): Promise<string> {
  try {
    return (await cacheRemoteHttpsResource({url, namespace: 'avatar', maxBytes: maxAvatarBytes})).uri;
  } catch {
    return '';
  }
}
