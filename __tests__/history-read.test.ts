import {sha256} from '@noble/hashes/sha2.js';
import {completeHistory, readSized} from '../src/remote/historyRead';
import {utf8ToBytes} from '../src/remote/utf8';
const frozen = require('../packages/remote-contract/fixtures/v1.0-view.json');
it('retries only oversized read pages with smaller limits, never loops at one', async () => {
 const calls: number[] = [];
 const result = await readSized(async size => {calls.push(size); if (size > 12) throw {code: 'remote_response_too_large'}; return 'ok';});
 expect(result).toBe('ok'); expect(calls).toEqual([50, 25, 12]);
 const denied = jest.fn(async () => {throw {code: 'remote_device_revoked'};});
 await expect(readSized(denied)).rejects.toEqual({code: 'remote_device_revoked'}); expect(denied).toHaveBeenCalledTimes(1);
});
it('reassembles full multilingual payload including surrogate boundaries before rendering and checks every chunk', async () => {
 const payload = {...frozen.page.messages[0].payload, content: '正文😀\n'.repeat(40000), reasoningContent: '完整推理'.repeat(20000)};
 const text = JSON.stringify(payload);
 const hash = Array.from(sha256(utf8ToBytes(text)), b => b.toString(16).padStart(2, '0')).join('');
 const ref = {id: 'a'.repeat(64), totalChars: text.length, sha256: hash};
 const page = {...frozen.page, messages: [{...frozen.page.messages[0], payload: {...frozen.page.messages[0].payload, fullPayload: ref}}]};
 const chunk = jest.fn(async params => {const offset = Number(params.offset); const part = text.slice(offset, offset + 16384); return {...ref, offset, text: part, nextOffset: offset + part.length};});
 const restored = await completeHistory(page, chunk);
 expect(restored.messages[0].payload).toEqual(payload);
 expect(restored.messages[0].role).toBe(page.messages[0].role);
 expect(chunk.mock.calls.length).toBeGreaterThan(1);
 await expect(completeHistory(page, async params => ({...ref, offset: params.offset, text: 'corrupt', nextOffset: 1}))).rejects.toThrow('remote_history_part_invalid');
});
