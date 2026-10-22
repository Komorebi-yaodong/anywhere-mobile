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

import {reconcileDesktopMessages} from '../components/conversationTimeline';

import {createConversationMessageRefresh} from './conversationMessageRefresh';

import {createBusinessSession} from '../remote/businessSession';

import {completeHistory, readSized} from '../remote/historyRead';
import type {Runtime} from '../../packages/remote-contract';

export type ActiveConversationTurn = {
  requestId: string;
  conversationId: string;
  submittedText: string;
  text: string;
  reasoning: string;
  toolCalls?: RemoteMessage['payload']['toolCalls'];
  event: string;
  eventSequence: number;
  terminal: boolean;
  truncated: boolean;
  segmentId?: string;
  historyLoaded?: boolean;
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
  const business = useMemo(() => createBusinessSession(desktopId, request), [desktopId, request]);
  const [authoritativeRuntime, setAuthoritativeRuntime] = useState<Runtime | null>(null);
  useEffect(() => {
    business.reset();
    setAuthoritativeRuntime(null);
  }, [business, desktopStatus]);

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

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [tasks, setTasks] = useState<ConversationTask[]>([]);
  const [conversationModel, setConversationModel] = useState('');
  const [conversationAssistant, setConversationAssistant] = useState({code: '', name: '', avatarUrl: ''});
  const [openedSessions, setOpenedSessions] = useState<OpenedConversationSession[]>([]);

  const [openedSessionsDesktop, setOpenedSessionsDesktop] = useState('');
  const [controlledConversationIds, setControlledConversationIds] = useState<string[]>([]);
  const [pendingChoices, setPendingChoices] = useState<Record<string, {conversationId: string; questions: Array<{question: string; header: string; options: Array<{label: string; description: string}>}>}>>({});
  const [messagePage, setMessagePage] = useState<
    ConversationMessagesResult['page']
  >({
    pageSize: 50,
    nextBeforeUiOrder: null,
    hasMore: false,
  });
  const messagePageRef = useRef(messagePage);
  messagePageRef.current = messagePage;


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

  const awaitingSendReceipts = useRef(new Set<string>());
  const [creatingConversation, setCreatingConversation] = useState(false);
  const creatingRef = useRef(false);

  const [catalogLoading, setCatalogLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState('');
  const scopeRef = useRef({ desktopId, desktopStatus, selectedConversationId });
  scopeRef.current = { desktopId, desktopStatus, selectedConversationId };
  const catalogEpoch = useRef(0);
  const messageEpoch = useRef(0);

  // Confirmed deletions remain hidden for this selected transcript, including
  // any stale in-flight refresh or older page. Cleared on conversation change.
  const deletedUiMessageIdsRef = useRef(new Set<string>());

  const missingConversationIds = useRef(new Set<string>());

  // An opened Desktop window might not appear in the current catalog page.
  // Keep only its safe display title while Mobile opens/reads the target; this
  // is UI state, not a Desktop path or a claim of write control.
  const selectedOpenedTitleRef = useRef('');

  const commitTurn = useCallback(
    (
      updater:
        | ActiveConversationTurn
        | null
        | ((
            current: ActiveConversationTurn | null,
          ) => ActiveConversationTurn | null),
      publish = true,
    ) => {
      const next =
        typeof updater === 'function'
          ? updater(activeTurnRef.current)
          : updater;
      activeTurnRef.current = next;
      if (publish) setActiveTurn(next);
    },
    [],
  );

  const forgetMissingConversation = useCallback((conversationId: string) => {
    missingConversationIds.current.add(conversationId);
    business.invalidate(conversationId);
    catalogEpoch.current += 1;
    setCatalogLoading(false);
    setCatalog(current => current.filter(item => item.conversationId !== conversationId));
    setOpenedSessions(current => current.filter(item => item.conversationId !== conversationId));
    setControlledConversationIds(current => current.filter(item => item !== conversationId));
    commitQueue(current => current.filter(item => item.conversationId !== conversationId));
    commitTurn(current => current?.conversationId === conversationId ? null : current);
    if (scopeRef.current.selectedConversationId === conversationId) {
      messageEpoch.current += 1;
      scopeRef.current.selectedConversationId = '';
      selectedOpenedTitleRef.current = '';
      messagesRef.current = [];
      setSelectedConversationId(''); setMessages([]); setMessagesLoading(false);
      setTasks([]); setConversationModel(''); setConversationAssistant({code: '', name: '', avatarUrl: ''});
      setPendingChoices({}); setAuthoritativeRuntime(null);
      setMessagePage({pageSize: 50, nextBeforeUiOrder: null, hasMore: false});
    }
  }, [business, commitQueue, commitTurn]);


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
      result.conversations = result.conversations.filter(item => !missingConversationIds.current.has(item.conversationId));
      setCatalog(result.conversations);
      setCatalogPage(result.page);
      setSelectedConversationId(current => {
        if (
          current &&
          (result.conversations.some(item => item.conversationId === current) ||
            !!selectedOpenedTitleRef.current)
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
        mergeById(current, result.conversations, 'conversationId').filter(item => !missingConversationIds.current.has(item.conversationId)),
      );
      setCatalogPage(result.page);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCatalogLoading(false);
    }
  }, [api, catalogLoading, catalogPage]);

  const readMessages = useCallback(
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
        const view = await business.read(conversationId, 50);
        const result = view?.page || await completeHistory(await readSized(size => api.listMessages(conversationId, {pageSize: size}), 50), params => request(desktopId, 'conversation.history.chunk.get', params));
        if (!isCurrent()) return;
        setAuthoritativeRuntime(view?.runtime || null);

        if (view) setPendingChoices(Object.fromEntries(view.runtime.pendingChoices.map(choice => [choice.toolCallId, {
          conversationId, questions: choice.questions as Array<{question: string; header: string; options: Array<{label: string; description: string}>}>,
        }])));
        // A confirmed deletion stays hidden for this selected transcript so a
        // stale in-flight list response cannot visibly resurrect its card.
        const incoming = result.messages.filter(message => !deletedUiMessageIdsRef.current.has(message.uiMessageId));
        // Reload the latest page without discarding already loaded older
        // pages or resetting the pagination cursor back into the loaded range.
        const firstOrder = incoming[0]?.order;
        const older = result.page.hasMore && firstOrder !== undefined
          ? messagesRef.current.filter(message => message.order < firstOrder && message.order >= (result.page.visibleFromUiOrder || 0) && !deletedUiMessageIdsRef.current.has(message.uiMessageId))
          : [];
        const nextMessages = reconcileDesktopMessages(messagesRef.current, [...older, ...incoming]);
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
        setTasks(Array.isArray(result.tasks) ? result.tasks : []);
        setConversationModel(typeof result.conversation?.model === 'string' ? result.conversation.model : '');
        setConversationAssistant({
          code: typeof result.conversation?.assistant?.code === 'string' ? result.conversation.assistant.code : '',
          name: typeof result.conversation?.assistant?.name === 'string' ? result.conversation.assistant.name : '',
          avatarUrl: typeof result.conversation?.assistant?.avatarUrl === 'string' ? result.conversation.assistant.avatarUrl : '',
        });
        setMessagePage(older.length && (result.page.visibleFromUiOrder || 0) === (messagePageRef.current.visibleFromUiOrder || 0) ? {...result.page,
          hasMore: messagePageRef.current.hasMore,
          nextBeforeUiOrder: messagePageRef.current.nextBeforeUiOrder,
        } : result.page);
        commitTurn(current => {
          if (
            !current ||
            current.conversationId !== conversationId ||
            (requestedTurn && current.requestId !== requestedTurn.requestId)
          ) return current;
          return current.terminal && requestedTurn?.terminal
            ? {...current, historyLoaded: true}
            : current;
        });
      } catch (cause) {
        if (isCurrent()) {
          if (errorCode(cause) === 'remote_conversation_not_found') {
            forgetMissingConversation(conversationId); setError('会话已不存在'); return;
          }

          // Keep history, but never treat a failed new-protocol read as fresh
          // permission. The next successful snapshot restores writability.
          if (business.usesView()) {
            business.invalidate(conversationId);
            setAuthoritativeRuntime(current => current?.conversationId === conversationId ? {...current, execution: {...current.execution, state: 'recovering'}, control: {...current.control, canWrite: false}} : current);
          }
          setError(errorMessage(cause));
        }
      } finally {
        if (isCurrent()) setMessagesLoading(false);
      }
    },
    [api, business, commitTurn, desktopId, desktopStatus, forgetMissingConversation, request],
  );

  const messageRefresh = useMemo(() => createConversationMessageRefresh(readMessages), [readMessages]);
  const loadMessages = useCallback((conversationId: string) => messageRefresh.request(conversationId), [messageRefresh]);

  useEffect(() => {
    if (desktopStatus !== '在线' || !selectedConversationId) return;
    let active = true;
    let running = false;
    const synchronize = async () => {
      if (running || !active) return;
      running = true;
      try {
        if (await business.dirty(selectedConversationId) && active) await loadMessages(selectedConversationId);
      } catch (cause) {if (active) {
        if (errorCode(cause) === 'remote_conversation_not_found') {forgetMissingConversation(selectedConversationId); setError('会话已不存在'); return;}
        business.invalidate(selectedConversationId);
        setAuthoritativeRuntime(current => current?.conversationId === selectedConversationId ? {...current, execution: {...current.execution, state: 'recovering'}, control: {...current.control, canWrite: false}} : current);
        setError(errorMessage(cause));
      }}
      finally {running = false;}
    };
    const timer = setInterval(synchronize, 2500);
    return () => {active = false; clearInterval(timer);};
  }, [business, desktopStatus, forgetMissingConversation, loadMessages, selectedConversationId]);
  useEffect(() => () => {
    messageEpoch.current += 1;
    messageRefresh.cancel();
  }, [messageRefresh]);


  const olderReadRunning = useRef(false);

  const loadOlderMessages = useCallback(async () => {
    if (
      !selectedConversationId ||
      !messagePage.hasMore ||
      messagePage.nextBeforeUiOrder == null ||
      olderReadRunning.current || messagesLoading
    ) {
      return;
    }
    const epoch = ++messageEpoch.current;
    const isCurrent = () =>
      epoch === messageEpoch.current &&
      scopeRef.current.desktopId === desktopId &&
      scopeRef.current.selectedConversationId === selectedConversationId;
    olderReadRunning.current = true;
    setMessagesLoading(true);
    try {
      const result = await completeHistory(await readSized(size => api.listMessages(selectedConversationId, {
        pageSize: size,
        beforeUiOrder: messagePage.nextBeforeUiOrder ?? undefined,
      }), messagePage.pageSize), params => request(desktopId, 'conversation.history.chunk.get', params));
      if (!isCurrent()) return;
      const visibleIncoming = result.messages.filter(message => !deletedUiMessageIdsRef.current.has(message.uiMessageId));
      setMessages(current =>
        mergeById(visibleIncoming, current, 'uiMessageId')
          .filter(message => !deletedUiMessageIdsRef.current.has(message.uiMessageId))
          .sort((left, right) => left.order - right.order),
      );
      setMessagePage(result.page);
    } catch (cause) {
      if (isCurrent()) {
        if (errorCode(cause) === 'remote_conversation_not_found') forgetMissingConversation(selectedConversationId);
        setError(errorMessage(cause));
      }
    } finally {
      olderReadRunning.current = false;
      if (isCurrent()) setMessagesLoading(false);
    }
  }, [api, desktopId, forgetMissingConversation, messagePage, messagesLoading, request, selectedConversationId]);

  const openedEpoch = useRef(0);
  const refreshOpenedSessions = useCallback(async () => {
    if (desktopStatus !== '在线') return;
    const epoch = ++openedEpoch.current;
    try {
      const result = await api.listOpenedSessions();
      if (epoch !== openedEpoch.current || scopeRef.current.desktopId !== desktopId) return;
      const sessions = (result.sessions || []).filter(item => !missingConversationIds.current.has(item.conversationId));
      setOpenedSessions(sessions);

      setOpenedSessionsDesktop(desktopId);
      setControlledConversationIds(sessions
        .filter(item => item.controlledByThisDevice)
        .map(item => item.conversationId));
    } catch {
      // Window ownership is advisory UI state; message reads remain available.
    }
  }, [api, desktopId, desktopStatus]);

  const takeoverConversation = useCallback(async (conversationId: string) => {
    if (!conversationId) return;
    const previous = activeTurnRef.current;
    await api.takeover(conversationId);
    // Successful Desktop takeover confirms the writer is idle. Never retire a
    // newer request submitted while this RPC was in flight.
    commitTurn(current => current?.requestId === previous?.requestId && current?.conversationId === conversationId ? null : current);
    await Promise.all([refreshOpenedSessions(), refreshCatalog()]);
    if (scopeRef.current.selectedConversationId === conversationId) await loadMessages(conversationId);
  }, [api, commitTurn, loadMessages, refreshCatalog, refreshOpenedSessions]);

  const handoffConversation = useCallback(async (conversationId: string) => {
    if (!conversationId) return;
    await api.handoff(conversationId);
    await Promise.all([refreshOpenedSessions(), refreshCatalog()]);
    if (scopeRef.current.selectedConversationId === conversationId) await loadMessages(conversationId);
  }, [api, loadMessages, refreshCatalog, refreshOpenedSessions]);

  const canControlConversation = useCallback((conversationId: string) =>
    business.usesView() && conversationId === selectedConversationId ? authoritativeRuntime?.conversationId === conversationId && authoritativeRuntime.control.canWrite :
      controlledConversationIds.includes(conversationId), [authoritativeRuntime, business, controlledConversationIds, selectedConversationId]);


  const releaseConversation = useCallback((conversationId: string) => {
    if (!conversationId || desktopStatus !== '在线') return;
    api.release(conversationId).catch(() => undefined);
  }, [api, desktopStatus]);

  const selectConversation = useCallback((conversationId: string, openedTitle = '') => {
    selectedOpenedTitleRef.current = openedTitle;
    const previousConversationId = scopeRef.current.selectedConversationId;
    if (previousConversationId && previousConversationId !== conversationId) {
      releaseConversation(previousConversationId);
    }
    if (desktopStatus === '在线') {
      api.openConversation(conversationId)
        .then(result => {
          if (scopeRef.current.selectedConversationId !== conversationId) return;
          if (missingConversationIds.current.has(conversationId)) return;
          if (result.mobileControlled) setControlledConversationIds(current => [...new Set([...current, conversationId])]);
          else setControlledConversationIds(current => current.filter(id => id !== conversationId));
          refreshOpenedSessions().catch(() => undefined);
        })
        .catch(cause => {
          if (scopeRef.current.desktopId !== desktopId) return;
          if (errorCode(cause) === 'remote_conversation_not_found') forgetMissingConversation(conversationId);
          if (scopeRef.current.selectedConversationId === conversationId || !scopeRef.current.selectedConversationId) setError(errorMessage(cause));
        });
    }
    messageEpoch.current += 1;
    messageRefresh.cancel();
    deletedUiMessageIdsRef.current.clear();
    scopeRef.current.selectedConversationId = conversationId;
    setMessages([]);
    setTasks([]);
    setConversationModel('');
    setConversationAssistant({code: '', name: '', avatarUrl: ''});
    setPendingChoices({});
    setMessagePage({ pageSize: 50, nextBeforeUiOrder: null, hasMore: false });
    setSelectedConversationId(conversationId);
  }, [api, desktopId, desktopStatus, forgetMissingConversation, messageRefresh, refreshOpenedSessions, releaseConversation]);

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
        if (!current || current.requestId !== state.requestId || current.terminal) return current;
        if (state.eventSequence < current.eventSequence) return current;
        return {
          ...current,
          conversationId: state.conversationId,
          text: state.text,
          reasoning: state.reasoning,
          toolCalls: state.toolCalls,
          segmentId: state.segmentId || current.segmentId,
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

  const recoveryInFlight = useRef(false);
  const recoverActiveTurn = useCallback(async () => {
    const active = activeTurnRef.current;
    if (!active || active.terminal || desktopStatus !== '在线' || recoveryInFlight.current || awaitingSendReceipts.current.has(active.requestId)) return;
    recoveryInFlight.current = true;
    const isCurrent = () => scopeRef.current.desktopId === desktopId &&
      activeTurnRef.current?.requestId === active.requestId && !activeTurnRef.current.terminal;
    try {
      const operation = await business.operation(active.requestId);
      const state = operation ? operation.progress as ConversationRequestState : await api.getRequest(active.requestId);
      if (isCurrent()) applyRequestState(state);
    } catch (cause) {
      if (!isCurrent()) return;
      if (errorCode(cause) === 'remote_request_not_found') {
        // Explicit absence is authoritative after gateway restart/record expiry.
        // Do not retry the send or pretend it completed successfully.
        commitTurn(current => current?.requestId === active.requestId ? {
          ...current, terminal: true, event: 'assistant.failed', errorCode: 'remote_request_not_found',
        } : current);
        setError('Desktop 已无此远程请求，已结束旧生成状态并重新读取会话；不会自动重发。');
        await Promise.all([
          scopeRef.current.selectedConversationId === active.conversationId ? loadMessages(active.conversationId) : Promise.resolve(),
          refreshOpenedSessions(),
        ]);
      } else {
        setError(`无法恢复生成状态：${errorMessage(cause)}`);
      }
    } finally { recoveryInFlight.current = false; }
  }, [api, business, applyRequestState, commitTurn, desktopId, desktopStatus, loadMessages, refreshOpenedSessions]);

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
            toolCalls: state.toolCalls,
            segmentId: state.segmentId || undefined,
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
            toolCalls: state.toolCalls,
            segmentId: state.segmentId || undefined,
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
      let acceptedUpdate = false;
      commitTurn(current => {
        if (!current || current.requestId !== requestId || current.terminal)
          return current;
        if (sequence < 1 || sequence <= current.eventSequence) return current;
        acceptedUpdate = true;
        const terminal = isTerminalEvent(event.event);
        const nextSegmentId = event.event === 'assistant.delta'
          ? stringValue(payload.segmentId) || current.segmentId
          : current.segmentId;
        const segmentChanged = Boolean(nextSegmentId && nextSegmentId !== current.segmentId);
        becameTerminal = terminal;
        return {
          ...current,
          conversationId: conversationId || current.conversationId,
          // Stream state is request progress only; never used as list data.
          text: event.event === 'assistant.delta'
            ? (segmentChanged ? '' : current.text) + stringValue(payload.textDelta)
            : current.text,
          reasoning: event.event === 'assistant.delta'
            ? (segmentChanged ? '' : current.reasoning) + stringValue(payload.reasoningDelta)
            : current.reasoning,
          segmentId: nextSegmentId,
          historyLoaded: terminal ? current.historyLoaded : false,
          toolCalls: event.event === 'assistant.delta' && Array.isArray(payload.toolCalls)
            ? mergeLiveToolCalls(segmentChanged ? undefined : current.toolCalls, payload.toolCalls as RemoteMessage['payload']['toolCalls'])
            : segmentChanged ? [] : current.toolCalls,
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
      }, event.event !== 'assistant.delta');
      if (event.event === 'assistant.delta' && conversationId && conversationId === scopeRef.current.selectedConversationId &&
        (acceptedUpdate || activeTurnRef.current?.requestId !== requestId)) {
        messageRefresh.request(conversationId, false).catch(() => undefined);
      }

      if (
        (becameTerminal || event.event === 'assistant.started' ||
          (isTerminalEvent(event.event) && activeTurnRef.current?.requestId !== requestId)) &&
        conversationId
      ) {
        if (scopeRef.current.selectedConversationId === conversationId) {
          // Desktop emits assistant.started only after the user message has
          // been persisted by its Renderer lease holder.
          loadMessages(conversationId).catch(() => undefined);
        }
        if (becameTerminal) {
          refreshCatalog().catch(() => undefined);
          refreshOpenedSessions().catch(() => undefined);
        }
      }
    },
    [commitQueue, commitTurn, loadMessages, messageRefresh, refreshCatalog, refreshOpenedSessions],
  );

  useEffect(() => {
    return subscribeEvents((eventDesktopId, event) => {
      if (eventDesktopId !== desktopId) return;

      if (event.event === 'remote.operation.recovered' || event.event === 'remote.operation.recovery.failed') {
        const state = event.payload.state;
        setError(event.event === 'remote.operation.recovery.failed' ? '部分原操作结果暂未确认；请重连查询，不要重复提交。' : state === 'interrupted' || state === 'unknown' ? 'Desktop 重启或原操作记录不可用，结果未知。已刷新历史，请检查后再决定；不会自动重发。' : state === 'failed' ? '原操作未完成，请刷新检查。' : '');
        refreshCatalog().catch(() => undefined);
        refreshOpenedSessions().catch(() => undefined);
        if (scopeRef.current.selectedConversationId) loadMessages(scopeRef.current.selectedConversationId).catch(() => undefined);
      }
      if (event.event === 'conversation.windows.changed') {
        refreshCatalog().catch(() => undefined);
        refreshOpenedSessions().catch(() => undefined);
        const selected = scopeRef.current.selectedConversationId;
        if (selected) loadMessages(selected).catch(() => undefined);
        recoverActiveTurn().catch(() => undefined);
      }
      handleStreamEvent(event as ConversationStreamEvent);
    });
  }, [desktopId, handleStreamEvent, loadMessages, recoverActiveTurn, refreshCatalog, refreshOpenedSessions, subscribeEvents]);

  useEffect(() => {
    return () => {
      // A Mobile view never owns SQLite. Tell Desktop to close only its idle,
      // hidden Renderer writer when this workspace is unmounted or changes Desktop.
      releaseConversation(scopeRef.current.selectedConversationId);
    };
  }, [releaseConversation]);


  useEffect(() => {
    setCatalog([]);

    selectedOpenedTitleRef.current = '';
    missingConversationIds.current.clear();

    deletedUiMessageIdsRef.current.clear();
    setMessages([]);
    setOpenedSessions([]);

    setOpenedSessionsDesktop('');
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
      messageEpoch.current += 1;
      setMessagesLoading(false);
      if (!selectedConversationId) setMessages([]);
    }
  }, [desktopStatus, loadMessages, selectedConversationId]);

  useEffect(() => {
    if (desktopStatus !== '在线') return;
    recoverActiveTurn().catch(() => undefined);
    const timer = setInterval(() => { recoverActiveTurn().catch(() => undefined); }, 2500);
    return () => clearInterval(timer);
  }, [desktopStatus, recoverActiveTurn]);

  const assertControl = useCallback((conversationId: string) => {
    if (desktopStatus !== '在线') throw new Error('连接正在恢复，暂时无法操作；已保留当前会话。');
    if (business.usesView() && conversationId === selectedConversationId ? authoritativeRuntime?.conversationId === conversationId && authoritativeRuntime.control.canWrite : controlledConversationIds.includes(conversationId)) return;
    throw new Error('该会话正在由 Desktop 控制，请先点击“接管会话”。');
  }, [authoritativeRuntime, business, controlledConversationIds, desktopStatus, selectedConversationId]);


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

      awaitingSendReceipts.current.add(tracked.requestId);
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
                  historyLoaded: true,
                }
              : current,
          );
          throw cause;
        }
      } finally { awaitingSendReceipts.current.delete(tracked.requestId); }
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

  const retryLastVisibleMessage = useCallback(
    async (uiMessageId: string, role: 'user' | 'assistant') => {
      if (activeTurnRef.current && !activeTurnRef.current.terminal) {
        throw new Error('当前回复仍在生成或执行工具，请先停止或等待本轮结束。');
      }
      const last = [...messages]
        .reverse()
        .find(item => item.role === 'user' || item.role === 'assistant');
      if (!last || last.role !== role || last.uiMessageId !== uiMessageId) {
        throw new Error(role === 'user' ? '仅允许重发送最后一条用户消息。' : '仅允许重答最后一条 Assistant 回复。');
      }
      // Desktop reuses the existing persisted user turn (and any persisted
      // attachments), so Mobile must not create a duplicate message or upload.
      await sendMessage('', [], uiMessageId);
    },
    [messages, sendMessage],
  );
  const reaskLastAssistant = useCallback(
    (uiMessageId: string) => retryLastVisibleMessage(uiMessageId, 'assistant'),
    [retryLastVisibleMessage],
  );
  const resendLastUser = useCallback(
    (uiMessageId: string) => retryLastVisibleMessage(uiMessageId, 'user'),
    [retryLastVisibleMessage],
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
    try { await api.cancel(active.conversationId); }
    catch (cause) {
      if (errorCode(cause) !== 'remote_conversation_not_generating') throw cause;
      // The cancel target may already have finished or disappeared. Reconcile
      // its original request instead of leaving a permanently spinning stop UI.
      await recoverActiveTurn();
    }
  }, [api, assertControl, recoverActiveTurn]);

  const closeConversation = useCallback(async (conversationId: string) => {
    if (!conversationId) return;
    assertControl(conversationId);
    await api.closeConversation(conversationId);
    if (scopeRef.current.selectedConversationId === conversationId) {
      messageEpoch.current += 1;
      scopeRef.current.selectedConversationId = '';
      selectedOpenedTitleRef.current = '';
      deletedUiMessageIdsRef.current.clear();
      setSelectedConversationId('');
      setMessages([]);
      setTasks([]);
      setConversationModel('');
      setConversationAssistant({code: '', name: '', avatarUrl: ''});
      setPendingChoices({});
      setMessagePage({pageSize: 50, nextBeforeUiOrder: null, hasMore: false});
      commitTurn(current =>
        current?.conversationId === conversationId ? null : current,
      );
    }
    await Promise.all([refreshOpenedSessions(), refreshCatalog()]);
  }, [api, assertControl, commitTurn, refreshCatalog, refreshOpenedSessions]);



  const removeConversationFromView = useCallback((conversationId: string) => {
    if (scopeRef.current.selectedConversationId === conversationId) messageRefresh.cancel();
    forgetMissingConversation(conversationId);
  }, [forgetMissingConversation, messageRefresh]);


  const removeMessageFromView = useCallback((uiMessageId: string) => {
    if (!uiMessageId) return;
    deletedUiMessageIdsRef.current.add(uiMessageId);
    // Invalidate any pre-deletion history response. Hide only the exact UI ID,
    // never infer aliases from text or a shared canonical messageId.
    messageEpoch.current += 1;
    setMessagesLoading(false);
    const remaining = messagesRef.current.filter(message => !deletedUiMessageIdsRef.current.has(message.uiMessageId));
    messagesRef.current = remaining;
    setMessages(remaining);
    commitTurn(current => current?.terminal ? {...current, historyLoaded: true} : current);
  }, [commitTurn]);


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
      (selectedConversationId && selectedOpenedTitleRef.current
        ? {
            conversationId: selectedConversationId,
            title: selectedOpenedTitleRef.current,
            format: 'sqlite' as const,
            revision: 0,
            createdAt: '',
            updatedAt: '',
            byteSize: 0,
            project: null,
            migrationRequired: false,
            readable: true,
            window: null,
          }
        : null),
    messages,
    messagePage,
    messagesLoading,
    activeTurn,
    tasks,
    conversationModel,
    conversationAssistant,
    openedSessions,

    openedSessionsReady: openedSessionsDesktop === desktopId,
    authoritativeRuntime: authoritativeRuntime?.conversationId === selectedConversationId ? authoritativeRuntime : null,
    canControlConversation,
    takeoverConversation,
    handoffConversation,
    closeConversation,
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
    resendLastUser,
    cancelActiveTurn,
    showSelectedOnDesktop,
    releaseSelectedConversation,
    removeMessageFromView,

    removeConversationFromView,
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


function mergeLiveToolCalls(
  current: RemoteMessage['payload']['toolCalls'] | undefined,
  incoming: RemoteMessage['payload']['toolCalls'],
): RemoteMessage['payload']['toolCalls'] {
  const merged = new Map<string, RemoteMessage['payload']['toolCalls'][number]>();
  for (const call of current || []) merged.set(call.id || call.name, call);
  for (const call of incoming) {
    const key = call.id || call.name;
    if (!key) continue;
    const previous = merged.get(key);
    merged.set(key, {
      ...previous,
      ...call,
      arguments: call.arguments ?? previous?.arguments,
      ...(call.result === undefined && previous?.result !== undefined ? {result: previous.result} : {}),
    });
  }
  return [...merged.values()];
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
    remote_conversation_not_found: '会话已不存在',

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
