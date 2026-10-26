/* Isolated contract integration. Uses only Desktop's synthetic test fixtures,
 * never the installed app or user data. Requires a Desktop source checkout. */
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');

const mobileRoot = path.resolve(__dirname, '..');
const desktopRoot = path.resolve(process.argv[2] || path.join(mobileRoot, '..', 'Anywhere_desktop'));
const output = path.join(mobileRoot, 'build', 'remote-v2-check', 'desktop-mobile-interop.mjs');
const testFile = path.join(desktopRoot, 'tests', 'remote-gateway.test.mjs');
const desktopRequire = createRequire(path.join(desktopRoot, 'package.json'));
let source = fs.readFileSync(testFile, 'utf8').replace(/\r\n/g, '\n');
const helperImport = /import \{([\s\S]*?)\} from '\.\.\/main\/core\/remote\/cryptoSession\.js'/;
// Restrict the replacement to the crypto helper import, not preceding imports.
const cryptoStart = source.indexOf('import {\n  completeDevicePairing,');
const cryptoEnd = source.indexOf("} from '../main/core/remote/cryptoSession.js'", cryptoStart);
if (cryptoStart < 0 || cryptoEnd < 0 || !helperImport.test(source)) throw new Error('Desktop crypto contract import changed');
source = source.slice(0, cryptoStart) + `
const mobileRequire = createRequire(${JSON.stringify(path.join(mobileRoot, 'package.json'))});
const babel = mobileRequire('@babel/core');
const Module = mobileRequire('node:module');
const tsHandler = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  if (!filename.startsWith(${JSON.stringify(path.join(mobileRoot, 'src', 'remote') + path.sep)})) {
    if (tsHandler) return tsHandler(module, filename);
    throw new Error('Unexpected TS dependency');
  }
  const result = babel.transformSync(mobileRequire('node:fs').readFileSync(filename, 'utf8'), {
    filename, cwd: ${JSON.stringify(mobileRoot)},
    configFile: ${JSON.stringify(path.join(mobileRoot, 'babel.config.js'))},
  });
  module._compile(result.code, filename);
};
const {createP256KeyPair} = mobileRequire('./src/remote/crypto.ts');
const {completeDevicePairing, createPairingStartEnvelope} = mobileRequire('./src/remote/pairing.ts');
const {completeSessionHello, createSessionHello} = mobileRequire('./src/remote/session.ts');
const {createResultTransferReader} = mobileRequire('./src/remote/resultTransfer.ts');

const {uploadAttachment} = mobileRequire('./src/remote/attachments.ts');
` + source.slice(cryptoEnd + "} from '../main/core/remote/cryptoSession.js'".length);
source = source.replace(/from '\.\.\/main\/([^']+)'/g, (_, relative) =>
  `from '${pathToFileURL(path.join(desktopRoot, 'main', relative)).href}'`);
source = source.replace("import { WebSocket } from 'ws'", `import WebSocket from '${pathToFileURL(desktopRequire.resolve('ws')).href}'`);
source = "import {createRequire} from 'node:module'\n" + source;
source = source.replace(/\/\/ RESULT_TRANSFER_READER_START[\s\S]*?\/\/ RESULT_TRANSFER_READER_END/, `async function readTransferredResult(connection, ref) {
  let cleanup;
  const reader = createResultTransferReader((method, params) => {
    const response = sendEncryptedRequest({...connection, requestId: 'interop-transfer-' + Date.now() + '-' + Math.random().toString(36).slice(2), method, params}).then(message => {
      if (!message.ok) throw Object.assign(new Error(message.error.code), {code: message.error.code});
      return message.result;
    });
    if (method === 'remote.transfer.release') cleanup = response;
    return response;
  }, ref.adaptive === true);
  const result = await reader.read(ref);
  await cleanup;
  return result;
}`);

const uploadAnchor = '    const eightMiB = 8 * 1024 * 1024';
if (!source.includes(uploadAnchor)) throw new Error('Desktop adaptive fixture anchor changed');
source = source.replace(uploadAnchor, `
    const uploadBytes = Buffer.alloc(10 * 1024 * 1024 + 17, 0x51);
    const uploadSha = crypto.createHash('sha256').update(uploadBytes).digest('base64url');
    let uploadOutstanding = 0, uploadPeak = 0, uploadReadOffset = 0;
    const uploadLengths = [];
    const mobileUpload = await uploadAttachment({desktopId: 'desktop-interop-upload-fixture',
      request: async (_desktopId, method, params) => {
        uploadOutstanding++;uploadPeak = Math.max(uploadPeak, uploadOutstanding);
        try {
          const response = await sendEncryptedRequest({socket, session, requestId: 'interop-upload-' + crypto.randomUUID(), method, params});
          if (!response.ok) throw Object.assign(new Error(response.error.code), {code: response.error.code});
          return response.result;
        } finally {uploadOutstanding--;}
      },
      source: {name: 'synthetic-sequential.jpg', type: 'image/jpeg', size: uploadBytes.length,
        hash: async () => uploadSha,
        read: async () => {throw new Error('native Base64 source expected');},
        readBase64: async (offset, length) => {
          assert.equal(uploadOutstanding, 0, 'no next read until the actual encrypted ACK');
          assert.equal(offset, uploadReadOffset);uploadReadOffset += length;uploadLengths.push(length);
          return uploadBytes.subarray(offset, offset + length).toString('base64');
        }}
    });
    assert.equal(mobileUpload.state, 'completed');assert.equal(mobileUpload.sha256, uploadSha);
    assert.equal(mobileUpload.receivedBytes, uploadBytes.length);assert.equal(uploadPeak, 1);
    assert.equal(uploadLengths[0], 512 * 1024);assert.equal(uploadReadOffset, uploadBytes.length);
    assert.ok(uploadLengths.every(length => length <= 8 * 1024 * 1024));
    assert.equal((await sendEncryptedRequest({socket, session, requestId: 'interop-upload-abort-' + crypto.randomUUID(), method: 'attachment.abort', params: {uploadId: mobileUpload.uploadId}})).ok, true);
    console.log(JSON.stringify({ok: true, suite: 'sequential-mobile-upload-wss', bytes: uploadBytes.length, peakInFlight: uploadPeak, chunkBytes: uploadLengths}));
` + uploadAnchor);


source = source.replace("suite: 'remote-gateway'", "suite: 'desktop-mobile-interop'");
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, source);
const result = spawnSync(process.execPath, [output], {
  cwd: mobileRoot, stdio: 'inherit', timeout: 180000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
