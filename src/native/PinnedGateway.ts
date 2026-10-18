import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

import {normalizeEndpoint, normalizeFingerprint} from '../domain/pairing';

export type TransportTlsOptions =
  | {tlsMode: 'pinned'; certificateFingerprint: string}
  | {tlsMode: 'system'};

export type HttpsPostOptions = TransportTlsOptions & {
  endpoint: string;
  path: string;
  body: string;
};

export type SocketConnectOptions = TransportTlsOptions & {
  connectionId: string;
  endpoint: string;
  path: string;
};

export type NativeHttpResponse = {
  status: number;
  body: string;
};

export type GatewayEvent = {
  connectionId: string;
  type: 'connected' | 'disconnected' | 'error' | 'message';
  message?: string;
  closeCode?: number;
  closeReason?: string;
  failureKind?: string;
};

type PinnedGatewayModule = {
  postJson(options: HttpsPostOptions): Promise<NativeHttpResponse>;
  connectSocket(options: SocketConnectOptions): Promise<void>;
  sendText(connectionId: string, text: string): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
};

const nativeModule = NativeModules.PinnedGateway as PinnedGatewayModule | undefined;

if (!nativeModule) {
  throw new Error(
    `PinnedGateway 原生模块不可用（${Platform.OS}）。请重新编译安装应用，不能降级为未固定证书或绕过系统 TLS 的 JavaScript 网络请求。`,
  );
}

const eventEmitter = new NativeEventEmitter(NativeModules.PinnedGateway);
const SAFE_PATH_PATTERN = /^\/(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^?#]*$/;

function normalizePath(path: string): string {
  const normalized = typeof path === 'string' ? path.trim() : '';
  if (!SAFE_PATH_PATTERN.test(normalized)) {
    throw new Error('Remote transport path 无效。');
  }
  return normalized;
}

function normalizeTls(options: TransportTlsOptions): TransportTlsOptions {
  if (options.tlsMode === 'pinned') {
    return {
      tlsMode: 'pinned',
      certificateFingerprint: normalizeFingerprint(
        options.certificateFingerprint,
      ),
    };
  }
  if (options.tlsMode === 'system') {
    return {tlsMode: 'system'};
  }
  throw new Error('tlsMode 必须是 pinned 或 system。');
}

export const PinnedGateway = {
  postJson(options: HttpsPostOptions): Promise<NativeHttpResponse> {
    return nativeModule.postJson({
      endpoint: normalizeEndpoint(options.endpoint),
      path: normalizePath(options.path),
      body: options.body,
      ...normalizeTls(options),
    });
  },
  connectSocket(options: SocketConnectOptions): Promise<void> {
    if (!options.connectionId.trim()) {
      throw new Error('connectionId 不能为空。');
    }
    return nativeModule.connectSocket({
      connectionId: options.connectionId.trim(),
      endpoint: normalizeEndpoint(options.endpoint),
      path: normalizePath(options.path),
      ...normalizeTls(options),
    });
  },
  sendText(connectionId: string, text: string): Promise<void> {
    if (!connectionId.trim()) {
      throw new Error('connectionId 不能为空。');
    }
    return nativeModule.sendText(connectionId.trim(), text);
  },
  disconnect(connectionId: string): Promise<void> {
    if (!connectionId.trim()) {
      throw new Error('connectionId 不能为空。');
    }
    return nativeModule.disconnect(connectionId.trim());
  },
};

export function subscribeGatewayEvents(
  listener: (event: GatewayEvent) => void,
): () => void {
  const subscription = eventEmitter.addListener(
    'AnywhereGatewayEvent',
    listener,
  );
  return () => subscription.remove();
}
