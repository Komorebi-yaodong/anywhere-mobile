import {sha256} from '@noble/hashes/sha2.js';
import {utf8ToBytes} from './utf8';
import type {ConversationMessagesResult} from './api';

const invalid = () => Object.assign(new Error('remote_history_part_invalid'), {code: 'remote_history_part_invalid'});

// Weak identity metadata does not retain payloads or trust unverified snapshots.
const verified = new WeakMap<object, string>();
/** Read-only retry: never reuse this helper for commands or mutate their IDs. */
export async function readSized<T>(read: (pageSize: number) => Promise<T>, requested = 50): Promise<T> {
  let size = Math.max(1, Math.min(100, Math.floor(requested) || 50));
  for (;;) {
    try {return await read(size);} catch (cause) {
      if ((cause as {code?: string})?.code !== 'remote_response_too_large' || size === 1) throw cause;
      size = Math.max(1, Math.floor(size / 2));
    }
  }
}
export type HistoryReadOptions = {

  previousPage?: ConversationMessagesResult | null;
  onPage?: (page: ConversationMessagesResult) => void;
  isCurrent?: () => boolean;
};
export async function completeHistory(page: ConversationMessagesResult, chunk: (params: Record<string, unknown>) => Promise<any>, options: HistoryReadOptions = {}): Promise<ConversationMessagesResult> {
  if (!page || !Array.isArray(page.messages)) throw invalid();
  const check = () => {if (options.isCurrent && !options.isCurrent()) throw Object.assign(new Error('remote_history_read_cancelled'), {code: 'remote_history_read_cancelled'});};
  const previous = options.previousPage?.conversation.conversationId === page.conversation.conversationId
    ? new Map(options.previousPage.messages.map(message => [message.uiMessageId, message])) : new Map();
  const fingerprint = (ref: {id: string; sha256: string; totalChars: number}) => `${ref.id}:${ref.sha256}:${ref.totalChars}`;
  const messages = page.messages.map(message => {
    const ref = (message.payload as any).fullPayload;
    const cached = previous.get(message.uiMessageId);
    if (ref && cached && verified.get(cached) === fingerprint(ref)) {
      const restored = {...message, payload: cached.payload};
      verified.set(restored, fingerprint(ref));
      return restored;
    }
    return message;
  });
  check();
  options.onPage?.({...page, messages: [...messages]});
  for (let index = 0; index < messages.length; index++) {
    check();
    const message = messages[index];
    const ref = (message.payload as typeof message.payload & {fullPayload?: {id: string; totalChars: number; sha256: string}}).fullPayload;
    if (!ref) continue;
    if (!/^[a-f0-9]{64}$/.test(ref.id) || !Number.isSafeInteger(ref.totalChars) || ref.totalChars < 1 || ref.totalChars > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw invalid();
    const parts: string[] = [];
    let offset = 0;
    while (offset < ref.totalChars) {
      check();
      // The RPC transparently reads one immutable adaptive byte transfer; there
      // is no nested fixed-size character-chunk protocol or old-client fallback.
      const part = await chunk({conversationId: page.conversation.conversationId, id: ref.id, offset});
      check();
      if (part?.id !== ref.id || part.offset !== offset || part.totalChars !== ref.totalChars || part.sha256 !== ref.sha256 || typeof part.text !== 'string' || !part.text.length || part.text.length > 8 * 1024 * 1024 || part.nextOffset !== offset + part.text.length || part.nextOffset > ref.totalChars) throw invalid();
      parts.push(part.text); offset = part.nextOffset;
    }
    const text = parts.join('');
    const hash = Array.from(sha256(utf8ToBytes(text)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== ref.sha256) throw invalid();
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'content') || typeof payload.reasoningContent !== 'string' || !Array.isArray(payload.toolCalls)) throw invalid();
    check();
    messages[index] = {...message, payload};

    verified.set(messages[index], fingerprint(ref));
    options.onPage?.({...page, messages: [...messages]});
  }
  return {...page, messages};
}
