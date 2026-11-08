import {useEffect, useState} from 'react';
import {Dirs, FileSystem} from 'react-native-file-access';

type Flags = Record<string, boolean>;
const file = `${Dirs.DocumentDir}/anywhere-provider-folders.json`;
const preferences = new Map<string, Flags>();
const listeners = new Set<() => void>();
let hydration: Promise<void> | null = null;
let writes = Promise.resolve();
const notify = () => {for (const listener of listeners) listener();};
function hydrate() {
  if (!hydration) hydration = (async () => {
    try {
      if (await FileSystem.exists(file)) {
        const data = JSON.parse(await FileSystem.readFile(file, 'utf8'));
        for (const [id, value] of Object.entries(data?.desktops || {}).slice(0, 32)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const flags = Object.fromEntries(Object.entries(value).slice(0, 1024).filter(([, state]) => typeof state === 'boolean')) as Flags;
          // A tap before hydration wins over older on-disk preferences.
          preferences.set(id, {...flags, ...preferences.get(id)});
        }
      }
    } catch { /* Missing/corrupt UI preferences do not block settings. */ }
    notify();
  })();
  return hydration;
}
export function useProviderFolderCollapse(desktopId: string) {
  const [state, setState] = useState(() => ({desktopId, flags: preferences.get(desktopId) || {}}));
  useEffect(() => {
    const update = () => setState({desktopId, flags: {...preferences.get(desktopId)}});
    listeners.add(update); update(); hydrate().catch(() => undefined);
    return () => {listeners.delete(update);};
  }, [desktopId]);
  const flags = state.desktopId === desktopId ? state.flags : preferences.get(desktopId) || {};
  const toggle = (folderId: string) => {
    const key = folderId || '__ungrouped__';
    const before = preferences.get(desktopId) || {};
    preferences.set(desktopId, {...before, [key]: !(before[key] ?? true)});
    notify();
    const job = writes.catch(() => undefined).then(async () => {
      await hydrate();
      await FileSystem.writeFile(file, JSON.stringify({version: 1, desktops: Object.fromEntries([...preferences].slice(-32))}), 'utf8');
    });
    writes = job;
    return job;
  };
  return {collapsed: (folderId: string) => flags[folderId || '__ungrouped__'] ?? true, toggle};
}
