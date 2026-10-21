import type {RemoteMessage} from '../remote/api';

/**
 * Desktop uiMessageId is the only row identity. Do not infer duplicates from
 * canonical messageId, text, request IDs, reasoning, or tool-call membership.
 * Keep the server page's exact order/cardinality and reuse unchanged objects
 * so memoized native cards retain state without re-rendering on every poll.
 */
export function reconcileDesktopMessages(previous: RemoteMessage[], incoming: RemoteMessage[]): RemoteMessage[] {
  const byId = new Map(previous.map(message => [message.uiMessageId, message]));
  const next = incoming.map(message => {
    const existing = byId.get(message.uiMessageId);
    return existing && JSON.stringify(existing) === JSON.stringify(message) ? existing : message;
  });
  return next.length === previous.length && next.every((message, index) => message === previous[index]) ? previous : next;
}
