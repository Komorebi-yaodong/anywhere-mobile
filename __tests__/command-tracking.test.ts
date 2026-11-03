import {trackCommand, waitForCommand} from '../src/remote/commands';
import type {RemoteRequest} from '../src/remote/api';
const desktopId = 'desktop-tracking-synthetic';
it('lost ACK and repeated read failures query only the original command', async () => {
  const request = jest.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({terminal: false, event: 'conversation.command.accepted'})
    .mockResolvedValue({terminal: true, event: 'conversation.operation.completed', result: {conversationId: 'created-synthetic'}});
  const operation = trackCommand({desktopId, tracked: {requestId: 'original-command-synthetic', response: Promise.reject(Object.assign(new Error('lost ACK'), {code: 'remote_request_timeout'}))}, request: request as RemoteRequest, keepTracking: true});
  await expect(operation.admitted).resolves.toBe(false);
  await expect(operation.completion).resolves.toMatchObject({result: {conversationId: 'created-synthetic'}});
  expect(request).toHaveBeenCalledTimes(4);
  for (const call of request.mock.calls) expect(call).toEqual([desktopId, 'conversation.request.get', {requestId: 'original-command-synthetic'}]);
});
it('definite admission rejection never polls or replays', async () => {
  const request = jest.fn();
  const operation = trackCommand({desktopId, tracked: {requestId: 'rejected-synthetic', response: Promise.reject(Object.assign(new Error('epoch'), {code: 'remote_control_epoch_conflict'}))}, request: request as RemoteRequest});
  await expect(operation.completion).rejects.toMatchObject({code: 'remote_control_epoch_conflict'});
  expect(request).not.toHaveBeenCalled();
});
it('tracking stops on view abort without sending a mutation', async () => {
  const controller = new AbortController();
  const request = jest.fn(async () => {controller.abort(); return {terminal: false, event: 'conversation.command.accepted'};});
  await expect(waitForCommand({desktopId, requestId: 'aborted-synthetic', request: request as RemoteRequest, signal: controller.signal, keepTracking: true, intervalMs: 0})).rejects.toMatchObject({requestId: 'aborted-synthetic'});
  expect(request).toHaveBeenCalledTimes(1);
});
