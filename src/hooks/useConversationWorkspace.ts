import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DesktopStatus } from '../domain/pairing';
import {
  ConversationListResult,
  ConversationMessagesResult,
  OpenedConversationSession,
  ConversationRequestState,
  ConversationStreamEvent,
  ConversationSummary,
  ConversationTask,
  createRemoteApi,
  RemoteMessage,
  RemoteRequest,
  RemoteTrackedRequest,
} from '../remote/api';
import type { RemoteEventMessage } from '../remote/client';

export type ActiveConversationTurn = {
  requestId: string;
  conversationId: string;
  submittedText: string;
  text: string;
  reasoning: string;
  event: string;
  eventSequence: number;
  terminal: boolean;
  truncated: boolean;
  historyLoaded?: boolean;
  replacedUiMessageId?: string;
  errorCode?: string;
};

type SubscribeEvents = (
  listener: (desktopId: string, event: RemoteEventMessage) => void,
) => () => void;

export function useConversationWorkspace({
  desktopId,
  desktopStatus,
  request,
  requestTracked,
  subscribeEvents,
}: {
  desktopId: string;
  desktopStatus: DesktopStatus;
  request: RemoteRequest;
  requestTracked: RemoteTrackedRequest;
  subscribeEvents: SubscribeEvents;
}) {
  const api = useMemo(
    () => createRemoteApi({ desktopId, request, requestTracked }),
    [desktopId, request, requestTracked],
  );
  const [catalog, setCatalog] = useState<ConversationSummary[]>([]);
  const [catalogPage, setCatalogPage] = useState<
    ConversationListResult['page']
  >({
    limit: 100,
    nextCursor: null,
    hasMore: false,
  });
  const [configured, setConfigured] = useState(true);
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [messages, setMessages] = useState<RemoteMessage[]>([]);
  const [tasks, setTasks] = useState<ConversationTask[]>([]);
  const [conversationModel, setConversationModel] = useState('');
  const [conversationAssistant, setConversationAssistant] = useState({name: '', avatarUrl: ''});
  const [openedSessions, setOpenedSessions] = useState<OpenedConversationSession[]>([]);
  const [controlledConversationIds, setControlledConversationIds] = useState<string[]>([]);
  const [pendingChoices, setPendingChoices] = useState<Record<string, {conversationId: string; questions: Array<{question: string; header: string; options: Array<{label: string; description: string}>}>}>>({});
  const [messagePage, setMessagePage] = useState<
    ConversationMessagesResult['page']
  >({
    pageSize: 50,
    nextBeforeUiOrder: null,
    hasMore: false,
  });
  const [activeTurn, setActiveTurn] = useState<ActiveConversationTurn | null>(
    null,
  );

  const [queuedSends, setQueuedSends] = useState<
    Array<{
      requestId: string;
      conversationId: string;
      text: string;
      position: number;
    }>
  >([]);
  const queuedSendsRef = useRef<
    Array<{
      requestId: string;
      conversationId: string;
      text: string;
      position: number;
    }>
  >([]);
  const commitQueue = useCallback(
    (
      updater:
        | Array<{
            requestId: string;
            conversationId: string;
            text: string;
            position: number;
          }>
        | ((
            current: Array<{
              requestId: string;
              conversationId: string;
              text: string;
              position: number;
            }>,
          ) => Array<{
            requestId: string;
            conversationId: string;
            text: string;
            position: number;
          }>),
    ) => {
      const next =
        typeof updater === 'function'
          ? updater(queuedSendsRef.current)
          : updater;
      queuedSendsRef.current = next;
      setQueuedSends(next);
    },
    [],
  );
  const activeTurnRef = useRef<ActiveConversationTurn | null>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const creatingRef = useRef(false);

  const [catalogLoading, setCatalogLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState('');
  const scopeRef = useRef({ desktopId, desktopStatus, selectedConversationId });
  scopeRef.current = { desktopId, desktopStatus, selectedConversationId };
  const catalogEpoch = useRef(0);
  const messageEpoch = useRef(0);

  const commitTurn = useCallback(
    (
      updater:
        | ActiveConversationTurn
        | null
        | ((
            current: ActiveConversationTurn | null,
          ) => ActiveConversationTurn | null),
    ) => {
      const next =
        typeof updater === 'function'
          ? updater(activeTurnRef.current)
          : updater;
      activeTurnRef.current = next;
      setActiveTurn(next);
    },
    [],
  );

  const refreshCatalog = useCallback(async () => {
    if (desktopStatus !== '在线') return;
    const epoch = ++catalogEpoch.current;
    const isCurrent = () =>
      epoch === catalogEpoch.current &&
      scopeRef.current.desktopId === desktopId;
    setCatalogLoading(true);
    setError('');
    try {
      const result = await api.listConversations(100);
      if (!isCurrent()) return;
      setConfigured(result.configured);
      setCatalog(result.conversations);
      setCatalogPage(result.page);
      setSelectedConversationId(current => {
        if (
          current &&
          result.conversations.some(item => item.conversationId === current)
        ) {
          return current;
        }
        return (
          result.conversations.find(item => item.readable)?.conversationId ?? ''
        );
      });
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause));
    } finally {
      if (isCurrent()) setCatalogLoading(false);
    }
  }, [api, desktopId, desktopStatus]);

  const loadMoreCatalog = useCallback(async () => {
    if (!catalogPage.hasMore || !catalogPage.nextCursor || catalogLoading)
      return;
    setCatalogLoading(true);
    try {
      const result = await api.listConversations(
        catalogPage.limit,
        catalogPage.nextCursor,
      );
      setCatalog(current =>
        mergeById(current, result.conversations, 'conversationId'),
      );
      setCatalogPage(result.page);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCatalogLoading(false);
    }
  }, [api, catalogLoading, catalogPage]);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      if (!conversationId || desktopStatus !== '在线') return;
      const epoch = ++messageEpoch.current;
      const requestedTurn = activeTurnRef.current;
      const isCurrent = () =>
        epoch === messageEpoch.current &&
        scopeRef.current.desktopId === desktopId &&
        scopeRef.current.selectedConversationId === conversationId;
      setMessagesLoading(true);
      setError('');
      try {
        const result = await api.listMessages(conversationId, { pageSize: 50 });
        if (!isCurrent()) return;
        setMessages(result.messages);
        setTasks(Array.isArray(result.tasks) ? result.tasks : []);
        setConversationModel(typeof result.conversation?.model === 'string' ? result.conversation.model : '');
        setConversationAssistant({
          name: typeof result.conversation?.assistant?.name === 'string' ? result.conversation.assistant.name : '',
          avatarUrl: typeof result.conversation?.assistant?.avatarUrl === 'string' ? result.conversation.assistant.avatarUrl : '',
        });
        setMessagePage(result.page);
        commitTurn(current =>
          requestedTurn?.terminal &&
          current?.terminal &&
          current.requestId === requestedTurn.requestId &&
          current.conversationId === conversationId
            ? { ...current, historyLoaded: true }
            : current,
        );
      } catch (cause) {
        if (isCurrent()) {
          setMessages([]);
          setError(errorMessage(cause));
        }
      } finally {
        if (isCurrent()) setMessagesLoading(false);
      }
    },
    [api, commitTurn, desktopId, desktopStatus],
  );

  const loadOlderMessages = useCallback(async () => {
    if (
      !selectedConversationId ||
      !messagePage.hasMore ||
      messagePage.nextBeforeUiOrder == null ||
      messagesLoading
    ) {
      return;
    }
    const epoch = ++messageEpoch.current;
    const isCurrent = () =>
      epoch === messageEpoch.current &&
      scopeRef.current.desktopId === desktopId &&
      scopeRef.current.selectedConversationId === selectedConversationId;
    setMessagesLoading(true);
    try {
      const result = await api.listMessages(selectedConversationId, {
        pageSize: messagePage.pageSize,
        beforeUiOrder: messagePage.nextBeforeUiOrder,
      });
      if (!isCurrent()) return;
      setMessages(current =>
        mergeById(result.messages, current, 'uiMessageId').sort(
          (left, right) => left.order - right.order,
        ),
      );
      setMessagePage(result.page);
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause));
    } finally {
      if (isCurrent()) setMessagesLoading(false);
    }
  }, [api, desktopId, messagePage, messagesLoading, selectedConversationId]);

  const refreshOpenedSessions = useCallback(async () => {
    if (desktopStatus !== '在线') return;
    try {
      const result = await api.listOpenedSessions();
      setOpenedSessions(result.sessions || []);
      setControlledConversationIds((result.sessions || [])
        .filter(item => item.controlledByThisDevice)
        .map(item => item.conversationId));
    } catch {
      // Window ownership is advisory UI state; message reads remain available.
    }
  }, [api, desktopStatus]);

  const takeoverConversation = useCallback(async (conversationId: string) => {
    if (!conversationId) return;
    await api.takeover(conversationId);
    await Promise.all([refreshOpenedSessions(), refreshCatalog()]);
    if (scopeRef.current.selectedConversationId === conversationId) await loadMessages(conversationId);
  }, [api, loadMessages, refreshCatalog, refreshOpenedSessions]);

  const handoffConversation = useCallback(async (conversationId: string) => {
    if (!conversationId) return;
    await api.handoff(conversationId);
    await Promise.all([refreshOpenedSessions(), refreshCatalog()]);
    if (scopeRef.current.selectedConversationId === conversationId) await loadMessages(conversationId);
  }, [api, loadMessages, refreshCatalog, refreshOpenedSessions]);

  const canControlConversation = useCallback((conversationId: string) =>
    controlledConversationIds.includes(conversationId), [controlledConversationIds]);


  const releaseConversation = useCallback((conversationId: string) => {
    if (!conversationId || desktopStatus !== '在线') return;
    api.release(conversationId).catch(() => undefined);
  }, [api, desktopStatus]);

  const selectConversation = useCallback((conversationId: string) => {
    const previousConversationId = scopeRef.current.selectedConversationId;
    if (previousConversationId && previousConversationId !== conversationId) {
      releaseConversation(previousConversationId);
    }
    if (desktopStatus === '在线') {
      api.openConversation(conversationId)
        .then(result => {
          if (scopeRef.current.selectedConversationId !== conversationId) return;
          if (result.mobileControlled) setControlledConversationIds(current => [...new Set([...current, conversationId])]);
          else setControlledConversationIds(current => current.filter(id => id !== conversationId));
          refreshOpenedSessions().catch(() => undefined);
        })
        .catch(cause => setError(errorMessage(cause)));
    }
    messageEpoch.current += 1;
    scopeRef.current.selectedConversationId = conversationId;
    setMessages([]);
    setTasks([]);
    setConversationModel('');
    setConversationAssistant({name: '', avatarUrl: ''});
    setPendingChoices({});
    setMessagePage({ pageSize: 50, nextBeforeUiOrder: null, hasMore: false });
    setSelectedConversationId(conversationId);
  }, [api, desktopStatus, refreshOpenedSessions, releaseConversation]);

  const createConversation = useCallback(
    async (promptCode: string) => {
      if (creatingRef.current) throw new Error('正在创建会话，请勿重复点击。');
      if (desktopStatus !== '在线')
        throw new Error('请等待 Desktop 在线后新建会话。');
      creatingRef.current = true;
      setCreatingConversation(true);
      try {
        const result = await api.createConversation(promptCode);
        if (scopeRef.current.desktopId !== desktopId) return;
        catalogEpoch.current += 1;
        setCatalogLoading(false);
        const now = new Date().toISOString();
        const created: ConversationSummary = {
          conversationId: result.conversationId,
          title: result.title,
          format: 'sqlite',
          revision: 0,
          createdAt: now,
          updatedAt: now,
          byteSize: 0,
          project: null,
          readable: true,
          migrationRequired: false,
          window: null,
        };
        setCatalog(current =>
          mergeById(
            [created],
            current.filter(
              item => item.conversationId !== result.conversationId,
            ),
            'conversationId',
          ),
        );
        setControlledConversationIds(current => [...new Set([...current, result.conversationId])]);
        setConfigured(true);
        selectConversation(result.conversationId);
        setError('');
      } catch (cause) {
        if (scopeRef.current.desktopId === desktopId)
          setError(errorMessage(cause));
        throw cause;
      } finally {
        creatingRef.current = false;
        setCreatingConversation(false);
      }
    },
    [api, desktopId, desktopStatus, selectConversation],
  );

  const applyRequestState = useCallback(
    (state: ConversationRequestState) => {
      commitTurn(current => {
        if (!current || current.requestId !== state.requestId) return current;
        if (state.eventSequence < current.eventSequence) return current;
        return {
          ...current,
          conversationId: state.conversationId,
          text: state.text,
          reasoning: state.reasoning,
          event: state.event,
          eventSequence: Math.max(current.eventSequence, state.eventSequence),
          terminal: state.terminal,
          truncated: state.truncated,
          errorCode:
            (state.event === 'assistant.failed' ||
              state.event === 'conversation.operation.failed') &&
            typeof state.result?.code === 'string'
              ? state.result.code
              : current.errorCode,
        };
      });
      if (state.terminal) {
        if (scopeRef.current.selectedConversationId === state.conversationId) {
          loadMessages(state.conversationId).catch(() => undefined);
        }
        refreshCatalog().catch(() => undefined);
      }
    },
    [commitTurn, loadMessages, refreshCatalog],
  );

  const recoverActiveTurn = useCallback(async () => {
    const active = activeTurnRef.current;
    if (!active || active.terminal || desktopStatus !== '在线') return;
    try {
      applyRequestState(await api.getRequest(active.requestId));
    } catch (cause) {
      setError(`无法恢复生成状态：${errorMessage(cause)}`);
    }
  }, [api, applyRequestState, desktopStatus]);

  useEffect(() => {
    if (desktopStatus !== '在线' || !selectedConversationId) return;
    let cancelled = false;
    api
      .listSendQueue(selectedConversationId)
      .then(async snapshot => {
        if (cancelled || !Array.isArray(snapshot.items)) return;
        commitQueue(current => [
          ...current.filter(
            item => item.conversationId !== selectedConversationId,
          ),
          ...snapshot.items.map(item => ({
            ...item,
            conversationId: selectedConversationId,
            text: item.text || '',
          })),
        ]);
        if (
          snapshot.activeRequestId &&
          (!activeTurnRef.current || activeTurnRef.current.terminal)
        ) {
          const state = await api.getRequest(snapshot.activeRequestId);
          if (cancelled) return;
          commitTurn({
            requestId: state.requestId,
            conversationId: selectedConversationId,
            submittedText: '',
            text: state.text,
            reasoning: state.reasoning,
            event: state.event,
            eventSequence: state.eventSequence,
            terminal: state.terminal,
            truncated: state.truncated,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, desktopStatus, selectedConversationId, commitQueue, commitTurn]);

  const recoverQueue = useCallback(async () => {
    if (desktopStatus !== '在线') return;
    for (const queued of [...queuedSendsRef.current]) {
      try {
        const state = await api.getRequest(queued.requestId);
        if (scopeRef.current.desktopId !== desktopId) return;
        if (state.terminal) {
          commitQueue(current =>
            current.filter(item => item.requestId !== queued.requestId),
          );
          if (scopeRef.current.selectedConversationId === queued.conversationId)
            loadMessages(queued.conversationId);
        } else if (
          state.event !== 'conversation.queue.pending' &&
          state.event !== 'conversation.command.pending'
        ) {
          commitQueue(current =>
            current.filter(item => item.requestId !== queued.requestId),
          );
          commitTurn({
            requestId: queued.requestId,
            conversationId: queued.conversationId,
            submittedText: queued.text,
            text: state.text,
            reasoning: state.reasoning,
            event: state.event,
            eventSequence: state.eventSequence,
            terminal: false,
            truncated: state.truncated,
          });
        }
      } catch {
        setError('待发请求状态暂不可用；请重连后查询，不要重复发送。');
      }
    }
  }, [api, desktopId, desktopStatus, commitQueue, commitTurn, loadMessages]);
  useEffect(() => {
    if (desktopStatus !== '在线') return;
    recoverQueue();
    const timer = setInterval(recoverQueue, 2500);
    return () => clearInterval(timer);
  }, [desktopStatus, recoverQueue]);

  const handleStreamEvent = useCallback(
    (event: ConversationStreamEvent) => {
      const payload = event.payload;
      const requestId =
        typeof payload.requestId === 'string' ? payload.requestId : '';
      const conversationId =
        typeof payload.conversationId === 'string'
          ? payload.conversationId
          : '';
      const sequence = Number(payload.eventSequence) || 0;
      if (event.event === 'conversation.tasks.updated' && conversationId === scopeRef.current.selectedConversationId && Array.isArray(payload.tasks)) {
        setTasks(payload.tasks as ConversationTask[]);
      }
      if (event.event === 'conversation.choice.required' && conversationId && typeof payload.toolCallId === 'string' && Array.isArray(payload.questions)) {
        setPendingChoices(current => ({
          ...current,
          [payload.toolCallId as string]: {
            conversationId,
            questions: payload.questions as Array<{question: string; header: string; options: Array<{label: string; description: string}>}>,
          },
        }));
      }

      const queued = queuedSendsRef.current.find(
        item => item.requestId === requestId,
      );
      if (
        queued &&
        (event.event === 'assistant.started' ||
          event.event === 'assistant.delta')
      ) {
        commitQueue(current =>
          current.filter(item => item.requestId !== requestId),
        );
        commitTurn(current =>
          current?.requestId === requestId
            ? current
            : {
                requestId,
                conversationId: conversationId || queued.conversationId,
                submittedText: queued.text,
                text: '',
                reasoning: '',
                event: 'conversation.command.pending',
                eventSequence: 0,
                terminal: false,
                truncated: false,
              },
        );
      }
      if (queued && isTerminalEvent(event.event)) {
        commitQueue(current =>
          current.filter(item => item.requestId !== requestId),
        );
      }
      let becameTerminal = false;
      commitTurn(current => {
        if (!current || current.requestId !== requestId || current.terminal)
          return current;
        if (sequence < 1 || sequence <= current.eventSequence) return current;
        const terminal = isTerminalEvent(event.event);
        becameTerminal = terminal;
        return {
          ...current,
          conversationId: conversationId || current.conversationId,
          text:
            event.event === 'assistant.delta'
              ? current.text + stringValue(payload.textDelta)
              : current.text,
          reasoning:
            event.event === 'assistant.delta'
              ? current.reasoning + stringValue(payload.reasoningDelta)
              : current.reasoning,
          event: event.event,
          eventSequence: Math.max(current.eventSequence, sequence),
          terminal,
          truncated: current.truncated,
          errorCode:
            event.event === 'assistant.failed' ||
            event.event === 'conversation.operation.failed'
              ? stringValue(payload.code) || 'remote_operation_failed'
              : current.errorCode,
        };
      });
      if (becameTerminal && conversationId) {
        if (scopeRef.current.selectedConversationId === conversationId) {
          loadMessages(conversationId).catch(() => undefined);
        }
        refreshCatalog().catch(() => undefined);
      }
    },
    [commitQueue, commitTurn, loadMessages, refreshCatalog],
  );

  useEffect(() => {
    return subscribeEvents((eventDesktopId, event) => {
      if (eventDesktopId !== desktopId) return;
      if (event.event === 'conversation.windows.changed') {
        refreshCatalog().catch(() => undefined);
        refreshOpenedSessions().catch(() => undefined);
      }
      handleStreamEvent(event as ConversationStreamEvent);
    });
  }, [desktopId, handleStreamEvent, refreshCatalog, refreshOpenedSessions, subscribeEvents]);

  useEffect(() => {
    return () => {
      // A Mobile view never owns SQLite. Tell Desktop to close only its idle,
      // hidden Renderer writer when this workspace is unmounted or changes Desktop.
      releaseConversation(scopeRef.current.selectedConversationId);
    };
  }, [releaseConversation]);


  useEffect(() => {
    setCatalog([]);
    setMessages([]);
    setOpenedSessions([]);
    setControlledConversationIds([]);
    setSelectedConversationId('');
    commitTurn(null);
    commitQueue([]);
  }, [commitQueue, commitTurn, desktopId]);

  useEffect(() => {
    if (desktopStatus === '在线') {
      refreshCatalog().catch(() => undefined);
      refreshOpenedSessions().catch(() => undefined);
    }
  }, [desktopStatus, refreshCatalog, refreshOpenedSessions]);

  useEffect(() => {
    if (selectedConversationId && desktopStatus === '在线') {
      loadMessages(selectedConversationId).catch(() => undefined);
    } else {
      setMessages([]);
    }
  }, [desktopStatus, loadMessages, selectedConversationId]);

  useEffect(() => {
    if (desktopStatus === '在线') {
      recoverActiveTurn().catch(() => undefined);
    }
  }, [desktopStatus, recoverActiveTurn]);

  const assertControl = useCallback((conversationId: string) => {
    if (controlledConversationIds.includes(conversationId)) return;
    throw new Error('该会话正在由 Desktop 控制，请先点击“接管会话”。');
  }, [controlledConversationIds]);


  const sendMessage = useCallback(
    async (
      text: string,
      uploadIds: string[] = [],
      reaskUiMessageId?: string,
    ) => {
      const body = text;
      if (
        !selectedConversationId ||
        (!reaskUiMessageId && !body.trim() && uploadIds.length === 0)
      )
        return;
      assertControl(selectedConversationId);
      const shouldQueue = Boolean(
        activeTurnRef.current &&
          !activeTurnRef.current.terminal &&
          !reaskUiMessageId,
      );
      // Invalidate history reads started for the previous turn before replacing it.
      messageEpoch.current += 1;
      setMessagesLoading(false);
      const tracked = reaskUiMessageId
        ? requestTracked(
            desktopId,
            'conversation.message.reask',
            {
              conversationId: selectedConversationId,
              uiMessageId: reaskUiMessageId,
            },
            30_000,
          )
        : api.send(selectedConversationId, body, uploadIds);
      if (shouldQueue)
        commitQueue(current => [
          ...current,
          {
            requestId: tracked.requestId,
            conversationId: selectedConversationId,
            text: body,
            position: current.length + 1,
          },
        ]);
      if (!shouldQueue) {
        commitTurn({
          requestId: tracked.requestId,
          conversationId: selectedConversationId,
          submittedText: body,
          replacedUiMessageId: reaskUiMessageId,
          text: '',
          reasoning: '',
          event: 'conversation.command.pending',
          eventSequence: 0,
          terminal: false,
          truncated: false,
        });
      }
      setError('');
      try {
        const accepted = (await tracked.response) as {
          queued?: boolean;
          position?: number;
        };
        if (accepted.queued) {
          if (!shouldQueue)
            commitQueue(current => [
              ...current,
              {
                requestId: tracked.requestId,
                conversationId: selectedConversationId,
                text: body,
                position: Number(accepted.position) || 1,
              },
            ]);
          else
            commitQueue(current =>
              current.map(item =>
                item.requestId === tracked.requestId
                  ? {
                      ...item,
                      position: Number(accepted.position) || item.position,
                    }
                  : item,
              ),
            );
        } else if (
          shouldQueue &&
          queuedSendsRef.current.some(
            item => item.requestId === tracked.requestId,
          )
        ) {
          commitQueue(current =>
            current.filter(item => item.requestId !== tracked.requestId),
          );
          commitTurn({
            requestId: tracked.requestId,
            conversationId: selectedConversationId,
            submittedText: body,
            text: '',
            reasoning: '',
            event: 'conversation.command.pending',
            eventSequence: 0,
            terminal: false,
            truncated: false,
          });
        }
      } catch (cause) {
        const code = errorCode(cause);
        const uncertain = [
          'remote_client_closed',
          'remote_request_timeout',
          'remote_transport_closed',
          'remote_transport_error',
          'SOCKET_SEND_FAILED',
          'SOCKET_UNAVAILABLE',
        ].includes(code);
        commitTurn(current =>
          current?.requestId === tracked.requestId && !current.terminal
            ? {
                ...current,
                terminal: !uncertain,
                event: uncertain
                  ? 'conversation.command.recovering'
                  : 'assistant.failed',
                errorCode: code,
              }
            : current,
        );
        setError(
          uncertain
            ? '连接已中断，Desktop 执行状态待确认；重连后查询原请求，请勿重复发送。'
            : errorMessage(cause),
        );
        if (!uncertain) {
          commitQueue(current =>
            current.filter(item => item.requestId !== tracked.requestId),
          );
          commitTurn(current =>
            current?.requestId === tracked.requestId
              ? {
                  ...current,
                  replacedUiMessageId: undefined,
                  historyLoaded: true,
                }
              : current,
          );
          throw cause;
        }
      }
    },
    [
      api,
      assertControl,
      commitQueue,
      commitTurn,
      desktopId,
      requestTracked,
      selectedConversationId,
    ],
  );

  const reaskLastAssistant = useCallback(
    async (uiMessageId: string) => {
      const last = [...messages]
        .reverse()
        .find(item => item.role === 'assistant');
      if (!last || last.uiMessageId !== uiMessageId) {
        throw new Error('仅允许重答最后一条 assistant 回复。');
      }
      await sendMessage('', [], uiMessageId);
    },
    [messages, sendMessage],
  );

  const removeQueuedSend = useCallback(
    async (requestId: string) => {
      const queued = queuedSendsRef.current.find(
        item => item.requestId === requestId,
      );
      if (!queued) return;
      assertControl(queued.conversationId);
      await api.removeQueuedSend(queued.conversationId, requestId);
      commitQueue(current =>
        current.filter(item => item.requestId !== requestId),
      );
    },
    [api, assertControl, commitQueue],
  );

  const submitChoice = useCallback(async (toolCallId: string, responses: Array<Record<string, unknown>>) => {
    const pending = pendingChoices[toolCallId];
    if (!pending || pending.conversationId !== selectedConversationId) throw new Error('该选择已失效，请刷新会话。');
    assertControl(pending.conversationId);
    await request(desktopId, 'conversation.choice.submit', {
      conversationId: pending.conversationId,
      toolCallId,
      responses,
    }, 60_000);
    setPendingChoices(current => {
      const next = {...current};
      delete next[toolCallId];
      return next;
    });
  }, [assertControl, desktopId, pendingChoices, request, selectedConversationId]);


  const releaseSelectedConversation = useCallback(() => {
    releaseConversation(scopeRef.current.selectedConversationId);
  }, [releaseConversation]);


  const cancelActiveTurn = useCallback(async () => {
    const active = activeTurnRef.current;
    if (!active || active.terminal) return;
    assertControl(active.conversationId);
    await api.cancel(active.conversationId);
  }, [api, assertControl]);

  const refreshMessages = useCallback(async () => {
    if (selectedConversationId) await loadMessages(selectedConversationId);
  }, [loadMessages, selectedConversationId]);

  const showSelectedOnDesktop = useCallback(async () => {
    if (selectedConversationId) {
      await api.showOnDesktop(selectedConversationId);
    }
  }, [api, selectedConversationId]);

  return {
    listAssistants: api.listAssistants,
    createConversation,
    queuedSends,
    removeQueuedSend,
    creatingConversation,

    configured,
    catalog,
    catalogPage,
    catalogLoading,
    selectedConversationId,
    selectedConversation:
      catalog.find(item => item.conversationId === selectedConversationId) ??
      null,
    messages:
      activeTurn?.conversationId === selectedConversationId &&
      !activeTurn.historyLoaded &&
      activeTurn.replacedUiMessageId
        ? messages.filter(
            message => message.uiMessageId !== activeTurn.replacedUiMessageId,
          )
        : messages,
    messagePage,
    messagesLoading,
    activeTurn,
    tasks,
    conversationModel,
    conversationAssistant,
    openedSessions,
    canControlConversation,
    takeoverConversation,
    handoffConversation,
    refreshOpenedSessions,
    pendingChoices,
    submitChoice,
    error,
    refreshCatalog,
    refreshMessages,
    loadMoreCatalog,
    selectConversation,
    loadOlderMessages,
    sendMessage,
    reaskLastAssistant,
    cancelActiveTurn,
    showSelectedOnDesktop,
    releaseSelectedConversation,
  };
}

function isTerminalEvent(event: string): boolean {
  return (
    event === 'assistant.completed' ||
    event === 'assistant.cancelled' ||
    event === 'assistant.failed' ||
    event === 'conversation.operation.failed'
  );
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errorCode(value: unknown): string {
  return value && typeof value === 'object' && 'code' in value
    ? String((value as { code: unknown }).code)
    : 'remote_request_failed';
}

function errorMessage(value: unknown): string {
  const code = errorCode(value);
  const messages: Record<string, string> = {
    remote_client_closed: '连接被重置，正在恢复。',
    remote_transport_closed: '连接已关闭，正在恢复。',
    remote_transport_error: '安全连接暂时不可用，正在重连。',

    remote_response_too_large: 'Desktop 返回的数据过大，当前请求未完成；连接仍保留。',
    remote_response_invalid: 'Desktop 返回的数据格式异常，当前请求未完成；连接仍保留。',
    remote_all_paired_endpoints_unreachable: '已配对的连接地址暂不可用，请确认 Desktop 远程服务仍在运行。',
    remote_request_timeout: 'Desktop 响应超时，请稍后重试。',
  };
  return messages[code] || (value instanceof Error ? value.message : String(value));
}

function mergeById<T extends Record<K, string>, K extends keyof T>(
  left: T[],
  right: T[],
  key: K,
): T[] {
  const result = new Map<string, T>();
  for (const item of [...left, ...right]) {
    result.set(item[key], item);
  }
  return [...result.values()];
}
