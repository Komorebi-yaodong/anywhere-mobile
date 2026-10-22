import {sha256} from '@noble/hashes/sha2.js';
import {utf8ToBytes} from './utf8';
import type {ConversationMessagesResult} from './api';

const invalid = () => Object.assign(new Error('remote_history_part_invalid'), {code: 'remote_history_part_invalid'});
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
export async function completeHistory(page: ConversationMessagesResult, chunk: (params: Record<string, unknown>) => Promise<any>): Promise<ConversationMessagesResult> {
  if (!page || !Array.isArray(page.messages)) throw invalid();
  const messages = [];
  for (const message of page.messages) {
    const ref = (message.payload as typeof message.payload & {fullPayload?: {id: string; totalChars: number; sha256: string}}).fullPayload;
    if (!ref) {messages.push(message); continue;}
    if (!/^[a-f0-9]{64}$/.test(ref.id) || !Number.isSafeInteger(ref.totalChars) || ref.totalChars < 1 || ref.totalChars > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw invalid();
    const parts: string[] = [];
    let offset = 0;
    while (offset < ref.totalChars) {
      const part = await chunk({conversationId: page.conversation.conversationId, id: ref.id, offset});
      if (part?.id !== ref.id || part.offset !== offset || part.totalChars !== ref.totalChars || part.sha256 !== ref.sha256 || typeof part.text !== 'string' || !part.text.length || part.text.length > 16384 || part.nextOffset !== offset + part.text.length || part.nextOffset > ref.totalChars) throw invalid();
      parts.push(part.text); offset = part.nextOffset;
    }
    const text = parts.join('');
    const hash = Array.from(sha256(utf8ToBytes(text)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== ref.sha256) throw invalid();
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'content') || typeof payload.reasoningContent !== 'string' || !Array.isArray(payload.toolCalls)) throw invalid();
    messages.push({...message, payload});
  }
  return {...page, messages};
}
