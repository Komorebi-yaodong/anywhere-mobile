import {utf8ToBytes} from './utf8';
import {
  AES_KEY_BYTES,
  createP256KeyPair,
  decryptAead,
  deriveSharedSecret,
  encryptAead,
  hkdfSha256,
  hmacSha256,
  normalizePublicKey,
  publicKeyFromPrivate,
  P256KeyPair,
  sha256Base64Url,
  sha256Bytes,
} from './crypto';
import {
  canonicalBytes,
  concatBytes,
  decodeBase64Url,
  encodeBase64Url,
  normalizeIdentifier,
  parseJsonBytes,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_PROTOCOL_VERSION,
  remoteError,
  timingSafeEqualBase64Url,
} from './protocol';

const HANDSHAKE_LABEL = 'anywhere-remote-v2/handshake';
const PAIRING_START_LABEL = 'anywhere-remote-v2/pair-start';

export type PairingContext = {
  pairingId: string;
  pairingChallenge: string;
  desktopId: string;
};

export type RemoteDeviceIdentity = {
  deviceId: string;
  displayName: string;
  platform: string;
  deviceModel?: string;
  appVersion: string;
  publicKey: string;
};

export type PairingStartEnvelope = {
  v: 2;
  type: 'remote.pair.start';
  pairingId: string;
  clientEphemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

export type PairingStartResponse = {
  v: 2;
  pairingAttemptId: string;
  desktopId: string;
  desktopName: string;
  desktopIdentityPublicKey: string;
  serverEphemeralPublicKey: string;
  desktopProof: string;
  transcriptHash: string;
  certificateFingerprint: string;
  expiresAt: string | number;
};

export type PairingConfirmRequest = {
  v: 2;
  pairingId: string;
  pairingAttemptId: string;
  deviceId: string;
  deviceProof: string;
};

export type CompletedDevicePairing = {
  deviceProof: string;
  rootSecret: string;
  transcriptHash: string;
};

export type PairingStartState = {
  clientEphemeralKeyPair: P256KeyPair;
  envelope: PairingStartEnvelope;
};

export function normalizePairingContext(context: PairingContext): PairingContext {
  const pairingId = normalizeIdentifier(context?.pairingId, 'pairingId', {
    minLength: 16,
    maxLength: 160,
  });
  const desktopId = normalizeIdentifier(context?.desktopId, 'desktopId', {
    minLength: 16,
    maxLength: 160,
  });
  const pairingChallenge =
    typeof context?.pairingChallenge === 'string'
      ? context.pairingChallenge
      : '';
  decodeBase64Url(pairingChallenge, 'pairingChallenge', {
    minBytes: 16,
    maxBytes: 128,
  });
  return {pairingId, pairingChallenge, desktopId};
}

export function createPairingStartAad({
  context,
  desktopPublicKey,
  clientEphemeralPublicKey,
}: {
  context: PairingContext;
  desktopPublicKey: string;
  clientEphemeralPublicKey: string;
}): Uint8Array {
  const normalizedContext = normalizePairingContext(context);
  normalizePublicKey(desktopPublicKey, 'desktopPublicKey');
  normalizePublicKey(
    clientEphemeralPublicKey,
    'clientEphemeralPublicKey',
  );
  return canonicalBytes({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'remote.pair.start',
    label: PAIRING_START_LABEL,
    pairingId: normalizedContext.pairingId,
    pairingChallenge: normalizedContext.pairingChallenge,
    desktopId: normalizedContext.desktopId,
    desktopPublicKey,
    clientEphemeralPublicKey,
  });
}

export function createPairingStartEnvelope({
  desktopPublicKey,
  clientEphemeralPrivateKey,
  context,
  pairingCode,
  device,
  nonce,
}: {
  desktopPublicKey: string;
  clientEphemeralPrivateKey: string;
  context: PairingContext;
  pairingCode: string;
  device: RemoteDeviceIdentity;
  nonce?: Uint8Array;
}): PairingStartEnvelope {
  const clientEphemeralPublicKey =
    publicKeyFromPrivate(clientEphemeralPrivateKey);
  const normalizedContext = normalizePairingContext(context);
  const aad = createPairingStartAad({
    context: normalizedContext,
    desktopPublicKey,
    clientEphemeralPublicKey,
  });
  const sharedSecret = deriveSharedSecret(
    clientEphemeralPrivateKey,
    desktopPublicKey,
  );
  const key = hkdfSha256({
    ikm: sharedSecret,
    salt: sha256Bytes(aad),
    info: `${PAIRING_START_LABEL}/key`,
  });
  const plaintext = canonicalBytes({
    pairingCode:
      typeof pairingCode === 'string' ? pairingCode.replace(/\s/g, '') : '',
    pairingChallenge: normalizedContext.pairingChallenge,
    device,
  });

  try {
    return {
      v: REMOTE_PROTOCOL_VERSION,
      type: 'remote.pair.start',
      pairingId: normalizedContext.pairingId,
      clientEphemeralPublicKey,
      ...encryptAead({key, plaintext, aad, nonce}),
    };
  } finally {
    sharedSecret.fill(0);
    key.fill(0);
    plaintext.fill(0);
  }
}

export function startDevicePairing(args: Omit<
  Parameters<typeof createPairingStartEnvelope>[0],
  'clientEphemeralPrivateKey'
>): PairingStartState {
  const clientEphemeralKeyPair = createP256KeyPair();
  return {
    clientEphemeralKeyPair,
    envelope: createPairingStartEnvelope({
      ...args,
      clientEphemeralPrivateKey: clientEphemeralKeyPair.privateKey,
    }),
  };
}

export function createPairingTranscript({
  context,
  desktopPublicKey,
  devicePublicKey,
  clientEphemeralPublicKey,
  serverEphemeralPublicKey,
}: {
  context: PairingContext;
  desktopPublicKey: string;
  devicePublicKey: string;
  clientEphemeralPublicKey: string;
  serverEphemeralPublicKey: string;
}): Uint8Array {
  const normalizedContext = normalizePairingContext(context);
  normalizePublicKey(desktopPublicKey, 'desktopPublicKey');
  normalizePublicKey(devicePublicKey, 'device.publicKey');
  normalizePublicKey(
    clientEphemeralPublicKey,
    'clientEphemeralPublicKey',
  );
  normalizePublicKey(
    serverEphemeralPublicKey,
    'serverEphemeralPublicKey',
  );
  return canonicalBytes({
    v: REMOTE_PROTOCOL_VERSION,
    label: HANDSHAKE_LABEL,
    pairingId: normalizedContext.pairingId,
    pairingChallenge: normalizedContext.pairingChallenge,
    desktopId: normalizedContext.desktopId,
    desktopPublicKey,
    devicePublicKey,
    clientEphemeralPublicKey,
    serverEphemeralPublicKey,
  });
}

export function createPairingProof({
  rootSecret,
  transcript,
  role,
}: {
  rootSecret: string | Uint8Array;
  transcript: Uint8Array;
  role: 'device' | 'desktop';
}): string {
  const root =
    typeof rootSecret === 'string'
      ? decodeBase64Url(rootSecret, 'rootSecret', {
          minBytes: AES_KEY_BYTES,
          maxBytes: AES_KEY_BYTES,
        })
      : rootSecret;
  if (root.length !== AES_KEY_BYTES || transcript.length === 0) {
    throw remoteError('remote_pairing_transcript_invalid');
  }
  return encodeBase64Url(
    hmacSha256(
      root,
      concatBytes(
        utf8ToBytes(`${HANDSHAKE_LABEL}/${role}\n`),
        transcript,
      ),
    ),
  );
}

export function completeDevicePairing({
  devicePrivateKey,
  desktopPublicKey,
  serverEphemeralPublicKey,
  clientEphemeralPrivateKey,
  devicePublicKey,
  context,
  desktopProof,
  expectedTranscriptHash,
}: {
  devicePrivateKey: string;
  desktopPublicKey: string;
  serverEphemeralPublicKey: string;
  clientEphemeralPrivateKey: string;
  devicePublicKey: string;
  context: PairingContext;
  desktopProof: string;
  expectedTranscriptHash?: string;
}): CompletedDevicePairing {
  const clientEphemeralPublicKey = publicKeyFromPrivate(
    clientEphemeralPrivateKey,
  );
  const transcript = createPairingTranscript({
    context,
    desktopPublicKey,
    devicePublicKey,
    clientEphemeralPublicKey,
    serverEphemeralPublicKey,
  });
  const staticSecret = deriveSharedSecret(devicePrivateKey, desktopPublicKey);
  const ephemeralSecret = deriveSharedSecret(
    clientEphemeralPrivateKey,
    serverEphemeralPublicKey,
  );
  const transcriptHash = sha256Base64Url(transcript);
  const rootSecret = hkdfSha256({
    ikm: concatBytes(staticSecret, ephemeralSecret),
    salt: sha256Bytes(transcript),
    info: `${HANDSHAKE_LABEL}/root`,
  });

  try {
    if (
      expectedTranscriptHash &&
      !timingSafeEqualBase64Url(expectedTranscriptHash, transcriptHash)
    ) {
      throw remoteError('remote_pairing_transcript_invalid');
    }
    const expectedDesktopProof = createPairingProof({
      rootSecret,
      transcript,
      role: 'desktop',
    });
    if (!timingSafeEqualBase64Url(expectedDesktopProof, desktopProof)) {
      throw remoteError('remote_pairing_proof_invalid');
    }
    return {
      deviceProof: createPairingProof({
        rootSecret,
        transcript,
        role: 'device',
      }),
      rootSecret: encodeBase64Url(rootSecret),
      transcriptHash,
    };
  } finally {
    staticSecret.fill(0);
    ephemeralSecret.fill(0);
    rootSecret.fill(0);
    transcript.fill(0);
  }
}

export function createPairingConfirmRequest({
  context,
  pairingAttemptId,
  deviceId,
  deviceProof,
}: {
  context: PairingContext;
  pairingAttemptId: string;
  deviceId: string;
  deviceProof: string;
}): PairingConfirmRequest {
  const normalizedContext = normalizePairingContext(context);
  decodeBase64Url(deviceProof, 'deviceProof', {minBytes: 32, maxBytes: 32});
  return {
    v: REMOTE_PROTOCOL_VERSION,
    pairingId: normalizedContext.pairingId,
    pairingAttemptId: normalizeIdentifier(
      pairingAttemptId,
      'pairingAttemptId',
      {minLength: 16, maxLength: 160},
    ),
    deviceId: normalizeIdentifier(deviceId, 'deviceId', {
      minLength: 16,
      maxLength: 160,
    }),
    deviceProof,
  };
}

// Test/diagnostic helper for synthetic vectors only. Production pairing never needs
// to decrypt its own start envelope; Desktop performs this operation.
export function openPairingStartForFixture({
  desktopPrivateKey,
  desktopPublicKey,
  context,
  input,
}: {
  desktopPrivateKey: string;
  desktopPublicKey: string;
  context: PairingContext;
  input: PairingStartEnvelope;
}): Record<string, unknown> {
  const aad = createPairingStartAad({
    context,
    desktopPublicKey,
    clientEphemeralPublicKey: input.clientEphemeralPublicKey,
  });
  const sharedSecret = deriveSharedSecret(
    desktopPrivateKey,
    input.clientEphemeralPublicKey,
  );
  const key = hkdfSha256({
    ikm: sharedSecret,
    salt: sha256Bytes(aad),
    info: `${PAIRING_START_LABEL}/key`,
  });
  try {
    return parseJsonBytes(
      decryptAead({
        key,
        nonce: input.nonce,
        ciphertext: input.ciphertext,
        tag: input.tag,
        aad,
        maxCiphertextBytes: REMOTE_MAX_FRAME_BYTES,
      }),
      {maxBytes: REMOTE_MAX_FRAME_BYTES, code: 'remote_pairing_start_invalid'},
    );
  } finally {
    sharedSecret.fill(0);
    key.fill(0);
  }
}
