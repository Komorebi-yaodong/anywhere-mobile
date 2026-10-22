import {createBusinessSession} from '../src/remote/businessSession';
import type {RemoteRequest} from '../src/remote/api';
import {CAPABILITIES, validateView} from '../packages/remote-contract';
const frozen = require('../packages/remote-contract/fixtures/v1.0-view.json');
const CID = frozen.runtime.conversationId;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fixture() {
  const rpc = jest.fn(async (_id: string, method: string): Promise<unknown> => {
    if (method === 'remote.status.get') return {capabilities: ['remote.contract.negotiate']};
    if (method === 'remote.contract.negotiate') return {selected: {major: 1, minor: 0}, capabilities: [...CAPABILITIES], serverEpoch: frozen.serverEpoch, limits: {eventRetention: 512, operationRetentionMs: 1800000}};
    if (method === 'conversation.view.get') return clone(frozen);
    if (method === 'conversation.changes.get') return {serverEpoch: frozen.serverEpoch, cursor: 'next:8', sequence: 8, resyncRequired: false, hasMore: false, events: []};
    throw new Error(method);
  });
  return {rpc, sdk: createBusinessSession('desktop-contract-fixture', rpc as RemoteRequest)};
}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}

it('new Mobile downgrades only when the frozen legacy Desktop does not advertise the contract', async () => {
  const {rpc, sdk} = fixture();
  rpc.mockResolvedValue({capabilities: ['conversation.messages.list', 'conversation.send']});
  expect(await sdk.read(CID)).toBeNull();
  expect(await sdk.operation('request-fixture')).toBeNull();
  expect(rpc.mock.calls.map(call => call[1])).toEqual(['remote.status.get']);
});
it('enables optional operation reads independently from conversation view capability', async () => {
  const {rpc, sdk} = fixture(); const base = rpc.getMockImplementation()!;
  rpc.mockImplementation((id, method) => method === 'remote.contract.negotiate' ? Promise.resolve({selected: {major: 1, minor: 0}, capabilities: ['conversation.view.v1', 'conversation.runtime.v1', 'conversation.invalidation.v1'], serverEpoch: frozen.serverEpoch, limits: {eventRetention: 512, operationRetentionMs: 1800000}}) : base(id, method));
  expect(await sdk.read(CID)).not.toBeNull();
  expect(await sdk.operation('request-fixture')).toBeNull();
  expect(rpc.mock.calls.some(call => call[1] === 'operation.get')).toBe(false);
});


it('does not downgrade a claimed but malformed new protocol or a transport failure', async () => {
  const {rpc, sdk} = fixture();
  const base = rpc.getMockImplementation()!;
  rpc.mockImplementation((id, method) => method === 'remote.contract.negotiate' ? Promise.resolve({selected: {major: 99}, capabilities: []}) : base(id, method));
  await expect(sdk.read(CID)).rejects.toMatchObject({code: 'remote_contract_invalid'});
  expect(rpc.mock.calls.some(call => call[1] === 'conversation.messages.list')).toBe(false);
  sdk.reset();
  rpc.mockRejectedValue(Object.assign(new Error('offline'), {code: 'remote_transport_closed'}));
  await expect(sdk.read(CID)).rejects.toMatchObject({code: 'remote_transport_closed'});
});
it('accepts frozen v1 plus unknown optional fields and rejects unknown critical runtime', async () => {
  const view = clone(frozen);
  view.newOptional = 'future';
  expect(validateView(view)).toBe(view);
  view.runtime.execution.state = 'new_unsafe_state';
  expect(() => validateView(view)).toThrow('remote_contract_invalid');
});
it('never lets an older concurrent snapshot overwrite a newer view', async () => {
  const {rpc, sdk} = fixture();
  await sdk.enabled();
  const older = deferred<unknown>();
  let count = 0;
  const base = rpc.getMockImplementation()!;
  rpc.mockImplementation((id, method) => method === 'conversation.view.get' ? ++count === 1 ? older.promise : Promise.resolve({...clone(frozen), sequence: 9}) : base(id, method));
  const first = sdk.read(CID);
  await Promise.resolve(); await Promise.resolve();
  const second = await sdk.read(CID);
  older.resolve({...clone(frozen), sequence: 7});
  expect((await first)?.sequence).toBe(second?.sequence);
});
it('retries dirty data without advancing its cursor, and handles epoch expiry by resnapshot', async () => {
  const {rpc, sdk} = fixture();
  await sdk.read(CID);
  const base = rpc.getMockImplementation()!;
  rpc.mockImplementation((id, method) => method === 'conversation.changes.get'
    ? Promise.resolve({serverEpoch: 'new-server', cursor: 'new-server:0', sequence: 0, resyncRequired: true, hasMore: false, events: []}) : base(id, method));
  expect(await sdk.dirty(CID)).toBe(true);
  expect(await sdk.dirty(CID)).toBe(true);
  const changes = rpc.mock.calls.filter(call => call[1] === 'conversation.changes.get');
  expect(changes).toHaveLength(2);
  sdk.reset();
  expect(sdk.runtime(CID)).toBeNull();
});
