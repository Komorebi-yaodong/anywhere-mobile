import type {PairedDesktop} from '../domain/pairing';
import {
  GatewayEvent,
  PinnedGateway,
  subscribeGatewayEvents,
  TransportTlsOptions,
} from '../native/PinnedGateway';
import type {DeviceIdentitySecret} from '../services/secureStore';
import {randomBase64Url} from './crypto';
import {gatewayFailureDetail, localFailureDetail, safeRemoteFailureCode} from './connectionDiagnostics';
import {
  completeSessionHello,
  createSessionHello,
  EncryptedFrame,
  RemoteCryptoSession,
  SessionAccept,
  SessionHelloState,
} from './session';
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SOCKET_PATH,
  remoteError,
} from './protocol';

export type RemoteClientStatus =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'online'
  | 'closed';

export type RemoteEventMessage = {
  kind: 'event';
  event: string;
  payload: Record<string, unknown>;
};

export class RemoteRpcError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RemoteRpcError';
    this.code = code;
  }
}

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ClientOptions = {
  desktop: PairedDesktop;
  credential: {rootSecret: string};
  identity: DeviceIdentitySecret;
  onStatus?: (status: RemoteClientStatus, detail?: string) => void;
  onEvent?: (event: RemoteEventMessage) => void;
};

export class RemoteClient {
  readonly connectionId = `connection-${randomBase64Url(18)}`;

  private readonly desktop: PairedDesktop;
  private readonly rootSecret: string;
  private readonly identity: DeviceIdentitySecret;
  private readonly onStatus?: ClientOptions['onStatus'];
  private readonly onEvent?: ClientOptions['onEvent'];
  private status: RemoteClientStatus = 'idle';
  private unsubscribe?: () => void;
  private helloState?: SessionHelloState;
  private cryptoSession?: RemoteCryptoSession;
  private connectResolve?: () => void;
  private connectReject?: (error: Error) => void;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, PendingRpc>();
  // Encryption advances a strict per-session sequence. Native bridge promises
  // may settle out of order, so frame construction and transport submission
  // must share one queue for the lifetime of this client connection.
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(options: ClientOptions) {
    this.desktop = options.desktop;
    this.rootSecret = options.credential.rootSecret;
    this.identity = options.identity;
    this.onStatus = options.onStatus;
    this.onEvent = options.onEvent;
  }

  async connect(): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'closed') {
      throw remoteError('remote_client_state_invalid');
    }
    this.cleanup(false);
    this.setStatus('connecting');
    this.unsubscribe = subscribeGatewayEvents(event => this.handleGatewayEvent(event));
    const connected = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = setTimeout(
        () => this.failConnection(new RemoteRpcError('remote_connect_timeout')),
        20_000,
      );
    });
    try {
      const nativeConnect = PinnedGateway.connectSocket({
        connectionId: this.connectionId,
        endpoint: this.desktop.endpoint,
        path: REMOTE_SOCKET_PATH,
        ...this.tlsOptions(),
      });
      await Promise.all([nativeConnect, connected]);
    } catch (error) {
      this.failConnection(asError(error));
      throw error;
    }
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 20_000,
  ): Promise<T> {
    return this.requestTracked<T>(method, params, timeoutMs).response;
  }

  requestTracked<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 20_000,
  ): {requestId: string; response: Promise<T>} {
    if (this.status !== 'online' || !this.cryptoSession) {
      throw new RemoteRpcError('remote_client_offline');
    }
    const requestId = `request-${randomBase64Url(18)}`;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RemoteRpcError('remote_request_timeout'));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
    });
    const submit = this.sendQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.status !== 'online' || !this.cryptoSession) {
          throw new RemoteRpcError('remote_client_offline');
        }
        const frame = this.cryptoSession.encrypt({
          kind: 'request',
          requestId,
          method,
          params,
        });
        await PinnedGateway.sendText(this.connectionId, JSON.stringify(frame));
      });
    this.sendQueue = submit.catch(() => undefined);
    submit.catch(error => {
      const transportError = error instanceof RemoteRpcError && error.code === 'remote_client_offline'
        ? error
        : new RemoteRpcError('remote_transport_error');
      this.rejectPending(requestId, transportError);
      // Encryption consumed a sequence only after this serialized submission
      // began. Never continue on a transport whose delivery is uncertain.
      if (transportError.code === 'remote_transport_error') this.failConnection(transportError);
    });
    return {requestId, response};
  }

  async close(): Promise<void> {
    this.connectReject?.(new RemoteRpcError('remote_client_closed'));
    this.cleanup(true);
    await PinnedGateway.disconnect(this.connectionId).catch(() => undefined);
  }

  private tlsOptions(): TransportTlsOptions {
    return this.desktop.tlsMode === 'pinned'
      ? {
          tlsMode: 'pinned',
          certificateFingerprint: this.desktop.certificateFingerprint,
        }
      : {tlsMode: 'system'};
  }

  private async handleGatewayEvent(event: GatewayEvent): Promise<void> {
    if (event.connectionId !== this.connectionId || this.status === 'closed') {
      return;
    }
    try {
      if (event.type === 'connected') {
        const handshake = createSessionHello({
          rootSecret: this.rootSecret,
          deviceId: this.identity.deviceId,
          desktopId: this.desktop.id,
        });
        this.helloState = handshake.state;
        this.setStatus('handshaking');
        await PinnedGateway.sendText(
          this.connectionId,
          JSON.stringify(handshake.hello),
        );
        return;
      }
      if (event.type === 'message') {
        this.handleText(event.message ?? '');
        return;
      }
      if (event.type === 'error' || event.type === 'disconnected') {
        this.failConnection(
          new RemoteRpcError(
            event.type === 'error'
              ? 'remote_transport_error'
              : 'remote_transport_closed',
          ),
          gatewayFailureDetail(event),
        );
      }
    } catch (error) {
      this.failConnection(asError(error));
      await PinnedGateway.disconnect(this.connectionId).catch(() => undefined);
    }
  }

  private handleText(text: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw remoteError('remote_socket_message_invalid');
      }
      message = parsed as Record<string, unknown>;
    } catch (error) {
      throw error instanceof Error
        ? error
        : remoteError('remote_socket_message_invalid');
    }

    if (!this.cryptoSession) {
      if (!this.helloState) {
        throw remoteError('remote_session_state_invalid');
      }
      this.cryptoSession = completeSessionHello({
        state: this.helloState,
        accept: message as SessionAccept,
        expectedDeviceId: this.identity.deviceId,
        expectedDesktopId: this.desktop.id,
      });
      this.helloState = undefined;
      return;
    }

    const payload = this.cryptoSession.decrypt(message as EncryptedFrame);
    if (payload.kind === 'response') {
      this.handleResponse(payload);
      return;
    }
    if (payload.kind !== 'event' || typeof payload.event !== 'string') {
      throw remoteError('remote_message_kind_invalid');
    }
    const event: RemoteEventMessage = {
      kind: 'event',
      event: payload.event,
      payload:
        payload.payload &&
        typeof payload.payload === 'object' &&
        !Array.isArray(payload.payload)
          ? (payload.payload as Record<string, unknown>)
          : {},
    };
    if (event.event === 'remote.error') {
      this.failConnection(
        new RemoteRpcError('remote_transport_closed'),
        `server_error:${safeRemoteFailureCode(event.payload.code)}`,
      );
      return;
    }

    if (event.event === 'remote.welcome') {
      const protocolVersion = Number(event.payload.protocolVersion);
      if (
        protocolVersion !== REMOTE_PROTOCOL_VERSION ||
        event.payload.desktopId !== this.desktop.id
      ) {
        throw remoteError('remote_welcome_invalid');
      }
      this.setStatus('online');
      this.finishConnect();
    }
    this.onEvent?.(event);
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(error);
  }


  private handleResponse(payload: Record<string, unknown>): void {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (payload.ok === true) {
      pending.resolve(payload.result);
      return;
    }
    const error = payload.error;
    const code =
      error && typeof error === 'object' && !Array.isArray(error)
        ? (error as {code?: unknown}).code
        : undefined;
    pending.reject(
      new RemoteRpcError(
        typeof code === 'string' ? code : 'remote_request_failed',
      ),
    );
  }

  private finishConnect(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    this.connectResolve?.();
    this.connectResolve = undefined;
    this.connectReject = undefined;
  }

  private failConnection(error: Error, detail?: string): void {
    if (this.status === 'closed') return;
    this.connectReject?.(error);
    this.cleanup(false);
    this.setStatus('closed', detail ?? localFailureDetail(error));
    PinnedGateway.disconnect(this.connectionId).catch(() => undefined);
  }

  private cleanup(closeStatus: boolean): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    this.connectResolve = undefined;
    this.connectReject = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.helloState = undefined;
    this.cryptoSession?.close();
    this.cryptoSession = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RemoteRpcError('remote_client_closed'));
    }
    this.pending.clear();
    this.sendQueue = Promise.resolve();
    if (closeStatus) {
      this.setStatus('closed');
    }
  }

  private setStatus(status: RemoteClientStatus, detail?: string): void {
    this.status = status;
    this.onStatus?.(status, detail);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
