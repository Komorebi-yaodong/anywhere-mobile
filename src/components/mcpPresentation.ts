/**
 * Safe presentation helpers for the public MCP transport/type metadata.
 * They intentionally never inspect command, args, cwd, env, or credentials.
 */
export function mcpTransportLabel(value?: string): string {
  const transport = String(value || '').trim().toLocaleLowerCase('zh-CN');
  return transport === 'builtin' ? '内置' : '';
}

export function mcpTransportSearchTerms(value?: string): string[] {
  const raw = String(value || '').trim();
  const label = mcpTransportLabel(raw);
  return [raw, label].filter(Boolean);
}
