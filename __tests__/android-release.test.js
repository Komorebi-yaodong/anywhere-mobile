/** @jest-environment node */

const {Buffer} = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const YAML = require('yaml');
const {metadata, validateBadging, validateSignature, archiveApk, assertPublishTarget} = require('../scripts/android-release.cjs');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'build-release.yml'), 'utf8'));
const meta = metadata(pkg);
const sha = 'a'.repeat(40);
const target = {repository: 'fixture/mobile', ref: 'refs/heads/main', sha, tag: meta.tag};
const badging = (variant = 'release') => `package: name='com.anywheremobile${variant === 'qa' ? '.qa' : ''}' versionCode='${meta.code}' versionName='${meta.version}${variant === 'qa' ? `-internal.${meta.code}` : ''}'\nnative-code: 'arm64-v8a'\n`;
const signer = `Signer #1 certificate DN: CN=Anywhere Mobile\nSigner #1 certificate SHA-256 digest: ${'b'.repeat(64)}\n`;

it('uses a single stable 1.1.0+ version with a monotonically-upgradable Android code', () => {
  expect(meta).toMatchObject({version: pkg.version, code: pkg.androidVersionCode, tag: `v${pkg.version}`, release_asset: `Anywhere-Mobile-Android-${pkg.version}-arm64-v8a.apk`});
  expect(metadata({...pkg, version: '1.1.0', androidVersionCode: 35})).toMatchObject({tag: 'v1.1.0', code: 35});
  for (const version of ['0.0.1', '1.0.99', '1.1.0-qa', 'v1.1.0', '01.1.0', '1.1.0\nmalicious=1']) expect(() => metadata({...pkg, version})).toThrow();
  for (const code of [34, 35.5, '35', 2100000001]) expect(() => metadata({...pkg, androidVersionCode: code})).toThrow();
  expect(metadata({...pkg, version: '1.1.1', androidVersionCode: 36}).tag).toBe('v1.1.1');
  expect(pkg.packageManager).toMatch(/^pnpm@/);
});

it.each(['qa', 'release'])('validates exact package, version, code and arm64-only APK for %s', variant => {
  expect(() => validateBadging(badging(variant), meta, variant)).not.toThrow();
  for (const value of [badging(variant).replace('arm64-v8a', 'x86_64'), badging(variant).replace("'arm64-v8a'", "'arm64-v8a' 'armeabi-v7a'"), badging(variant).replace(`versionCode='${meta.code}'`, "versionCode='1'"), badging(variant).replace(meta.version, '9.9.9'), badging(variant).replace('com.anywheremobile', 'com.other')]) {
    expect(() => validateBadging(value, meta, variant)).toThrow();
  }
  expect(() => validateBadging(badging(variant === 'qa' ? 'release' : 'qa'), meta, variant)).toThrow();
});

it('requires verified signing and refuses production APKs with an Android Debug certificate', () => {
  expect(() => validateSignature(signer, 'release')).not.toThrow();
  const debug = signer.replace('CN=Anywhere Mobile', 'C=US, O=Android, CN=Android Debug');
  expect(() => validateSignature(debug, 'release')).toThrow(/debug-signed/);
  expect(() => validateSignature(debug, 'qa')).not.toThrow();
  expect(() => validateSignature('', 'release')).toThrow();
});

it('archives the exact APK bytes with a portable SHA-256 and never overwrites', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-release-fixture-'));
  try {
    const source = path.join(temporary, 'synthetic.apk');
    const bytes = Buffer.from('synthetic APK test data, no user data'); fs.writeFileSync(source, bytes);
    const directory = path.join(temporary, 'distribution');
    const result = archiveApk(source, directory, meta.release_asset);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(result).toMatchObject({bytes: bytes.length, sha256: digest});
    expect(fs.readFileSync(result.file).equals(bytes)).toBe(true);
    expect(fs.readFileSync(`${result.file}.sha256.txt`, 'utf8')).toBe(`${digest}  ${meta.release_asset}\n`);
    expect(() => archiveApk(source, directory, meta.release_asset)).toThrow();
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});

it('allows a missing release/tag without creating or pushing anything in preflight', async () => {
  const request = jest.fn(async () => ({status: 404}));
  await expect(assertPublishTarget({...target, request})).resolves.toBeUndefined();
  expect(request.mock.calls.map(([route]) => route)).toEqual([`/repos/fixture/mobile/releases/tags/${meta.tag}`, `/repos/fixture/mobile/git/ref/tags/${meta.tag}`]);
});

it('rejects a manual dispatch outside main before making a request', async () => {
  const request = jest.fn();
  await expect(assertPublishTarget({...target, ref: 'refs/heads/other', request})).rejects.toThrow(/main/);
  expect(request).not.toHaveBeenCalled();
});

it('never overwrites an existing published or draft release', async () => {
  for (const draft of [false, true]) {
    const request = jest.fn(async () => ({status: 200, data: {draft}}));
    await expect(assertPublishTarget({...target, request})).rejects.toThrow(/already has a release/);
    expect(request).toHaveBeenCalledTimes(1);
  }
});

it('fails closed on auth/network/API errors instead of interpreting them as absent releases', async () => {
  for (const status of [401, 403, 429, 500]) await expect(assertPublishTarget({...target, request: async () => ({status})})).rejects.toThrow(/Cannot check/);
  await expect(assertPublishTarget({...target, request: async () => {throw new Error('offline');}})).rejects.toThrow('offline');
});

it('accepts lightweight or annotated tags only when they resolve to this exact commit', async () => {
  for (const annotated of [false, true]) {
    const request = jest.fn(async route => {
      if (route.includes('/releases/')) return {status: 404};
      if (route.includes('/git/tags/')) return {status: 200, data: {object: {type: 'commit', sha}}};
      return {status: 200, data: {object: {type: annotated ? 'tag' : 'commit', sha}}};
    });
    await expect(assertPublishTarget({...target, request})).resolves.toBeUndefined();
  }
  const request = async route => route.includes('/releases/') ? {status: 404} : {status: 200, data: {object: {type: 'commit', sha: 'c'.repeat(40)}}};
  await expect(assertPublishTarget({...target, request})).rejects.toThrow(/different commit/);
});

it('push builds artifacts only; only manual publication receives contents write', () => {
  expect(workflow.on.push.branches).toEqual(['main']); expect(workflow.on).toHaveProperty('workflow_dispatch');
  expect(workflow.permissions).toEqual({contents: 'read'});
  expect(workflow.jobs.publish.if).toBe("github.event_name == 'workflow_dispatch'");
  expect(workflow.jobs.publish.permissions).toEqual({contents: 'write'});
  expect(workflow.jobs.android.needs).toBe('checks'); expect(workflow.jobs.publish.needs).toBe('android');
  const checks = workflow.jobs.checks.steps.map(step => step.run).filter(Boolean).join('\n');
  expect(checks).toContain('pnpm install --frozen-lockfile'); expect(checks).toContain('pnpm test --runInBand');
  expect(checks).toContain('tsc --noEmit'); expect(checks).toContain('eslint . --max-warnings 0');
  expect(JSON.stringify(workflow)).not.toContain('macos'); expect(JSON.stringify(workflow)).not.toContain('xcodebuild');
});

it('keeps signing secrets out of preview steps, clears temporary keys, and publishes only verified assets', () => {
  const steps = workflow.jobs.android.steps;
  for (const step of steps.filter(candidate => JSON.stringify(candidate).includes('${{ secrets.'))) expect(step.if).toBe("github.event_name == 'workflow_dispatch'");
  expect(steps.find(step => step.name === 'Build preview APK')).toMatchObject({if: "github.event_name == 'push'", run: expect.stringContaining(':app:assembleQa')});
  expect(steps.find(step => step.name === 'Build signed production APK').run).toContain(':app:assembleRelease');
  expect(steps.find(step => step.name === 'Remove temporary signing key').if).toBe("always() && github.event_name == 'workflow_dispatch'");
  const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = workflow.jobs.publish.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  expect(upload.with.path).toBe('build/distribution/*.apk\nbuild/distribution/*.sha256.txt\n');
  expect(upload.with.name.replace("${{ github.event_name == 'push' && 'preview' || 'release' }}", 'release').replace('${{ steps.metadata.outputs.version }}', '${{ needs.android.outputs.version }}')).toBe(download.with.name);
  const publish = workflow.jobs.publish.steps.map(step => step.run).filter(Boolean).join('\n');
  expect(publish).toContain('sha256sum --check'); expect(publish).toContain('preflight');
  expect(publish).toContain('--draft'); expect(publish).toContain('--target "$GITHUB_SHA"'); expect(publish).toContain('--draft=false'); expect(publish).not.toContain('--clobber');
  for (const step of workflow.jobs.publish.steps) expect(JSON.stringify(step)).not.toContain('${{ secrets.');
});

it('Gradle reads the same version, isolates QA signing and blocks production signing fallback', () => {
  const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');
  expect(gradle).toContain('new JsonSlurper().parse(rootProject.file("../package.json"))');
  expect(gradle).toContain('versionCode mobilePackage.androidVersionCode.intValue()'); expect(gradle).toContain('versionName mobilePackage.version');
  const production = gradle.split('// Production signing')[1].split('// Standalone internal')[0];
  expect(production).toContain('signingConfig signingConfigs.release'); expect(production).not.toContain('signingConfigs.debug');
  expect(gradle).toContain('task.dependsOn("validateProductionSigning")');
  const qa = gradle.split('// Standalone internal')[1];
  expect(qa).toContain('applicationIdSuffix ".qa"'); expect(qa).toContain('signingConfig signingConfigs.debug');
  expect(fs.readFileSync(path.join(root, 'android', 'gradle.properties'), 'utf8')).not.toMatch(/org\.gradle\.java\.(home|installations\.paths)=/);
});
