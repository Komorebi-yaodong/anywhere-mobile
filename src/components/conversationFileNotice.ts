/** Separate attachment display metadata from editable prose. */
export type ConversationFile = {name: string};

export function extractedFileName(value: string): string | null {
  if (!/^file name:/i.test(value)) return null;
  const header = /^file name:([^\r\n]+)\r?\nfile content:\r?\n/i.exec(value);
  if (!header || !/\r?\nfile end\s*$/i.test(value)) return null;
  return header[1].trim().slice(0, 240);
}

export function fileNotice(name: unknown): string {
  const label = typeof name === 'string' ? name.trim().slice(0, 240) : '';
  return `[文件${label ? `：${label}` : ''}]`;
}

export function extractedFileNotice(value: string): string | null {
  const name = extractedFileName(value);
  return name === null ? null : fileNotice(name);
}

function filePart(value: unknown): ConversationFile | null {
  if (typeof value === 'string') {
    const name = extractedFileName(value);
    return name === null ? null : {name};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const part = value as Record<string, any>;
  if (['file', 'document', 'input_file'].includes(part.type)) {
    return {name: String(part.name || part.file?.filename || part.filename || '文件').slice(0, 240)};
  }
  if (part.type === 'text' && typeof part.text === 'string') return filePart(part.text);
  if (part.type === 'attachment' && !/^(image|video|audio)\//i.test(part.mimeType || '')) return {name: String(part.name || '文件').slice(0, 240)};
  return null;
}

export function conversationFiles(content: unknown): ConversationFile[] {
  return (Array.isArray(content) ? content : [content]).flatMap(part => {
    const file = filePart(part);
    return file ? [file] : [];
  });
}

/** Mirrors Desktop: edit prose, never file labels, generated media markup or bytes. */
export function editableConversationText(content: unknown): string {
  if (typeof content === 'string') return filePart(content) ? '' : content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => !filePart(part)).map(part => {
    if (typeof part === 'string') return part;
    return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
  }).filter(Boolean).join('\n');
}

export function withoutConversationFiles(content: unknown): unknown {
  if (!Array.isArray(content)) return filePart(content) ? '' : content;
  return content.filter(part => !filePart(part));
}
