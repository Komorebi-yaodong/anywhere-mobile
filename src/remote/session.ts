import {
  AES_KEY_BYTES,
  createP256KeyPair,
  decryptAead,
  deriveSharedSecret,
  encryptAead,
  hkdfSha256,
  hmacSha256,
  P256KeyPair,
  randomBase64Url,
  sha256Bytes,
} from './crypto';
import {
  buildFrameAad,
  canonicalBytes,
  concatBytes,
  decodeBase64Url,
  encodeBase64Url,
  normalizeIdentifier,
  normalizeSequence,
  parseJsonBytes,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_PROTOCOL_VERSION,
  RemoteDirection,
  remoteError,
  timingSafeEqualBase64Url,
} from './protocol';

const SESSION_LABEL = 'anywhere-remote-v2/session';

export type SessionHello = {
  type: 'remote.session.hello';
  v: 2;
  deviceId: string;
  desktopId: string;
  clientNonce: string;
  clientEphemeralPublicKey: string;
  proof: string;
};

export type SessionAccept = {
  type: 'remote.session.accept';
  v: 2;
  sessionId: string;
  serverNonce: string;
  serverEphemeralPublicKey: string;
  proof: string;
};

export type SessionHelloState = {
  rootSecret: string;
  deviceId: string;
  desktopId: string;
  clientNonce: string;
  clientEphemeralPrivateKey: string;
  clientEphemeralPublicKey: string;
};

export type EncryptedFrame = {
  v: 2;
  type: 'remote.encrypted';
  sessionId: string;
  sequence: number;
  nonce: string;
  ciphertext: string;
  tag: string;
};

export interface RemoteCryptoSession {
  readonly sessionId: string;
  readonly expectedReceiveSequence: number;
  encrypt(payload: Record<string, unknown>, nonce?: Uint8Array): EncryptedFrame;
  decrypt(frame: EncryptedFrame | Record<string, unknown>): Record<string, unknown>;
  close(): void;
}

function normalizeRootSecret(value: string): Uint8Array {
  return decodeBase64Url(value, 'rootSecret', {
    minBytes: AES_KEY_BYTES,
    maxBytes: AES_KEY_BYTES,
  });
}

export function createSessionHelloProofPayload({
  deviceId,
  desktopId,
  clientNonce,
  clientEphemeralPublicKey,
}: Omit<SessionHello, 'type' | 'v' | 'proof'>): Uint8Array {
  return canonicalBytes({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'remote.session.hello',
    deviceId,
    desktopId,
    clientNonce,
    clientEphemeralPublicKey,
  });
}

export function createSessionAcceptProofPayload({
  deviceId,
  desktopId,
  sessionId,
  clientNonce,
  serverNonce,
  clientEphemeralPublicKey,
  serverEphemeralPublicKey,
}: {
  deviceId: string;
  desktopId: string;
  sessionId: string;
  clientNonce: string;
  serverNonce: string;
  clientEphemeralPublicKey: string;
  serverEphemeralPublicKey: string;
}): Uint8Array {
  return canonicalBytes({
    v: REMOTE_PROTOCOL_VERSION,
    type: 'remote.session.accept',
    deviceId,
    desktopId,
    sessionId,
    clientNonce,
    serverNonce,
    clientEphemeralPublicKey,
    serverEphemeralPublicKey,
  });
}

export function createSessionHello({
  rootSecret,
  deviceId,
  desktopId,
  ephemeralKeyPair = createP256KeyPair(),
  clientNonce = randomBase64Url(32),
}: {
  rootSecret: string;
  deviceId: string;
  desktopId: string;
  ephemeralKeyPair?: P256KeyPair;
  clientNonce?: string;
}): {hello: SessionHello; state: SessionHelloState} {
  const safeDeviceId = normalizeIdentifier(deviceId, 'deviceId', {
    minLength: 16,
    maxLength: 160,
  });
  const safeDesktopId = normalizeIdentifier(desktopId, 'desktopId', {
    minLength: 16,
    maxLength: 160,
  });
  decodeBase64Url(clientNonce, 'clientNonce', {minBytes: 16, maxBytes: 64});
  const root = normalizeRootSecret(rootSecret);
  const proofPayload = createSessionHelloProofPayload({
    deviceId: safeDeviceId,
    desktopId: safeDesktopId,
    clientNonce,
    clientEphemeralPublicKey: ephemeralKeyPair.publicKey,
  });

  try {
    return {
      hello: {
        type: 'remote.session.hello',
        v: REMOTE_PROTOCOL_VERSION,
        deviceId: safeDeviceId,
        desktopId: safeDesktopId,
        clientNonce,
        clientEphemeralPublicKey: ephemeralKeyPair.publicKey,
        proof: encodeBase64Url(hmacSha256(root, proofPayload)),
      },
      state: {
        rootSecret,
        deviceId: safeDeviceId,
        desktopId: safeDesktopId,
        clientNonce,
        clientEphemeralPrivateKey: ephemeralKeyPair.privateKey,
        clientEphemeralPublicKey: ephemeralKeyPair.publicKey,
      },
    };
  } finally {
    root.fill(0);
    proofPayload.fill(0);
  }
}

function deriveSessionMaterial({
  rootSecret,
  sessionId,
  clientNonce,
  serverNonce,
  ephemeralSecret,
}: {
  rootSecret: string;
  sessionId: string;
  clientNonce: string;
  serverNonce: string;
  ephemeralSecret: Uint8Array;
}): {sessionId: string; clientToDesktopKey: Uint8Array; desktopToClientKey: Uint8Array} {
  const safeSessionId = normalizeIdentifier(sessionId, 'sessionId', {
    minLength: 16,
    maxLength: 128,
  });
  const clientNonceBytes = decodeBase64Url(clientNonce, 'clientNonce', {
    minBytes: 16,
    maxBytes: 64,
  });
  const serverNonceBytes = decodeBase64Url(serverNonce, 'serverNonce', {
    minBytes: 16,
    maxBytes: 64,
  });
  const root = normalizeRootSecret(rootSecret);
  if (ephemeralSecret.length !== 32) {
    throw remoteError('remote_ecdh_failed');
  }
  const material = hkdfSha256({
    ikm: concatBytes(root, ephemeralSecret),
    salt: sha256Bytes(concatBytes(clientNonceBytes, serverNonceBytes)),
    info: canonicalBytes({
      v: REMOTE_PROTOCOL_VERSION,
      label: SESSION_LABEL,
      sessionId: safeSessionId,
    }),
    length: AES_KEY_BYTES * 2,
  });
  root.fill(0);
  const clientToDesktopKey = material.slice(0, AES_KEY_BYTES);
  const desktopToClientKey = material.slice(
    AES_KEY_BYTES,
    AES_KEY_BYTES * 2,
  );
  material.fill(0);
  return {
    sessionId: safeSessionId,
    clientToDesktopKey,
    desktopToClientKey,
  };
}

export function completeSessionHello({
  state,
  accept,
  expectedDeviceId,
  expectedDesktopId,
}: {
  state: SessionHelloState;
  accept: SessionAccept | Record<string, unknown>;
  expectedDeviceId?: string;
  expectedDesktopId?: string;
}): RemoteCryptoSession {
  if (
    !accept ||
    accept.type !== 'remote.session.accept' ||
    Number(accept.v) !== REMOTE_PROTOCOL_VERSION
  ) {
    throw remoteError('remote_session_accept_invalid');
  }
  const deviceId = normalizeIdentifier(state?.deviceId, 'deviceId', {
    minLength: 16,
    maxLength: 160,
  });
  const desktopId = normalizeIdentifier(state?.desktopId, 'desktopId', {
    minLength: 16,
    maxLength: 160,
  });
  if (expectedDeviceId && deviceId !== expectedDeviceId) {
    throw remoteError('remote_device_mismatch');
  }
  if (expectedDesktopId && desktopId !== expectedDesktopId) {
    throw remoteError('remote_desktop_mismatch');
  }

  const sessionId = normalizeIdentifier(accept.sessionId, 'sessionId', {
    minLength: 16,
    maxLength: 128,
  });
  const serverNonce = typeof accept.serverNonce === 'string' ? accept.serverNonce : '';
  const serverEphemeralPublicKey =
    typeof accept.serverEphemeralPublicKey === 'string'
      ? accept.serverEphemeralPublicKey
      : '';
  const ackPayload = createSessionAcceptProofPayload({
    deviceId,
    desktopId,
    sessionId,
    clientNonce: state.clientNonce,
    serverNonce,
    clientEphemeralPublicKey: state.clientEphemeralPublicKey,
    serverEphemeralPublicKey,
  });
  const root = normalizeRootSecret(state.rootSecret);
  const expectedProof = encodeBase64Url(hmacSha256(root, ackPayload));
  root.fill(0);
  ackPayload.fill(0);
  if (!timingSafeEqualBase64Url(expectedProof, accept.proof)) {
    throw remoteError('remote_session_proof_invalid');
  }

  const ephemeralSecret = deriveSharedSecret(
    state.clientEphemeralPrivateKey,
    serverEphemeralPublicKey,
  );
  const material = deriveSessionMaterial({
    rootSecret: state.rootSecret,
    sessionId,
    clientNonce: state.clientNonce,
    serverNonce,
    ephemeralSecret,
  });
  ephemeralSecret.fill(0);
  return createRemoteCryptoSession({
    sessionId,
    sendKey: material.clientToDesktopKey,
    receiveKey: material.desktopToClientKey,
    sendDirection: 'client-to-desktop',
    receiveDirection: 'desktop-to-client',
  });
}

export function createRemoteCryptoSession({
  sessionId,
  sendKey,
  receiveKey,
  sendDirection,
  receiveDirection,
}: {
  sessionId: string;
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
  sendDirection: RemoteDirection;
  receiveDirection: RemoteDirection;
}): RemoteCryptoSession {
  const safeSessionId = normalizeIdentifier(sessionId, 'sessionId', {
    minLength: 16,
    maxLength: 128,
  });
  if (
    sendKey.length !== AES_KEY_BYTES ||
    receiveKey.length !== AES_KEY_BYTES
  ) {
    throw remoteError('remote_session_key_invalid');
  }
  const ownedSendKey = sendKey.slice();
  const ownedReceiveKey = receiveKey.slice();
  sendKey.fill(0);
  receiveKey.fill(0);
  let nextSendSequence = 1;
  let nextReceiveSequence = 1;
  let closed = false;

  const assertOpen = () => {
    if (closed) {
      throw remoteError('remote_session_closed');
    }
  };

  return {
    get sessionId() {
      return safeSessionId;
    },
    get expectedReceiveSequence() {
      return nextReceiveSequence;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      ownedSendKey.fill(0);
      ownedReceiveKey.fill(0);
    },
    encrypt(payload, nonce) {
      assertOpen();
      const sequence = nextSendSequence;
      const plaintext = canonicalBytes(payload);
      if (plaintext.length > REMOTE_MAX_FRAME_BYTES) {
        plaintext.fill(0);
        throw remoteError('remote_payload_size_invalid');
      }
      const aad = buildFrameAad({
        sessionId: safeSessionId,
        sequence,
        direction: sendDirection,
      });
      try {
        const encrypted = encryptAead({
          key: ownedSendKey,
          plaintext,
          aad,
          nonce,
        });
        const frame: EncryptedFrame = {
          v: REMOTE_PROTOCOL_VERSION,
          type: 'remote.encrypted',
          sessionId: safeSessionId,
          sequence,
          ...encrypted,
        };
        // The envelope fields are ASCII (Base64URL/identifiers/numbers), so
        // string length is its UTF-8 byte length without allocating another copy.
        if (JSON.stringify(frame).length > REMOTE_MAX_FRAME_BYTES) throw remoteError('remote_payload_size_invalid');
        nextSendSequence += 1;
        return frame;
      } finally {
        plaintext.fill(0);
        aad.fill(0);
      }
    },
    decrypt(frame) {
      assertOpen();
      if (
        !frame ||
        frame.type !== 'remote.encrypted' ||
        Number(frame.v) !== REMOTE_PROTOCOL_VERSION
      ) {
        throw remoteError('remote_frame_invalid');
      }
      const frameSessionId = normalizeIdentifier(frame.sessionId, 'sessionId', {
        minLength: 16,
        maxLength: 128,
      });
      if (frameSessionId !== safeSessionId) {
        throw remoteError('remote_session_mismatch');
      }
      const sequence = normalizeSequence(frame.sequence);
      if (sequence !== nextReceiveSequence) {
        throw remoteError(
          sequence < nextReceiveSequence
            ? 'remote_frame_replayed'
            : 'remote_frame_out_of_order',
        );
      }
      const aad = buildFrameAad({
        sessionId: safeSessionId,
        sequence,
        direction: receiveDirection,
      });
      const plaintext = decryptAead({
        key: ownedReceiveKey,
        nonce: typeof frame.nonce === 'string' ? frame.nonce : '',
        ciphertext: typeof frame.ciphertext === 'string' ? frame.ciphertext : '',
        tag: typeof frame.tag === 'string' ? frame.tag : '',
        aad,
        maxCiphertextBytes: REMOTE_MAX_FRAME_BYTES,
      });
      try {
        const payload = parseJsonBytes(plaintext, {
          maxBytes: REMOTE_MAX_FRAME_BYTES,
          code: 'remote_frame_payload_invalid',
        });
        nextReceiveSequence += 1;
        return payload;
      } finally {
        aad.fill(0);
        plaintext.fill(0);
      }
    },
  };
}

// Desktop-side synthetic helper used only by fixed interoperability tests.
export function createSessionAcceptForFixture({
  rootSecret,
  hello,
  serverEphemeralKeyPair,
  sessionId,
  serverNonce,
}: {
  rootSecret: string;
  hello: SessionHello;
  serverEphemeralKeyPair: P256KeyPair;
  sessionId: string;
  serverNonce: string;
}): {accept: SessionAccept; session: RemoteCryptoSession} {
  const helloPayload = createSessionHelloProofPayload(hello);
  const root = normalizeRootSecret(rootSecret);
  const expectedHelloProof = encodeBase64Url(hmacSha256(root, helloPayload));
  if (!timingSafeEqualBase64Url(expectedHelloProof, hello.proof)) {
    root.fill(0);
    helloPayload.fill(0);
    throw remoteError('remote_session_proof_invalid');
  }
  const acceptPayload = createSessionAcceptProofPayload({
    deviceId: hello.deviceId,
    desktopId: hello.desktopId,
    sessionId,
    clientNonce: hello.clientNonce,
    serverNonce,
    clientEphemeralPublicKey: hello.clientEphemeralPublicKey,
    serverEphemeralPublicKey: serverEphemeralKeyPair.publicKey,
  });
  const proof = encodeBase64Url(hmacSha256(root, acceptPayload));
  root.fill(0);
  helloPayload.fill(0);
  acceptPayload.fill(0);
  const ephemeralSecret = deriveSharedSecret(
    serverEphemeralKeyPair.privateKey,
    hello.clientEphemeralPublicKey,
  );
  const material = deriveSessionMaterial({
    rootSecret,
    sessionId,
    clientNonce: hello.clientNonce,
    serverNonce,
    ephemeralSecret,
  });
  ephemeralSecret.fill(0);
  return {
    accept: {
      type: 'remote.session.accept',
      v: REMOTE_PROTOCOL_VERSION,
      sessionId,
      serverNonce,
      serverEphemeralPublicKey: serverEphemeralKeyPair.publicKey,
      proof,
    },
    session: createRemoteCryptoSession({
      sessionId,
      sendKey: material.desktopToClientKey,
      receiveKey: material.clientToDesktopKey,
      sendDirection: 'desktop-to-client',
      receiveDirection: 'client-to-desktop',
    }),
  };
}
