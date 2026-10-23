import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {AppState, type AppStateStatus} from 'react-native';
import type {RemoteClientStatus} from '../src/remote/client';
import type {PairedDesktop} from '../src/domain/pairing';
import {useDesktops} from '../src/hooks/useDesktops';

type MockClient = {onStatus: (status: RemoteClientStatus, detail?: string) => void};
const mockClients: MockClient[] = [];
const mockProbe = jest.fn(async () => ({}));
const mockConnectAttempt = jest.fn(async () => undefined);
const mockInitialize = jest.fn(async () => ({}));
let mockAppStateListener: (state: AppStateStatus) => void;
const mockRemoveListener = jest.fn();
const mockDesktop: PairedDesktop = {
  id: 'desktop-reconnect-fixture-0001', name: 'Fixture Desktop',
  endpoint: 'https://192.168.1.88:17860', endpoints: ['https://192.168.1.88:17860'],
  tlsMode: 'pinned', certificateFingerprint: 'AA'.repeat(32),
  desktopIdentityPublicKey: 'fixture', pairedAt: '2026-10-19T00:00:00.000Z',
};
jest.mock('../src/services/secureStore', () => ({
  loadDesktopIndex: jest.fn(async () => [mockDesktop]),
  loadDesktopCredential: jest.fn(async () => ({rootSecret: 'fixture'})),
  loadOrCreateDeviceIdentity: jest.fn(async () => ({deviceId: 'fixture'})),
  saveDesktopIndex: jest.fn(async () => undefined),
  removeDesktopCredential: jest.fn(async () => undefined),
}));
jest.mock('../src/remote/client', () => ({
  RemoteClient: class {
    readonly options: MockClient;
    constructor(mockOptions: MockClient) {
      this.options = mockOptions;
      mockClients.push(mockOptions);
    }
    async connect() {
      this.options.onStatus('connecting');
      this.options.onStatus('handshaking');
      try { await mockConnectAttempt(); } catch (error) {
        this.options.onStatus('closed', 'transport:network_io');
        throw error;
      }
      this.options.onStatus('online');
    }
    async request(method: string) { return method === 'remote.ping' ? mockProbe() : mockInitialize(); }
    async close() { this.options.onStatus('closed'); }
  },
}));

let latest!: ReturnType<typeof useDesktops>;
function Harness() { latest = useDesktops(); return null; }

describe('Desktop reconnect lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers(); mockClients.length = 0;
    mockProbe.mockReset().mockResolvedValue({});
    mockConnectAttempt.mockReset().mockResolvedValue(undefined);
    mockInitialize.mockReset().mockResolvedValue({});
    mockRemoveListener.mockClear();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      mockAppStateListener = listener;
      return {remove: mockRemoveListener};
    });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('retains the close diagnostic and increases delay across welcome/close loops', async () => {
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<Harness />); });
    expect(mockClients).toHaveLength(1);
    expect(latest.desktops[0].status).toBe('在线');
    await act(async () => {
      mockClients[0].onStatus('closed', 'server_close:1011:response_send_failed');
    });
    expect(latest.desktops[0].detail).toBe('Desktop 关闭连接（1011 / response_send_failed）\n1 秒后重连');
    await act(async () => { jest.advanceTimersByTime(999); });
    expect(mockClients).toHaveLength(1);
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(mockClients).toHaveLength(2);
    await act(async () => {
      mockClients[1].onStatus('closed', 'mobile:remote_frame_out_of_order');
    });
    expect(latest.desktops[0].detail).toBe('Mobile 连接校验失败（remote_frame_out_of_order）\n2 秒后重连');
    await act(async () => { jest.advanceTimersByTime(2000); });
    expect(mockClients).toHaveLength(3);
    await act(async () => {
      mockClients[2].onStatus('closed', 'transport:timeout');
    });
    expect(latest.desktops[0].detail).toBe('网络传输中断（timeout）\n4 秒后重连');
    await act(async () => { root.unmount(); });
  });

  it('pauses background retry and immediately restores a disconnected foreground session', async () => {
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<Harness />); });
    await act(async () => {
      mockAppStateListener('background');
      mockClients[0].onStatus('closed', 'transport:network_io');
      jest.advanceTimersByTime(60_000);
    });
    expect(mockClients).toHaveLength(1);
    expect(latest.desktops[0].detail).toBe('回到前台后恢复连接。');
    await act(async () => { mockAppStateListener('active'); });
    expect(mockClients).toHaveLength(2);
    expect(latest.desktops[0].status).toBe('在线');
    await act(async () => root.unmount());
    expect(mockRemoveListener).toHaveBeenCalled();
  });

  it('probes and reuses a healthy native socket on resume rather than closing it', async () => {
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<Harness />); });
    await act(async () => { mockAppStateListener('background'); });
    await act(async () => { mockAppStateListener('active'); });
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockClients).toHaveLength(1);
    expect(latest.desktops[0].status).toBe('在线');
    await act(async () => root.unmount());
  });

  it('keeps the healthy socket online while the foreground probe is pending, including photo-picker return', async () => {
    let finish!: (value: {}) => void;
    mockProbe.mockImplementationOnce(() => new Promise<{}>(resolve => {finish = resolve;}));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => {root = TestRenderer.create(<Harness />);});
    await act(async () => {mockAppStateListener('background'); mockAppStateListener('active');});
    expect(latest.desktops[0].status).toBe('在线'); expect(mockClients).toHaveLength(1);
    await act(async () => finish({}));
    expect(latest.desktops[0].status).toBe('在线');
    await act(async () => root.unmount());
  });

  it('does not kill a working socket when a foreground application ping times out behind transfers', async () => {
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => {root = TestRenderer.create(<Harness />);});
    mockProbe.mockRejectedValueOnce(Object.assign(new Error('queued ping'), {code: 'remote_request_timeout'}));
    await act(async () => {mockAppStateListener('background'); mockAppStateListener('active');});
    expect(mockClients).toHaveLength(1); expect(latest.desktops[0].status).toBe('在线');
    await act(async () => root.unmount());
  });


  it('replaces a stale foreground socket once and preserves subsequent failure diagnostics', async () => {
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<Harness />); });
    mockProbe.mockRejectedValueOnce(new Error('synthetic stale socket'));
    await act(async () => { mockAppStateListener('background'); });
    await act(async () => { mockAppStateListener('active'); });
    expect(mockClients).toHaveLength(2);
    await act(async () => { mockClients[1].onStatus('closed', 'transport:network_io'); });
    expect(latest.desktops[0].detail).toContain('network_io');
    await act(async () => root.unmount());
  });


  it('manual reconnect bypasses retry delay and ignores old-generation callbacks', async () => {
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<Harness />); });
    const old = mockClients[0];
    await act(async () => { old.onStatus('closed', 'transport:network_io'); });
    await act(async () => { await latest.reconnect(mockDesktop.id); });
    expect(mockClients).toHaveLength(2);
    await act(async () => { old.onStatus('closed', 'transport:timeout'); old.onStatus('online'); });
    expect(latest.desktops[0].status).toBe('在线');
    expect(latest.desktops[0].detail).toBeUndefined();
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(mockClients).toHaveLength(2);
    await act(async () => root.unmount());
  });

  it('continues retrying after many transient drops rather than exhausting a retry budget', async () => {
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<Harness />); });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await act(async () => { mockClients.at(-1)!.onStatus('closed', 'transport:network_io'); });
      await act(async () => { jest.advanceTimersByTime(Math.min(1000 * 2 ** attempt, 30000)); });
      expect(mockClients).toHaveLength(attempt + 2);
    }
    expect(latest.desktops[0].status).toBe('在线');
    await act(async () => root.unmount());
  });


  it('recovers after eight initial connection failures without restarting the app', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) mockConnectAttempt.mockRejectedValueOnce(new Error('synthetic no signal'));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<Harness />); });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(latest.desktops[0].status).toBe('离线');
      await act(async () => { jest.advanceTimersByTime(Math.min(1000 * 2 ** attempt, 30000)); });
    }
    expect(mockClients).toHaveLength(9);
    expect(latest.desktops[0].status).toBe('在线');
    await act(async () => root.unmount());
  });

  it('manual reconnect does not await a stalled initialization from the old connection', async () => {
    let release!: (value: {}) => void;
    mockInitialize.mockImplementationOnce(() => new Promise<{}>(resolve => { release = resolve; }));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<Harness />); });
    await act(async () => { await latest.reconnect(mockDesktop.id); });
    expect(mockClients).toHaveLength(2);
    expect(latest.desktops[0].status).toBe('在线');
    await act(async () => { release({}); });
    expect(latest.desktops[0].status).toBe('在线');
    await act(async () => root.unmount());
  });


  it('resets delay only after the socket stayed online for 30 seconds', async () => {
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<Harness />); });
    await act(async () => { mockClients[0].onStatus('closed', 'transport:network_io'); });
    await act(async () => { jest.advanceTimersByTime(1000); });
    await act(async () => { jest.advanceTimersByTime(31_000); });
    await act(async () => { mockClients[1].onStatus('closed', 'transport:network_io'); });
    expect(latest.desktops[0].detail).toContain('1 秒后重连');
    await act(async () => { root.unmount(); });
  });
});
