import {controlledErrorCode, projectNativeTrace, shareConnectionDiagnostics, traceTransport, transportTraceSnapshot} from '../src/remote/transportTrace';

it('retains only bounded projected metadata, never arbitrary content or identifiers', () => {
  for (let i = 0; i < 300; i++) traceTransport('image_stage', {generation: i, bytes: 100, state: 'uploading', code: 'https://secret.invalid', path: '/private/photo', taskId: 'secret', payload: 'chat'} as any);
  const rows = transportTraceSnapshot();
  expect(rows).toHaveLength(256);expect(rows[0].generation).toBe(44);
  expect(rows[0]).toMatchObject({event: 'image_stage', bytes: 100, code: 'other'});
  expect(JSON.stringify(rows)).not.toMatch(/secret|private|chat|payload|taskId|path/);
  rows[0].bytes = 0;expect(transportTraceSnapshot()[0].bytes).toBe(100);
});
it('projects native data again and rejects invalid events/numbers and excess rows', () => {
  const input = Array.from({length: 300}, (_, i) => ({event: 'submitted', generation: i, bytes: 932546, elapsedMs: -1, atMs: NaN, code: 'remote_pong_timeout', message: 'private content', path: '/private', requestId: 'secret'}));
  const output = projectNativeTrace(input);
  expect(output).toHaveLength(256);expect(output[0]).toEqual({event: 'submitted', generation: 44, bytes: 932546, code: 'remote_pong_timeout'});
  expect(projectNativeTrace([{event: 'private-content'}, null, 'secret'])).toEqual([]);
  expect(projectNativeTrace('secret')).toEqual([]);
});
it('uses native code rather than localized message and drops unsafe text', () => {
  expect(controlledErrorCode({code: 'remote_pong_timeout', message: '/private/photo'})).toBe('remote_pong_timeout');
  expect(controlledErrorCode(new Error('remote_request_timeout'))).toBe('remote_request_timeout');
  expect(controlledErrorCode({code: 'https://private', message: 'secret'})).toBe('remote_upload_failed');
});
it('shares a bounded sanitized snapshot only when explicitly requested', async () => {
  const read = jest.fn(async () => JSON.stringify([{event: 'failure', code: 'SOCKET_PONG_TIMEOUT', path: '/private', bytes: 100}]));
  const share = jest.fn(async (_message: string) => undefined);
  expect(read).not.toHaveBeenCalled();expect(share).not.toHaveBeenCalled();
  await shareConnectionDiagnostics(read, share);
  const content = share.mock.calls[0][0];
  const result = JSON.parse(content);
  expect(result.native).toEqual([{event: 'failure', code: 'SOCKET_PONG_TIMEOUT', bytes: 100}]);
  expect(content).not.toContain('/private');expect(result.schema).toBe(1);
});
