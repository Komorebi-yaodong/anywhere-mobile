declare const __dirname: string;

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const android = fs.readFileSync(
  path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'anywheremobile', 'PinnedGatewayModule.kt'),
  'utf8',
);
const ios = fs.readFileSync(
  path.join(root, 'ios', 'AnywhereMobile', 'PinnedGateway.swift'),
  'utf8',
);
const desktops = fs.readFileSync(
  path.join(root, 'src', 'hooks', 'useDesktops.ts'),
  'utf8',
);

describe('Remote connection liveness boundaries', () => {
  it('uses transport pings for WebSocket idle liveness without weakening HTTPS timeouts', () => {
    expect(android).toContain('transportClient(options, endpoint, webSocket = true)');
    expect(android).toContain('transportClient(options, endpoint, webSocket = true)');
    expect(android).toContain('.readTimeout(if (webSocket) 0 else 20, TimeUnit.SECONDS)');
    expect(android).toContain('builder.pingInterval(15, TimeUnit.SECONDS)');
  });

  it('keeps iOS WebSocket ping lifecycle paired with socket lifecycle', () => {
    expect(ios).toContain('socket?.sendPing');
    expect(ios).toContain('repeating: .seconds(15)');
    expect(ios).toContain('context.pingTimer.cancel()');
  });

  it('does not replace an online socket from a single application ping failure', () => {
    const heartbeat = desktops.slice(
      desktops.indexOf('const timer = setInterval'),
      desktops.indexOf('return () => clearInterval(timer);'),
    );
    expect(heartbeat).toContain("client?.request('remote.ping').catch(() => undefined)");
    expect(heartbeat).not.toContain('scheduleReconnect(desktop)');
  });
});
