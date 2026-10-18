/** WHATWG UTF-8 encoding, including replacement of isolated UTF-16 surrogates.
 * No Buffer/TextEncoder dependency: Hermes and Jest use exactly the same bytes.
 */
export function utf8ToBytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    let code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(Math.floor(code / 64) + 192, code % 64 + 128);
    } else if (code < 0x10000) {
      bytes.push(Math.floor(code / 4096) + 224, Math.floor(code / 64) % 64 + 128, code % 64 + 128);
    } else {
      bytes.push(Math.floor(code / 262144) + 240, Math.floor(code / 4096) % 64 + 128, Math.floor(code / 64) % 64 + 128, code % 64 + 128);
    }
  }
  return Uint8Array.from(bytes);
}
