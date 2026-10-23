import {FileSystem} from 'react-native-file-access';

const pending = new Map<string, Promise<void>>();
/** Native Android mkdir rejects EEXIST: share concurrent creation and recheck races. */
export async function ensureCacheDirectory(path: string): Promise<void> {
  const existing = pending.get(path);
  if (existing) return existing;
  const run = (async () => {
    if (await FileSystem.exists(path)) return;
    try {await FileSystem.mkdir(path);} catch (error) {
      if (!(await FileSystem.exists(path))) throw error;
    }
  })();
  pending.set(path, run);
  try {await run;} finally {if (pending.get(path) === run) pending.delete(path);}
}
