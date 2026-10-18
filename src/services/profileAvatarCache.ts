import {Dirs, FileSystem} from 'react-native-file-access';

import type {AvatarCache} from '../domain/pairing';

const cacheDirectory = `${Dirs.CacheDir}/anywhere-profile-avatars`;
const maxAvatarBytes = 160 * 1024;
const maxCacheAgeMs = 30 * 24 * 60 * 60 * 1000;

type AvatarPayload = {extension: 'png' | 'jpg' | 'webp'; base64: string};

function parseAvatarDataUrl(value: string): AvatarPayload | null {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const base64 = match[2];
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  if (bytes <= 0 || bytes > maxAvatarBytes) return null;
  return {
    extension: match[1].toLowerCase() === 'jpeg' ? 'jpg' : (match[1].toLowerCase() as 'png' | 'webp'),
    base64,
  };
}

function cachePath(desktopId: string, extension: AvatarPayload['extension']): string {
  const safeId = desktopId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160);
  if (!safeId) throw new Error('桌面标识无效。');
  return `${cacheDirectory}/${safeId}.${extension}`;
}

function imageUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function nativePath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

export function isAvatarCacheValid(cache: AvatarCache | undefined): boolean {
  if (!cache || typeof cache.uri !== 'string' || !cache.uri.startsWith('file://')) {
    return false;
  }
  const expiresAt = Date.parse(cache.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export async function removeProfileAvatarCache(
  cache: AvatarCache | undefined,
): Promise<void> {
  if (!cache?.uri?.startsWith('file://')) return;
  await FileSystem.unlink(nativePath(cache.uri)).catch(() => undefined);
}

/**
 * Stores only a Mobile-private image copy. The Desktop source path is never
 * accepted here; this function accepts an already validated image Data URL
 * received inside the encrypted workspace RPC response.
 */
export async function cacheProfileAvatar({
  desktopId,
  avatarDataUrl,
  avatarVersion,
  displayName,
  previous,
}: {
  desktopId: string;
  avatarDataUrl: string;
  avatarVersion: string;
  displayName: string;
  previous?: AvatarCache;
}): Promise<AvatarCache | undefined> {
  const avatar = parseAvatarDataUrl(avatarDataUrl);
  if (!avatar) return undefined;
  if (!(await FileSystem.exists(cacheDirectory))) {
    await FileSystem.mkdir(cacheDirectory);
  }
  const path = cachePath(desktopId, avatar.extension);
  await FileSystem.writeFile(path, avatar.base64, 'base64');
  const uri = imageUri(path);
  if (previous?.uri && previous.uri !== uri) {
    await removeProfileAvatarCache(previous);
  }
  return {
    uri,
    expiresAt: new Date(Date.now() + maxCacheAgeMs).toISOString(),
    version: avatarVersion,
    ...(displayName.trim() ? {displayName: displayName.trim().slice(0, 80)} : {}),
  };
}
