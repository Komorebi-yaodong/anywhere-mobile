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
  it('aligns bounded native transports and private recording reads with negotiated 8 MiB uploads', () => {
    const media = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'anywheremobile', 'MediaCaptureModule.kt'), 'utf8');
    expect(android).toContain('MAX_SOCKET_BYTES = 16 * 1024 * 1024');
    expect(android).toContain('MAX_RESPONSE_BYTES = 512L * 1024L');
    expect(ios).toContain('socket.maximumMessageSize = 16 * 1024 * 1024');
    expect(ios).toContain('maxResponseBytes = 512 * 1024');
    expect(media).toContain('length>8388608');
    expect(media).not.toContain('length>131072');
    expect(ios).toContain('length<=8388608');
    expect(ios).not.toContain('length<=131072');
  });


  it('uses transport pings for WebSocket idle liveness without weakening HTTPS timeouts', () => {
    expect(android).toContain('transportClient(options, endpoint, webSocket = true)');
    expect(android).toContain('transportClient(options, endpoint, webSocket = true)');
    expect(android).toContain('.readTimeout(if (webSocket) 0 else 20, TimeUnit.SECONDS)');
    expect(android).toContain('builder.pingInterval(15, TimeUnit.SECONDS)');

    expect(android).toContain('builder.writeTimeout(60, TimeUnit.SECONDS)');
    expect(android).toContain('record.writer.send(text');
    expect(android).toContain('it.writer.close(); it.socket.cancel()');
  });

  it('keeps iOS WebSocket ping lifecycle paired with socket lifecycle', () => {
    expect(ios).toContain('socket?.sendPing');
    expect(ios).toContain('repeating: .seconds(15)');
    expect(ios).toContain('context.pingTimer.cancel()');
  });

  it('preserves structured native close diagnostics with exact reason allowlists', () => {
    expect(android).toContain('closeCode = code, closeReason = reason');
    expect(android).toContain('if (it in safeCloseReasons) it else "other"');
    expect(android).toContain('"pong_timeout" else "write_timeout"');
    expect(android).not.toContain('emit(connectionId, "error", safeError(throwable))');
    expect(ios).toContain('closeCode: closeCode.rawValue');
    expect(ios).toContain('Self.safeCloseReasons.contains(closeReason) ? closeReason : "other"');
    expect(ios).toContain('socket.closeCode != .invalid');
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
