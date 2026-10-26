/* Real local TLS + Desktop pairing protocol using only synthetic identities.
 * No installed app, real pairing QR, Keychain or user data is accessed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const Module = require('node:module');
const mobileRoot = path.resolve(__dirname, '..');
const desktopRoot = path.resolve(process.argv[2] || path.join(mobileRoot, '..', 'Anywhere_desktop'));
const babel = require('@babel/core');
const extension = Module._extensions['.ts'];
Module._extensions['.ts'] = (mod, filename) => {
  if (!filename.startsWith(path.join(mobileRoot, 'src') + path.sep)) {
    if (extension) return extension(mod, filename);
    throw new Error('Unexpected TS dependency');
  }
  const result = babel.transformSync(fs.readFileSync(filename, 'utf8'), {filename, cwd: mobileRoot, configFile: path.join(mobileRoot, 'babel.config.js')});
  mod._compile(result.code, filename);
};
const mobileCrypto = require('../src/remote/crypto.ts');
const syntheticIdentity = {...mobileCrypto.createP256KeyPair(), deviceId: 'device-pairing-fallback-fixture'};
let saved = null;
let fixtureCa;
const attempts = [];
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (parent?.filename === path.join(mobileRoot, 'src/remote/pairingClient.ts')) {
    if (name === '../services/secureStore') return {
      loadOrCreateDeviceIdentity: async () => syntheticIdentity,
      saveDesktopCredential: async value => {saved = value;},
    };
    if (name === '../native/PinnedGateway') return {PinnedGateway: {postJson}};
  }
  return originalLoad.call(this, name, parent, isMain);
};
function postJson(options) {
  attempts.push({endpoint: options.endpoint, path: options.path});
  return new Promise((resolve, reject) => {
    // Trust only the ephemeral fixture's exact leaf; hostname is still checked.
    const req = https.request(new URL(options.path, options.endpoint), {
      method: 'POST', ca: fixtureCa, rejectUnauthorized: true,
      headers: {'content-type': 'application/json'},
    });
    req.on('socket', socket => socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const pin = crypto.createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
      const hostError = require('node:tls').checkServerIdentity(new URL(options.endpoint).hostname, cert);
      if (options.tlsMode !== 'pinned' || pin !== options.certificateFingerprint || hostError) req.destroy(new Error('fixture TLS identity mismatch'));
    }));
    req.on('response', response => {
      let body = '';
      response.setEncoding('utf8');response.on('data', chunk => {body += chunk;});
      response.on('end', () => resolve({status: response.statusCode, body}));
    });
    req.on('error', error => reject(Object.assign(new Error(error.code === 'ECONNREFUSED' ? 'failed to connect to synthetic first endpoint' : error.message), {code: 'HTTPS_REQUEST_FAILED'})));
    req.setTimeout(2000, () => req.destroy(new Error('connect timeout')));
    req.end(options.body);
  });
}
async function main() {
  const {createRemoteGateway} = await import(pathToFileURL(path.join(desktopRoot, 'main/core/remote/index.js')));
  const storage = new Map();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-pairing-fallback-'));
  let observed;
  const gateway = createRemoteGateway({
    app: {getName: () => 'Synthetic LAN fixture', getPath: () => tempRoot},
    safeStorage: {isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString()},
    dbStorageGetItem: async (key, fallback) => ({ok: true, value: storage.get(key) ?? fallback}),
    dbStorageSetItem: async (key, value) => {storage.set(key, value); return {ok: true};},
    getLanAddresses: () => ['127.0.0.1'], onPairingCreated: value => {observed = value;},
    logger: {log() {}, warn() {}, error() {}},
  });
  const reserve = https.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  try {
    const status = await gateway.configure({remote: {enabled: true, host: '127.0.0.1', port}});
    assert.equal(status.running, true);
    fixtureCa = JSON.parse(Buffer.from(storage.get('remote:v2:tls').encryptedPem, 'base64').toString()).cert;
    const qr = await gateway.createPairing();
    const good = `https://127.0.0.1:${port}`, bad = `https://127.0.0.2:${port}`;
    const {parsePairingPayload} = require('../src/domain/pairing.ts');
    const {pairDesktop} = require('../src/remote/pairingClient.ts');
    const payload = parsePairingPayload(JSON.stringify({...observed, endpoint: bad, endpoints: [bad, good]}));
    const desktop = await pairDesktop({payload, pairingCode: qr.pairingCode, deviceInfo: {displayName: 'Synthetic', platform: 'test', appVersion: 'test', deviceModel: 'fixture'}});
    assert.equal(desktop.endpoint, good);assert.equal(desktop.tlsMode, 'pinned');
    assert.deepEqual(attempts.map(value => value.endpoint), [bad, good, good]);
    assert.equal(saved.desktopId, desktop.id);assert.equal(typeof saved.rootSecret, 'string');
    const devices = await gateway.listDevices();
    assert.equal(devices.devices.some(device => device.deviceId === syntheticIdentity.deviceId), true);
    console.log(JSON.stringify({ok: true, suite: 'pairing-fallback-real-tls', attempts: attempts.map(value => value.path), selected: 'second QR endpoint', savedOnlyAfterConfirm: true}));
  } finally {
    await gateway.stop();Module._load = originalLoad;Module._extensions['.ts'] = extension;
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
}
main().catch(error => {console.error(error.message);process.exitCode = 1;});
