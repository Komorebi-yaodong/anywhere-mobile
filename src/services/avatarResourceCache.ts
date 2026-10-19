import {toByteArray} from 'base64-js';
import {Dirs, FileSystem} from 'react-native-file-access';

import type {AvatarCache} from '../domain/pairing';
import type {
  AvatarResourceMetadata,
  RemoteRequest,
  WorkspaceAvatarResponse,
} from '../remote/api';
import {sha256Base64Url} from '../remote/crypto';

const cacheDirectory = `${Dirs.CacheDir}/anywhere-avatar-resources`;
export const maxAvatarBytes = 48 * 1024;
const maxCacheAgeMs = 30 * 24 * 60 * 60 * 1000;
const pending = new Map<string, Promise<AvatarCache | undefined>>();

type AvatarPayload = {
  extension: 'png' | 'jpg' | 'webp';
  mimeType: AvatarResourceMetadata['mimeType'];
  base64: string;
  bytes: Uint8Array;
};

function safeSegment(value: string, field: string): string {
  const safe = String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160);
  if (!safe) throw new Error(`${field}无效。`);
  return safe;
}

function extensionFor(mimeType: AvatarResourceMetadata['mimeType']): AvatarPayload['extension'] {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function parseAvatarDataUrl(value: string): AvatarPayload | null {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
    String(value || '').trim(),
  );
  if (!match) return null;
  let bytes: Uint8Array;
  try {
    bytes = toByteArray(match[2]);
  } catch {
    return null;
  }
  if (bytes.length < 1 || bytes.length > maxAvatarBytes) return null;
  const subtype = match[1].toLowerCase();
  const mimeType = `image/${subtype}` as AvatarResourceMetadata['mimeType'];
  return {
    extension: subtype === 'jpeg' ? 'jpg' : (subtype as 'png' | 'webp'),
    mimeType,
    base64: match[2],
    bytes,
  };
}

function sameResource(left: AvatarResourceMetadata, right: AvatarResourceMetadata): boolean {
  return left.kind === right.kind &&
    left.code === right.code &&
    left.version === right.version &&
    left.mimeType === right.mimeType &&
    left.byteLength === right.byteLength;
}

function pathFor(desktopId: string, resource: AvatarResourceMetadata): string {
  const desktop = safeSegment(desktopId, '桌面标识');
  const code = resource.kind === 'agent' ? `-${safeSegment(resource.code || '', 'Agent 标识')}` : '';
  const version = safeSegment(resource.version, '头像版本');
  return `${cacheDirectory}/${desktop}-${resource.kind}${code}-${version}.${extensionFor(resource.mimeType)}`;
}

function fileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function nativePath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

function cacheFor(desktopId: string, resource: AvatarResourceMetadata, displayName = ''): AvatarCache {
  return {
    uri: fileUri(pathFor(desktopId, resource)),
    // This is a local garbage-collection/last-use marker, not a remote cache
    // validator. The SHA-256 version below remains the cache-hit authority.
    expiresAt: new Date(Date.now() + maxCacheAgeMs).toISOString(),
    version: resource.version,
    ...(displayName.trim() ? {displayName: displayName.trim().slice(0, 80)} : {}),
  };
}

async function fileVersion(uri: string): Promise<string> {
  const base64 = await FileSystem.readFile(nativePath(uri), 'base64');
  return sha256Base64Url(toByteArray(base64));
}

/** Checks expiry, physical file presence, and the actual SHA-256 content version. */
export async function validateAvatarCache(
  cache: AvatarCache | undefined,
  resource: AvatarResourceMetadata,
): Promise<boolean> {
  if (!cache || !isAvatarCacheRecord(cache) || cache.version !== resource.version) return false;
  try {
    const stat = await FileSystem.stat(nativePath(cache.uri));
    if (!stat || stat.size !== resource.byteLength || stat.size < 1 || stat.size > maxAvatarBytes) return false;
    return (await fileVersion(cache.uri)) === resource.version;
  } catch {
    return false;
  }
}

/** Structural check used before local-file verification. */
function isAvatarCacheRecord(cache: AvatarCache | undefined): cache is AvatarCache {
  return Boolean(
    cache &&
    typeof cache.uri === 'string' &&
    cache.uri.startsWith('file://') &&
    typeof cache.expiresAt === 'string' &&
    Number.isFinite(Date.parse(cache.expiresAt)) &&
    /^[A-Za-z0-9_-]{16,128}$/.test(cache.version),
  );
}

/**
 * Kept for UI/persisted-record compatibility. Expiry is a garbage-collection
 * marker only; a SHA-256+file validation decides whether bytes are reusable.
 */
export function isAvatarCacheValid(cache: AvatarCache | undefined): boolean {
  return isAvatarCacheRecord(cache);
}

export async function removeAvatarCache(cache: AvatarCache | undefined): Promise<void> {
  if (!cache?.uri?.startsWith('file://')) return;
  await FileSystem.unlink(nativePath(cache.uri)).catch(() => undefined);
}

async function pruneExpiredAvatarFiles(): Promise<void> {
  if (!(await FileSystem.exists(cacheDirectory))) return;
  const now = Date.now();
  const files = await FileSystem.ls(cacheDirectory).catch(() => [] as string[]);
  await Promise.all(files.map(async file => {
    const path = file.includes('/') ? file : `${cacheDirectory}/${file}`;
    const stat = await FileSystem.stat(path).catch(() => null);
    if (!stat || now - stat.lastModified > maxCacheAgeMs) await FileSystem.unlink(path).catch(() => undefined);
  }));
}

async function writeVerifiedAvatar({
  desktopId,
  resource,
  dataUrl,
  displayName,
}: {
  desktopId: string;
  resource: AvatarResourceMetadata;
  dataUrl: string;
  displayName?: string;
}): Promise<AvatarCache> {
  const payload = parseAvatarDataUrl(dataUrl);
  if (!payload || payload.mimeType !== resource.mimeType || payload.bytes.length !== resource.byteLength) {
    throw new Error('头像数据格式或长度无效。');
  }
  if (sha256Base64Url(payload.bytes) !== resource.version) {
    throw new Error('头像完整性校验失败。');
  }
  if (!(await FileSystem.exists(cacheDirectory))) await FileSystem.mkdir(cacheDirectory);
  const target = pathFor(desktopId, resource);
  const temporary = `${target}.${Date.now().toString(36)}.tmp`;
  try {
    await FileSystem.writeFile(temporary, payload.base64, 'base64');
    const written = await FileSystem.readFile(temporary, 'base64');
    if (sha256Base64Url(toByteArray(written)) !== resource.version) throw new Error('头像缓存写入校验失败。');
    await FileSystem.mv(temporary, target);
  } catch (error) {
    await FileSystem.unlink(temporary).catch(() => undefined);
    throw error;
  }
  pruneExpiredAvatarFiles().catch(() => undefined);
  return cacheFor(desktopId, resource, displayName);
}

/**
 * Resolves a resource only after proving there is no valid local SHA-256 cache
 * hit. The Desktop receives neither a path nor an arbitrary source URL.
 */
export async function ensureAvatarResource({
  desktopId,
  resource,
  request,
  previous,
  displayName,
}: {
  desktopId: string;
  resource: AvatarResourceMetadata | null | undefined;
  request: RemoteRequest;
  previous?: AvatarCache;
  displayName?: string;
}): Promise<AvatarCache | undefined> {
  if (!resource || !/^[A-Za-z0-9_-]{16,128}$/.test(resource.version) || resource.byteLength < 1 || resource.byteLength > maxAvatarBytes) return undefined;
  const key = `${desktopId}:${resource.kind}:${resource.code || ''}:${resource.version}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const run = (async () => {
    const candidate = previous?.version === resource.version ? previous : cacheFor(desktopId, resource, displayName);
    if (await validateAvatarCache(candidate, resource)) return candidate;
    if (candidate?.uri) await removeAvatarCache(candidate);
    const result = await request<WorkspaceAvatarResponse>(desktopId, 'workspace.avatar.get', {
      kind: resource.kind,
      ...(resource.kind === 'agent' && resource.code ? {code: resource.code} : {}),
      version: resource.version,
    });
    if (!result?.ok || !sameResource(result.avatar, resource)) throw new Error('头像版本响应无效。');
    return writeVerifiedAvatar({desktopId, resource, dataUrl: result.dataUrl, displayName});
  })();
  pending.set(key, run);
  try {
    return await run;
  } finally {
    pending.delete(key);
  }
}
