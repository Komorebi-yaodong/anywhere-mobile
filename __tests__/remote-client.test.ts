import {createP256KeyPair, randomBase64Url} from '../src/remote/crypto';
import {encodeBase64Url, REMOTE_MAX_FRAME_BYTES} from '../src/remote/protocol';
import type {
  RemoteCryptoSession,
  SessionHello,
} from '../src/remote/session';

import {PinnedGateway} from '../src/native/PinnedGateway';

import type {GatewayEvent} from '../src/native/PinnedGateway';

let mockListener: ((event: GatewayEvent) => void) | undefined;
let mockServerSession: RemoteCryptoSession | undefined;
const mockSentTexts: string[] = [];
let mockHoldBusinessSend: Promise<void> | undefined;

let mockRpcErrorCode: string | undefined;

let mockV11 = false;
let mockTransfer = false;
let mockAdaptive = false;
let mockTransferResult: unknown;
let mockHoldChunk: Promise<void> | undefined;
const mockTransferSnapshots = new Map<string, {bytes: Uint8Array; ref: any}>();
const mockOperationItems: Array<{operationId: string; conversationId: string | null; issuedAt: number}> = [];
const mockMethods: string[] = [];

function mockSnapshot(value: unknown) {
  const {canonicalBytes} = require('../src/remote/protocol');
  const {sha256} = require('@noble/hashes/sha2.js');
  const bytes = canonicalBytes(value);
  const ref = {id: randomBase64Url(24), totalBytes: bytes.length, sha256: Array.from(sha256(bytes) as Uint8Array, b => b.toString(16).padStart(2, '0')).join(''), chunkBytes: mockAdaptive ? 512 * 1024 : 48 * 1024, ...(mockAdaptive ? {adaptive: true, maxChunkBytes: 8 * 1024 * 1024} : {})};
  mockTransferSnapshots.set(ref.id, {bytes, ref});
  return ref;
}
jest.mock('../src/services/secureStore', () => ({updatePendingOperations: jest.fn(async (_id, update) => {
  const next = update([...mockOperationItems]); mockOperationItems.splice(0, mockOperationItems.length, ...next); return next;
})}));

jest.mock('../src/native/PinnedGateway', () => ({
  PinnedGateway: {
    connectSocket: jest.fn(async ({connectionId}) => {
      mockListener?.({connectionId, type: 'connected'});
    }),
    sendText: jest.fn(async (connectionId: string, text: string) => {
      mockSentTexts.push(text);
      const message = JSON.parse(text) as {type?: string};
      if (message.type === 'remote.encrypted' && mockHoldBusinessSend) {
        const wait = mockHoldBusinessSend;
        mockHoldBusinessSend = undefined;
        await wait;
      }
      if (message.type === 'remote.session.hello') {
        const hello = message as SessionHello;
        const {createSessionAcceptForFixture} = require('../src/remote/session') as typeof import('../src/remote/session');
        const accepted = createSessionAcceptForFixture({
          rootSecret: mockRootSecret,
          hello,
          serverEphemeralKeyPair: mockServerKeyPair,
          sessionId: 'session-remote-v2-client-test-0001',
          serverNonce: 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8',
        });
        mockServerSession = accepted.session;
        mockListener?.({connectionId, type: 'message', message: JSON.stringify(accepted.accept)});
        mockListener?.({
          connectionId,
          type: 'message',
          message: JSON.stringify(
            mockServerSession.encrypt({
              kind: 'event',
              event: 'remote.welcome',
              payload: {
                protocolVersion: 2,
                desktopId: mockDesktop.id,
                device: {deviceId: mockIdentity.deviceId},
                capabilities: mockTransfer ? ['remote.transfer.v1', ...(mockAdaptive ? ['remote.transfer.adaptive.v1'] : [])] : mockV11 ? ['remote.contract.negotiate', 'resource.get', 'command.submit', 'operation.status.get'] : {},
              },
            }),
          ),
        });
        return;
      }
      if (message.type === 'remote.encrypted') {
        const request = mockServerSession?.decrypt(message as never);

        mockMethods.push(String(request?.method));
        const params = request?.params as Record<string, any>;
        let value: any = {method: request?.method, e2ee: true};
        if (mockV11) {
          if (request?.method === 'remote.contract.negotiate') value = {selected: {major: 1, minor: 1}, capabilities: ['resource.read.v1', 'command.durable.v1', 'message.blocks.v1'], serverEpoch: 'client-fixture', limits: {eventRetention: 512, operationRetentionMs: 1800000}};
          if (request?.method === 'resource.get') value = {schemaVersion: '1.0', resource: params.resource, value: {method: params.resource, e2ee: true}};
          if (request?.method === 'command.submit' || request?.method === 'operation.status.get') value = {operationId: params.commandId || params.operationId, conversationId: 'conversation-client-v11', state: 'succeeded', terminal: true, code: null, receipt: {ok: true}, progress: null, acceptedAt: 100, expiresAt: 10000};
        }
        let transfer;
        if (mockTransfer) {
          if (request?.method === 'remote.transfer.negotiate') {
            if (mockAdaptive) mockServerSession?.enableAdaptiveTransfers();
            value = {capabilities: ['remote.transfer.v1', ...(mockAdaptive ? ['remote.transfer.adaptive.v1'] : [])]};
          }
          if (request?.method === 'conversation.view.get') transfer = mockSnapshot(mockTransferResult);
          if (request?.method === 'remote.transfer.chunk') {
            if (mockHoldChunk) {await mockHoldChunk; mockHoldChunk = undefined;}
            const snapshot = mockTransferSnapshots.get(params.id)!;
            const bytes = snapshot.bytes.slice(params.offset, params.offset + (mockAdaptive ? params.length : snapshot.ref.chunkBytes));
            value = {...snapshot.ref, offset: params.offset, byteLength: bytes.length, data: require('../src/remote/protocol').encodeBase64Url(bytes)};
          }
          if (request?.method === 'remote.transfer.release') {mockTransferSnapshots.delete(params.id); value = {ok: true};}
        }

        const response = mockServerSession?.encrypt({
          kind: 'response',
          requestId: request?.requestId,
          ok: !mockRpcErrorCode,
          ...(mockRpcErrorCode ? {error: {code: mockRpcErrorCode}} : transfer ? {transfer} : {result: value}),
        });
        mockListener?.({connectionId, type: 'message', message: JSON.stringify(response)});
      }
    }),
    disconnect: jest.fn(async () => undefined),
  },
  subscribeGatewayEvents: (callback: typeof mockListener) => {
    mockListener = callback;
    return () => {
      if (mockListener === callback) mockListener = undefined;
    };
  },
}));

import {RemoteClient, type RemoteEventMessage} from '../src/remote/client';
import type {PairedDesktop} from '../src/domain/pairing';
import type {DeviceIdentitySecret} from '../src/services/secureStore';

const mockRootSecret = randomBase64Url(32);
const mockServerKeyPair = createP256KeyPair();
const deviceKeyPair = createP256KeyPair();
const mockIdentity: DeviceIdentitySecret = {
  version: 2,
  deviceId: 'device-remote-v2-client-test-0001',
  privateKey: deviceKeyPair.privateKey,
  publicKey: deviceKeyPair.publicKey,
  createdAt: '2026-10-14T00:00:00.000Z',
};
const mockDesktop: PairedDesktop = {
  id: 'mockDesktop-remote-v2-client-test-0001',
  name: 'Fixture Desktop',
  endpoint: 'https://192.168.1.88:17860',
  endpoints: ['https://192.168.1.88:17860'],
  certificateFingerprint: 'AA'.repeat(32),
  desktopIdentityPublicKey: createP256KeyPair().publicKey,
  tlsMode: 'pinned',
  pairedAt: '2026-10-14T00:00:00.000Z',
};

describe('RemoteClient encrypted transport boundary', () => {
  beforeEach(() => {
    mockListener = undefined;
    mockServerSession = undefined;
    mockSentTexts.length = 0;
    mockHoldBusinessSend = undefined;
    mockRpcErrorCode = undefined;

    mockV11 = false; mockMethods.length = 0; mockOperationItems.length = 0;

    mockTransfer = false; mockAdaptive = false; mockTransferResult = undefined; mockHoldChunk = undefined; mockTransferSnapshots.clear();
  });

  it('explicitly negotiates adaptive transfers before consuming larger response chunks', async () => {
    mockTransfer = true; mockAdaptive = true;
    const full = {text: '完整协商结果'.repeat(150000)}; mockTransferResult = full;
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}});
    try {
      await client.connect();
      await expect(client.request('conversation.view.get', {conversationId: 'conversation-adaptive-negotiation'})).resolves.toEqual(full);
      expect(mockMethods[0]).toBe('remote.transfer.negotiate');
      const encrypted = mockSentTexts.map(text => JSON.parse(text)).filter(frame => frame.type === 'remote.encrypted');
      expect(encrypted.map(frame => frame.sequence)).toEqual(encrypted.map((_, index) => index + 1));
      expect(mockMethods.filter(method => method === 'conversation.view.get')).toHaveLength(1);
      await expect(client.request('remote.ping')).resolves.toMatchObject({e2ee: true});
    } finally {await client.close();}
  });


  it('transparently restores an entire large view while preserving the original request ID and connection', async () => {
    mockTransfer = true;
    const full = {messages: [{uiMessageId: 'same-continuous-bubble', payload: {content: '长中文😀完整正文'.repeat(30000)}}], tasks: [{content: '全量任务'}], runtime: {execution: {state: 'idle'}}};
    mockTransferResult = full;
    const statuses: string[] = [];
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}, onStatus: status => statuses.push(status)});
    try {
      await client.connect();
      expect(mockMethods).toContain('remote.transfer.negotiate');
      await expect(client.request('conversation.view.get', {conversationId: 'conversation-full-view-fixture'})).resolves.toEqual(full);
      expect(mockMethods.filter(method => method === 'conversation.view.get')).toHaveLength(1);
      expect(mockMethods.filter(method => method === 'remote.transfer.chunk').length).toBeGreaterThan(2);
      expect(statuses.at(-1)).toBe('online');
      await expect(client.request('remote.ping')).resolves.toMatchObject({e2ee: true});
    } finally {await client.close();}
  });

  it('delivers a large event before later terminal events without blocking chunk replies or exposing transport notices', async () => {
    mockTransfer = true;
    const events: RemoteEventMessage[] = [];
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}, onEvent: event => events.push(event)});
    let release!: () => void;
    try {
      await client.connect();
      events.length = 0;
      mockHoldChunk = new Promise<void>(resolve => {release = resolve;});
      const tasks = Array.from({length: 10}, () => ({content: '完整任务'.repeat(1200)}));
      const ref = mockSnapshot({kind: 'event', event: 'conversation.tasks.updated', payload: {conversationId: 'conversation-full-event-fixture', tasks}});
      const emit = (value: Record<string, unknown>) => mockListener?.({connectionId: client.connectionId, type: 'message', message: JSON.stringify(mockServerSession!.encrypt(value))});
      emit({kind: 'event', event: 'remote.transfer.ready', payload: {transfer: ref}});
      emit({kind: 'event', event: 'assistant.completed', payload: {conversationId: 'conversation-full-event-fixture', requestId: 'request-terminal-fixture'}});
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(events).toHaveLength(0);
      release();
      for (let i = 0; i < 300; i++) await Promise.resolve();
      expect(events.map(event => event.event)).toEqual(['conversation.tasks.updated', 'assistant.completed']);
      expect(events[0].payload.tasks).toEqual(tasks);
      expect(events.some(event => event.event.startsWith('remote.transfer'))).toBe(false);
    } finally {release?.(); await client.close();}
  });

  it('drops an unfinished large result immediately on disconnect and never replays its request', async () => {
    mockTransfer = true; mockTransferResult = {text: '未完成'.repeat(80000)};
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}});
    let release!: () => void;
    await client.connect();
    mockHoldChunk = new Promise<void>(resolve => {release = resolve;});
    const result = client.request('conversation.view.get', {conversationId: 'conversation-disconnect-fixture'}).catch(error => error.code);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await client.close(); release();
    expect(await result).toBe('remote_client_closed');
    expect(mockMethods.filter(method => method === 'conversation.view.get')).toHaveLength(1);
  });


  it('runs negotiated resources/durable writes through real encrypted RemoteClient and reconciles stored IDs without resend', async () => {
    mockV11 = true;
    mockOperationItems.push({operationId: 'command-before-mobile-restart', conversationId: 'conversation-client-v11', issuedAt: 100});
    const recovered = jest.fn();
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}, onEvent: recovered});
    try {
      await client.connect();
      await expect(client.request('workspace.bootstrap.get')).resolves.toEqual({method: 'workspace.bootstrap.get', e2ee: true});
      await expect(client.request('workspace.project.create', {name: 'Synthetic'})).resolves.toEqual({ok: true});
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(mockMethods).toContain('resource.get'); expect(mockMethods).toContain('command.submit'); expect(mockMethods).toContain('operation.status.get');
      expect(mockMethods.filter(method => method === 'command.submit')).toHaveLength(1);
      expect(mockOperationItems).toHaveLength(0);
      expect(recovered.mock.calls.some(([event]) => event.event === 'remote.operation.recovered')).toBe(true);
      expect(mockSentTexts.slice(1).every(text => !text.includes('workspace.project.create'))).toBe(true);
    } finally {await client.close();}
  });


  it('sends an actual 512 KiB chunk inside a bounded encrypted frame and keeps ping working', async () => {
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}});
    try {
      await client.connect();
      const data = encodeBase64Url(new Uint8Array(512 * 1024).fill(7));
      await expect(client.request('attachment.chunk', {uploadId: 'upload-client-boundary-0001', index: 0, data})).resolves.toMatchObject({method: 'attachment.chunk', e2ee: true});
      const encrypted = mockSentTexts.map(text => JSON.parse(text)).find(frame => frame.type === 'remote.encrypted');
      const bytes = JSON.stringify(encrypted).length;
      expect(bytes).toBeGreaterThan(512 * 1024);
      expect(bytes).toBeLessThanOrEqual(REMOTE_MAX_FRAME_BYTES);
      await expect(client.request('remote.ping')).resolves.toMatchObject({e2ee: true});
    } finally {await client.close();}
  });


  it('rejects a locally oversized frame without disconnecting or consuming its send sequence', async () => {
    const statuses: string[] = [];
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}, onStatus: value => statuses.push(value)});
    try {
      await client.connect();
      await expect(client.request('attachment.chunk', {data: 'a'.repeat(REMOTE_MAX_FRAME_BYTES * 3 / 4)})).rejects.toMatchObject({code: 'remote_payload_size_invalid'});
      expect(statuses.at(-1)).toBe('online');
      await expect(client.request('remote.ping')).resolves.toMatchObject({e2ee: true});
      const frames = mockSentTexts.map(text => JSON.parse(text)).filter(item => item.type === 'remote.encrypted');
      expect(frames.map(frame => frame.sequence)).toEqual([1]);
    } finally {await client.close();}
  });


  it('recovers 64-ID batches with at most four in flight and a failed first batch cannot block later cleanup', async () => {
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}});
    await client.connect();
    const internals = client as any;
    internals.operationBatchSupported = true;
    const count = 321;
    mockOperationItems.push(...Array.from({length: count}, (_, i) => ({operationId: `command-batch-fixture-${i}`, conversationId: null, issuedAt: Date.now() - 120000})));
    const waits: Array<{ids: string[]; resolve: (result: unknown) => void; reject: (error: Error) => void}> = [];
    let inFlight = 0, peak = 0;
    internals.rawRequestTracked = jest.fn((method: string, params: any) => {
      if (method === 'remote.contract.negotiate') return {response: Promise.resolve({})};
      expect(method).toBe('operation.status.batch');
      expect(params.operationIds.length).toBeLessThanOrEqual(64);
      inFlight++; peak = Math.max(peak, inFlight);
      return {response: new Promise((resolve, reject) => waits.push({ids: params.operationIds, resolve, reject})).finally(() => inFlight--)};
    });
    const flush = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
    try {
      const recovery = internals.reconcilePendingOperations();
      await flush();
      expect(waits).toHaveLength(4);
      const complete = (slot: number) => waits[slot].resolve({items: waits[slot].ids.map(operationId => ({operationId, terminal: true, state: 'succeeded', code: null}))});
      complete(1); await flush();
      expect(mockOperationItems).toHaveLength(count - 64); // no wait for stalled batch zero
      complete(2); complete(3); await flush();
      expect(waits).toHaveLength(6);
      complete(4); complete(5); waits[0].reject(new Error('synthetic timeout'));
      await recovery;
      expect(peak).toBe(4);
      expect(mockOperationItems).toHaveLength(64);
      expect(mockOperationItems.every(item => waits[0].ids.includes(item.operationId))).toBe(true);
    } finally {await client.close();}
  });

  it('isolates a failed legacy status query and ignores results from a closed generation', async () => {
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}});
    await client.connect();
    const internals = client as any;
    mockOperationItems.push(...Array.from({length: 6}, (_, i) => ({operationId: `command-legacy-recovery-${i}`, conversationId: null, issuedAt: Date.now() - 120000})));
    internals.rawRequestTracked = jest.fn((method: string, params: any) => ({response: method === 'remote.contract.negotiate' ? Promise.resolve({}) : params.operationId.endsWith('-0') ? Promise.reject(new Error('timeout')) : Promise.resolve({operationId: params.operationId, conversationId: null, state: 'succeeded', terminal: true, code: null, receipt: null, progress: null, acceptedAt: 1, expiresAt: 2})}));
    await internals.reconcilePendingOperations();
    expect(mockOperationItems.map(item => item.operationId)).toEqual(['command-legacy-recovery-0']);
    internals.operationBatchSupported = true;
    let finish!: (value: unknown) => void;
    internals.rawRequestTracked = (method: string) => ({response: method === 'remote.contract.negotiate' ? Promise.resolve({}) : new Promise(resolve => {finish = resolve;})});
    const recovery = internals.reconcilePendingOperations();
    for (let i = 0; i < 15; i++) await Promise.resolve();
    await client.close();
    finish({items: [{operationId: 'command-legacy-recovery-0', state: 'succeeded', terminal: true}]});
    await recovery;
    expect(mockOperationItems).toHaveLength(1);
  });


  it('retires a terminal event immediately without resubmitting or waiting for the recovery sweep', async () => {
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}});
    await client.connect();
    const operationId = 'command-immediate-terminal-fixture';
    mockOperationItems.push({operationId, conversationId: null, issuedAt: Date.now()});
    (client as any).deliverEvent({kind: 'event', event: 'assistant.completed', payload: {requestId: operationId}});
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(mockOperationItems).toHaveLength(0);
    expect(mockMethods).not.toContain('command.submit');
    await client.close();
  });


  it('keeps the original config deadline while an oversized result is being reassembled', async () => {
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}});
    await client.connect();
    const internals = client as any;
    const original = (PinnedGateway.sendText as jest.Mock).getMockImplementation();
    (PinnedGateway.sendText as jest.Mock).mockImplementation(async () => undefined);
    jest.useFakeTimers();
    let finishRead!: (value: unknown) => void;
    internals.transferEnabled = true;
    internals.transfers = {read: () => new Promise(resolve => {finishRead = resolve;}), close: () => {}};
    try {
      const request = internals.rawRequestTracked('resource.get', {resource: 'conversation.config.get'});
      const outcome = request.response.catch((error: Error) => error);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await jest.advanceTimersByTimeAsync(119000);
      internals.handleResponse({requestId: request.requestId, ok: true, transfer: {id: 'synthetic'}});
      await jest.advanceTimersByTimeAsync(1000);
      expect(await outcome).toMatchObject({code: 'remote_request_timeout'});
      finishRead({late: true});
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(internals.pending.has(request.requestId)).toBe(false);
    } finally {
      (PinnedGateway.sendText as jest.Mock).mockImplementation(original);
      jest.useRealTimers(); await client.close();
    }
  });


  it('starts the 120-second config timeout only at network submission and never consumes a sequence while queued', async () => {
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity, credential: {rootSecret: mockRootSecret}});
    await client.connect();
    const internals = client as any;
    jest.useFakeTimers();
    let release!: () => void;
    internals.sendQueue = new Promise<void>(resolve => {release = resolve;});
    const original = (PinnedGateway.sendText as jest.Mock).getMockImplementation();
    (PinnedGateway.sendText as jest.Mock).mockImplementation(async () => undefined);
    try {
      let settled = false;
      const pending = internals.rawRequestTracked('resource.get', {resource: 'conversation.config.get'}, 1000).response.catch((error: Error) => {settled = true; return error;});
      await jest.advanceTimersByTimeAsync(130000);
      expect(settled).toBe(false);
      release(); for (let i = 0; i < 10; i++) await Promise.resolve();
      await jest.advanceTimersByTimeAsync(119999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({code: 'remote_request_timeout'});
    } finally {
      (PinnedGateway.sendText as jest.Mock).mockImplementation(original);
      jest.useRealTimers(); await client.close();
    }
  });


  it('authenticates before online and carries RPC only in encrypted frames', async () => {
    const statuses: string[] = [];
    const events: string[] = [];
    const client = new RemoteClient({
      desktop: mockDesktop,
      identity: mockIdentity,
      credential: {rootSecret: mockRootSecret},
      onStatus: status => statuses.push(status),
      onEvent: event => events.push(event.event),
    });
    await client.connect();
    await expect(client.request('remote.status.get', {includeDevices: true})).resolves.toEqual({
      method: 'remote.status.get',
      e2ee: true,
    });
    expect(statuses).toEqual(['connecting', 'handshaking', 'online']);
    expect(events).toEqual(['remote.welcome']);
    expect(mockSentTexts).toHaveLength(2);
    expect(JSON.parse(mockSentTexts[0]).type).toBe('remote.session.hello');
    const encrypted = JSON.parse(mockSentTexts[1]);
    expect(encrypted.type).toBe('remote.encrypted');
    expect(mockSentTexts[1]).not.toContain('remote.status.get');
    await client.close();
  });

  it('serializes concurrent encrypted sends so Desktop receives strict sequences', async () => {
    const client = new RemoteClient({
      desktop: mockDesktop,
      identity: mockIdentity,
      credential: {rootSecret: mockRootSecret},
    });
    await client.connect();
    let releaseFirst!: () => void;
    mockHoldBusinessSend = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = client.request('workspace.bootstrap.get');
    const second = client.request('conversation.assistants.list');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSentTexts.filter(text => JSON.parse(text).type === 'remote.encrypted')).toHaveLength(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      {method: 'workspace.bootstrap.get', e2ee: true},
      {method: 'conversation.assistants.list', e2ee: true},
    ]);
    const sequences = mockSentTexts
      .map(text => JSON.parse(text) as {type?: string; sequence?: number})
      .filter(frame => frame.type === 'remote.encrypted')
      .map(frame => frame.sequence);
    expect(sequences).toEqual([1, 2]);
    await client.close();
  });


  it.each(['remote_response_too_large', 'remote_response_invalid'])(
    'rejects only the RPC for %s and keeps the same encrypted session usable', async code => {
      const onStatus = jest.fn();
      const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity,
        credential: {rootSecret: mockRootSecret}, onStatus});
      await client.connect();
      mockRpcErrorCode = code;
      await expect(client.request('workspace.bootstrap.get')).rejects.toMatchObject({code});
      expect(onStatus).not.toHaveBeenCalledWith('closed', expect.anything());
      mockRpcErrorCode = undefined;
      await expect(client.request('remote.ping')).resolves.toMatchObject({method: 'remote.ping'});
      await client.close();
    },
  );


  it('preserves a whitelisted Desktop close reason without raw native text', async () => {
    const onStatus = jest.fn();
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity,
      credential: {rootSecret: mockRootSecret}, onStatus});
    await client.connect();
    mockListener?.({connectionId: client.connectionId, type: 'disconnected',
      closeCode: 1011, closeReason: 'response_send_failed', message: 'private native text'});
    expect(onStatus).toHaveBeenLastCalledWith('closed', 'server_close:1011:response_send_failed');
    await expect(client.request('remote.ping')).rejects.toMatchObject({code: 'remote_client_offline'});
  });

  it('distinguishes a local encrypted receive sequence rejection', async () => {
    const onStatus = jest.fn();
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity,
      credential: {rootSecret: mockRootSecret}, onStatus});
    await client.connect();
    mockServerSession!.encrypt({kind: 'event', event: 'fixture.skipped'});
    const skippedSequence = mockServerSession!.encrypt({kind: 'event', event: 'fixture.next'});
    mockListener?.({connectionId: client.connectionId, type: 'message', message: JSON.stringify(skippedSequence)});
    expect(onStatus).toHaveBeenLastCalledWith('closed', 'mobile:remote_frame_out_of_order');
  });

  it('preserves an authenticated Desktop protocol rejection', async () => {
    const onStatus = jest.fn();
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity,
      credential: {rootSecret: mockRootSecret}, onStatus});
    await client.connect();
    const rejection = mockServerSession!.encrypt({kind: 'event', event: 'remote.error',
      payload: {code: 'remote_frame_auth_failed'}});
    mockListener?.({connectionId: client.connectionId, type: 'message', message: JSON.stringify(rejection)});
    expect(onStatus).toHaveBeenLastCalledWith('closed', 'server_error:remote_frame_auth_failed');
  });

  it('classifies transport errors without exposing native exception text', async () => {
    const onStatus = jest.fn();
    const client = new RemoteClient({desktop: mockDesktop, identity: mockIdentity,
      credential: {rootSecret: mockRootSecret}, onStatus});
    await client.connect();
    mockListener?.({connectionId: client.connectionId, type: 'error',
      failureKind: 'timeout', message: 'https://private.invalid/fixture'});
    expect(onStatus).toHaveBeenLastCalledWith('closed', 'transport:timeout');
  });


  it('does not accept a request before the authenticated welcome event', async () => {
    const client = new RemoteClient({
      desktop: mockDesktop,
      identity: mockIdentity,
      credential: {rootSecret: mockRootSecret},
    });
    await expect(client.request('remote.ping')).rejects.toMatchObject({
      code: 'remote_client_offline',
    });
  });
});
