import {
  inferTlsMode,
  orderedPairedEndpoints,
  withDesktopEndpoint,
  normalizeEndpoint,
  normalizeFingerprint,
  parsePairingPayload,
  withPairingTransport,
} from '../src/domain/pairing';

const fingerprint = 'AA'.repeat(32);
const desktopPublicKey =
  'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';

function qr(overrides: Record<string, unknown> = {}) {
  return {
    v: 2,
    desktopId: 'desktop-remote-v2-fixture-0001',
    desktopName: 'Fixture Desktop',
    endpoint: 'https://192.168.1.88:17860',
    endpoints: [
      'https://desktop.example.test',
      'https://192.168.1.88:17860',
    ],
    pairingId: 'pairing-remote-v2-fixture-0001',
    pairingChallenge: 'cGFpcmluZy1jaGFsbGVuZ2UtdmVjdG9y',
    certificateFingerprint: fingerprint.toLowerCase(),
    desktopIdentityPublicKey: desktopPublicKey,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('Remote v2 pairing payload safety', () => {
  it('parses a v2 QR without accepting or requiring a pairing code', () => {
    const raw = JSON.stringify(qr({pairingCode: 'must-not-be-read'}));
    const payload = parsePairingPayload(raw);
    expect(payload).toMatchObject({
      v: 2,
      desktopId: 'desktop-remote-v2-fixture-0001',
      pairingId: 'pairing-remote-v2-fixture-0001',
      certificateFingerprint: fingerprint,
      tlsMode: 'pinned',
    });
    expect(payload).not.toHaveProperty('pairingCode');
  });

  it('parses the compact QR aliases emitted by current Desktop versions', () => {
    const source = qr();
    const compact = {
      v: source.v, d: source.desktopId, n: source.desktopName, e: source.endpoint,
      i: source.pairingId, c: source.pairingChallenge, f: source.certificateFingerprint,
      k: source.desktopIdentityPublicKey, x: source.expiresAt,
    };
    expect(parsePairingPayload(JSON.stringify(compact))).toMatchObject({
      desktopId: source.desktopId, endpoint: source.endpoint, pairingId: source.pairingId,
      desktopIdentityPublicKey: source.desktopIdentityPublicKey,
    });
  });


  it('rejects expired QR data and invalid Desktop identity keys', () => {
    expect(() =>
      parsePairingPayload(
        JSON.stringify(qr({expiresAt: '2020-01-01T00:00:00.000Z'})),
      ),
    ).toThrow('已过期');
    expect(() =>
      parsePairingPayload(
        JSON.stringify(qr({desktopIdentityPublicKey: 'invalid'})),
      ),
    ).toThrow();
  });

  it('rejects cleartext endpoints and malformed certificate fingerprints', () => {
    expect(() => normalizeEndpoint('http://192.168.1.88:17860')).toThrow(
      '只允许 HTTPS',
    );
    expect(() => normalizeFingerprint('ABCD')).toThrow('SHA-256');
  });

  it('rotates only among QR-paired endpoints and preserves endpoint TLS policy', () => {
    const payload = parsePairingPayload(JSON.stringify(qr()));
    const desktop = {
      id: payload.desktopId,
      name: payload.desktopName,
      endpoint: payload.endpoint,
      endpoints: payload.endpoints,
      certificateFingerprint: payload.certificateFingerprint,
      desktopIdentityPublicKey: payload.desktopIdentityPublicKey,
      tlsMode: payload.tlsMode,
      pairedAt: '2026-10-18T00:00:00.000Z',
    };
    expect(orderedPairedEndpoints(desktop)).toEqual([
      'https://192.168.1.88:17860',
      'https://desktop.example.test',
    ]);
    expect(withDesktopEndpoint(desktop, 'https://desktop.example.test')).toMatchObject({
      endpoint: 'https://desktop.example.test',
      tlsMode: 'system',
    });
    expect(() => withDesktopEndpoint(desktop, 'https://192.168.1.99:17860')).toThrow(
      '安全地址列表',
    );
  });


  it('defaults private LAN addresses to pinning and public endpoints to system TLS', () => {
    expect(inferTlsMode('https://192.168.1.88:17860')).toBe('pinned');
    expect(inferTlsMode('https://desktop.example.test')).toBe('system');
    const tunnel = withPairingTransport(
      parsePairingPayload(JSON.stringify(qr())),
      'https://desktop.example.test',
      'system',
    );
    expect(tunnel.endpoint).toBe('https://desktop.example.test');
    expect(tunnel.tlsMode).toBe('system');
  });
});
