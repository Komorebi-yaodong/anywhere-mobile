import routes from '../../packages/remote-contract/routes.json';
import {validateNegotiation, validateDurableOperation, validateResource} from '../../packages/remote-contract';
import {decodeStructuredPage} from './structuredContent';

type Raw = (method: string, params?: Record<string, unknown>, timeout?: number, requestId?: string) => Promise<unknown>;
const error = (code: string) => Object.assign(new Error(code), {code});
/** Every UI API enters this connection-scoped protocol adapter. No auto-resend. */
export function createBusinessRouter(raw: Raw, persistence?: {remember: (id: string, params: Record<string, unknown>, issuedAt: number) => Promise<void>; settle: (id: string) => Promise<void>}) {
  let advertised: string[] = [];
  let negotiation: ReturnType<typeof validateNegotiation> | null = null;
  let pending: Promise<void> | undefined;
  let generation = 0;

  const readReceipts = new Map<string, {conversationId: string; result: unknown; expiresAt: number}>();
  function welcome(capabilities: unknown) {generation++; advertised = Array.isArray(capabilities) ? capabilities : []; negotiation = null; pending = undefined; readReceipts.clear();}
  async function negotiate() {
    if (!advertised.includes('remote.contract.negotiate')) return;
    const started = generation;
    if (!pending) pending = (async () => {
      const selected = validateNegotiation(await raw('remote.contract.negotiate', {versions: [{major: 1, minor: 1}, {major: 1, minor: 0}]}));
      if (started !== generation) throw error('remote_client_closed');
      negotiation = selected;
    })();
    try {await pending} catch (cause) {pending = undefined; throw cause;}
  }
  async function route(method: string, params: Record<string, unknown>, timeout: number, commandId: string, issuedAt: number) {
    if (['remote.ping', 'remote.status.get', 'remote.device.self.get', 'remote.contract.negotiate', 'resource.get', 'command.submit', 'transfer.request', 'operation.status.get', 'conversation.view.get', 'conversation.changes.get', 'operation.get'].includes(method)) return raw(method, params, timeout, commandId);
    if (!advertised.includes('remote.contract.negotiate')) return raw(method, params, timeout, commandId);
    await negotiate();
    if (!negotiation || negotiation.selected.minor < 1) return raw(method, params, timeout, commandId);
    if (method === 'conversation.request.get') {

      const read = readReceipts.get(String(params.requestId));
      if (read && read.expiresAt > Date.now()) return {requestId: params.requestId, conversationId: read.conversationId, terminal: true, event: 'conversation.config.result', eventSequence: 1, text: '', reasoning: '', truncated: false, result: read.result};
      let operation;
      try {operation = validateDurableOperation(await raw('operation.status.get', {operationId: params.requestId}, timeout));}
      catch (cause) {
        if ((cause as {code?: string})?.code !== 'remote_operation_not_found') throw cause;
        // Read-only compatibility for an in-flight request created on the
        // legacy adapter. Never redispatch the original operation.
        return validateResource(await raw('resource.get', {resource: 'conversation.request.get', params}, timeout), 'conversation.request.get').value;
      }
      if (operation.terminal) await persistence?.settle(operation.operationId);
      if (operation.progress) return operation.progress;
      return {requestId: operation.operationId, conversationId: operation.conversationId || '', terminal: operation.terminal,
        event: operation.state === 'succeeded' ? 'conversation.operation.completed' : operation.terminal ? 'conversation.operation.failed' : 'conversation.command.pending',
        eventSequence: operation.terminal ? Number.MAX_SAFE_INTEGER : 0, text: '', reasoning: '', toolCalls: [], truncated: false,
        result: operation.code ? {code: operation.code} : operation.receipt};
    }
    if (routes.queries.includes(method)) {

      if (!negotiation.capabilities.includes('resource.read.v1')) throw error('remote_method_unavailable');
      const response = validateResource(await raw('resource.get', {resource: method, params}, timeout), method);
      if (!response || response.resource !== method || response.schemaVersion !== '1.0') throw error('remote_contract_invalid');
      if (method === 'conversation.config.get') {
        for (const [id, item] of readReceipts) if (item.expiresAt < Date.now()) readReceipts.delete(id);
        if (readReceipts.size >= 64) readReceipts.delete(readReceipts.keys().next().value!);
        readReceipts.set(commandId, {conversationId: String(params.conversationId), result: response.value, expiresAt: Date.now() + 120000});
        return {ok: true};
      }

      return method === 'conversation.messages.list' ? decodeStructuredPage(response.value) : response.value;
    }
    if (routes.transfers.includes(method)) return raw('transfer.request', {method, params}, timeout, commandId);

    if (routes.commands.includes(method)) {

      if (!negotiation.capabilities.includes('command.durable.v1')) throw error('remote_method_unavailable');
      let preconditions;
      if (routes.controlRequired.includes(method) && typeof params.conversationId === 'string') {
        const view = await raw('conversation.view.get', {conversationId: params.conversationId, pageSize: 1}) as any;
        if (typeof view?.runtime?.control?.epoch !== 'string') throw error('remote_contract_invalid');
        preconditions = {controlEpoch: view.runtime.control.epoch};
      }
      await persistence?.remember(commandId, params, issuedAt);

      const operation = validateDurableOperation(await raw('command.submit', {commandId, issuedAt, method, params, ...(preconditions ? {preconditions} : {})}, timeout));
      if (operation.terminal) await persistence?.settle(operation.operationId);

      if (operation.state === 'failed' || operation.state === 'interrupted') throw error(operation.code || 'remote_command_failed');
      return operation.receipt || {ok: true, operationId: operation.operationId};
    }
    throw error('remote_method_unavailable');
  }
  return {welcome, route};
}
