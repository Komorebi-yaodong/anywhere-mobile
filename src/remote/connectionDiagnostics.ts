import type {GatewayEvent} from '../native/PinnedGateway';

// Exact allowlists only: arbitrary server/native error text may contain private
// endpoints or business data and must never become a connection diagnostic.
const remoteCodes = new Set([
  'remote_frame_invalid', 'remote_frame_replayed', 'remote_frame_out_of_order',
  'remote_frame_auth_failed', 'remote_frame_payload_invalid', 'remote_session_mismatch',
  'remote_session_state_invalid', 'remote_session_accept_invalid', 'remote_session_proof_invalid',
  'remote_device_mismatch', 'remote_desktop_mismatch', 'remote_device_not_found',
  'remote_session_hello_replayed', 'remote_socket_message_invalid', 'remote_socket_error',
  'remote_request_invalid', 'remote_message_kind_invalid', 'remote_welcome_invalid',
  'remote_invalid_base64url', 'remote_identifier_invalid', 'remote_sequence_invalid',
  'remote_payload_size_invalid', 'remote_session_closed', 'remote_ecdh_failed',
  'remote_connect_timeout', 'remote_transport_error', 'remote_transport_closed',
  'remote_session_accept_send_failed', 'remote_welcome_send_failed',
]);
const closeReasons = new Set([
  ...remoteCodes,
  'response_send_failed', 'error_response_send_failed', 'encrypted_event_send_failed',
  'device_session_replaced', 'device_repaired', 'device_revoked', 'gateway_stopped',
  'session_handshake_timeout', 'too_many_pending_connections', 'too_many_connections',
  'binary_frames_not_supported',
]);
const failureKinds = new Set([
  'timeout', 'write_timeout', 'pong_timeout', 'tls', 'network_io', 'protocol', 'frame_too_large',
  'binary_frame', 'transport', 'cancelled',
]);

export function safeRemoteFailureCode(value: unknown): string {
  return typeof value === 'string' && remoteCodes.has(value) ? value : 'other';
}

export function localFailureDetail(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as {code?: unknown}).code : undefined;
  return `mobile:${safeRemoteFailureCode(code)}`;
}

export function gatewayFailureDetail(event: GatewayEvent): string {
  if (event.type === 'disconnected') {
    const code = Number.isInteger(event.closeCode) && event.closeCode! >= 1000 && event.closeCode! <= 4999
      ? String(event.closeCode) : 'unknown';
    const reason = event.closeReason && closeReasons.has(event.closeReason) ? event.closeReason : 'other';
    return `server_close:${code}:${reason}`;
  }
  const kind = event.failureKind && failureKinds.has(event.failureKind) ? event.failureKind : 'transport';
  return `transport:${kind}`;
}

export function describeConnectionFailure(detail?: string): string {
  const parts = detail?.split(':') ?? [];
  if (parts[0] === 'server_close' && parts.length === 3) {
    const code = /^\d{4}$/.test(parts[1]) && Number(parts[1]) >= 1000 && Number(parts[1]) <= 4999
      ? parts[1] : 'unknown';
    const reason = closeReasons.has(parts[2]) ? parts[2] : 'other';
    return `Desktop 关闭连接（${code} / ${reason}）`;
  }
  if (parts[0] === 'mobile' && parts.length === 2) {
    return `Mobile 连接校验失败（${safeRemoteFailureCode(parts[1])}）`;
  }
  if (parts[0] === 'server_error' && parts.length === 2) {
    return `Desktop 协议拒绝（${safeRemoteFailureCode(parts[1])}）`;
  }
  if (parts[0] === 'transport' && parts.length === 2) {
    const kind = failureKinds.has(parts[1]) ? parts[1] : 'transport';
    return `网络传输中断（${kind}）`;
  }
  return '连接中断（未分类）';
}

export const stableConnectionMs = 30_000;

export function reconnectDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.min(5, Math.max(0, Math.floor(attempt))), 30_000);
}
