import {pairDesktop} from '../src/remote/pairingClient';
import {PinnedGateway} from '../src/native/PinnedGateway';
import {saveDesktopCredential} from '../src/services/secureStore';
import {parsePairingPayload} from '../src/domain/pairing';
import {completeDevicePairing} from '../src/remote/pairing';

jest.mock('../src/native/PinnedGateway', () => ({PinnedGateway: {postJson: jest.fn()}}));
jest.mock('../src/services/secureStore', () => ({
  loadOrCreateDeviceIdentity: jest.fn(async () => ({deviceId: 'device-lan-fixture-0001', publicKey: 'synthetic-device-key', privateKey: 'synthetic-private'})),
  saveDesktopCredential: jest.fn(async () => {}),
}));
jest.mock('../src/remote/pairing', () => ({
  startDevicePairing: jest.fn(() => ({envelope: {type: 'synthetic-encrypted-start'}, clientEphemeralKeyPair: {privateKey: 'synthetic-ephemeral'}})),
  completeDevicePairing: jest.fn(() => ({rootSecret: 'synthetic-secret', deviceProof: 'synthetic-proof'})),
  createPairingConfirmRequest: jest.fn(() => ({type: 'synthetic-confirm'})),
}));
const primary = 'https://192.168.56.1:17860';
const lan = 'https://192.168.77.17:17860';
const tunnel = 'https://synthetic.example.test';
function payload(endpoints = [primary, lan]) {
  return parsePairingPayload(JSON.stringify({v: 2, d: 'desktop-lan-fixture-0001', n: 'Synthetic', e: primary, endpoints,
    i: 'pairing-lan-fixture-0001', c: 'cGFpcmluZy1jaGFsbGVuZ2UtdmVjdG9y', f: 'AA'.repeat(32),
    k: 'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
    x: new Date(Date.now() + 120000).toISOString()}));
}
const info = {displayName: 'Synthetic phone', platform: 'android', deviceModel: 'fixture', appVersion: 'test'};
const http = (value: object, status = 200) => ({status, body: JSON.stringify(value)});
function response(stage: 'start' | 'confirm', override = {}) {
  const p = payload();
  return http({ok: true, v: 2, desktopId: p.desktopId, desktopName: p.desktopName,
    desktopIdentityPublicKey: p.desktopIdentityPublicKey, certificateFingerprint: p.certificateFingerprint,
    ...(stage === 'start' ? {pairingAttemptId: 'attempt-fixture', serverEphemeralPublicKey: 'fixture', desktopProof: 'fixture', transcriptHash: 'fixture', expiresAt: p.expiresAt}
      : {device: {deviceId: 'device-lan-fixture-0001'}}), ...override});
}
const post = jest.mocked(PinnedGateway.postJson);
const unreachable = () => Object.assign(new Error('failed to connect to /192.168.56.1 (port 17860) after 12000ms'), {code: 'HTTPS_REQUEST_FAILED'});
beforeEach(() => {jest.clearAllMocks(); jest.mocked(completeDevicePairing).mockImplementation(() => ({rootSecret: 'synthetic-secret', deviceProof: 'synthetic-proof', transcriptHash: 'fixture'}));});

it('falls back from unreachable first QR address, confirms and persists only on the selected LAN address', async () => {
  post.mockRejectedValueOnce(unreachable()).mockResolvedValueOnce(response('start')).mockResolvedValueOnce(response('confirm'));
  const desktop = await pairDesktop({payload: payload(), pairingCode: '123456', deviceInfo: info});
  expect(post.mock.calls.map(([options]) => options.endpoint)).toEqual([primary, lan, lan]);
  expect(post.mock.calls.every(([options]) => options.tlsMode === 'pinned')).toBe(true);
  expect(desktop).toMatchObject({endpoint: lan, tlsMode: 'pinned', endpoints: [primary, lan]});
  expect(saveDesktopCredential).toHaveBeenCalledTimes(1);
});
it('uses system TLS when the next QR-provided candidate is a public tunnel', async () => {
  post.mockRejectedValueOnce(unreachable()).mockResolvedValueOnce(response('start')).mockResolvedValueOnce(response('confirm'));
  const desktop = await pairDesktop({payload: payload([primary, tunnel]), pairingCode: '123456', deviceInfo: info});
  expect(desktop).toMatchObject({endpoint: tunnel, tlsMode: 'system'});
  expect(post.mock.calls[1][0]).toMatchObject({tlsMode: 'system', endpoint: tunnel});
  expect(post.mock.calls[1][0]).not.toHaveProperty('certificateFingerprint');
});
it.each(['Certificate pin mismatch', 'SSL handshake failed', 'Hostname not verified', '证书错误', 'unknown error'])('does not rotate peers for security or unknown failure: %s', async message => {
  post.mockRejectedValueOnce(Object.assign(new Error(message), {code: 'HTTPS_REQUEST_FAILED'}));
  await expect(pairDesktop({payload: payload(), pairingCode: '123456', deviceInfo: info})).rejects.toThrow(message);
  expect(post).toHaveBeenCalledTimes(1);expect(saveDesktopCredential).not.toHaveBeenCalled();
});
it.each([http({ok: false, error: 'remote_pairing_code_invalid'}, 403), response('start', {desktopId: 'foreign-desktop'}), {status: 200, body: 'not-json'}])('does not rotate after HTTP error or invalid desktop response', async reply => {
  post.mockResolvedValueOnce(reply);
  await expect(pairDesktop({payload: payload(), pairingCode: '123456', deviceInfo: info})).rejects.toThrow();
  expect(post).toHaveBeenCalledTimes(1);expect(saveDesktopCredential).not.toHaveBeenCalled();
});
it('does not rotate after cryptographic proof rejection', async () => {
  post.mockResolvedValueOnce(response('start'));
  jest.mocked(completeDevicePairing).mockImplementationOnce(() => {throw new Error('remote_pairing_proof_invalid');});
  await expect(pairDesktop({payload: payload(), pairingCode: '123456', deviceInfo: info})).rejects.toThrow('proof_invalid');
  expect(post).toHaveBeenCalledTimes(1);expect(saveDesktopCredential).not.toHaveBeenCalled();
});
it('does not retry confirm on a different endpoint or save uncertain credentials', async () => {
  post.mockResolvedValueOnce(response('start')).mockRejectedValueOnce(unreachable());
  await expect(pairDesktop({payload: payload(), pairingCode: '123456', deviceInfo: info})).rejects.toThrow('failed to connect');
  expect(post.mock.calls.map(([options]) => options.endpoint)).toEqual([primary, primary]);
  expect(saveDesktopCredential).not.toHaveBeenCalled();
});
it('exhausts only QR-known endpoints on unreachable failures, without network discovery', async () => {
  post.mockRejectedValue(unreachable());
  await expect(pairDesktop({payload: payload(), pairingCode: '123456', deviceInfo: info})).rejects.toThrow();
  expect(post.mock.calls.map(([options]) => options.endpoint)).toEqual([primary, lan]);
  expect(saveDesktopCredential).not.toHaveBeenCalled();
});
