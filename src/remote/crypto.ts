import './runtime';

import {gcm} from '@noble/ciphers/aes.js';
import {p256} from '@noble/curves/nist.js';
import {hkdf} from '@noble/hashes/hkdf.js';
import {hmac} from '@noble/hashes/hmac.js';
import {sha256} from '@noble/hashes/sha2.js';
import {randomBytes} from '@noble/hashes/utils.js';
import {utf8ToBytes} from './utf8';
import {
  concatBytes,
  decodeBase64Url,
  encodeBase64Url,
  remoteError,
} from './protocol';

export const P256_PRIVATE_KEY_BYTES = 32;
export const P256_PUBLIC_KEY_BYTES = 65;
export const P256_SHARED_SECRET_BYTES = 32;
export const AES_KEY_BYTES = 32;
export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;

export type P256KeyPair = {
  privateKey: string;
  publicKey: string;
};

export type AeadEnvelope = {
  nonce: string;
  ciphertext: string;
  tag: string;
};

export function randomProtocolBytes(size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 1 || size > 4096) {
    throw remoteError('remote_random_size_invalid');
  }
  return randomBytes(size);
}

export function randomBase64Url(size = 32): string {
  if (!Number.isInteger(size) || size < 16 || size > 4096) {
    throw remoteError('remote_random_size_invalid');
  }
  return encodeBase64Url(randomProtocolBytes(size));
}

export function sha256Bytes(value: Uint8Array): Uint8Array {
  return sha256(value);
}

export function sha256Base64Url(value: Uint8Array): string {
  return encodeBase64Url(sha256Bytes(value));
}

export function hmacSha256(key: Uint8Array, value: Uint8Array): Uint8Array {
  return hmac(sha256, key, value);
}

export function hkdfSha256({
  ikm,
  salt,
  info,
  length = AES_KEY_BYTES,
}: {
  ikm: Uint8Array;
  salt: Uint8Array;
  info: Uint8Array | string;
  length?: number;
}): Uint8Array {
  return hkdf(
    sha256,
    ikm,
    salt,
    typeof info === 'string' ? utf8ToBytes(info) : info,
    length,
  );
}

export function normalizePrivateKey(value: string, field = 'privateKey'): Uint8Array {
  const privateKey = decodeBase64Url(value, field, {
    minBytes: P256_PRIVATE_KEY_BYTES,
    maxBytes: P256_PRIVATE_KEY_BYTES,
  });
  try {
    p256.getPublicKey(privateKey, false);
  } catch {
    privateKey.fill(0);
    throw remoteError(
      'remote_private_key_invalid',
      `${field} must be a valid P-256 private scalar`,
    );
  }
  return privateKey;
}

export function normalizePublicKey(value: string, field = 'publicKey'): Uint8Array {
  const publicKey = decodeBase64Url(value, field, {
    minBytes: P256_PUBLIC_KEY_BYTES,
    maxBytes: P256_PUBLIC_KEY_BYTES,
  });
  if (publicKey[0] !== 0x04) {
    throw remoteError(
      'remote_public_key_invalid',
      `${field} must be an uncompressed P-256 public key`,
    );
  }
  try {
    p256.Point.fromBytes(publicKey);
  } catch {
    throw remoteError(
      'remote_public_key_invalid',
      `${field} must be an uncompressed P-256 public key`,
    );
  }
  return publicKey;
}

export function createP256KeyPair(): P256KeyPair {
  const {secretKey} = p256.keygen();
  try {
    return {
      privateKey: encodeBase64Url(secretKey),
      publicKey: encodeBase64Url(p256.getPublicKey(secretKey, false)),
    };
  } finally {
    secretKey.fill(0);
  }
}

export function publicKeyFromPrivate(privateKeyValue: string): string {
  const privateKey = normalizePrivateKey(privateKeyValue);
  try {
    return encodeBase64Url(p256.getPublicKey(privateKey, false));
  } finally {
    privateKey.fill(0);
  }
}

export function deriveSharedSecret(
  privateKeyValue: string,
  publicKeyValue: string,
): Uint8Array {
  const privateKey = normalizePrivateKey(privateKeyValue);
  const publicKey = normalizePublicKey(publicKeyValue);
  try {
    // Noble returns an uncompressed SEC1 point. Node crypto.diffieHellman(), used by
    // Desktop, returns its 32-byte affine X coordinate for prime256v1.
    const sharedPoint = p256.getSharedSecret(privateKey, publicKey, false);
    if (sharedPoint.length !== P256_PUBLIC_KEY_BYTES || sharedPoint[0] !== 0x04) {
      throw remoteError('remote_ecdh_failed');
    }
    const sharedSecret = sharedPoint.slice(1, 33);
    sharedPoint.fill(0);
    return sharedSecret;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      throw error;
    }
    throw remoteError('remote_ecdh_failed');
  } finally {
    privateKey.fill(0);
  }
}

export function encryptAead({
  key,
  plaintext,
  aad,
  nonce = randomProtocolBytes(AES_GCM_NONCE_BYTES),
}: {
  key: Uint8Array;
  plaintext: Uint8Array;
  aad: Uint8Array;
  nonce?: Uint8Array;
}): AeadEnvelope {
  if (key.length !== AES_KEY_BYTES) {
    throw remoteError('remote_session_key_invalid');
  }
  if (nonce.length !== AES_GCM_NONCE_BYTES) {
    throw remoteError('remote_nonce_invalid');
  }
  const sealed = gcm(key, nonce, aad).encrypt(plaintext);
  const ciphertext = sealed.slice(0, sealed.length - AES_GCM_TAG_BYTES);
  const tag = sealed.slice(sealed.length - AES_GCM_TAG_BYTES);
  return {
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(ciphertext),
    tag: encodeBase64Url(tag),
  };
}

export function decryptAead({
  key,
  nonce,
  ciphertext,
  tag,
  aad,
  maxCiphertextBytes,
}: {
  key: Uint8Array;
  nonce: string;
  ciphertext: string;
  tag: string;
  aad: Uint8Array;
  maxCiphertextBytes: number;
}): Uint8Array {
  if (key.length !== AES_KEY_BYTES) {
    throw remoteError('remote_session_key_invalid');
  }
  const safeNonce = decodeBase64Url(nonce, 'frame.nonce', {
    minBytes: AES_GCM_NONCE_BYTES,
    maxBytes: AES_GCM_NONCE_BYTES,
  });
  const safeCiphertext = decodeBase64Url(ciphertext, 'frame.ciphertext', {
    minBytes: 1,
    maxBytes: maxCiphertextBytes,
  });
  const safeTag = decodeBase64Url(tag, 'frame.tag', {
    minBytes: AES_GCM_TAG_BYTES,
    maxBytes: AES_GCM_TAG_BYTES,
  });
  try {
    return gcm(key, safeNonce, aad).decrypt(
      concatBytes(safeCiphertext, safeTag),
    );
  } catch {
    throw remoteError('remote_frame_auth_failed');
  }
}
