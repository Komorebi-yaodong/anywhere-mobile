import {createP256KeyPair, randomBase64Url} from '../src/remote/crypto';
import type {
  RemoteCryptoSession,
  SessionHello,
} from '../src/remote/session';

import type {GatewayEvent} from '../src/native/PinnedGateway';

let mockListener: ((event: GatewayEvent) => void) | undefined;
let mockServerSession: RemoteCryptoSession | undefined;
const mockSentTexts: string[] = [];
let mockHoldBusinessSend: Promise<void> | undefined;

let mockRpcErrorCode: string | undefined;

let mockV11 = false;
const mockOperationItems: Array<{operationId: string; conversationId: string | null; issuedAt: number}> = [];
const mockMethods: string[] = [];
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
                capabilities: mockV11 ? ['remote.contract.negotiate', 'resource.get', 'command.submit', 'operation.status.get'] : {},
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
        const response = mockServerSession?.encrypt({
          kind: 'response',
          requestId: request?.requestId,
          ok: !mockRpcErrorCode,
          ...(mockRpcErrorCode ? {error: {code: mockRpcErrorCode}} : {result: value}),
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

import {RemoteClient} from '../src/remote/client';
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
