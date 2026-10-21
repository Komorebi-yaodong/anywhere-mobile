import {sessionSettingsPatch} from '../src/components/sessionSettings';
import type {ConversationConfig} from '../src/remote/commands';
const baseline: ConversationConfig = {model: 'fixture|model', reasoningEffort: 'default', voice: '', systemPrompt: '', mcpServerIds: [], skillIds: [], compact: {autoCompactEnabled: true, triggerRatio: 0.9, contextLength: 65536, contextLengthSource: 'api', contextLengthManual: false, keepRecentRounds: 3, hideCompactedMessages: true, compactPrompt: ''}};
const drafts = {contextLengthDraft: '65536', contextLengthEdited: false, triggerRatioDraft: '0.9'};

test('only changed fields from all tabs are included; never resaves an API length as manual', () => {
  expect(sessionSettingsPatch(baseline, baseline, drafts)).toEqual({});
  expect(sessionSettingsPatch({...baseline, systemPrompt: 'draft', mcpServerIds: ['mcp'], skillIds: ['skill'], compact: {...baseline.compact, compactPrompt: 'summary', autoCompactEnabled: false}}, baseline, drafts)).toEqual({systemPrompt: 'draft', mcpServerIds: ['mcp'], skillIds: ['skill'], compact: {compactPrompt: 'summary', autoCompactEnabled: false}});
});
test('hidden compact drafts still validate, and manual source intent is explicit', () => {
  expect(() => sessionSettingsPatch(baseline, baseline, {...drafts, triggerRatioDraft: '.'})).toThrow('触发比例');
  expect(() => sessionSettingsPatch(baseline, baseline, {...drafts, contextLengthEdited: true, contextLengthDraft: '0.'})).toThrow('上下文长度');
  expect(sessionSettingsPatch(baseline, baseline, {...drafts, contextLengthEdited: true})).toEqual({compact: {contextLength: 65536}});
});
