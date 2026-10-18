import {utf8ToBytes} from './utf8';

/** Noble's NIST module encodes constants at module initialization. Some Hermes
 * versions have no TextEncoder. Install a byte-compatible fallback before Noble
 * is loaded; never replace an existing platform implementation.
 */
class Utf8TextEncoder {
  readonly encoding = 'utf-8';

  encode(value = ''): Uint8Array {
    return utf8ToBytes(String(value));
  }

  encodeInto(value: string, destination: Uint8Array): {read: number; written: number} {
    let read = 0;
    let written = 0;
    for (const character of String(value)) {
      const bytes = utf8ToBytes(character);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += character.length;
    }
    return {read, written};
  }
}

const runtime = globalThis as typeof globalThis & {TextEncoder?: unknown};
if (typeof runtime.TextEncoder !== 'function') {
  Object.defineProperty(globalThis, 'TextEncoder', {
    value: Utf8TextEncoder,
    configurable: true,
    writable: true,
  });
}
