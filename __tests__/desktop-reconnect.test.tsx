import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import type {RemoteClientStatus} from '../src/remote/client';
import type {PairedDesktop} from '../src/domain/pairing';
import {useDesktops} from '../src/hooks/useDesktops';

type MockClient = {onStatus: (status: RemoteClientStatus, detail?: string) => void};
const mockClients: MockClient[] = [];
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
      this.options.onStatus('online');
    }
    async request() { return {}; }
    async close() { this.options.onStatus('closed'); }
  },
}));

let latest!: ReturnType<typeof useDesktops>;
function Harness() { latest = useDesktops(); return null; }

describe('Desktop reconnect lifecycle', () => {
  beforeEach(() => { jest.useFakeTimers(); mockClients.length = 0; });
  afterEach(() => { jest.useRealTimers(); });

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
