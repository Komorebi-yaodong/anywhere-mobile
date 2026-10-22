import type {ConversationMessagesResult} from './api';
export function decodeStructuredPage(value: unknown): ConversationMessagesResult {
  const page = value as ConversationMessagesResult;
  if (!page || !Array.isArray(page.messages)) throw new Error('remote_contract_invalid');
  return {...page, messages: page.messages.map(message => {
    const payload = message.payload as typeof message.payload & {blocks?: Array<Record<string, unknown>>};
    if (!Array.isArray(payload.blocks)) return message;
    const content = payload.blocks.map(block => {
      if (!block || typeof block !== 'object') return {type: 'text', text: '[不支持的内容]'};
      if (block.kind === 'markdown' || block.kind === 'text') return {type: 'text', text: typeof block.text === 'string' ? block.text : ''};
      if (block.kind === 'file') return {type: 'file', name: typeof block.name === 'string' ? block.name : '文件', previewable: false};
      if (['image', 'audio', 'video'].includes(String(block.kind)) && typeof block.uri === 'string') {
        let safe = /^anywhere-media:\/\/[A-Za-z0-9_-]{16,160}(?:\?type=(?:image|audio|video))?$/.test(block.uri);
        try {const uri = new URL(block.uri); safe = safe || (uri.protocol === 'https:' && !uri.username && !uri.password);} catch { /* opaque/local */ }
        if (safe) return block.kind === 'image' ? {type: 'image', url: block.uri} : {type: 'text', text: `<${block.kind} src="${block.uri.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"></${block.kind}>`};
      }
      return {type: 'text', text: typeof block.text === 'string' ? block.text : '[此内容暂不支持，请在 Desktop 查看]'};
    });
    const safePayload = {...payload, content};
    delete safePayload.blocks;
    return {...message, payload: safePayload};
  })};
}
