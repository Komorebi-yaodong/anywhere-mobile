/** Validate credentials only in the authority: RN URL misreads @scope paths as userinfo. */
export function httpsResourceUrl(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source || source.length > 4096 || source.includes('\\') || Array.from(source).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return '';
  const authority = /^https:\/\/([^/?#]+)/i.exec(source)?.[1];
  if (!authority || /[@%]/.test(authority)) return '';
  try {
    const origin = new URL(`https://${authority}/`);
    if (origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password) return '';
    return new URL(source).toString();
  } catch {return '';}
}
