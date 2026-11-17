import {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import type {RemoteRequest} from '../remote/api';
import {AppState} from 'react-native';
import {peekSettings, readSettings, hydrateSettings, subscribeSettings, storeSettings} from '../services/settingsCache';

export const SettingsActivityContext = createContext(true);

export function useSettingsCatalog<T>(request: RemoteRequest, desktopId: string, method: string, params: Record<string, unknown> = {}) {
  const screenActive = useContext(SettingsActivityContext);
  const serialized = JSON.stringify(params);
  const scope = `${desktopId}:${method}:${serialized}`;
  const latest = useRef(scope); latest.current = scope;
  const latestRequest = useRef(request); latestRequest.current = request;
  const version = useRef(0);
  const mounted = useRef(true);
  const [state, setState] = useState<{scope: string; request: RemoteRequest; value: T | null}>(() => ({scope, request, value: peekSettings<T>(request, desktopId, method, params)}));
  const [loading, setLoading] = useState(false);
  useEffect(() => {mounted.current = true; version.current++; return () => {mounted.current = false;};}, []);
  const value = state.scope === scope && state.request === request ? state.value : peekSettings<T>(request, desktopId, method, JSON.parse(serialized));
  const valueRef = useRef(value); valueRef.current = value;
  useEffect(() => {
    let disposed = false;
    const publish = () => {
      if (disposed || !mounted.current || latest.current !== scope || latestRequest.current !== request) return;
      const cached = peekSettings<T>(request, desktopId, method, JSON.parse(serialized));
      if (cached !== null && cached !== valueRef.current) {valueRef.current = cached; setState({scope, request, value: cached});}
    };
    const unsubscribe = subscribeSettings(publish, request);
    hydrateSettings(desktopId, request).then(publish).catch(() => undefined);
    publish(); return () => {disposed = true; unsubscribe();};
  }, [request, desktopId, method, serialized, scope]);
  const reload = useCallback(async (force = true) => {
    if (!mounted.current || latest.current !== scope || latestRequest.current !== request) throw new Error('settings_read_superseded');
    const ticket = ++version.current;
    setLoading(true);
    try {
      const next = await readSettings<T>(request, desktopId, method, JSON.parse(serialized), force).catch(error => {
        if (error?.message !== 'settings_read_superseded' || !mounted.current || latest.current !== scope || latestRequest.current !== request) throw error;
        return readSettings<T>(request, desktopId, method, JSON.parse(serialized), true);
      });
      if (mounted.current && latest.current === scope && latestRequest.current === request && version.current === ticket) setState({scope, request, value: next});
      return next;
    } finally {if (mounted.current && latest.current === scope && latestRequest.current === request && version.current === ticket) setLoading(false);}
  }, [request, desktopId, method, scope, serialized]);
  useEffect(() => {
    let active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
    let disposed = false;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {if (timer !== undefined) clearTimeout(timer); timer = undefined;};
    const schedule = () => {clear(); if (!disposed && screenActive && active) timer = setTimeout(check, 15000);};
    const check = () => {
      clear();
      if (disposed || !screenActive || !active || checking) return;
      checking = true;
      reload(false).catch(() => undefined).finally(() => {checking = false; schedule();});
    };
    const subscription = AppState.addEventListener('change', appState => {
      active = appState === 'active';
      if (active) check(); else clear();
    });
    if (screenActive && active) check();
    return () => {disposed = true; clear(); subscription.remove();};
  }, [reload, screenActive]);

  const update = useCallback((action: T | null | ((current: T | null) => T | null)) => {
    if (!mounted.current || latest.current !== scope || latestRequest.current !== request) return;
    const next = typeof action === 'function' ? (action as (current: T | null) => T | null)(valueRef.current) : action;
    valueRef.current = next; version.current++;
    setState({scope, request, value: next});
    storeSettings(request, desktopId, method, JSON.parse(serialized), next);
  }, [scope, request, desktopId, method, serialized]);
  return {catalog: value, reload, setCatalog: update, refreshing: loading};
}
