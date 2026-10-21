import type {ConversationConfig} from '../remote/commands';

/** All tabs share one draft. Save only changed fields in one Desktop command. */
export function sessionSettingsPatch(config: ConversationConfig, baseline: ConversationConfig, {
  contextLengthDraft, contextLengthEdited, triggerRatioDraft,
}: {contextLengthDraft: string; contextLengthEdited: boolean; triggerRatioDraft: string}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of ['systemPrompt', 'mcpServerIds', 'skillIds'] as const) {
    if (JSON.stringify(config[key]) !== JSON.stringify(baseline[key])) patch[key] = config[key];
  }
  const compact: Record<string, unknown> = {};
  for (const key of ['autoCompactEnabled', 'keepRecentRounds', 'compactPrompt'] as const) {
    if (config.compact[key] !== baseline.compact[key]) compact[key] = config.compact[key];
  }
  const triggerRatio = Number(triggerRatioDraft);
  if (!triggerRatioDraft.trim() || !Number.isFinite(triggerRatio) || triggerRatio < 0.1 || triggerRatio > 0.99) {
    throw new Error('触发比例请输入 0.1–0.99 之间的数值。');
  }
  if (triggerRatio !== baseline.compact.triggerRatio) compact.triggerRatio = triggerRatio;
  if (contextLengthEdited) {
    const contextLength = Number(contextLengthDraft);
    if (!Number.isInteger(contextLength) || contextLength < 4096 || contextLength > 10_000_000) {
      throw new Error('上下文长度请输入 4096–10000000 之间的整数。');
    }
    compact.contextLength = contextLength;
  }
  if (compact.keepRecentRounds !== undefined && (!Number.isInteger(compact.keepRecentRounds) || Number(compact.keepRecentRounds) < 0 || Number(compact.keepRecentRounds) > 100)) {
    throw new Error('保留轮数请输入 0–100 之间的整数。');
  }
  if (Object.keys(compact).length) patch.compact = compact;
  return patch;
}
