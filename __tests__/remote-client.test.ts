import {createP256KeyPair, randomBase64Url} from '../src/remote/crypto';
import type {
  RemoteCryptoSession,
  SessionHello,
} from '../src/remote/session';

let mockListener: ((event: {
  connectionId: string;
  type: 'connected' | 'disconnected' | 'error' | 'message';
  message?: string;
}) => void) | undefined;
let mockServerSession: RemoteCryptoSession | undefined;
const mockSentTexts: string[] = [];

jest.mock('../src/native/PinnedGateway', () => ({
  PinnedGateway: {
    connectSocket: jest.fn(async ({connectionId}) => {
      mockListener?.({connectionId, type: 'connected'});
    }),
    sendText: jest.fn(async (connectionId: string, text: string) => {
      mockSentTexts.push(text);
      const message = JSON.parse(text) as {type?: string};
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
                capabilities: {},
              },
            }),
          ),
        });
        return;
      }
      if (message.type === 'remote.encrypted') {
        const request = mockServerSession?.decrypt(message as never);
        const response = mockServerSession?.encrypt({
          kind: 'response',
          requestId: request?.requestId,
          ok: true,
          result: {method: request?.method, e2ee: true},
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
