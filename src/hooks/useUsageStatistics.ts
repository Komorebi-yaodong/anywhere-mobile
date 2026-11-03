import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { RemoteRequest } from '../remote/api';
import {
  validateUsage,
  type UsageFilters,
  type UsageSnapshot,
} from '../remote/usage';

export function useUsageStatistics({
  desktopId,
  request,
  active,
  filters,
  refreshSignal = 0,
}: {
  desktopId: string;
  request: RemoteRequest;
  active: boolean;
  filters: UsageFilters;
  refreshSignal?: number;
}) {
  const [foreground, setForeground] = useState(
    AppState.currentState !== 'background' &&
      AppState.currentState !== 'inactive',
  );
  const [value, setValue] = useState<{
    key: string;
    data: UsageSnapshot;
  } | null>(null);
  const [status, setStatus] = useState<{
    key: string;
    loading: boolean;
    error: string;
  }>({ key: '', loading: false, error: '' });
  const flight = useRef<Promise<unknown> | null>(null);
  const key = JSON.stringify([
    desktopId,
    filters.range,
    filters.providerId,
    filters.agentName,
    filters.model,
  ]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state =>
      setForeground(state === 'active'),
    );
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!active || !foreground) return;
    let live = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      // Wait for an old-scope read to settle; never overlap polling requests.
      await flight.current?.catch(() => undefined);
      if (!live) return;
      setStatus({ key, loading: true, error: '' });
      const job = Promise.resolve().then(() =>
        request(desktopId, 'workspace.usage.get', { ...filters }, 20_000),
      );
      flight.current = job;
      let poll = true;
      try {
        const data = validateUsage(await job);
        if (live) {
          setValue({ key, data });
          setStatus({ key, loading: false, error: '' });
        }
      } catch (cause) {
        const unsupported =
          (cause as { code?: string })?.code === 'remote_method_unavailable';
        poll = !unsupported;
        if (live)
          setStatus({
            key,
            loading: false,
            error: unsupported
              ? '请更新 Desktop 后查看数据统计。'
              : '统计读取失败，请稍后刷新。',
          });
      } finally {
        if (flight.current === job) flight.current = null;
        if (live && poll) timer = setTimeout(run, 15_000);
      }
    };
    run();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // All filter primitives are represented by key; no object identity polling loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, foreground, desktopId, request, key, refreshSignal]);
  return {
    data: value?.key === key ? value.data : null,
    loading: status.key === key && status.loading,
    error: status.key === key ? status.error : '',
  };
}
