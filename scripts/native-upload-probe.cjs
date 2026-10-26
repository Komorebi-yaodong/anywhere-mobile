/* Real OkHttp/production writer over synthetic loopback; never uses a device. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'internal-test', 'native-upload-probe');
const cache = path.join(os.homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1');
function jar(group, name, version) {
  const directory = path.join(cache, group, name, version);
  for (const hash of fs.readdirSync(directory)) {
    const candidate = path.join(directory, hash, `${name}-${version}.jar`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing cached ${name}@${version}; run the normal Android dependency build first`);
}
const jars = [jar('com.squareup.okhttp3', 'okhttp', '4.12.0'), jar('com.squareup.okio', 'okio-jvm', '3.6.0'), jar('org.jetbrains.kotlin', 'kotlin-stdlib', '1.9.20')];
const java = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
function run(command, args, timeout) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', timeout});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native upload regression failed (${result.status})`);
}
fs.mkdirSync(output, {recursive: true});
run(java('javac'), ['-cp', jars.join(path.delimiter), '-d', output,
  path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'anywheremobile', 'GatewaySocketWriter.java'),
  path.join(root, 'tests', 'native', 'GatewaySocketWriterProbe.java'),
  path.join(root, 'tests', 'native', 'GatewayUploadHeartbeatProbe.java')], 15000);
const mode = process.argv[2];
const suite = mode === '--heartbeat' || mode === '--heartbeat-large' ? 'GatewayUploadHeartbeatProbe' : 'GatewaySocketWriterProbe';
run(java('java'), ['-cp', [output, ...jars].join(path.delimiter), `com.anywheremobile.${suite}`, ...(mode === '--heartbeat-large' ? ['--large-control'] : [])], 90000);
