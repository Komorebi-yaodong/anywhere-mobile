import {useEffect} from 'react';
import type {RemoteRequest, RemoteTrackedRequest} from '../remote/api';
import {startCommand, type ContextUsage, type ConversationConfigResult} from '../remote/commands';

/** Read-only polling: no control acquisition, capacity lookup or settings draft writes. */
export function useContextUsageRefresh({
  active, desktopId, conversationId, request, requestTracked, onUsage,
}: {
  active: boolean;
  desktopId: string;
  conversationId: string;
  request: RemoteRequest;
  requestTracked: RemoteTrackedRequest;
  onUsage: (usage: ContextUsage) => void;
}) {
  useEffect(() => {
    if (!active || !conversationId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const receipt = startCommand({
          desktopId, method: 'conversation.config.get', params: {conversationId},
          request, requestTracked, signal: controller.signal, timeoutMs: 60_000,
        });
        const state = await receipt.completion;
        const usage = (state.result as ConversationConfigResult | undefined)?.contextUsage;
        if (!disposed && usage && usage.updatedAt > 0 &&
          [usage.systemTokens, usage.conversationTokens, usage.toolTokens, usage.updatedAt]
            .every(value => Number.isFinite(value) && value >= 0)) onUsage(usage);
      } catch {
        // A transient read failure must not erase the last usable numeric snapshot.
      } finally {
        if (!disposed) timer = setTimeout(refresh, 2000);
      }
    };
    refresh().catch(() => {});
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, desktopId, conversationId, request, requestTracked, onUsage]);
}
