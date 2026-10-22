import {validateNegotiation, validateView, validateChanges, validateOperation, type Negotiation, type Runtime, type View} from '../../packages/remote-contract';
import type {ConversationMessagesResult, RemoteRequest} from './api';

import {decodeStructuredPage} from './structuredContent';

import {completeHistory, readSized} from './historyRead';

export type ConversationView = View<ConversationMessagesResult>;
const invalid = () => Object.assign(new Error('remote_contract_invalid'), {code: 'remote_contract_invalid'});

/** Connection-scoped SDK. Legacy discovery never means malformed new data is OK. */
export function createBusinessSession(desktopId: string, request: RemoteRequest) {
  let generation = 0;
  let negotiation: Promise<Negotiation | null> | undefined;
  let ticket = 0;
  let negotiatedView = false;
  const views = new Map<string, {ticket: number; value: ConversationView}>();
  function reset() {generation++; negotiation = undefined; negotiatedView = false; views.clear();}
  async function discover() {
    const status = await request<{capabilities?: string[]}>(desktopId, 'remote.status.get');
    if (!Array.isArray(status?.capabilities) || !status.capabilities.includes('remote.contract.negotiate')) return null;
    const selected = validateNegotiation(await request(desktopId, 'remote.contract.negotiate', {versions: [{major: 1, minor: 1}, {major: 1, minor: 0}]}));
    return selected;
  }
  function negotiate() {
    if (!negotiation) {
      const pending = discover();
      negotiation = pending;
      pending.catch(() => {if (negotiation === pending) negotiation = undefined;});
    }
    return negotiation;
  }
  async function enabled(capabilities = ['conversation.view.v1', 'conversation.runtime.v1', 'conversation.invalidation.v1']) {
    const result = await negotiate();
    return Boolean(result && capabilities.every(capability => result.capabilities.includes(capability)));
  }
  async function read(conversationId: string, pageSize = 50): Promise<ConversationView | null> {
    const started = generation;
    if (!await enabled()) return null;
    if (generation !== started) throw invalid();
    negotiatedView = true;
    const currentTicket = ++ticket;
    const raw = await readSized(size => request<any>(desktopId, 'conversation.view.get', {conversationId, pageSize: size}), pageSize);
    const page = await completeHistory(decodeStructuredPage(raw.page), params => request(desktopId, 'conversation.history.chunk.get', params));
    const value = validateView<ConversationMessagesResult>({...raw, page});
    if (generation !== started || value.runtime.conversationId !== conversationId) throw invalid();
    const previous = views.get(conversationId);
    if (previous && (previous.ticket > currentTicket || previous.value.serverEpoch === value.serverEpoch && previous.value.sequence > value.sequence)) return previous.value;
    views.set(conversationId, {ticket: currentTicket, value});
    return value;
  }
  async function dirty(conversationId: string): Promise<boolean> {
    const previous = views.get(conversationId);
    if (!previous) return negotiatedView;
    const started = generation;
    const result = validateChanges(await request(desktopId, 'conversation.changes.get', {conversationId, cursor: previous.value.cursor}));
    if (generation !== started || views.get(conversationId) !== previous) return false;
    if (result.resyncRequired || result.serverEpoch !== previous.value.serverEpoch || result.events.length || previous.value.runtime.execution.state === 'recovering') return true;
    if (result.sequence < previous.value.sequence) throw invalid();
    // No relevant changes: advance only this view's cursor, not its data/version.
    previous.value = {...previous.value, cursor: result.cursor};
    return false;
  }
  async function operation(operationId: string) {
    if (await enabled(['command.durable.v1'])) return null;
    if (!await enabled(['operation.read.v1'])) return null;
    return validateOperation(await request(desktopId, 'operation.get', {operationId}));
  }
  function invalidate(conversationId: string) {
    const stored = views.get(conversationId);
    if (stored) stored.value = {...stored.value, runtime: {...stored.value.runtime, execution: {...stored.value.runtime.execution, state: 'recovering'}, control: {...stored.value.runtime.control, canWrite: false}}};
  }
  const runtime = (conversationId: string): Runtime | null => views.get(conversationId)?.value.runtime || null;
  return {reset, negotiate, enabled, read, dirty, operation, runtime, invalidate, usesView: () => negotiatedView};
}
