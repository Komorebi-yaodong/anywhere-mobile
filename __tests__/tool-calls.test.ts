import {hasToolArguments, mergeLiveToolCalls} from '../src/remote/toolCalls';

const base = {id: 'synthetic-tool', name: 'fixture_tool', status: 'finished'};

it.each([undefined, null, '', '   ', '[参数已隐藏]', ' [参数已隐藏] '])('does not treat omitted input as a load in progress: %s', value => {
  expect(hasToolArguments(value)).toBe(false);
});
it.each([{}, [], false, 0, '{"query":"synthetic"}', {query: 'synthetic'}])('recognizes supplied input including empty objects and scalar values: %s', value => {
  expect(hasToolArguments(value)).toBe(true);
});
it.each([undefined, null, '', '[参数已隐藏]'])('preserves complete input and output under a same-terminal progress projection: %s', value => {
  const argumentsValue = {query: 'synthetic'}, result = {ok: true};
  const original = {...base, arguments: argumentsValue, result};
  const merged = mergeLiveToolCalls([original], [{...base, arguments: value}]);
  expect(merged).toEqual([original]);
  expect(merged[0].arguments).toBe(argumentsValue);
  expect(merged[0].result).toBe(result);
  expect(original).toEqual({...base, arguments: argumentsValue, result});
});
it('hydrates input without reviving a completed tool or replacing its output', () => {
  const result = {ok: true}, argumentsValue = {query: 'late synthetic input'};
  const merged = mergeLiveToolCalls([{...base, arguments: '[参数已隐藏]', result}], [{...base, status: 'executing', arguments: argumentsValue}]);
  expect(merged).toEqual([{...base, arguments: argumentsValue, result}]);
});
it('keeps an actual empty argument object and accepts newer complete input', () => {
  expect(mergeLiveToolCalls([{...base, arguments: {}}], [{...base, arguments: '[参数已隐藏]'}])[0].arguments).toEqual({});
  expect(mergeLiveToolCalls([{...base, arguments: '[参数已隐藏]'}], [{...base, arguments: {}}])[0].arguments).toEqual({});
  expect(mergeLiveToolCalls([{...base, arguments: {old: true}}], [{...base, arguments: {updated: true}}])[0].arguments).toEqual({updated: true});
});
it('merges by tool ID without borrowing another tool input or changing its order', () => {
  const first = {...base, id: 'one', arguments: {query: 'one'}, result: 'one result'};
  const second = {...base, id: 'two', arguments: '[参数已隐藏]'};
  const merged = mergeLiveToolCalls([first, second], [{...base, id: 'two', arguments: {query: 'two'}}]);
  expect(merged).toEqual([first, {...second, arguments: {query: 'two'}}]);
  expect(merged[0]).toBe(first);
});
