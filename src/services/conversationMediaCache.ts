import {Dirs, FileSystem} from 'react-native-file-access';

import type {RemoteRequest} from '../remote/api';
import {decodeBase64Url, normalizeIdentifier} from '../remote/protocol';

const cacheDirectory = `${Dirs.CacheDir}/anywhere-conversation-media`;
const cacheAgeMs = 7 * 24 * 60 * 60 * 1000;
const maxBytes = 25 * 1024 * 1024;
const chunkBytes = 96 * 1024;

type MediaReply = {
  ok: true;
  mediaId: string;
  mimeType: string;
  totalBytes: number;
  offset: number;
  byteLength: number;
  data: string;
};

type CacheEntry = {uri: string; expiresAt: string; mimeType: string; totalBytes: number};
const pending = new Map<string, Promise<CacheEntry>>();

function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  };
  return map[mimeType] || 'bin';
}

function safePath(desktopId: string, mediaId: string, mimeType: string): string {
  const desktop = desktopId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160);
  const media = mediaId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160);
  if (!desktop || !media) throw new Error('媒体引用无效。');
  return `${cacheDirectory}/${desktop}-${media}.${extensionFor(mimeType)}`;
}

function metaPath(filePath: string): string {
  return `${filePath}.json`;
}

function uri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

async function readValid(filePath: string): Promise<CacheEntry | null> {
  try {
    const raw = await FileSystem.readFile(metaPath(filePath), 'utf8');
    const value = JSON.parse(raw) as CacheEntry;
    const expiresAt = Date.parse(value.expiresAt);
    if (!value?.uri || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !(await FileSystem.exists(filePath))) {
      await FileSystem.unlink(filePath).catch(() => undefined);
      await FileSystem.unlink(metaPath(filePath)).catch(() => undefined);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** Downloads only opaque Desktop-issued media IDs. No Desktop path is accepted. */
export async function getConversationMediaCache({
  desktopId,
  conversationId,
  mediaId,
  request,
}: {
  desktopId: string;
  conversationId: string;
  mediaId: string;
  request: RemoteRequest;
}): Promise<CacheEntry> {
  const safeConversationId = normalizeIdentifier(conversationId, 'conversationId', {minLength: 16});
  const safeMediaId = normalizeIdentifier(mediaId, 'mediaId', {minLength: 16});
  const key = `${desktopId}:${safeConversationId}:${safeMediaId}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const run = (async () => {
    const first = await request<MediaReply>(desktopId, 'conversation.media.get', {
      conversationId: safeConversationId,
      mediaId: safeMediaId,
      offset: 0,
      length: chunkBytes,
    }, 60_000);
    if (!first.ok || first.offset !== 0 || first.totalBytes < 1 || first.totalBytes > maxBytes || first.byteLength < 1) {
      throw new Error('媒体响应无效。');
    }
    const filePath = safePath(desktopId, safeMediaId, first.mimeType);
    const cached = await readValid(filePath);
    if (cached && cached.totalBytes === first.totalBytes && cached.mimeType === first.mimeType) return cached;
    if (!(await FileSystem.exists(cacheDirectory))) await FileSystem.mkdir(cacheDirectory);
    await FileSystem.unlink(filePath).catch(() => undefined);
    await FileSystem.unlink(metaPath(filePath)).catch(() => undefined);
    const write = async (reply: MediaReply, append: boolean) => {
      if (reply.mediaId !== safeMediaId || reply.mimeType !== first.mimeType || reply.totalBytes !== first.totalBytes || reply.byteLength < 1 || reply.byteLength > chunkBytes || reply.offset < 0) throw new Error('媒体分块无效。');
      const bytes = decodeBase64Url(reply.data, 'media.data', {minBytes: reply.byteLength, maxBytes: chunkBytes});
      if (bytes.length !== reply.byteLength) throw new Error('媒体分块长度错误。');
      const base64 = reply.data.replace(/-/g, '+').replace(/_/g, '/');
      if (append) await FileSystem.appendFile(filePath, base64, 'base64');
      else await FileSystem.writeFile(filePath, base64, 'base64');
    };
    await write(first, false);
    for (let offset = first.byteLength; offset < first.totalBytes;) {
      const reply = await request<MediaReply>(desktopId, 'conversation.media.get', {
        conversationId: safeConversationId,
        mediaId: safeMediaId,
        offset,
        length: Math.min(chunkBytes, first.totalBytes - offset),
      }, 60_000);
      if (reply.offset !== offset) throw new Error('媒体分块顺序错误。');
      await write(reply, true);
      offset += reply.byteLength;
    }
    const stat = await FileSystem.stat(filePath);
    if (stat.size !== first.totalBytes) {
      await FileSystem.unlink(filePath).catch(() => undefined);
      throw new Error('媒体缓存校验失败。');
    }
    const entry: CacheEntry = {
      uri: uri(filePath),
      expiresAt: new Date(Date.now() + cacheAgeMs).toISOString(),
      mimeType: first.mimeType,
      totalBytes: first.totalBytes,
    };
    await FileSystem.writeFile(metaPath(filePath), JSON.stringify(entry), 'utf8');
    return entry;
  })();
  pending.set(key, run);
  try {
    return await run;
  } finally {
    pending.delete(key);
  }
}
