import {sha256} from '@noble/hashes/sha2.js';
import {completeHistory, readSized} from '../src/remote/historyRead';
import {utf8ToBytes} from '../src/remote/utf8';
const frozen = require('../packages/remote-contract/fixtures/v1.0-view.json');

it('reuses only SHA-verified unchanged payloads from the same conversation/ID', async () => {
 const f = historyFixture();
 const chunk = jest.fn(async () => ({...f.ref, offset: 0, text: f.text, nextOffset: f.text.length}));
 const first = await completeHistory(f.page, chunk);
 expect(chunk).toHaveBeenCalledTimes(1);
 const second = await completeHistory(f.page, chunk, {previousPage: first});
 expect(chunk).toHaveBeenCalledTimes(1);
 expect(second.messages[1].payload).toBe(first.messages[1].payload);
 const unverified = JSON.parse(JSON.stringify(first));
 await completeHistory(f.page, chunk, {previousPage: unverified});
 expect(chunk).toHaveBeenCalledTimes(2);
});

function historyFixture() {
 const payload = {...frozen.page.messages[0].payload, content: '长结果中😀\n'.repeat(60000)};
 const text = JSON.stringify(payload);
 const hash = Array.from(sha256(utf8ToBytes(text)), b => b.toString(16).padStart(2, '0')).join('');
 const ref = {id: 'b'.repeat(64), totalChars: text.length, sha256: hash};
 const page = {...frozen.page, messages: [frozen.page.messages[0], {...frozen.page.messages[0], uiMessageId: 'long-original-id', payload: {...frozen.page.messages[0].payload, fullPayload: ref}}]};
 return {payload, text, ref, page};
}
it('publishes normal messages before a slow unified result and updates only the original long bubble after verification', async () => {
 const f = historyFixture(), published: any[] = [];
 let finish!: (value: any) => void;
 const read = jest.fn(() => new Promise(resolve => {finish = resolve;}));
 const pending = completeHistory(f.page, read, {onPage: page => published.push(page)});
 expect(published).toHaveLength(1);
 expect(published[0].messages[0]).toEqual(frozen.page.messages[0]);
 expect(published[0].messages[1].payload.fullPayload).toEqual(f.ref);
 finish({...f.ref, offset: 0, text: f.text, nextOffset: f.text.length});
 const result = await pending;
 expect(read).toHaveBeenCalledTimes(1);
 expect(result.messages[1].uiMessageId).toBe('long-original-id');
 expect(result.messages[1].payload).toEqual(f.payload);
 expect(published).toHaveLength(2);
});
it('stops old history after a switch, and never publishes unverified corrupt bytes', async () => {
 const f = historyFixture(), onPage = jest.fn();
 let current = true, finish!: (value: any) => void;
 const pending = completeHistory(f.page, () => new Promise(resolve => {finish = resolve;}), {onPage, isCurrent: () => current});
 current = false;
 finish({...f.ref, offset: 0, text: f.text, nextOffset: f.text.length});
 await expect(pending).rejects.toThrow('remote_history_read_cancelled');
 expect(onPage).toHaveBeenCalledTimes(1);
 const corrupt = f.text.replace('长', '坏');
 await expect(completeHistory(f.page, async () => ({...f.ref, offset: 0, text: corrupt, nextOffset: corrupt.length}), {onPage})).rejects.toThrow('remote_history_part_invalid');
 expect(onPage).toHaveBeenCalledTimes(2);
});

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
