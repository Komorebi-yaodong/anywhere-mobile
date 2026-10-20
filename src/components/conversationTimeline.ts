import type {RemoteMessage} from '../remote/api';

export type LiveSegment = {
  segmentId: string;
  text: string;
  reasoning: string;
  toolCalls?: RemoteMessage['payload']['toolCalls'];
};

export type LiveTurn = {
  requestId?: string;
  segmentId?: string;
  segments?: LiveSegment[];
  baselineUiMessageIds?: string[];
  baselineLastOrder?: number;
  handoffUiMessageId?: string;
  text: string;
  reasoning: string;
  toolCalls?: RemoteMessage['payload']['toolCalls'];
  terminal?: boolean;
  historyLoaded?: boolean;
} | null | undefined;

export type TimelineMessage = RemoteMessage & {
  /** Local identity only. Never sent to Desktop as a mutation target. */
  renderKey: string;
  preview?: boolean;
};

function mergeTools(durable: RemoteMessage['payload']['toolCalls'], live: RemoteMessage['payload']['toolCalls']) {
  const calls = new Map(durable.map(call => [call.id || call.name, call]));
  for (const call of live) {
    const key = call.id || call.name;
    const previous = calls.get(key);
    calls.set(key, {
      ...previous, ...call,
      arguments: call.arguments === '[参数已隐藏]' ? previous?.arguments ?? call.arguments : call.arguments ?? previous?.arguments,
      ...(call.result === undefined && previous?.result !== undefined ? {result: previous.result} : {}),
    });
  }
  return [...calls.values()];
}

/** Only discard a subset snapshot of the SAME real Assistant message. */
function isSubsetProjection(left: RemoteMessage, right: RemoteMessage): boolean {
  const same = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second);
  const source = left.payload;
  const target = right.payload;
  const contentContained = !source.content || same(source.content, target.content);
  const reasoningContained = !source.reasoningContent || source.reasoningContent === target.reasoningContent;
  const toolsContained = (source.toolCalls || []).every(call => (target.toolCalls || []).some(other =>
    call.id === other.id && call.name === other.name));
  return contentContained && reasoningContained && toolsContained &&
    (!source.summary || source.summary === target.summary) && !source.compaction;
}

/** Aliases removed from the view AFTER Desktop confirms the real deletion. */
export function deletedProjectionUiIds(messages: RemoteMessage[], uiMessageId: string): string[] {
  const target = messages.find(message => message.uiMessageId === uiMessageId);
  if (!target || target.role !== 'assistant' || !target.messageId) return [uiMessageId];
  return messages.filter(message => message.uiMessageId === uiMessageId || (
    message.role === 'assistant' && message.messageId === target.messageId && isSubsetProjection(message, target)
  )).map(message => message.uiMessageId);
}

function uniqueHistory(messages: RemoteMessage[]): RemoteMessage[] {
  const rows: RemoteMessage[] = [];
  const byMessage = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.messageId) { rows.push(message); continue; }
    const index = byMessage.get(message.messageId);
    if (index === undefined) {
      byMessage.set(message.messageId, rows.length);
      rows.push(message);
    } else if (isSubsetProjection(rows[index], message)) {
      rows[index] = message;
    } else if (!isSubsetProjection(message, rows[index])) {
      // Independent content must remain independently addressable/deletable.
      rows.push(message);
    }
  }
  return rows;
}


/** Pure view projection: never changes the DTO or its real mutation IDs. */
export function projectConversationTimeline(messages: RemoteMessage[], turn: LiveTurn): {
  messages: TimelineMessage[];
  hasPersistedLiveSegment: boolean;
} {
  const history = uniqueHistory(messages).map(message => ({...message, renderKey: message.uiMessageId}));
  if (!turn) return {messages: history, hasPersistedLiveSegment: false};
  const segments = [
    ...(turn.segments || []).filter(segment => segment.segmentId !== turn.segmentId),
    {segmentId: turn.segmentId || '', text: turn.text, reasoning: turn.reasoning, toolCalls: turn.toolCalls},
  ];
  const ids = new Set(segments.map(segment => segment.segmentId).filter(Boolean));
  const baseline = turn.baselineUiMessageIds ? new Set(turn.baselineUiMessageIds) : null;
  // Newly materialized UI-only reasoning/tool projections may have a UI UUID
  // rather than the canonical segment UUID. They are still part of this turn,
  // not an additional bubble alongside its one live preview.
  const belongsToTurn = (message: RemoteMessage) => message.role === 'assistant' && (
    ids.has(message.messageId) || ids.has(message.uiMessageId) ||
    (baseline !== null && !baseline.has(message.uiMessageId) && message.order >= (turn.baselineLastOrder ?? Number.MAX_SAFE_INTEGER))
  );
  const durable = messages.filter(belongsToTurn);
  const hasPersistedLiveSegment = durable.length > 0;
  const key = `live-turn-${turn.requestId || turn.segmentId || 'assistant'}`;
  if (turn.terminal && turn.historyLoaded) {
    // Hand off to actual durable messages, never synthesize a history record.
    // The last durable Assistant reuses the preview's React identity once.
    const target = durable.find(message => message.uiMessageId === turn.handoffUiMessageId);
    return {
      hasPersistedLiveSegment,
      messages: history.map(message => target?.uiMessageId === message.uiMessageId ? {...message, renderKey: key} : message),
    };
  }
  const text = segments.map(segment => segment.text).filter(Boolean).join('\n\n');
  const reasoning = segments.map(segment => segment.reasoning).filter(Boolean).join('\n\n');
  const tools = mergeTools(durable.flatMap(message => message.payload.toolCalls || []), segments.flatMap(segment => segment.toolCalls || []));
  if (!text && !reasoning && !tools.length) return {messages: history, hasPersistedLiveSegment};
  const timestamp = durable[0]?.payload.timestamp || '';
  return {
    hasPersistedLiveSegment,
    messages: [
      ...history.filter(message => !belongsToTurn(message)),
      {
        renderKey: key, preview: true,
        messageId: key, uiMessageId: key, role: 'assistant', order: Number.MAX_SAFE_INTEGER,
        payload: {
          content: text, reasoningContent: reasoning, toolCalls: tools,
          summary: '', summaryPrefix: '', timestamp, completedTimestamp: '',
          aiName: '', voiceName: '', status: '',
        },
      },
    ],
  };
}
