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
  intervalMs = 400, onProgress,
}: {
  desktopId: string;
  requestId: string;
  request: RemoteRequest;
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
  onProgress?: (state: ConversationRequestState) => void;
}): Promise<ConversationRequestState> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (signal?.aborted) throw new RemoteCommandPendingError(requestId);
    let state: ConversationRequestState;
    try {
      state = await request<ConversationRequestState>(
        desktopId, 'conversation.request.get', {requestId},
      );
    } catch {
      throw new RemoteCommandPendingError(requestId);
    }
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
  } while (Date.now() < deadline);
  throw new RemoteCommandPendingError(requestId);
}

export function startCommand({
  desktopId, method, params, request, requestTracked, signal, timeoutMs,
}: {
  desktopId: string;
  method: string;
  params: Record<string, unknown>;
  request: RemoteRequest;
  requestTracked: RemoteTrackedRequest;
  signal?: AbortSignal;
  timeoutMs?: number;
}): CommandReceipt {
  const tracked = requestTracked(desktopId, method, params, 30_000);
  const completion = (async () => {
    try {
      await tracked.response;
    } catch (error) {
      // A lost ACK is not proof of failure. Never dispatch the command again.
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code) : '';
      if (code.startsWith('remote_') && ![
        'remote_client_closed', 'remote_request_timeout', 'remote_client_offline',
        'remote_transport_error', 'remote_transport_closed',
      ].includes(code)) throw error;
    }
    return waitForCommand({
      desktopId, requestId: tracked.requestId, request, signal, timeoutMs,
    });
  })();
  return {requestId: tracked.requestId, completion};
}

export type CompactConfig = {
  autoCompactEnabled: boolean;
  triggerRatio: number;
  contextLength: number;
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

export type ConversationConfigResult = {
  revision: number;
  patched: string[];
  config: ConversationConfig;
  options: {
    models: Array<{value: string; label: string}>;
    reasoningEfforts: string[];
    voices: string[];
    mcpServers: Array<{id: string; name: string}>;
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
