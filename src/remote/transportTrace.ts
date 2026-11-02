/** Runtime-only, bounded and schema-projected. Never retain identifiers/content. */
export type TraceEvent = 'connection' | 'foreground' | 'refresh_start' | 'refresh_join' | 'refresh_done' | 'refresh_stale' | 'refresh_failed' | 'image_start' | 'image_stage' | 'image_failed' | 'image_done' | 'rpc_timeout';
const events = new Set<TraceEvent>(['connection', 'foreground', 'refresh_start', 'refresh_join', 'refresh_done', 'refresh_stale', 'refresh_failed', 'image_start', 'image_stage', 'image_failed', 'image_done', 'rpc_timeout']);
const states = new Set(['idle', 'connecting', 'handshaking', 'online', 'closed', 'active', 'background', 'inactive', 'unknown', 'hashing', 'creating', 'waiting_first_ack', 'uploading', 'completing', 'connection', 'manual', 'mutation']);
const codes = new Set(['remote_pong_timeout', 'remote_write_timeout', 'remote_request_timeout', 'remote_client_closed', 'remote_transport_error', 'remote_transport_closed', 'remote_client_offline', 'remote_upload_cancelled', 'remote_upload_response_invalid', 'remote_upload_source_invalid', 'remote_upload_failed', 'remote_send_capacity', 'remote_initialization_timeout', 'remote_handshake_timeout', 'remote_transport_connect_timeout']);
const started = Date.now();
const rows: Array<Record<string, number | string>> = [];
export function traceTransport(event: TraceEvent, fields: {generation?: number; state?: string; code?: string; bytes?: number; total?: number; elapsedMs?: number} = {}): void {
  if (!events.has(event)) return;
  const row: Record<string, number | string> = {atMs: Math.max(0, Date.now() - started), event};
  for (const key of ['generation', 'bytes', 'total', 'elapsedMs'] as const) {
    const value = fields[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) row[key] = value;
  }
  if (fields.state && states.has(fields.state)) row.state = fields.state;
  if (fields.code) row.code = codes.has(fields.code) ? fields.code : 'other';
  rows.push(row); if (rows.length > 256) rows.shift();
}
export function transportTraceSnapshot(): Array<Record<string, number | string>> {return rows.map(row => ({...row}));}
const nativeEvents = new Set(['connection', 'closed', 'failure', 'queued', 'submitted', 'drained', 'rejected', 'upload_start', 'upload_done', 'upload_failed', 'rpc_begin', 'rpc_chunk', 'rpc_complete', 'rpc_abort', 'ack', 'ack_failed']);
export function projectNativeTrace(input: unknown): Array<Record<string, string | number>> {
  if (!Array.isArray(input)) return [];
  return input.slice(-256).flatMap(value => {
    if (!value || typeof value !== 'object' || !nativeEvents.has(value.event)) return [];
    const row: Record<string, string | number> = {event: value.event};
    for (const key of ['atMs', 'generation', 'bytes', 'elapsedMs']) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) row[key] = value[key];
    }
    if (typeof value.code === 'string') row.code = codes.has(value.code) || ['SOCKET_WRITE_TIMEOUT', 'SOCKET_PONG_TIMEOUT', 'SOCKET_UNAVAILABLE'].includes(value.code) ? value.code : 'other';
    return [row];
  });
}

export async function shareConnectionDiagnostics(load?: () => Promise<string>, share?: (message: string) => Promise<unknown>): Promise<void> {
  const read = load || (async () => (await import('../native/PinnedGateway')).PinnedGateway.connectionDiagnostics());
  const send = share || (async (message: string) => (await import('react-native')).Share.share({title: '连接诊断', message}));
  // Native projects the same bounded schema. No endpoint/task/path ever enters it.
  const native = projectNativeTrace(JSON.parse(await read()));
  await send(JSON.stringify({schema: 1, js: transportTraceSnapshot(), native}));
}
export function controlledErrorCode(error: unknown): string {
  const source = error && typeof error === 'object' ? error as {code?: unknown; message?: unknown} : {};
  const candidate = typeof source.code === 'string' ? source.code : source.message;
  return typeof candidate === 'string' && /^remote_[a-z0-9_]{1,80}$/.test(candidate) ? candidate : 'remote_upload_failed';
}
