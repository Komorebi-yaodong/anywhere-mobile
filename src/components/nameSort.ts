/** Stable, locale-aware name order for project/MCP/Skill lists; never mutates source. */
export function sortByName<T extends {name?: string; id?: string; projectId?: string}>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => String(a.name || a.id || a.projectId || '').localeCompare(String(b.name || b.id || b.projectId || ''), 'zh-CN', {numeric: true, sensitivity: 'base'}) || String(a.id || a.projectId || '').localeCompare(String(b.id || b.projectId || '')));
}
