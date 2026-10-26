import {
  describeConnectionFailure, gatewayFailureDetail, localFailureDetail,
  reconnectDelayMs, safeRemoteFailureCode, stableConnectionMs,
} from '../src/remote/connectionDiagnostics';

describe('Safe connection diagnostics', () => {
  it('retains only exact server reason allowlist entries and numeric close codes', () => {
    expect(gatewayFailureDetail({connectionId: 'fixture', type: 'disconnected', closeCode: 1011,
      closeReason: 'response_send_failed'})).toBe('server_close:1011:response_send_failed');
    expect(describeConnectionFailure('server_close:4002:device_session_replaced'))
      .toBe('Desktop 关闭连接（4002 / device_session_replaced）');
    const detail = gatewayFailureDetail({connectionId: 'fixture', type: 'disconnected',
      closeCode: 99999, closeReason: 'https://private.invalid/path token=fixture'});
    expect(detail).toBe('server_close:unknown:other');
    expect(describeConnectionFailure(detail)).toBe('Desktop 关闭连接（unknown / other）');
  });

  it('uses structured local codes instead of error messages or permissive remote prefixes', () => {
    expect(localFailureDetail({code: 'remote_frame_out_of_order', message: 'private'}))
      .toBe('mobile:remote_frame_out_of_order');
    expect(localFailureDetail(new Error('https://private.invalid/fixture'))).toBe('mobile:other');
    expect(safeRemoteFailureCode('remote_private_secret')).toBe('other');
    expect(describeConnectionFailure('server_error:remote_frame_auth_failed'))
      .toBe('Desktop 协议拒绝（remote_frame_auth_failed）');
  });

  it('redacts unrecognized diagnostics at the presentation boundary too', () => {
    expect(describeConnectionFailure('server_close:1011:private-secret'))
      .toBe('Desktop 关闭连接（1011 / other）');
    expect(describeConnectionFailure('mobile:remote_private_secret'))
      .toBe('Mobile 连接校验失败（other）');
    expect(describeConnectionFailure('transport:private-secret'))
      .toBe('网络传输中断（transport）');
    expect(describeConnectionFailure('https://private.invalid/fixture')).toBe('连接中断（未分类）');
    expect(gatewayFailureDetail({connectionId: 'fixture', type: 'error', failureKind: 'timeout',
      message: 'private-secret'})).toBe('transport:timeout');
  });

  it.each(['write_timeout', 'pong_timeout'])('preserves structured %s without exposing native error text', kind => {
    expect(gatewayFailureDetail({connectionId: 'fixture', type: 'error', failureKind: kind, message: 'private'})).toBe(`transport:${kind}`);
    expect(describeConnectionFailure(`transport:${kind}`)).toBe(`网络传输中断（${kind}）`);
  });


  it('backs off consecutive short sessions and defines a 30 second stable threshold', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 1000].map(reconnectDelayMs))
      .toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(stableConnectionMs).toBe(30_000);
  });
});
