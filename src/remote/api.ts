import type {RemoteEventMessage} from './client';

export type RemoteRequest = <T>(
  desktopId: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<T>;

export type RemoteTrackedRequest = <T>(
  desktopId: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => {requestId: string; response: Promise<T>};

export type ConversationProject = {
  projectId: string;
  name: string;
};

export type ConversationWindow = {
  windowId: string;
  conversationId: string;
  title: string;
  revision: number;
  visible: boolean;
  busy: boolean;
  generating: boolean;
  compacting: boolean;
  readOnly: boolean;
  mobileControlled?: boolean;
  leasePending: boolean;
  promptCode: string;
};

export type OpenedConversationSession = {
  conversationId: string;
  title: string;
  windowId: string;
  visible: boolean;
  busy: boolean;
  mobileControlled: boolean;
  controlledByThisDevice: boolean;
  hidden: boolean;
  hasDesktopObserver: boolean;
};


export type ConversationSummary = {
  conversationId: string;
  title: string;
  format: 'sqlite' | 'legacy-json';
  revision: number;
  createdAt: string;
  updatedAt: string;
  byteSize: number;
  project: ConversationProject | null;
  migrationRequired: boolean;
  readable: boolean;
  window: ConversationWindow | null;
};

export type ConversationListResult = {
  ok: true;
  configured: boolean;
  conversations: ConversationSummary[];
  projects: Array<ConversationProject & {conversationIds: string[]}>;
  windows?: ConversationWindow[];
  page: {limit: number; nextCursor: string | null; hasMore: boolean};
  catalogRevision: string;
};

export type RemoteAttachmentReference = {
  type?: string;
  attachmentId?: string;
  filename?: string;
  name?: string;
  mimeType?: string;
  byteSize?: number;
  sha256?: string;
  available?: boolean;
  [key: string]: unknown;
};

export type RemoteMessagePayload = {
  content: unknown;
  reasoningContent: string;
  summary: string;
  summaryPrefix: string;
  timestamp: string;
  completedTimestamp: string;
  aiName: string;
  voiceName: string;
  status: string;
  toolCalls: Array<{
    id: string;
    name: string;
    status: string;
    arguments?: unknown;
    result?: unknown;
    choice?: {
      questions: Array<{
        question: string;
        header: string;
        options: Array<{label: string; description: string}>;
      }>;
    };
  }>;
  compaction?: {
    snapshotId: string;
    coveredCount: number;
    tokenCount: number;
    canRestore: boolean;
  };
};

export type RemoteMessage = {
  messageId: string;
  uiMessageId: string;
  role: string;
  order: number;
  payload: RemoteMessagePayload;
};

export type ConversationTask = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  steps: Array<{content: string; status: 'pending' | 'in_progress' | 'completed'}>;
};

export type ConversationMessagesResult = {
  ok: true;
  conversation: {
    conversationId: string;
    title: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    model?: string;
    assistant?: {name: string; avatarUrl: string};
    project: ConversationProject | null;
  };
  messages: RemoteMessage[];
  tasks?: ConversationTask[];
  page: {
    pageSize: number;
    nextBeforeUiOrder: number | null;
    hasMore: boolean;
  };
};

export type RemoteAssistant = {
  code: string;
  name: string;
  icon?: string;
  model?: string;
  defaultProjectName?: string;
  mcpCount?: number;
  skillCount?: number;
  usageWeight?: number;
};

export type WorkspaceProject = {
  projectId: string;
  name: string;
  conversationCount: number;
};

export type WorkspaceAssistant = {
  code: string;
  name: string;
  icon: string;
  enabled: boolean;
  model: string;
  defaultProjectId: string;
  defaultProjectName: string;
  mcpCount: number;
  skillCount: number;
  capabilities: string[];
};

export type WorkspaceProfile = {
  displayName: string;
  avatarUrl: string;
  avatarDataUrl?: string;
  avatarVersion?: string;
};

export type WorkspaceBootstrap = {
  ok: true;
  profile: WorkspaceProfile;
  projects: WorkspaceProject[];
  assistants: WorkspaceAssistant[];
  configured: boolean;
};

export type WorkspaceAssistantDetail = WorkspaceAssistant & {
  revision: string;
  systemPrompt: string;
  reasoningEffort: string;
  voice: string;
  mcpServerIds: string[];
  skillIds: string[];
};

export type AgentOption = {id?: string; value?: string; name?: string; label?: string};

export type WorkspaceAgent = {
  code: string;
  name: string;
  enabled: boolean;
  icon: string;
  iconDataUrl: string;
  model: string;
  type: 'general' | 'over' | 'img' | 'files';
  showMode: 'window' | 'fastinput';
  tags: string[];
  stream: boolean;
  reasoningEffort: string;
  autoSaveChat: boolean;
  defaultProjectId: string;
  defaultProjectName: string;
  voice: string;
  mcpServerIds: string[];
  skillIds: string[];
  revision: string;
};

export type WorkspaceAgentDetail = WorkspaceAgent & {systemPrompt: string};


export type WorkspaceAgentOptions = {
  models: Array<{value: string; label: string}>;
  projects: WorkspaceProject[];
  mcpServers: Array<{id: string; name: string}>;
  skills: Array<{id: string; name: string}>;
  voices: string[];
};

export type WorkspaceAgentRoutes = {
  general: string;
  superior: string;
  fast: string;
};

export type WorkspaceAgentCatalog = {
  ok: true;
  tags: string[];
  agents: WorkspaceAgent[];
  options: WorkspaceAgentOptions;
  routes: WorkspaceAgentRoutes;
  routesRevision: string;
};


export type WorkspaceProviderFolder = {
  id: string;
  name: string;
  collapsed: boolean;
};

export type WorkspaceProvider = {
  id: string;
  name: string;
  enabled: boolean;
  url: string;
  apiType: 'chat_completions' | 'responses' | 'codex' | 'claude';
  models: string[];
  retryCount: number;
  folderId: string;
  apiKeyCount: number;
  headerNames: string[];
  revision: string;
};

export type WorkspaceProviderOptions = {
  apiTypes: Array<{value: WorkspaceProvider['apiType']; label: string}>;
  folders: Array<{id: string; name: string}>;
};

export type WorkspaceProviderCatalog = {
  ok: true;
  folders: WorkspaceProviderFolder[];
  providers: WorkspaceProvider[];
  options: WorkspaceProviderOptions;
};


export type WorkspaceManagementCatalog = {
  ok: true;
  sections: Array<{id: string; title: string; count: number}>;
  projects: WorkspaceProject[];
  general: {language: string; themeMode: string};
};


export type WorkspaceManagementDetails = {
  ok: true;
  section: 'providers' | 'mcp' | 'skills' | 'tasks' | 'general';
  revision?: string;
  items?: Array<Record<string, unknown>>;
  value?: {language: string; themeMode: string; displayName: string; avatarUrl: string};
};
export type ConversationCreateResult = {
  ok: true; conversationId: string; windowId: string; title: string; promptCode: string;
  hidden: boolean; created: true; queued?: boolean; position?: number; duplicate?: boolean;
};


export type ConversationCommandResult = {
  ok: true;
  conversationId: string;
  windowId: string;
  hidden: boolean;
  created: boolean;
  queued?: boolean;
  position?: number;
  duplicate?: boolean;
};

export type ConversationRequestState = {
  ok: true;
  requestId: string;
  conversationId: string;
  windowId: string;
  event: string;
  eventSequence: number;
  terminal: boolean;
  text: string;
  reasoning: string;
  truncated: boolean;
  updatedAt: string;
  result?: Record<string, unknown>;
};

export type ConversationStreamEvent = RemoteEventMessage & {
  payload: {
    requestId?: string;
    conversationId?: string;
    windowId?: string;
    eventSequence?: number;
    textDelta?: string;
    reasoningDelta?: string;
    status?: string;
    code?: string;
    revision?: number;
    [key: string]: unknown;
  };
};

export function createRemoteApi({
  desktopId,
  request,
  requestTracked,
}: {
  desktopId: string;
  request: RemoteRequest;
  requestTracked: RemoteTrackedRequest;
}) {
  return {
    workspaceBootstrap() {
      return request<WorkspaceBootstrap>(desktopId, 'workspace.bootstrap.get');
    },
    workspaceAssistants() {
      return request<{ok: true; assistants: WorkspaceAssistant[]}>(desktopId, 'workspace.assistants.list');
    },
    workspaceAssistant(code: string) {
      return request<{ok: true; assistant: WorkspaceAssistantDetail}>(desktopId, 'workspace.assistant.get', {code});
    },
    patchWorkspaceAssistant(code: string, expectedRevision: string, patch: Record<string, unknown>) {
      return request<{ok: true; assistant: WorkspaceAssistantDetail}>(desktopId, 'workspace.assistant.patch', {code, expectedRevision, patch}, 60_000);
    },
    createWorkspaceProject(name: string) {
      return request<{ok: true; project: WorkspaceProject}>(desktopId, 'workspace.project.create', {name}, 60_000);
    },
    workspaceManagementCatalog() {
      return request<WorkspaceManagementCatalog>(desktopId, 'workspace.management.catalog.get');
    },

    workspaceManagementDetails(section: 'providers' | 'mcp' | 'skills' | 'tasks' | 'general') {
      return request<WorkspaceManagementDetails>(desktopId, 'workspace.management.details.get', {section});
    },
    listAssistants() {
      return request<{ok: true; assistants: RemoteAssistant[]}>(desktopId, 'conversation.assistants.list');
    },
    createConversation(promptCode: string) {
      return request<ConversationCreateResult>(desktopId, 'conversation.create', {promptCode}, 60_000);
    },

    listConversations(limit = 100, cursor?: string) {
      return request<ConversationListResult>(desktopId, 'conversation.list', {
        limit,
        ...(cursor ? {cursor} : {}),
      });
    },
    listMessages(
      conversationId: string,
      options: {beforeUiOrder?: number; pageSize?: number} = {},
    ) {
      return request<ConversationMessagesResult>(
        desktopId,
        'conversation.messages.list',
        {
          conversationId,
          ...(options.beforeUiOrder !== undefined
            ? {beforeUiOrder: options.beforeUiOrder}
            : {}),
          ...(options.pageSize !== undefined
            ? {pageSize: options.pageSize}
            : {}),
        },
      );
    },
    listWindows() {
      return request<{ok: true; windows: ConversationWindow[]; updatedAt: string}>(
        desktopId,
        'conversation.windows.list',
      );
    },
    send(
      conversationId: string,
      text: string,
      uploadIds: string[] = [],
    ) {
      return requestTracked<ConversationCommandResult>(
        desktopId,
        'conversation.send',
        {conversationId, text, uploadIds},
        30_000,
      );
    },
    openConversation(conversationId: string) {
      return request<{ok: true; conversationId: string; windowId: string; created: boolean; mobileControlled: boolean; observingDesktop: boolean}>(
        desktopId,
        'conversation.open',
        {conversationId},
        30_000,
      );
    },

    listSendQueue(conversationId: string) {
      return request<{ok: true; conversationId: string; activeRequestId: string; items: Array<{requestId: string; position: number; text?: string}>}>(desktopId, 'conversation.queue.list', {conversationId});
    },
    removeQueuedSend(conversationId: string, requestId: string) {
      return request<{ok: true; conversationId: string; requestId: string; removed: true}>(desktopId, 'conversation.queue.remove', {conversationId, requestId});
    },

    cancel(conversationId: string) {
      return request<{ok: true; targetRequestId: string}>(
        desktopId,
        'conversation.cancel',
        {conversationId},
      );
    },
    getRequest(requestId: string) {
      return request<ConversationRequestState>(
        desktopId,
        'conversation.request.get',
        {requestId},
      );
    },
    release(conversationId: string) {
      return request<{ok: true; conversationId: string; released: boolean; busy?: boolean}>(
        desktopId,
        'conversation.release',
        {conversationId},
        15_000,
      );
    },

    listOpenedSessions() {
      return request<{ok: true; sessions: OpenedConversationSession[]}>(
        desktopId,
        'conversation.opened.list',
      );
    },
    takeover(conversationId: string) {
      return request<{ok: true; conversationId: string; windowId: string; hidden: boolean; mobileControlled: true}>(
        desktopId,
        'conversation.takeover',
        {conversationId},
        30_000,
      );
    },
    handoff(conversationId: string) {
      return request<{ok: true; conversationId: string; windowId: string; hidden: false; mobileControlled: false}>(
        desktopId,
        'conversation.handoff',
        {conversationId},
        30_000,
      );
    },


    showOnDesktop(conversationId: string) {
      return request<{ok: true; windowId: string; hidden: false}>(
        desktopId,
        'conversation.showOnDesktop',
        {conversationId},
      );
    },
  };
}
