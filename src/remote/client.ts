import type {PairedDesktop} from '../domain/pairing';

import {createBusinessRouter} from './businessRouter';
import {createResultTransferReader, RESULT_TRANSFER_CAPABILITY} from './resultTransfer';
import {
  GatewayEvent,
  PinnedGateway,
  subscribeGatewayEvents,
  TransportTlsOptions,
} from '../native/PinnedGateway';
import {updatePendingOperations, type DeviceIdentitySecret} from '../services/secureStore';
import {validateDurableOperation} from '../../packages/remote-contract';
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

  private transfers?: ReturnType<typeof createResultTransferReader>;
  private transferEnabled = false;
  private eventQueue: Promise<void> = Promise.resolve();
  private eventGeneration = 0;


  private operationRecoveryTimer?: ReturnType<typeof setInterval>;
  private operationRecoveryRunning = false;

  private readonly submittingOperations = new Set<string>();

  private readonly business = createBusinessRouter((method, params = {}, timeout = 20000, requestId) => this.rawRequestTracked(method, params, timeout, requestId).response, {
    remember: async (id, params, issuedAt) => {await updatePendingOperations(this.desktop.id, items => items.some(item => item.operationId === id) ? items : [...items, {operationId: id, conversationId: typeof params.conversationId === 'string' ? params.conversationId : null, issuedAt}]);},
    settle: async id => {await updatePendingOperations(this.desktop.id, items => items.filter(item => item.operationId !== id));},
  });

  private async reconcilePendingOperations(): Promise<void> {
    const items = await updatePendingOperations(this.desktop.id, current => current);
    if (!items.length) return;
    await this.rawRequestTracked('remote.contract.negotiate', {versions: [{major: 1, minor: 1}]}).response;
    for (const item of items) {

      if (this.submittingOperations.has(item.operationId)) continue;
      let result;
      try {result = validateDurableOperation(await this.rawRequestTracked('operation.status.get', {operationId: item.operationId}).response);}
      catch (cause) {
        if (!(cause instanceof RemoteRpcError) || cause.code !== 'remote_operation_not_found') throw cause;

        if (Date.now() - item.issuedAt < 60000) continue;
        this.onEvent?.({kind: 'event', event: 'remote.operation.recovered', payload: {...item, state: 'unknown', terminal: true}});
        await updatePendingOperations(this.desktop.id, current => current.filter(operation => operation.operationId !== item.operationId));
        continue;
      }
      if (result.terminal) {
        await updatePendingOperations(this.desktop.id, current => current.filter(operation => operation.operationId !== item.operationId));
        this.onEvent?.({kind: 'event', event: 'remote.operation.recovered', payload: {...item, state: result.state, code: result.code, terminal: true}});
      }
    }
  }

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

  requestTracked<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20000): {requestId: string; response: Promise<T>} {
    if (this.status !== 'online' || !this.cryptoSession) throw new RemoteRpcError('remote_client_offline');
    const issuedAt = Date.now();
    const requestId = `command-${issuedAt}-${randomBase64Url(18)}`;
    this.submittingOperations.add(requestId);
    const response = (this.business.route(method, params, timeoutMs, requestId, issuedAt) as Promise<T>).finally(() => this.submittingOperations.delete(requestId));
    return {requestId, response};
  }

  private rawRequestTracked<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 20_000,
    suppliedRequestId?: string,
  ): {requestId: string; response: Promise<T>} {
    if (this.status !== 'online' || !this.cryptoSession) {
      throw new RemoteRpcError('remote_client_offline');
    }
    const requestId = suppliedRequestId || `request-${randomBase64Url(18)}`;
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
      // Local validation failed before encrypt committed a sequence or a frame
      // reached native transport. Reject only this request, keep WSS usable.
      if (['remote_payload_size_invalid', 'remote_canonical_value_invalid'].includes((error as {code?: string})?.code || '')) {
        this.rejectPending(requestId, error);
        return;
      }
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

    if (event.event === 'remote.transfer.ready') {
      if (!this.transferEnabled || !this.transfers) throw remoteError('remote_transfer_not_negotiated');
      this.deliverEvent(event);
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
      this.business.welcome(event.payload.capabilities);

      this.setStatus('online');
      if (Array.isArray(event.payload.capabilities) && event.payload.capabilities.includes(RESULT_TRANSFER_CAPABILITY)) {
        const generation = this.eventGeneration;
        this.transferEnabled = true; // The request below explicitly opts in before any ready event can arrive.
        this.transfers = createResultTransferReader((method, params) => this.rawRequestTracked(method, params, 20_000).response);
        this.rawRequestTracked<{capabilities: string[]}>('remote.transfer.negotiate', {capabilities: [RESULT_TRANSFER_CAPABILITY]}).response.then(reply => {
          if (generation !== this.eventGeneration || this.status !== 'online') return;
          this.transferEnabled = reply?.capabilities?.includes(RESULT_TRANSFER_CAPABILITY) === true;
          this.finishConnect();
        }).catch(() => {if (generation === this.eventGeneration && this.status === 'online') {this.transferEnabled = false; this.finishConnect();}});
      } else this.finishConnect();

      if (Array.isArray(event.payload.capabilities) && event.payload.capabilities.includes('operation.status.get')) {
        const recover = async () => {
          if (this.operationRecoveryRunning || this.status !== 'online') return;
          this.operationRecoveryRunning = true;
          try {await this.reconcilePendingOperations();}
          catch {if (this.status === 'online') this.onEvent?.({kind: 'event', event: 'remote.operation.recovery.failed', payload: {}});}
          finally {this.operationRecoveryRunning = false;}
        };
        recover();
        this.operationRecoveryTimer = setInterval(recover, 5000);
      }
    }
    this.deliverEvent(event);
  }

  private deliverEvent(event: RemoteEventMessage): void {
    const generation = this.eventGeneration;
    const reader = this.transfers;
    // Decrypt incoming frames synchronously. Only callback delivery waits for a
    // large event, so chunk RPC replies can never deadlock behind this queue.
    this.eventQueue = this.eventQueue.catch(() => undefined).then(async () => {
      if (generation !== this.eventGeneration) return;
      let delivered = event;
      if (event.event === 'remote.transfer.ready') {
        try {
          const value = await reader!.read(event.payload.transfer) as RemoteEventMessage;
          if (!value || value.kind !== 'event' || typeof value.event !== 'string' ||
              value.event === 'remote.transfer.ready' || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) throw remoteError('remote_transfer_invalid');
          delivered = value;
        } catch {
          // Existing invalidation path retries authoritative reads silently.
          delivered = {kind: 'event', event: 'conversation.windows.changed', payload: {}};
        }
      }
      if (generation === this.eventGeneration && this.status === 'online') this.onEvent?.(delivered);
    }).catch(() => undefined);
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
      if (Object.hasOwn(payload, 'transfer')) {
        if (!this.transferEnabled || !this.transfers) {pending.reject(remoteError('remote_transfer_not_negotiated')); return;}
        const generation = this.eventGeneration;
        const reader = this.transfers;
        reader.read(payload.transfer).then(value => {
          if (generation !== this.eventGeneration || this.status !== 'online') throw remoteError('remote_client_closed');
          pending.resolve(value);
        }).catch(error => pending.reject(asError(error)));
        return;
      }
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

    this.eventGeneration += 1;
    this.transfers?.close();
    this.transfers = undefined;
    this.transferEnabled = false;
    this.eventQueue = Promise.resolve();

    if (this.operationRecoveryTimer) clearInterval(this.operationRecoveryTimer);
    this.operationRecoveryTimer = undefined;
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
