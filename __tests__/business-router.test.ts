import {createBusinessRouter} from '../src/remote/businessRouter';
import {decodeStructuredPage} from '../src/remote/structuredContent';
const frozen = require('../packages/remote-contract/fixtures/v1.0-view.json');
function fixture(minor = 1) {
 const operation = {operationId: 'command-router-fixture', conversationId: frozen.runtime.conversationId, state: 'succeeded', terminal: true, code: null, receipt: {ok: true}, progress: null, acceptedAt: 100, expiresAt: 10000};
 const raw = jest.fn(async (method: string, params?: Record<string, any>) => {
  if (method === 'remote.contract.negotiate') return {selected: {major: 1, minor}, capabilities: minor ? ['resource.read.v1', 'command.durable.v1', 'message.blocks.v1'] : [], serverEpoch: 'fixture', limits: {eventRetention: 512, operationRetentionMs: 1800000}};
  if (method === 'resource.get') return {schemaVersion: '1.0', resource: params?.resource, value: {ok: true}};
  if (method === 'conversation.view.get') return {...frozen, runtime: {...frozen.runtime, control: {owner: 'this_device', canWrite: true, epoch: 'control-fixture'}}};
  if (method === 'command.submit' || method === 'operation.status.get') return operation;
  return {ok: true};
 });
 const persistence = {remember: jest.fn(async () => {}), settle: jest.fn(async () => {})};
 const router = createBusinessRouter(raw, persistence);
 router.welcome(['remote.contract.negotiate']);
 return {raw, router, operation, persistence};
}
it('routes resource reads, durable commands and attachment transfer through independent endpoints', async () => {
 const f = fixture();
 await f.router.route('workspace.bootstrap.get', {}, 20000, 'read-id-fixture', 100);
 expect(f.raw).toHaveBeenCalledWith('resource.get', {resource: 'workspace.bootstrap.get', params: {}}, 20000);
 await f.router.route('conversation.rename', {conversationId: frozen.runtime.conversationId, title: 'new'}, 30000, 'command-router-fixture', 100);
 expect(f.raw).toHaveBeenCalledWith('command.submit', expect.objectContaining({commandId: 'command-router-fixture', preconditions: {controlEpoch: 'control-fixture'}}), 30000);
 expect(f.persistence.remember).toHaveBeenCalledTimes(1);
 expect(f.persistence.settle).toHaveBeenCalledWith('command-router-fixture');
 await f.router.route('attachment.chunk', {uploadId: 'upload-fixture', offset: 0}, 30000, 'chunk-request-fixture', 100);
 expect(f.raw).toHaveBeenCalledWith('transfer.request', {method: 'attachment.chunk', params: {uploadId: 'upload-fixture', offset: 0}}, 30000, 'chunk-request-fixture');
});
it('configuration reads use resource results and do not consume durable command records', async () => {
 const f = fixture();
 await f.router.route('conversation.config.get', {conversationId: frozen.runtime.conversationId}, 30000, 'read-config-fixture', 100);
 const state: any = await f.router.route('conversation.request.get', {requestId: 'read-config-fixture'}, 20000, 'poll-config-fixture', 100);
 expect(state.event).toBe('conversation.config.result'); expect(state.terminal).toBe(true);
 expect(f.persistence.remember).not.toHaveBeenCalled();
 expect(f.raw.mock.calls.some(call => call[0] === 'command.submit' || call[0] === 'operation.status.get')).toBe(false);
});


it('restores interrupted operation as failure without resubmitting', async () => {
 const f = fixture(); Object.assign(f.operation, {state: 'interrupted', code: 'remote_operation_interrupted'});
 const state: any = await f.router.route('conversation.request.get', {requestId: f.operation.operationId}, 20000, 'poll-id-fixture', 100);
 expect(state.terminal).toBe(true); expect(state.event).toBe('conversation.operation.failed'); expect(state.result.code).toBe('remote_operation_interrupted');
 expect(f.raw.mock.calls.some(call => call[0] === 'command.submit')).toBe(false);
});
it('gives config snapshots 120 seconds and retires only proven admission rejection', async () => {
 const f = fixture();
 await f.router.route('conversation.config.get', {conversationId: frozen.runtime.conversationId}, 30000, 'config-long-read', 100);
 expect(f.raw).toHaveBeenCalledWith('resource.get', expect.objectContaining({resource: 'conversation.config.get'}), 120000);
 const base = f.raw.getMockImplementation()!;
 for (const code of ['remote_method_unavailable', 'remote_request_timeout', 'remote_operation_storage_failed', 'remote_command_id_conflict']) {
  f.persistence.settle.mockClear();
  f.raw.mockImplementation((method, params) => method === 'command.submit' ? Promise.reject(Object.assign(new Error(code), {code})) : base(method, params));
  await expect(f.router.route('workspace.project.create', {name: 'Synthetic'}, 30000, 'command-rejected-fixture', 100)).rejects.toThrow(code);
  expect(f.persistence.settle).toHaveBeenCalledTimes(code === 'remote_method_unavailable' ? 1 : 0);
 }
});

it('legacy 1.0 keeps original RPC and malformed claimed support never downgrades', async () => {
 const f = fixture(0);
 await f.router.route('workspace.bootstrap.get', {}, 20000, 'legacy-request-fixture', 100);
 expect(f.raw).toHaveBeenCalledWith('workspace.bootstrap.get', {}, 20000, 'legacy-request-fixture');
 const broken = fixture(); broken.raw.mockResolvedValue({invalid: true});
 await expect(broken.router.route('workspace.bootstrap.get', {}, 20000, 'broken-request-fixture', 100)).rejects.toThrow('remote_contract_invalid');
 expect(broken.raw.mock.calls.some(call => call[0] === 'workspace.bootstrap.get')).toBe(false);
});
it('reads an existing legacy in-flight request only when the durable record is explicitly absent', async () => {
 const f = fixture(); const base = f.raw.getMockImplementation()!;
 f.raw.mockImplementation((method, params) => method === 'operation.status.get' ? Promise.reject(Object.assign(new Error('missing'), {code: 'remote_operation_not_found'})) : base(method, params));
 await f.router.route('conversation.request.get', {requestId: 'legacy-inflight-fixture'}, 20000, 'poll-legacy-fixture', 100);
 expect(f.raw).toHaveBeenCalledWith('resource.get', {resource: 'conversation.request.get', params: {requestId: 'legacy-inflight-fixture'}}, 20000);
 expect(f.raw.mock.calls.some(call => call[0] === 'command.submit')).toBe(false);
});


it('persistence failure prevents dispatch and unsafe/unknown content has a visible fallback', async () => {
 const f = fixture(); f.persistence.remember.mockRejectedValue(new Error('disk failure'));
 await expect(f.router.route('workspace.project.create', {name: 'Synthetic'}, 30000, 'command-router-fixture', 100)).rejects.toThrow('disk failure');
 expect(f.raw.mock.calls.some(call => call[0] === 'command.submit')).toBe(false);
 const page = decodeStructuredPage({...frozen.page, messages: [{...frozen.page.messages[0], payload: {blocks: [{kind: 'markdown', text: 'safe'}, {kind: 'file', name: 'a.txt'}, {kind: 'image', uri: 'file:///PRIVATE'}, {kind: 'future'}]}}]});
 expect(JSON.stringify(page)).toContain('safe'); expect(JSON.stringify(page)).toContain('a.txt'); expect(JSON.stringify(page)).not.toContain('PRIVATE'); expect(JSON.stringify(page)).toContain('暂不支持');
});
