import {useCallback, useEffect, useRef, useState} from 'react';
import {Platform} from 'react-native';

import {
  orderedPairedEndpoints,
  withDesktopEndpoint,
  type DesktopStatus,
  type PairedDesktop,
  type PairingPayload,
} from '../domain/pairing';
import {RemoteClient, RemoteEventMessage} from '../remote/client';
import {describeConnectionFailure, reconnectDelayMs, stableConnectionMs} from '../remote/connectionDiagnostics';
import {pairDesktop} from '../remote/pairingClient';
import {isAvatarCacheValid} from '../services/avatarResourceCache';
import {
  loadDesktopCredential,
  loadDesktopIndex,
  loadOrCreateDeviceIdentity,
  removeDesktopCredential,
  saveDesktopIndex,
} from '../services/secureStore';

export type DesktopRuntime = PairedDesktop & {
  status: DesktopStatus;
  detail?: string;
};

const pingEveryMs = 20_000;

function deviceModel(): string {
  const constants = Platform.constants as {Brand?: unknown; Model?: unknown};
  return [constants.Brand, constants.Model]
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
    .join(' ')
    .slice(0, 80);
}

function defaultDeviceName(): string {
  return deviceModel() || 'Anywhere Mobile';
}

export function useDesktops() {
  const [desktops, setDesktops] = useState<DesktopRuntime[]>([]);
  const desktopsRef = useRef<DesktopRuntime[]>([]);
  const clients = useRef(new Map<string, RemoteClient>());

  const connectGenerations = useRef(new Map<string, number>());
  const connecting = useRef(new Map<string, Promise<void>>());
  const retryCount = useRef(new Map<string, number>());

  const lastFailures = useRef(new Map<string, string>());
  const reconnectTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const eventListeners = useRef(
    new Set<(desktopId: string, event: RemoteEventMessage) => void>(),
  );

  const replaceDesktops = useCallback((next: DesktopRuntime[]) => {
    desktopsRef.current = next;
    setDesktops(next);
  }, []);

  const update = useCallback(
    (id: string, patch: Partial<DesktopRuntime>) => {
      replaceDesktops(
        desktopsRef.current.map(item =>
          item.id === id ? {...item, ...patch} : item,
        ),
      );
    },
    [replaceDesktops],
  );

  const persist = useCallback(async (current: DesktopRuntime[]) => {
    await saveDesktopIndex(
      current.map(({status: _status, detail: _detail, ...desktop}) => desktop),
    );
  }, []);

  const clearReconnect = useCallback((desktopId: string) => {
    const timer = reconnectTimers.current.get(desktopId);
    if (timer) {
      clearTimeout(timer);
    }
    reconnectTimers.current.delete(desktopId);
  }, []);

  const connectRef = useRef<(desktop: PairedDesktop) => Promise<void>>(
    async () => undefined,
  );

  const scheduleReconnect = useCallback(
    (desktop: PairedDesktop) => {
      if (!desktopsRef.current.some(item => item.id === desktop.id)) return;
      if (reconnectTimers.current.has(desktop.id)) return;
      const attempt = retryCount.current.get(desktop.id) ?? 0;
      const delay = reconnectDelayMs(attempt);
      retryCount.current.set(desktop.id, attempt + 1);
      update(desktop.id, {
        status: '离线',
        detail: [lastFailures.current.get(desktop.id), `${Math.ceil(delay / 1000)} 秒后重连`].filter(Boolean).join('\n'),
      });
      const timer = setTimeout(() => {
        reconnectTimers.current.delete(desktop.id);
        // connect() is the sole failure owner: it updates the user-facing state
        // and schedules at most one next attempt after all safe endpoints fail.
        connectRef.current(desktop).catch(() => undefined);
      }, delay);
      reconnectTimers.current.set(desktop.id, timer);
    },
    [update],
  );

  const connect = useCallback(
    async (desktop: PairedDesktop) => {
      const existing = connecting.current.get(desktop.id);
      if (existing) return existing;
      clearReconnect(desktop.id);
      const generation = (connectGenerations.current.get(desktop.id) || 0) + 1;
      connectGenerations.current.set(desktop.id, generation);
      const run = (async () => {
        const previous = clients.current.get(desktop.id);
        clients.current.delete(desktop.id);
        await previous?.close();
        const [credential, identity] = await Promise.all([
          loadDesktopCredential(desktop.id),
          loadOrCreateDeviceIdentity(),
        ]);
        if (!credential) {
          update(desktop.id, {
            status: '错误',
            detail: 'Keychain/Keystore 中没有 Remote v2 root secret，请移除后重新配对。',
          });
          return;
        }
        const candidates = orderedPairedEndpoints(desktop);
        let lastError: unknown = null;
        for (const endpoint of candidates) {
          if (connectGenerations.current.get(desktop.id) !== generation) return;
          const candidate = withDesktopEndpoint(desktop, endpoint);
          let becameOnline = false;
          let onlineSince: number | undefined;
          const client = new RemoteClient({
            desktop: candidate,
            credential,
            identity,
            onStatus: (status, detail) => {
              const current = clients.current.get(desktop.id);
              if (connectGenerations.current.get(desktop.id) !== generation || current !== client) return;
              if (status === 'online') {
                becameOnline = true;
                onlineSince = Date.now();
                update(desktop.id, {status: '在线', detail: undefined});
              } else if (status === 'connecting' || status === 'handshaking') {
                update(desktop.id, {
                  status: '连接中',
                  detail: [lastFailures.current.get(desktop.id), status === 'handshaking' ? '正在验证 E2EE 会话…' : '正在连接…'].filter(Boolean).join('\n'),
                });
              } else if (status === 'closed') {
                // A welcome alone is not a stable connection. Repeated short
                // sessions retain the retry count instead of looping at 1s.
                if (onlineSince !== undefined && Date.now() - onlineSince >= stableConnectionMs) {
                  retryCount.current.set(desktop.id, 0);
                }
                lastFailures.current.set(desktop.id, describeConnectionFailure(detail));
                if (becameOnline) scheduleReconnect(candidate);
              }
            },
            onEvent: event => {
              if (connectGenerations.current.get(desktop.id) !== generation || clients.current.get(desktop.id) !== client) return;
              for (const listener of eventListeners.current) listener(desktop.id, event);
            },
          });
          clients.current.set(desktop.id, client);
          try {
            await client.connect();
            if (connectGenerations.current.get(desktop.id) !== generation || clients.current.get(desktop.id) !== client) {
              await client.close();
              return;
            }
            await client.request('remote.device.profile.update', {
              platform: Platform.OS,
              deviceModel: deviceModel(),
              appVersion: '0.0.1',
            }).catch(() => undefined);
            if (candidate.endpoint !== desktop.endpoint) {
              const next = desktopsRef.current.map(item => item.id === desktop.id
                ? {...item, endpoint: candidate.endpoint, endpoints: candidate.endpoints, tlsMode: candidate.tlsMode}
                : item);
              try {
                await persist(next);
              } catch {
                // The authenticated socket remains valid; retry persistence on a later state update.
              }
              replaceDesktops(next);
            }
            return;
          } catch (error) {
            lastError = error;
            if (clients.current.get(desktop.id) === client) clients.current.delete(desktop.id);
            await client.close().catch(() => undefined);
          }
        }
        if (connectGenerations.current.get(desktop.id) === generation) {
          update(desktop.id, {
            status: '离线',
            detail: '所有已配对连接地址均不可用，正在重连。',
          });
          scheduleReconnect(desktop);
        }
        throw lastError instanceof Error ? lastError : new Error('remote_all_paired_endpoints_unreachable');
      })();
      connecting.current.set(desktop.id, run);
      try {
        return await run;
      } finally {
        if (connecting.current.get(desktop.id) === run) connecting.current.delete(desktop.id);
      }
    },
    [clearReconnect, persist, replaceDesktops, scheduleReconnect, update],
  );
  connectRef.current = connect;

  useEffect(() => {
    let disposed = false;
    loadDesktopIndex()
      .then(restored => {
        if (disposed) {
          return;
        }
        // Do not discard a profile cache merely because its 30-day use marker
        // elapsed. The next bootstrap compares the Desktop SHA-256 descriptor
        // with the actual local file before any byte request is considered.
        const fresh = restored.map(desktop =>
          !desktop.avatarCache || isAvatarCacheValid(desktop.avatarCache)
            ? desktop
            : {...desktop, avatarCache: undefined},
        );
        if (fresh.some((desktop, index) => desktop.avatarCache !== restored[index].avatarCache)) {
          saveDesktopIndex(fresh).catch(() => undefined);
        }
        const runtime = fresh.map(desktop => ({
          ...desktop,
          status: '离线' as const,
        }));
        replaceDesktops(runtime);
        for (const desktop of fresh) {
          connectRef.current(desktop).catch(() => undefined);
        }
      })
      .catch(error => {
        if (!disposed) {
          replaceDesktops([]);
          console.warn(
            'Remote v2 desktop index unavailable:',
            error instanceof Error ? error.name : 'unknown',
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [replaceDesktops]);

  useEffect(() => {
    const timer = setInterval(() => {
      for (const desktop of desktopsRef.current) {
        if (desktop.status !== '在线') {
          continue;
        }
        const client = clients.current.get(desktop.id);
        // Native WebSocket ping owns transport liveness. An application-level
        // ping can fail transiently while its socket is still valid; never
        // replace an online E2EE session from this single RPC failure.
        client?.request('remote.ping').catch(() => undefined);
      }
    }, pingEveryMs);
    return () => clearInterval(timer);
  }, [scheduleReconnect]);

  useEffect(
    () => () => {
      for (const timer of reconnectTimers.current.values()) {
        clearTimeout(timer);
      }
      reconnectTimers.current.clear();
      for (const desktopId of clients.current.keys()) {
        connectGenerations.current.set(desktopId, (connectGenerations.current.get(desktopId) || 0) + 1);
      }
      connecting.current.clear();
      const closingClients = [...clients.current.values()];
      clients.current.clear();
      for (const client of closingClients) {
        client.close().catch(() => undefined);
      }
    },
    [],
  );

  const pair = useCallback(
    async (
      payload: PairingPayload,
      pairingCode: string,
      connectionName?: string,
    ): Promise<PairedDesktop> => {
      const desktop = await pairDesktop({
        payload,
        pairingCode,
        deviceInfo: {
          displayName: defaultDeviceName(),
          platform: Platform.OS,
          deviceModel: deviceModel(),
          appVersion: '0.0.1',
        },
      });
      const name = connectionName?.trim().replace(/\s+/g, ' ').slice(0, 80);
      const namedDesktop = {...desktop, name: name || desktop.name};
      const next = [
        ...desktopsRef.current.filter(item => item.id !== namedDesktop.id),
        {...namedDesktop, status: '连接中' as const},
      ];
      try {
        await persist(next);
      } catch (error) {
        await removeDesktopCredential(desktop.id).catch(() => undefined);
        throw error;
      }
      replaceDesktops(next);
      await connect(namedDesktop).catch(() => undefined);
      return namedDesktop;
    },
    [connect, persist, replaceDesktops],
  );

  const rename = useCallback(
    async (desktopId: string, value: string) => {
      const name = value.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!name) throw new Error('请输入连接名称。');
      const next = desktopsRef.current.map(item =>
        item.id === desktopId ? {...item, name} : item,
      );
      await persist(next);
      replaceDesktops(next);
    },
    [persist, replaceDesktops],
  );

  const updateProfile = useCallback(
    async (
      desktopId: string,
      profile: Pick<PairedDesktop, 'profileName' | 'avatarCache'>,
    ) => {
      const next = desktopsRef.current.map(item =>
        item.id === desktopId ? {...item, ...profile} : item,
      );
      await persist(next);
      replaceDesktops(next);
    },
    [persist, replaceDesktops],
  );


  const updateAvatarCache = useCallback(
    async (desktopId: string, avatarCache: PairedDesktop['avatarCache']) => {
      const current = desktopsRef.current;
      const next = current.map(item =>
        item.id === desktopId ? {...item, ...(avatarCache ? {avatarCache} : {avatarCache: undefined})} : item,
      );
      await persist(next);
      replaceDesktops(next);
    },
    [persist, replaceDesktops],
  );


  const remove = useCallback(
    async (desktop: PairedDesktop) => {
      clearReconnect(desktop.id);
      retryCount.current.delete(desktop.id);

      lastFailures.current.delete(desktop.id);
      connectGenerations.current.set(desktop.id, (connectGenerations.current.get(desktop.id) || 0) + 1);
      connecting.current.delete(desktop.id);
      const client = clients.current.get(desktop.id);
      clients.current.delete(desktop.id);
      await client?.close().catch(() => undefined);
      await removeDesktopCredential(desktop.id);
      const next = desktopsRef.current.filter(item => item.id !== desktop.id);
      await persist(next);
      replaceDesktops(next);
    },
    [clearReconnect, persist, replaceDesktops],
  );

  const request = useCallback(
    async <T,>(
      desktopId: string,
      method: string,
      params: Record<string, unknown> = {},
      timeoutMs?: number,
    ): Promise<T> => {
      const client = clients.current.get(desktopId);
      if (!client) {
        throw new Error('桌面未连接。');
      }
      return client.request<T>(method, params, timeoutMs);
    },
    [],
  );

  const requestTracked = useCallback(
    <T,>(
      desktopId: string,
      method: string,
      params: Record<string, unknown> = {},
      timeoutMs?: number,
    ): {requestId: string; response: Promise<T>} => {
      const client = clients.current.get(desktopId);
      if (!client) {
        throw new Error('桌面未连接。');
      }
      return client.requestTracked<T>(method, params, timeoutMs);
    },
    [],
  );


  const subscribeEvents = useCallback(
    (listener: (desktopId: string, event: RemoteEventMessage) => void) => {
      eventListeners.current.add(listener);
      return () => eventListeners.current.delete(listener);
    },
    [],
  );

  return {
    desktops,
    pair,
    rename,
    updateProfile,
    updateAvatarCache,
    remove,
    request,
    requestTracked,
    subscribeEvents,
  };
}
