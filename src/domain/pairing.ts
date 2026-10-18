import {decodeBase64Url, normalizeIdentifier} from '../remote/protocol';
import {normalizePublicKey} from '../remote/crypto';

export type TransportTlsMode = 'pinned' | 'system';

export type PairingPayload = {
  v: 2;
  desktopId: string;
  desktopName: string;
  endpoint: string;
  endpoints: string[];
  pairingId: string;
  pairingChallenge: string;
  certificateFingerprint: string;
  desktopIdentityPublicKey: string;
  expiresAt: string;
  tlsMode: TransportTlsMode;
};

export type AvatarCache = {
  uri: string;
  expiresAt: string;
  version: string;
  displayName?: string;
};

export type PairedDesktop = {
  id: string;
  name: string;
  profileName?: string;
  avatarCache?: AvatarCache;
  endpoint: string;
  endpoints: string[];
  certificateFingerprint: string;
  desktopIdentityPublicKey: string;
  tlsMode: TransportTlsMode;
  pairedAt: string;
};

export type DesktopStatus = '连接中' | '在线' | '离线' | '错误';

function readString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function readStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [];
}

function parseObject(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('请粘贴桌面端生成的 Remote v2 配对二维码内容。');
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // QR payload may be a deep-link URL; handle it below.
  }
  try {
    const url = new URL(trimmed);
    const embedded = url.searchParams.get('data') ?? url.searchParams.get('payload');
    if (!embedded) {
      return Object.fromEntries(url.searchParams.entries());
    }
    const parsed: unknown = JSON.parse(embedded);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error('二维码 payload 不是 JSON 对象。');
  } catch (error) {
    if (error instanceof Error && error.message.includes('二维码')) {
      throw error;
    }
    throw new Error('二维码内容格式不正确：应为 Remote v2 JSON 或携带 payload 的链接。');
  }
}

export function normalizeFingerprint(value: string): string {
  const normalized = value.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) {
    throw new Error('证书指纹必须是 SHA-256（64 位十六进制）。');
  }
  return normalized;
}

export function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('桌面端地址不是有效 URL。');
  }
  if (url.protocol !== 'https:') {
    throw new Error('只允许 HTTPS 桌面端地址。');
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('桌面端地址不能包含账号、查询参数或片段。');
  }
  const normalizedPath = url.pathname.replace(/\/$/, '');
  return `${url.protocol}//${url.host}${normalizedPath}`;
}

export function inferTlsMode(endpoint: string): TransportTlsMode {
  const hostname = new URL(normalizeEndpoint(endpoint)).hostname
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname === '::1' ||
    hostname.startsWith('fc') ||
    hostname.startsWith('fd') ||
    hostname.startsWith('fe80:')
  ) {
    return 'pinned';
  }
  return 'system';
}

export function normalizePairingPayload(input: Partial<PairingPayload>): PairingPayload {
  if (Number(input.v) !== 2) {
    throw new Error('二维码不是 Anywhere Remote v2 协议。');
  }
  const endpoint = normalizeEndpoint(input.endpoint ?? '');
  const endpoints = [...new Set([endpoint, ...(input.endpoints ?? []).map(normalizeEndpoint)])];
  const desktopId = normalizeIdentifier(input.desktopId, 'desktopId', {
    minLength: 16,
    maxLength: 160,
  });
  const pairingId = normalizeIdentifier(input.pairingId, 'pairingId', {
    minLength: 16,
    maxLength: 160,
  });
  const pairingChallenge = input.pairingChallenge?.trim() ?? '';
  decodeBase64Url(pairingChallenge, 'pairingChallenge', {minBytes: 16, maxBytes: 128});
  const desktopIdentityPublicKey = input.desktopIdentityPublicKey?.trim() ?? '';
  normalizePublicKey(desktopIdentityPublicKey, 'desktopIdentityPublicKey');
  const expiresAt = input.expiresAt?.trim() ?? '';
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error('配对二维码已过期，请在桌面端重新生成。');
  }
  const desktopName = input.desktopName?.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Anywhere Desktop';
  const tlsMode = input.tlsMode === 'pinned' || input.tlsMode === 'system'
    ? input.tlsMode
    : inferTlsMode(endpoint);
  return {
    v: 2,
    desktopId,
    desktopName,
    endpoint,
    endpoints,
    pairingId,
    pairingChallenge,
    certificateFingerprint: normalizeFingerprint(input.certificateFingerprint ?? ''),
    desktopIdentityPublicKey,
    expiresAt: new Date(expiresAtMs).toISOString(),
    tlsMode,
  };
}

export function parsePairingPayload(raw: string): PairingPayload {
  const source = parseObject(raw);
  return normalizePairingPayload({
    v: Number(source.v) as 2,
    desktopId: readString(source, ['desktopId', 'd']),
    desktopName: readString(source, ['desktopName', 'n']),
    endpoint: readString(source, ['endpoint', 'e']),
    endpoints: readStringArray(source, 'endpoints'),
    pairingId: readString(source, ['pairingId', 'i']),
    pairingChallenge: readString(source, ['pairingChallenge', 'c']),
    certificateFingerprint: readString(source, ['certificateFingerprint', 'f']),
    desktopIdentityPublicKey: readString(source, ['desktopIdentityPublicKey', 'k']),
    expiresAt: readString(source, ['expiresAt', 'x']),
  });
}

/** Returns only QR-provided, already paired endpoints; no network discovery occurs. */
export function orderedPairedEndpoints(desktop: Pick<PairedDesktop, 'endpoint' | 'endpoints'>): string[] {
  const primary = normalizeEndpoint(desktop.endpoint);
  const known = Array.isArray(desktop.endpoints) ? desktop.endpoints : [];
  const values = [primary, ...known]
    .map(value => {
      try { return normalizeEndpoint(value); } catch { return ''; }
    })
    .filter(Boolean);
  return [...new Set(values)];
}

export function withDesktopEndpoint(desktop: PairedDesktop, endpoint: string): PairedDesktop {
  const normalized = normalizeEndpoint(endpoint);
  const endpoints = orderedPairedEndpoints(desktop);
  if (!endpoints.includes(normalized)) {
    throw new Error('连接地址不在已配对的安全地址列表中。');
  }
  return {
    ...desktop,
    endpoint: normalized,
    endpoints,
    tlsMode: inferTlsMode(normalized),
  };
}


export function withPairingTransport(
  payload: PairingPayload,
  endpoint: string,
  tlsMode: TransportTlsMode,
): PairingPayload {
  return normalizePairingPayload({...payload, endpoint, tlsMode});
}
