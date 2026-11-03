import type {ConversationRequestState, RemoteRequest, RemoteTrackedRequest} from './api';
import {RemoteRpcError} from './client';

export type CommandReceipt = {
  requestId: string;
  completion: Promise<ConversationRequestState>;
};

export class RemoteCommandPendingError extends Error {
  readonly requestId: string;
  readonly code = 'remote_command_pending';

  constructor(requestId: string) {
    super('Desktop 执行状态尚待确认，请查询原请求，勿重复提交。');
    this.name = 'RemoteCommandPendingError';
    this.requestId = requestId;
  }
}

export function commandFailed(state: ConversationRequestState): boolean {
  return state.event.endsWith('.failed');
}

export async function waitForCommand({
  desktopId, requestId, request, signal, timeoutMs = 90_000,
  intervalMs = 400, onProgress, keepTracking = false,
}: {
  desktopId: string;
  requestId: string;
  request: RemoteRequest;
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
  onProgress?: (state: ConversationRequestState) => void;
  keepTracking?: boolean;
}): Promise<ConversationRequestState> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (signal?.aborted) throw new RemoteCommandPendingError(requestId);
    let state: ConversationRequestState;
    try {
      state = await request<ConversationRequestState>(
        desktopId, 'conversation.request.get', {requestId},
      );
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
      if (['remote_operation_not_found', 'remote_request_not_found'].includes(code) && Date.now() >= deadline) throw new RemoteCommandPendingError(requestId);
      // Reads may be retried; the original mutation is never submitted again.
      if (signal?.aborted) throw new RemoteCommandPendingError(requestId);
      await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
      continue;
    }
    if (signal?.aborted) throw new RemoteCommandPendingError(requestId);
    onProgress?.(state);
    if (state.terminal) {
      if (commandFailed(state)) {
        throw new RemoteRpcError(
          typeof state.result?.code === 'string'
            ? state.result.code : 'remote_operation_failed',
        );
      }
      return state;
    }
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  } while (keepTracking || Date.now() < deadline);
  throw new RemoteCommandPendingError(requestId);
}

export function trackCommand({desktopId, tracked, request, signal, keepTracking = false, timeoutMs, onAccepted}: {
  desktopId: string;
  tracked: {requestId: string; response: Promise<unknown>};
  request: RemoteRequest;
  signal?: AbortSignal;
  keepTracking?: boolean;
  timeoutMs?: number;
  onAccepted?: () => void;
}) {
  const admitted = tracked.response.then(() => {
    try {onAccepted?.();} catch { /* UI feedback cannot change execution. */ }
    return true;
  }, cause => {
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
    if (code.startsWith('remote_') && ![
      'remote_client_closed', 'remote_request_timeout', 'remote_client_offline',
      'remote_transport_error', 'remote_transport_closed', 'remote_operation_storage_failed',
    ].includes(code)) throw cause;
    return false;
  });
  const completion = admitted.then(() => waitForCommand({desktopId, requestId: tracked.requestId, request, signal, timeoutMs, keepTracking}));
  // Callers may first await admission. Keep a terminal rejection handled until
  // their completion observer is attached in the same click lifecycle.
  completion.catch(() => undefined);
  return {requestId: tracked.requestId, admitted, completion};
}


export function startCommand({
  desktopId, method, params, request, requestTracked, signal, timeoutMs, onAccepted,
}: {
  desktopId: string;
  method: string;
  params: Record<string, unknown>;
  request: RemoteRequest;
  requestTracked: RemoteTrackedRequest;
  signal?: AbortSignal;
  timeoutMs?: number;
  onAccepted?: () => void;
}): CommandReceipt {
  return trackCommand({desktopId, tracked: requestTracked(desktopId, method, params, 30_000), request, signal, timeoutMs, onAccepted});
}

export type CompactConfig = {
  autoCompactEnabled: boolean;
  triggerRatio: number;
  contextLength: number;
  contextLengthSource?: 'api' | 'manual' | 'default';
  contextLengthManual?: boolean;
  keepRecentRounds: number;
  hideCompactedMessages: boolean;
  compactPrompt: string;
};

export type ConversationConfig = {
  model: string;
  reasoningEffort: string;
  voice: string;
  mcpServerIds: string[];
  skillIds: string[];
  systemPrompt: string;
  compact: CompactConfig;
};

export type ContextUsage = {
  status: 'ready' | 'calculating' | 'stale' | 'unavailable'; estimated: boolean;
  systemTokens: number; conversationTokens: number; toolTokens: number; updatedAt: number;
};


export type ConversationConfigResult = {

  contextUsage?: ContextUsage | null,
  revision: number;
  busy?: boolean;
  deferred?: boolean;
  patched: string[];
  config: ConversationConfig;
  options: {
    models: Array<{value: string; label: string}>;
    reasoningEfforts: string[];
    voices: string[];
    mcpServers: Array<{id: string; name: string; tags: string[]; preset: boolean; transport?: string}>;
    skills: Array<{id: string; name: string}>;
  };
};

export type BusinessSection = 'general' | 'providers' | 'prompts' | 'mcpServers' | 'tasks';
export type BusinessConfigSection = {
  ok: true;
  section: BusinessSection;
  revision: string;
  bytes: number;
  value: Record<string, unknown>;
};
