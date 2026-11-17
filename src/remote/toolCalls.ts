import type {RemoteMessage} from './api';

type ToolCall = RemoteMessage['payload']['toolCalls'][number];
const terminalStatuses = new Set(['finished', 'completed', 'failed', 'error', 'rejected', 'cancelled']);

/** Live progress intentionally omits input details; that is not a loading state. */
export function hasToolArguments(value: unknown): boolean {
  return value !== undefined && value !== null &&
    (typeof value !== 'string' || (value.trim() !== '' && value.trim() !== '[参数已隐藏]'));
}

export function mergeLiveToolCalls(current: ToolCall[] | undefined, incoming: ToolCall[]): ToolCall[] {
  const merged = new Map<string, ToolCall>();
  for (const call of current || []) merged.set(call.id || call.name, call);
  for (const call of incoming) {
    const key = call.id || call.name;
    if (!key) continue;
    const previous = merged.get(key);
    const argumentsValue = hasToolArguments(call.arguments) ? call.arguments :
      hasToolArguments(previous?.arguments) ? previous!.arguments : call.arguments ?? previous?.arguments;
    if (previous && terminalStatuses.has(previous.status) && !terminalStatuses.has(call.status)) {
      // Detail hydration may fill missing input without regressing lifecycle or result.
      if (!hasToolArguments(previous.arguments) && hasToolArguments(argumentsValue)) {
        merged.set(key, {...previous, arguments: argumentsValue});
      }
      continue;
    }
    merged.set(key, {
      ...previous,
      ...call,
      arguments: argumentsValue,
      ...(call.result === undefined && previous?.result !== undefined ? {result: previous.result} : {}),
    });
  }
  return [...merged.values()];
}
