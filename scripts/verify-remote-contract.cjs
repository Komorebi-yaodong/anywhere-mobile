const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
for (const release of ['remote-contract', 'remote-contract-v1']) {
const root = path.join(__dirname, '..', 'packages', release);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'integrity.json'), 'utf8'));
for (const [file, expected] of Object.entries(manifest.files)) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  assert.equal(hash, expected, `contract release drift: ${file}`);
}
const contract = require(path.join(root, 'index.cjs'));
contract.validateView(JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'v1.0-view.json'), 'utf8')));
console.log(JSON.stringify({ok: true, suite: 'remote-contract-integrity', version: manifest.version}));

}
