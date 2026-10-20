import {markdownCodeRanges} from './markdownParser';


export type ConversationMediaKind = 'image' | 'video' | 'audio';

export type ConversationMedia = {
  key: string;
  kind: ConversationMediaKind;
  uri: string;
  opaque: boolean;
};

export type ConversationContentBlock =
  | {kind: 'text'; value: string}
  | {kind: 'media'; media: ConversationMedia};

type LocatedMedia = {
  start: number;
  end: number;
  media: ConversationMedia;
};

const OPAQUE_MEDIA_PATTERN = /^anywhere-media:\/\/([A-Za-z0-9_-]{16,160})(?:\?type=(image|video|audio))?$/;
const OPAQUE_MEDIA_GLOBAL = /anywhere-media:\/\/[A-Za-z0-9_-]{16,160}(?:\?type=(?:image|video|audio))?/g;
const MARKDOWN_IMAGE = /!\[[^\]\r\n]*\]\(\s*(?:<([^>\s]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const MARKDOWN_IMAGE_ANY = /!\[[^\]\r\n]*\]\(\s*[^)]+\)/g;

function trimSource(value: string): string {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function safeHttpsUri(value: string): string {
  const source = trimSource(value);
  if (!source || source.length > 4096) return '';
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function attribute(markup: string, name: string): string {
  const match = markup.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function kindForMime(value: string): ConversationMediaKind | null {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
}

function kindForUri(value: string): ConversationMediaKind | null {
  const source = String(value || '').split(/[?#]/, 1)[0].toLowerCase();
  if (/\.(?:png|jpe?g|webp|gif|bmp|heic)$/i.test(source)) return 'image';
  if (/\.(?:mp4|webm|mov|m4v|mkv)$/i.test(source)) return 'video';
  if (/\.(?:mp3|wav|m4a|aac|ogg|opus|flac)$/i.test(source)) return 'audio';
  return null;
}

function mediaFor(source: string, preferredKind?: ConversationMediaKind | null): Omit<ConversationMedia, 'key'> | null {
  const normalized = trimSource(source);
  const opaque = OPAQUE_MEDIA_PATTERN.exec(normalized);
  if (opaque) {
    return {
      kind: (opaque[2] as ConversationMediaKind | undefined) || preferredKind || 'image',
      uri: normalized,
      opaque: true,
    };
  }
  const uri = safeHttpsUri(normalized);
  if (!uri) return null;
  const kind = preferredKind || kindForUri(uri);
  return kind ? {kind, uri, opaque: false} : null;
}

function addLocatedMedia(items: LocatedMedia[], start: number, end: number, media: Omit<ConversationMedia, 'key'> | null): void {
  if (!media || start < 0 || end <= start) return;
  items.push({start, end, media: {...media, key: `media-${start}-${end}-${items.length}`}});
}

function isInside(items: Array<{start: number; end: number}>, position: number): boolean {
  return items.some(item => item.start <= position && position < item.end);
}

function stripUnsupportedMarkup(value: string): string {
  const ranges = markdownCodeRanges(value);
  const strip = (part: string) => part.replace(MARKDOWN_IMAGE_ANY, '')
    .replace(/<\/?(?:audio|video)\b[^>]*>/gi, '')
    .replace(/<(?:img|source)\b[^>]*>/gi, '');
  let cursor = 0;
  let output = '';
  for (const range of ranges) {
    output += strip(value.slice(cursor, range.start)) + value.slice(range.start, range.end);
    cursor = range.end;
  }
  // Ordinary HTML is literal text in the native Markdown renderer (html:false),
  // not an executable DOM. Keep it so blockquotes/autolinks/code are not lost.
  return output + strip(value.slice(cursor));
}

/**
 * Parses a deliberately small, safe media subset. Direct media may only use
 * HTTPS. Desktop-local media must already have been converted to the opaque,
 * device- and conversation-bound anywhere-media scheme.
 */
export function parseConversationContent(value: string): ConversationContentBlock[] {
  const source = String(value || '');
  const located: LocatedMedia[] = [];
  const codeRanges = markdownCodeRanges(source);

  for (const match of source.matchAll(MARKDOWN_IMAGE)) {
    if (isInside(codeRanges, match.index || 0)) continue;
    addLocatedMedia(located, match.index || 0, (match.index || 0) + match[0].length, mediaFor(match[1] || match[2] || '', 'image'));
  }

  const pairedMedia = /<(audio|video)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of source.matchAll(pairedMedia)) {
    if (isInside(codeRanges, match.index || 0)) continue;
    const start = match.index || 0;
    const openAttributes = match[2] || '';
    const body = match[3] || '';
    const sourceTag = body.match(/<source\b[^>]*>/i)?.[0] || '';
    const mediaSource = attribute(openAttributes, 'src') || attribute(sourceTag, 'src');
    addLocatedMedia(located, start, start + match[0].length, mediaFor(mediaSource, match[1].toLowerCase() as ConversationMediaKind));
  }

  const imageTags = /<img\b([^>]*)\/?\s*>/gi;
  for (const match of source.matchAll(imageTags)) {
    if (isInside(codeRanges, match.index || 0)) continue;
    const start = match.index || 0;
    if (!isInside(located, start)) addLocatedMedia(located, start, start + match[0].length, mediaFor(attribute(match[1] || '', 'src'), 'image'));
  }

  const standaloneMedia = /<(audio|video)\b([^>]*)\/?\s*>/gi;
  for (const match of source.matchAll(standaloneMedia)) {
    if (isInside(codeRanges, match.index || 0)) continue;
    const start = match.index || 0;
    if (!isInside(located, start)) addLocatedMedia(located, start, start + match[0].length, mediaFor(attribute(match[2] || '', 'src'), match[1].toLowerCase() as ConversationMediaKind));
  }

  const sourceTags = /<source\b([^>]*)\/?\s*>/gi;
  for (const match of source.matchAll(sourceTags)) {
    if (isInside(codeRanges, match.index || 0)) continue;
    const start = match.index || 0;
    if (isInside(located, start)) continue;
    const attrs = match[1] || '';
    addLocatedMedia(located, start, start + match[0].length, mediaFor(attribute(attrs, 'src'), kindForMime(attribute(attrs, 'type'))));
  }

  for (const match of source.matchAll(OPAQUE_MEDIA_GLOBAL)) {
    if (isInside(codeRanges, match.index || 0)) continue;
    const start = match.index || 0;
    if (!isInside(located, start)) addLocatedMedia(located, start, start + match[0].length, mediaFor(match[0]));
  }

  located.sort((left, right) => left.start - right.start || right.end - left.end);
  const blocks: ConversationContentBlock[] = [];
  let cursor = 0;
  for (const item of located) {
    if (item.start < cursor) continue;
    const text = stripUnsupportedMarkup(source.slice(cursor, item.start));
    if (text.trim()) blocks.push({kind: 'text', value: text});
    blocks.push({kind: 'media', media: item.media});
    cursor = item.end;
  }
  const trailing = stripUnsupportedMarkup(source.slice(cursor));
  if (trailing.trim()) blocks.push({kind: 'text', value: trailing});
  return blocks;
}

export function hasRenderableConversationContent(value: string): boolean {
  return parseConversationContent(value).some(block => block.kind === 'media' || Boolean(block.value.trim()));
}
