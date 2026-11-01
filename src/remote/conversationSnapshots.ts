import type {ConversationMessagesResult} from './api';

/** Read-only, desktop-scoped LRU. Never stores credentials or runtime authority. */
export function createConversationSnapshots(maxBytes = 16 * 1024 * 1024, maxEntries = 6, desktopId = '') {
  const entries = new Map<string, {page: ConversationMessagesResult; bytes: number}>();
  let bytes = 0;
  function remove(id: string) {
    const old = entries.get(id);
    if (old) {bytes -= old.bytes; entries.delete(id);}
  }
  return {

    desktopId,
    put(page: ConversationMessagesResult) {
      const id = page.conversation.conversationId;
      remove(id);
      // Conservatively budget UTF-16 heap storage, not network-encoded bytes.
      const size = JSON.stringify(page).length * 2;
      if (size > maxBytes) return;
      entries.set(id, {page, bytes: size}); bytes += size;
      while (bytes > maxBytes || entries.size > maxEntries) remove(entries.keys().next().value!);
    },
    get(id: string) {
      const entry = entries.get(id);
      if (!entry) return null;
      entries.delete(id); entries.set(id, entry);
      return entry.page;
    },
    remove,
  };
}
