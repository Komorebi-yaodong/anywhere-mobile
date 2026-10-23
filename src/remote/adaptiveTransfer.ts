import {remoteError} from './protocol';

export const ADAPTIVE_TRANSFER_CAPABILITY = 'remote.transfer.adaptive.v1';
export const TRANSFER_MIN_CHUNK_BYTES = 512 * 1024;
export const TRANSFER_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const TRANSFER_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** One controller per transfer: measure preparation through validated receipt/write. */
export function createAdaptiveChunkSizer(maximum = TRANSFER_MAX_CHUNK_BYTES) {
  let size = Math.min(TRANSFER_MIN_CHUNK_BYTES, maximum);
  let baseline = 0;
  let samples = 0;
  let stable = 0;
  let probing = false;
  let ceiling = maximum;
  return {
    next: (remaining: number) => Math.min(size, remaining),
    observe(bytes: number, elapsedMs: number, processingMs = 0) {
      if (bytes !== size || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
      const rate = bytes / Math.max(1, elapsedMs);
      const pressured = elapsedMs > 1500 || processingMs > 160;
      if (pressured || baseline && rate < baseline * 0.75) {
        ceiling = Math.max(TRANSFER_MIN_CHUNK_BYTES, size / 2);
        size = Math.max(Math.min(TRANSFER_MIN_CHUNK_BYTES, maximum), size / 2);
        stable = 0; samples = 0; probing = false; baseline = rate;
        return;
      }
      samples++;
      if (!baseline) baseline = rate;
      if (probing) {
        if (rate < baseline * 1.08) {size /= 2; ceiling = size; stable = 0;}
        else {baseline = rate; stable = 1;}
        probing = false; samples = stable;
        return;
      }
      if (rate >= baseline * 0.9) stable++; else stable = 0;
      baseline = baseline * 0.75 + rate * 0.25;
      if (ceiling < maximum && stable >= 6 && samples >= 6) {ceiling = Math.min(maximum, size * 2); stable = 0; samples = 0;}
      if (stable >= 2 && samples >= 2 && size * 2 <= ceiling) {size *= 2; probing = true; stable = 0; samples = 0;}
    },
    slow() {ceiling = Math.max(TRANSFER_MIN_CHUNK_BYTES, size / 2); size = Math.max(Math.min(TRANSFER_MIN_CHUNK_BYTES, maximum), size / 2); stable = 0; samples = 0; probing = false;},
  };
}

/** Bounds raw data shared by concurrent upload, media and result transfers. */
export function createTransferBudget(limit = TRANSFER_MAX_CHUNK_BYTES) {
  let used = 0;
  const waiting: Array<{bytes: number; resolve: (release: () => void) => void}> = [];
  const pump = () => {
    while (waiting.length && used + waiting[0].bytes <= limit) {
      const item = waiting.shift()!; used += item.bytes;
      let released = false;
      item.resolve(() => {if (!released) {released = true; used -= item.bytes; pump();}});
    }
  };
  return {acquire(bytes: number): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limit) return Promise.reject(remoteError('remote_transfer_capacity'));
    return new Promise(resolve => {waiting.push({bytes, resolve}); pump();});
  }};
}
export const transferBudget = createTransferBudget();
