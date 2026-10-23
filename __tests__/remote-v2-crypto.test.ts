import {
  createPairingStartEnvelope,
  completeDevicePairing,
  openPairingStartForFixture,
  PairingContext,
  PairingStartEnvelope,
  RemoteDeviceIdentity,
} from '../src/remote/pairing';
import {
  completeSessionHello,
  createRemoteCryptoSession,
  createSessionHello,
  EncryptedFrame,
  SessionAccept,
} from '../src/remote/session';
import {
  decodeBase64Url,
  REMOTE_MAX_FRAME_BYTES,
  RemoteProtocolError,
  stableStringify,
} from '../src/remote/protocol';

import {utf8ToBytes} from '../src/remote/utf8';


const privateKeys = {
  desktop: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
  device: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI',
  clientPair: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM',
  clientSession: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAU',
};

const publicKeys = {
  desktop:
    'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
  device:
    'BHzyexiNA09-ilI4AwS1GsPAiWnid_IbNaYLSPxHZpl4B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E',
  serverPair:
    'BOJTSjUy0I-7oC3eZZ7mK9ADH-LbeFWW71CTAkRrAwhS4PFXWkxjPMcZ3-5f2oYtdk78lsPzDuAFXELCPxhO2MY',
};

const context: PairingContext = {
  pairingId: 'pairing-remote-v2-vector-0001',
  pairingChallenge: 'cGFpcmluZy1jaGFsbGVuZ2UtdmVjdG9y',
  desktopId: 'desktop-remote-v2-vector-0001',
};

const device: RemoteDeviceIdentity = {
  deviceId: 'device-remote-v2-vector-0001',
  displayName: 'Vector Phone',
  platform: 'android',
  appVersion: '0.0.1',
  publicKey: publicKeys.device,
};

const pairingStartVector: PairingStartEnvelope = {
  v: 2,
  type: 'remote.pair.start',
  pairingId: context.pairingId,
  clientEphemeralPublicKey:
    'BF7L5NGmMwpEyPfvlR1L8WXmxrch762phftBZhvG5_1shzRkDEmY_343SwbOGmSi7NgqsDY4T7g9mnmxJ6J9UDI',
  nonce: 'AAECAwQFBgcICQoL',
  ciphertext:
    'wdaOmdGih-obJNoe_gEr1u1VYpJCRPE7feL7c9Bo-U3aAkGqq39AcLIh2vGWZ81bdOn1TM9_Rx4UH2e1dCp9s7ehsH0seGWIqzP9NHV_Uz--zjaFdlVQJCIknycQErkX1seEGfSqqVYfcMztyMGQ9czN7dvVwT5R6Z6XSOyOsA09qyPB_4E1SZ-ixjiaeYyATXvzjxPYn-Me8IANzA5OFlOh7K6wh2iyQVk3re2ZVWAc-kEdsUdMQL7rV9He-usPZWS-AsIFWcNL4FA-sNiv9ZksCgxACHIeMnzXgSHPTpaAugtlwIkal97yzVaDYAaGVf9Eq8ybgb-z5fRayd1H0_mgkWCPfgI1Ohri3J_TXRD_Plj5bQKHwS-3xIjs716n6buEHb1SiZm7hc5Ja57hGQ',
  tag: 'Xc87Ore18gMSqSPrPzLZGg',
};

const pairingVector = {
  rootSecret: 'SOghSkbcVLCILfjCzuhOxLN88lVic_L4qw_EwhQn9zY',
  transcriptHash: '7EkHQNdz1wiJEWV91pSrkhOHfHzFkh9hSHGDWfjav9o',
  desktopProof: 'Sgs2BI1i8687ZeuyZ7qj4-siZGk-sbC6nxNm62QCR8k',
  deviceProof: 'BJgzL1QhIU4QiEasHs1HvVyBU1681L-fTkHRRn8VdwY',
};

const clientNonce = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const sessionAccept: SessionAccept = {
  type: 'remote.session.accept',
  v: 2,
  sessionId: 'session-remote-v2-vector-0001',
  serverNonce: 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8',
  serverEphemeralPublicKey:
    'BLAaFyp2pGAsktMkLLiX3eMCTHQN67IVtMawquk8IpGp6FwQdDI32tVv7A4t-6cDeRwA93Acfha9_XxIU4_Hf-I',
  proof: 'rjPjLW_qA5mcezrYJlY65kGnAHU4b-9BjzlMfohEzxQ',
};

const c2dPayload = {
  kind: 'request',
  method: 'remote.status.get',
  params: {includeDevices: true},
  requestId: 'request-remote-v2-vector-0001',
};
const c2dFrame: EncryptedFrame = {
  v: 2,
  type: 'remote.encrypted',
  sessionId: sessionAccept.sessionId,
  sequence: 1,
  nonce: 'YGFiY2RlZmdoaWpr',
  ciphertext:
    'lyifoIu7rD0aTpiXmujXWULrae4Xe5uDbSHVtNssBLJCFX3GZedWRuju6ubWXVkC_huxUgAQ8sJUdMjz04SpCx_x0Jirei-88m0eXtdxhM0DatCyBH0Hun62ZpvpbcW9LAW2396mBe9VLHM2eKJZc_7KknYhyx9FwOsYFw',
  tag: 'FAmjuMzDcuEFD2n-ZshFIQ',
};
const d2cPayload = {
  kind: 'response',
  ok: true,
  result: {running: true},
};
const d2cFrame: EncryptedFrame = {
  v: 2,
  type: 'remote.encrypted',
  sessionId: sessionAccept.sessionId,
  sequence: 1,
  nonce: 'cHFyc3R1dnd4eXp7',
  ciphertext: 'z73B5tjvraQFL9ai35dAGvwmMZDqUszrvaDjE3kCQfgtFFhOZG40Byd408QMgiQXL1aq6FsQHQ',
  tag: 'FO0uLichRXA1u3RSSglBvg',
};

function expectCode(callback: () => unknown, code: string) {
  expect(callback).toThrow(expect.objectContaining({code}));
}

describe('Remote v2 Desktop interoperability vectors', () => {

  it('encodes Unicode independently of TextEncoder, including isolated surrogates', () => {
    expect(Array.from(utf8ToBytes('中😀\ud800'))).toEqual([
      228, 184, 173, 240, 159, 152, 128, 239, 191, 189,
    ]);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
    try {
      Object.defineProperty(globalThis, 'TextEncoder', {configurable: true, value: undefined});
      jest.isolateModules(() => {
        const crypto = require('../src/remote/crypto') as typeof import('../src/remote/crypto');
        expect(decodeBase64Url(crypto.createP256KeyPair().publicKey)).toHaveLength(65);
      });
    } finally {
      if (original) Object.defineProperty(globalThis, 'TextEncoder', original);
    }
  });

  it('generates 32-byte private scalars and 65-byte uncompressed public keys', () => {
    const {createP256KeyPair} = require('../src/remote/crypto') as typeof import('../src/remote/crypto');
    const pair = createP256KeyPair();
    expect(decodeBase64Url(pair.privateKey)).toHaveLength(32);
    const publicKey = decodeBase64Url(pair.publicKey);
    expect(publicKey).toHaveLength(65);
    expect(publicKey[0]).toBe(0x04);
  });
  it('matches Desktop canonical JSON and strict Base64URL rules', () => {
    expect(stableStringify({z: 1, a: {y: true, x: '中文'}, skip: undefined})).toBe(
      '{"a":{"x":"中文","y":true},"z":1}',
    );
    expect(() => decodeBase64Url('AQ==')).toThrow(RemoteProtocolError);
    expect(() => decodeBase64Url('AB')).toThrow(RemoteProtocolError);
    expect(decodeBase64Url('AQ')).toEqual(new Uint8Array([1]));
  });

  it('produces the exact Desktop Node crypto pairing-start envelope', () => {
    const envelope = createPairingStartEnvelope({
      desktopPublicKey: publicKeys.desktop,
      clientEphemeralPrivateKey: privateKeys.clientPair,
      context,
      pairingCode: '123 456',
      device,
      nonce: Uint8Array.from({length: 12}, (_, index) => index),
    });
    expect(envelope).toEqual(pairingStartVector);
    expect(JSON.stringify(envelope)).not.toContain('123456');
    expect(
      openPairingStartForFixture({
        desktopPrivateKey: privateKeys.desktop,
        desktopPublicKey: publicKeys.desktop,
        context,
        input: envelope,
      }),
    ).toEqual({
      pairingCode: '123456',
      pairingChallenge: context.pairingChallenge,
      device,
    });
  });

  it('derives the exact Desktop root secret and ownership proof', () => {
    expect(
      completeDevicePairing({
        devicePrivateKey: privateKeys.device,
        desktopPublicKey: publicKeys.desktop,
        serverEphemeralPublicKey: publicKeys.serverPair,
        clientEphemeralPrivateKey: privateKeys.clientPair,
        devicePublicKey: publicKeys.device,
        context,
        desktopProof: pairingVector.desktopProof,
        expectedTranscriptHash: pairingVector.transcriptHash,
      }),
    ).toEqual({
      rootSecret: pairingVector.rootSecret,
      transcriptHash: pairingVector.transcriptHash,
      deviceProof: pairingVector.deviceProof,
    });
  });

  it('matches hello/accept proofs and both Desktop frame directions', () => {
    const handshake = createSessionHello({
      rootSecret: pairingVector.rootSecret,
      deviceId: device.deviceId,
      desktopId: context.desktopId,
      ephemeralKeyPair: {
        privateKey: privateKeys.clientSession,
        publicKey:
          'BFFZC3pRUUDS14TIVghmj9_vjIL9H1vlJCFVSg3D0DPt4MF9qJBKcn2K4b82v4p5Jg0BLwDU2AiI0dC7RP2hbaQ',
      },
      clientNonce,
    });
    expect(handshake.hello).toEqual({
      type: 'remote.session.hello',
      v: 2,
      deviceId: device.deviceId,
      desktopId: context.desktopId,
      clientNonce,
      clientEphemeralPublicKey: handshake.state.clientEphemeralPublicKey,
      proof: 'r0o0a9fh94C5RVMLhYZlYnhC5gwO7My8I8ORZoToiwM',
    });

    const mobile = completeSessionHello({
      state: handshake.state,
      accept: sessionAccept,
      expectedDeviceId: device.deviceId,
      expectedDesktopId: context.desktopId,
    });
    expect(mobile.encrypt(c2dPayload, decodeBase64Url(c2dFrame.nonce))).toEqual(c2dFrame);
    expect(mobile.decrypt(d2cFrame)).toEqual(d2cPayload);
    expectCode(() => mobile.decrypt(d2cFrame), 'remote_frame_replayed');
    mobile.close();
    expectCode(() => mobile.encrypt({kind: 'request'}), 'remote_session_closed');
  });

  it('rejects wrong Desktop proofs, changed transcripts and invalid session frames', () => {
    const pairingArgs = {
      devicePrivateKey: privateKeys.device,
      desktopPublicKey: publicKeys.desktop,
      serverEphemeralPublicKey: publicKeys.serverPair,
      clientEphemeralPrivateKey: privateKeys.clientPair,
      devicePublicKey: publicKeys.device,
      context,
      desktopProof: pairingVector.desktopProof,
    };
    expectCode(() => completeDevicePairing({
      ...pairingArgs, desktopProof: 'AA'.repeat(22),
    }), 'remote_pairing_proof_invalid');
    expectCode(() => completeDevicePairing({
      ...pairingArgs, expectedTranscriptHash: 'AA'.repeat(22),
    }), 'remote_pairing_transcript_invalid');
    const state = createSessionHello({
      rootSecret: pairingVector.rootSecret,
      deviceId: device.deviceId,
      desktopId: context.desktopId,
      ephemeralKeyPair: {
        privateKey: privateKeys.clientSession,
        publicKey: 'BFFZC3pRUUDS14TIVghmj9_vjIL9H1vlJCFVSg3D0DPt4MF9qJBKcn2K4b82v4p5Jg0BLwDU2AiI0dC7RP2hbaQ',
      },
      clientNonce,
    }).state;
    expectCode(() => completeSessionHello({
      state, accept: {...sessionAccept, proof: 'AA'.repeat(22)},
    }), 'remote_session_proof_invalid');
    const session = completeSessionHello({state, accept: sessionAccept});
    expectCode(() => session.decrypt({...d2cFrame, sequence: 2}), 'remote_frame_out_of_order');
    expectCode(() => session.decrypt({
      ...d2cFrame, sessionId: 'session-another-fixture-0001',
    }), 'remote_session_mismatch');
    expectCode(() => session.decrypt({...d2cFrame, tag: 'AAAAAAAAAAAAAAAAAAAAAA'}), 'remote_frame_auth_failed');
    expect(session.expectedReceiveSequence).toBe(1);
    expect(session.decrypt(d2cFrame)).toEqual(d2cPayload);
    session.close();
  });


  it('does not consume a send sequence for an oversized payload', () => {
    const sendKey = new Uint8Array(32).fill(1);
    const receiveKey = new Uint8Array(32).fill(2);
    const session = createRemoteCryptoSession({
      sessionId: 'session-sequence-vector-0001',
      sendKey,
      receiveKey,
      sendDirection: 'client-to-desktop',
      receiveDirection: 'desktop-to-client',
    });
    expectCode(
      () => session.encrypt({content: 'x'.repeat(REMOTE_MAX_FRAME_BYTES + 1)}),
      'remote_payload_size_invalid',
    );
    // Plaintext fits but its Base64 ciphertext envelope exceeds 1 MiB.
    expectCode(() => session.encrypt({data: 'a'.repeat(REMOTE_MAX_FRAME_BYTES * 3 / 4)}), 'remote_payload_size_invalid');

    expect(session.encrypt({kind: 'request'}).sequence).toBe(1);

    session.enableAdaptiveTransfers();
    expectCode(() => session.encrypt({content: 'x'.repeat(16 * 1024 * 1024 + 1)}), 'remote_payload_size_invalid');
    expectCode(() => session.encrypt({data: 'a'.repeat(12 * 1024 * 1024)}), 'remote_payload_size_invalid');
    expect(session.encrypt({kind: 'request'}).sequence).toBe(2);

  });
});
