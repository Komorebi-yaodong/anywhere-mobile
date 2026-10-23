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
let source = fs.readFileSync(testFile, 'utf8');
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

source = source.replace("suite: 'remote-gateway'", "suite: 'desktop-mobile-interop'");
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, source);
const result = spawnSync(process.execPath, [output], {
  cwd: mobileRoot, stdio: 'inherit', timeout: 180000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
