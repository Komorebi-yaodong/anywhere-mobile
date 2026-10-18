import {fromByteArray, toByteArray} from 'base64-js';
import {utf8ToBytes} from './utf8';

export const REMOTE_PROTOCOL_VERSION = 2;
export const REMOTE_PAIR_START_PATH = '/api/v2/pair/start';
export const REMOTE_PAIR_CONFIRM_PATH = '/api/v2/pair/confirm';
export const REMOTE_SOCKET_PATH = '/api/v2/socket';
export const REMOTE_HEALTH_PATH = '/health';
export const REMOTE_MAX_FRAME_BYTES = 256 * 1024;
export const REMOTE_MAX_REQUEST_BYTES = 128 * 1024;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type RemoteDirection = 'client-to-desktop' | 'desktop-to-client';
export type RemoteJsonPrimitive = null | boolean | number | string;
export type RemoteJsonValue =
  | RemoteJsonPrimitive
  | RemoteJsonValue[]
  | {[key: string]: RemoteJsonValue | undefined};

export class RemoteProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'RemoteProtocolError';
    this.code = code;
  }
}

export function remoteError(code: string, message = code): RemoteProtocolError {
  return new RemoteProtocolError(code, message);
}

export function concatBytes(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

export function encodeBase64Url(value: Uint8Array): string {
  const encoded = fromByteArray(value)
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return encoded.slice(0, encoded.indexOf('=') >= 0 ? encoded.indexOf('=') : undefined);
}

export function decodeBase64Url(
  value: unknown,
  field = 'base64url',
  {minBytes = 1, maxBytes = 1024 * 1024}: {minBytes?: number; maxBytes?: number} = {},
): Uint8Array {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw remoteError(
      'remote_invalid_base64url',
      `${field} must be an unpadded base64url string`,
    );
  }

  const padding = (4 - (value.length % 4)) % 4;
  let decoded: Uint8Array;
  try {
    decoded = toByteArray(
      `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat(padding)}`,
    );
  } catch {
    throw remoteError('remote_invalid_base64url', `${field} is invalid`);
  }

  if (
    decoded.length < minBytes ||
    decoded.length > maxBytes ||
    encodeBase64Url(decoded) !== value
  ) {
    throw remoteError(
      'remote_invalid_base64url',
      `${field} has an invalid byte length or encoding`,
    );
  }
  return decoded;
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = Math.abs(left.length - right.length);
  for (let index = 0; index < maxLength; index += 1) {
    difference += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return difference === 0;
}

export function timingSafeEqualBase64Url(left: unknown, right: unknown): boolean {
  try {
    return timingSafeEqual(
      decodeBase64Url(left, 'left'),
      decodeBase64Url(right, 'right'),
    );
  } catch {
    return false;
  }
}

export function normalizeIdentifier(
  value: unknown,
  field = 'identifier',
  {minLength = 1, maxLength = 160}: {minLength?: number; maxLength?: number} = {},
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    normalized.length < minLength ||
    normalized.length > maxLength ||
    !SAFE_IDENTIFIER_PATTERN.test(normalized)
  ) {
    throw remoteError('remote_identifier_invalid', `${field} is invalid`);
  }
  return normalized;
}

export function normalizeSequence(value: unknown): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw remoteError('remote_sequence_invalid');
  }
  return sequence;
}

export function stableStringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const type = typeof value;
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw remoteError('remote_canonical_value_invalid');
    }
    return JSON.stringify(value);
  }
  if (
    type === 'bigint' ||
    type === 'undefined' ||
    type === 'function' ||
    type === 'symbol'
  ) {
    throw remoteError('remote_canonical_value_invalid');
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }

  throw remoteError('remote_canonical_value_invalid');
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8ToBytes(stableStringify(value));
}


export function decodeUtf8(value: Uint8Array): string {
  let encoded = '';
  for (const byte of value) {
    encoded += `%${byte.toString(16).padStart(2, '0')}`;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw remoteError('remote_invalid_utf8');
  }
}

export function parseJsonBytes(
  value: Uint8Array,
  {maxBytes = REMOTE_MAX_REQUEST_BYTES, code = 'remote_invalid_json'}: {
    maxBytes?: number;
    code?: string;
  } = {},
): Record<string, unknown> {
  if (value.length === 0 || value.length > maxBytes) {
    throw remoteError('remote_payload_size_invalid');
  }
  try {
    const parsed: unknown = JSON.parse(decodeUtf8(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw remoteError(code);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RemoteProtocolError) {
      throw error;
    }
    throw remoteError(code);
  }
}

export function buildFrameAad({
  sessionId,
  sequence,
  direction,
}: {
  sessionId: unknown;
  sequence: unknown;
  direction: RemoteDirection;
}): Uint8Array {
  const safeSessionId = normalizeIdentifier(sessionId, 'sessionId', {
    minLength: 16,
    maxLength: 128,
  });
  const safeSequence = normalizeSequence(sequence);
  if (
    direction !== 'client-to-desktop' &&
    direction !== 'desktop-to-client'
  ) {
    throw remoteError('remote_frame_direction_invalid');
  }
  return canonicalBytes({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'remote.encrypted',
    sessionId: safeSessionId,
    sequence: safeSequence,
    direction,
  });
}
