import * as Keychain from 'react-native-keychain';

import {
  createP256KeyPair,
  publicKeyFromPrivate,
  randomBase64Url,
} from '../remote/crypto';
import {decodeBase64Url, normalizeIdentifier} from '../remote/protocol';
import type {AvatarCache, PairedDesktop} from '../domain/pairing';

export type DeviceIdentitySecret = {
  version: 2;
  deviceId: string;
  privateKey: string;
  publicKey: string;
  createdAt: string;
};

export type DesktopCredentialSecret = {
  version: 2;
  desktopId: string;
  rootSecret: string;
  savedAt: string;
};

const deviceIdentityService = 'com.anywhere.mobile.remote-v2.device-identity';
const desktopCredentialPrefix = 'com.anywhere.mobile.remote-v2.desktop.';
const desktopIndexService = 'com.anywhere.mobile.remote-v2.desktop-index';

const secureOptions = {
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  securityLevel: Keychain.SECURITY_LEVEL.SECURE_SOFTWARE,
} as const;

function desktopCredentialService(desktopId: string): string {
  return `${desktopCredentialPrefix}${desktopId}`;
}

async function writeSecret(service: string, username: string, value: unknown): Promise<void> {
  const stored = await Keychain.setGenericPassword(username, JSON.stringify(value), {
    service,
    ...secureOptions,
  });
  if (!stored) {
    throw new Error('无法写入系统 Keychain/Keystore。');
  }
}

async function readSecret(service: string): Promise<unknown | null> {
  const credentials = await Keychain.getGenericPassword({service});
  if (!credentials) {
    return null;
  }
  try {
    return JSON.parse(credentials.password) as unknown;
  } catch {
    throw new Error('系统安全存储中的 Remote v2 记录已损坏。');
  }
}

function parseDeviceIdentity(value: unknown): DeviceIdentitySecret {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('设备身份记录无效。');
  }
  const record = value as Partial<DeviceIdentitySecret>;
  if (record.version !== 2) {
    throw new Error('设备身份版本不受支持。');
  }
  const deviceId = normalizeIdentifier(record.deviceId, 'deviceId', {
    minLength: 16,
    maxLength: 160,
  });
  if (typeof record.privateKey !== 'string' || typeof record.publicKey !== 'string') {
    throw new Error('设备身份密钥缺失。');
  }
  if (publicKeyFromPrivate(record.privateKey) !== record.publicKey) {
    throw new Error('设备身份公私钥不匹配。');
  }
  return {
    version: 2,
    deviceId,
    privateKey: record.privateKey,
    publicKey: record.publicKey,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
  };
}

let identityLoad: Promise<DeviceIdentitySecret> | undefined;

export function loadOrCreateDeviceIdentity(): Promise<DeviceIdentitySecret> {
  if (!identityLoad) {
    identityLoad = readOrCreateDeviceIdentity().finally(() => {
      identityLoad = undefined;
    });
  }
  return identityLoad;
}

async function readOrCreateDeviceIdentity(): Promise<DeviceIdentitySecret> {
  const stored = await readSecret(deviceIdentityService);
  if (stored) {
    return parseDeviceIdentity(stored);
  }
  const keyPair = createP256KeyPair();
  const identity: DeviceIdentitySecret = {
    version: 2,
    deviceId: `device-${createOpaqueIdentifier()}`,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    createdAt: new Date().toISOString(),
  };
  await writeSecret(deviceIdentityService, identity.deviceId, identity);
  return identity;
}

export async function saveDesktopCredential(
  credential: DesktopCredentialSecret,
): Promise<void> {
  const desktopId = normalizeIdentifier(credential.desktopId, 'desktopId', {
    minLength: 16,
    maxLength: 160,
  });
  decodeBase64Url(credential.rootSecret, 'rootSecret', {minBytes: 32, maxBytes: 32});
  await writeSecret(desktopCredentialService(desktopId), desktopId, {
    version: 2,
    desktopId,
    rootSecret: credential.rootSecret,
    savedAt: credential.savedAt,
  } satisfies DesktopCredentialSecret);
}

export async function loadDesktopCredential(
  desktopId: string,
): Promise<DesktopCredentialSecret | null> {
  const safeDesktopId = normalizeIdentifier(desktopId, 'desktopId', {
    minLength: 16,
    maxLength: 160,
  });
  const value = await readSecret(desktopCredentialService(safeDesktopId));
  if (!value) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('桌面凭证记录无效。');
  }
  const record = value as Partial<DesktopCredentialSecret>;
  if (record.version !== 2 || record.desktopId !== safeDesktopId || typeof record.rootSecret !== 'string') {
    throw new Error('桌面凭证版本或身份不匹配。');
  }
  decodeBase64Url(record.rootSecret, 'rootSecret', {minBytes: 32, maxBytes: 32});
  return {
    version: 2,
    desktopId: safeDesktopId,
    rootSecret: record.rootSecret,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
  };
}

export async function removeDesktopCredential(desktopId: string): Promise<void> {
  await Keychain.resetGenericPassword({service: desktopCredentialService(desktopId)});
}

function avatarCache(value: unknown): AvatarCache | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const cache = value as Partial<AvatarCache>;
  if (
    typeof cache.uri !== 'string' ||
    !cache.uri.startsWith('file://') ||
    typeof cache.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(cache.expiresAt)) ||
    typeof cache.version !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(cache.version)
  ) {
    return undefined;
  }
  return {
    uri: cache.uri,
    expiresAt: cache.expiresAt,
    version: cache.version,
    ...(typeof cache.displayName === 'string' && cache.displayName.trim()
      ? {displayName: cache.displayName.trim().slice(0, 80)}
      : {}),
  };
}


export async function saveDesktopIndex(desktops: PairedDesktop[]): Promise<void> {
  await writeSecret(desktopIndexService, 'desktops', desktops);
}

export async function loadDesktopIndex(): Promise<PairedDesktop[]> {
  const value = await readSecret(desktopIndexService);
  if (!value) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('已配对桌面索引已损坏。');
  }
  return value.flatMap((item): PairedDesktop[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const desktop = item as Partial<PairedDesktop>;
    const valid =
      typeof desktop.id === 'string' &&
      typeof desktop.name === 'string' &&
      typeof desktop.endpoint === 'string' &&
      Array.isArray(desktop.endpoints) &&
      typeof desktop.certificateFingerprint === 'string' &&
      typeof desktop.desktopIdentityPublicKey === 'string' &&
      (desktop.tlsMode === 'pinned' || desktop.tlsMode === 'system') &&
      typeof desktop.pairedAt === 'string';
    if (!valid) return [];
    const cache = avatarCache(desktop.avatarCache);
    return [{...desktop, ...(cache ? {avatarCache: cache} : {})} as PairedDesktop];
  });
}

export type PendingRemoteOperation = {operationId: string; conversationId: string | null; issuedAt: number};
const operationQueues = new Map<string, Promise<unknown>>();
export function updatePendingOperations(desktopId: string, update: (items: PendingRemoteOperation[]) => PendingRemoteOperation[]): Promise<PendingRemoteOperation[]> {
  const service = `com.anywhere.mobile.remote-v2.operations.${desktopId}`;
  const next = (operationQueues.get(desktopId) || Promise.resolve()).catch(() => undefined).then(async () => {
    const stored = await readSecret(service);
    if (stored !== null && !Array.isArray(stored)) throw new Error('remote_operation_storage_invalid');
    const items = (stored || []) as PendingRemoteOperation[];
    if (items.some(item => !item || typeof item.operationId !== 'string' || !Number.isFinite(item.issuedAt))) throw new Error('remote_operation_storage_invalid');
    const result = update(items);
    if (result.length > 128) throw new Error('remote_operation_limit_reached');
    if (JSON.stringify(result) !== JSON.stringify(items) || stored === null && result.length > 0) await writeSecret(service, desktopId, result);
    return result;
  });
  operationQueues.set(desktopId, next);
  return next;
}


function createOpaqueIdentifier(): string {
  return randomBase64Url(24);
}
