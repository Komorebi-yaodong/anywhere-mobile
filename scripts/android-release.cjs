const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const BUILD_TOOLS = '36.0.0';

function metadata(pkg) {
  const version = pkg.version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Use a stable x.y.z release version in package.json');
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part)) || parts[0] < 1 || (parts[0] === 1 && parts[1] < 1)) {
    throw new Error('Public Android releases start at 1.1.0');
  }
  const code = pkg.androidVersionCode;
  if (!Number.isInteger(code) || code < 35 || code > 2100000000) throw new Error('Invalid androidVersionCode');
  return {
    version, code, tag: `v${version}`,
    release_asset: `Anywhere-Mobile-Android-${version}-arm64-v8a.apk`,
    qa_asset: `Anywhere-Mobile-Android-${version}-qa.${code}-arm64-v8a.apk`,
  };
}

function validateBadging(text, meta, variant) {
  if (!['qa', 'release'].includes(variant)) throw new Error('Unknown Android variant');
  const identity = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(text);
  const packageName = variant === 'qa' ? 'com.anywheremobile.qa' : 'com.anywheremobile';
  const version = variant === 'qa' ? `${meta.version}-internal.${meta.code}` : meta.version;
  if (!identity || identity[1] !== packageName || identity[2] !== String(meta.code) || identity[3] !== version) {
    throw new Error('APK package or version does not match release metadata');
  }
  if (!/^native-code: 'arm64-v8a'\s*$/m.test(text)) throw new Error('APK must contain only arm64-v8a');
}

function validateSignature(text, variant) {
  if (!/Signer #1 certificate SHA-256 digest: [a-f0-9]{64}/i.test(text)) throw new Error('APK signer was not verified');
  if (variant === 'release' && /certificate DN:.*CN\s*=\s*Android\s*Debug/i.test(text)) {
    throw new Error('A debug-signed APK must never be published as a production release');
  }
}

function archiveApk(source, directory, name) {
  fs.mkdirSync(directory, {recursive: true});
  const target = path.join(directory, name);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  fs.writeFileSync(`${target}.sha256.txt`, `${digest}  ${name}\n`, {flag: 'wx'});
  return {file: target, bytes: fs.statSync(target).size, sha256: digest};
}

async function assertPublishTarget({repository, ref, sha, tag, request}) {
  if (ref !== 'refs/heads/main') throw new Error('Production releases must run from main');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[a-f0-9]{40}$/.test(sha || '') || !/^v\d+\.\d+\.\d+$/.test(tag || '')) {
    throw new Error('Invalid GitHub release target');
  }
  const base = `/repos/${repository}`;
  const release = await request(`${base}/releases/tags/${tag}`);
  if (release.status === 200) throw new Error(`${tag} already has a release; increase the version instead of overwriting it`);
  if (release.status !== 404) throw new Error(`Cannot check existing release (HTTP ${release.status})`);
  const result = await request(`${base}/git/ref/tags/${tag}`);
  if (result.status === 404) return;
  if (result.status !== 200) throw new Error(`Cannot check release tag (HTTP ${result.status})`);
  let object = result.data?.object;
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha || '')) throw new Error('Invalid annotated tag');
    const annotated = await request(`${base}/git/tags/${object.sha}`);
    if (annotated.status !== 200) throw new Error('Cannot resolve annotated release tag');
    object = annotated.data?.object;
  }
  if (object?.type !== 'commit' || object.sha !== sha) throw new Error(`${tag} points to a different commit`);
}

async function githubRequest(route) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GitHub token is required');
  const response = await fetch(`https://api.github.com${route}`, {
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
    signal: AbortSignal.timeout(30000),
  });
  return {status: response.status, data: response.status === 200 ? await response.json() : null};
}

async function main() {
  const command = process.argv[2];
  const meta = metadata(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
  if (command === 'metadata') {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(meta).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify(meta));
  } else if (command === 'preflight') {
    await assertPublishTarget({repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, tag: meta.tag, request: githubRequest});
    console.log(`Release target ${meta.tag} is available`);
  } else if (command === 'package') {
    const variant = process.argv[3];
    if (!['qa', 'release'].includes(variant)) throw new Error('Specify qa or release');
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error('ANDROID_HOME is required to verify APK metadata and signatures');
    const tools = path.join(sdk, 'build-tools', BUILD_TOOLS);
    const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
    const options = {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024};
    validateBadging(execFileSync(path.join(tools, process.platform === 'win32' ? 'aapt.exe' : 'aapt'), ['dump', 'badging', apk], options), meta, variant);
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
    validateSignature(execFileSync(java, ['-jar', path.join(tools, 'lib', 'apksigner.jar'), 'verify', '--verbose', '--print-certs', apk], options), variant);
    console.log(JSON.stringify(archiveApk(apk, path.join(root, 'build', 'distribution'), meta[`${variant}_asset`])));
  } else {
    throw new Error('Usage: android-release.cjs metadata | preflight | package qa|release');
  }
}

module.exports = {metadata, validateBadging, validateSignature, archiveApk, assertPublishTarget};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
