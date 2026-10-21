import React, {useEffect, useState} from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Pressable, ScrollView, Text} from 'react-native';
import {ConversationMessageList, MessageLayoutInteractionContext, type ConversationMessageListHandle} from '../src/components/ConversationMessageList';
import type {RemoteMessage} from '../src/remote/api';

const mockScrollTo = jest.fn();
jest.mock('react-native/Libraries/Components/ScrollView/ScrollView', () => {
  const R = require('react');
  return {__esModule: true, default: R.forwardRef((props: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({scrollTo: mockScrollTo}));
    return R.createElement('MockScrollView', props, props.children);
  })};
});

function message(index: number): RemoteMessage {
  return {messageId: `storage-${index}`, uiMessageId: `ui-${index}`, order: index, role: 'assistant',
    payload: {content: `tail-fixture-${index}`, reasoningContent: '', toolCalls: [], timestamp: '', completedTimestamp: '', summary: '', summaryPrefix: '', aiName: '', voiceName: '', status: ''}};
}

function ExpandingRow({message: row, unmount}: {message: RemoteMessage; unmount: (id: string) => void}) {
  const [open, setOpen] = useState(false);
  const beforeLayoutChange = React.useContext(MessageLayoutInteractionContext);
  useEffect(() => () => unmount(row.uiMessageId), [row.uiMessageId, unmount]);
  return <>
    <Text>{row.payload.content as string}</Text>
    {row.order === 0 ? <Pressable accessibilityLabel="expand-first-tool" onPress={() => { beforeLayoutChange(); setOpen(current => !current); }}><Text>Expand fixture tool</Text></Pressable> : null}
    {open ? <ScrollView accessibilityLabel="inner-tool-scroll" nestedScrollEnabled style={{height: 184, flexGrow: 0}}><Text>{'safe-detail\n'.repeat(100)}</Text></ScrollView> : null}
  </>;
}

let frames: Map<number, () => void>;
let sequence = 0;
beforeEach(() => {
  frames = new Map();
  mockScrollTo.mockClear();
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { const id = ++sequence; frames.set(id, () => callback(0)); return id; });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { if (id != null) frames.delete(id); });
});
afterEach(() => jest.restoreAllMocks());
async function flushFrames() {
  await act(async () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback()); });
}

async function fixture(count = 80) {
  const rows = Array.from({length: count}, (_, index) => message(index));
  const handle = React.createRef<ConversationMessageListHandle>();
  const unmount = jest.fn();
  const pinned = jest.fn();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<ConversationMessageList ref={handle} messages={rows} onPinnedChange={pinned} renderMessage={row => <ExpandingRow message={row} unmount={unmount} />} />); });
  const outer = () => root.root.findAllByType(ScrollView).find(node => node.props.accessibilityLabel === '聊天消息列表')!;
  const rowHost = (index: number) => root.root.findAll(node => node.props.testID === `message-row-ui-${index}` && typeof node.props.onLayout === 'function')[0];
  await act(async () => {
    outer().props.onLayout({nativeEvent: {layout: {height: 500}}});
    for (let index = 0; index < count; index += 1) rowHost(index).props.onLayout({nativeEvent: {layout: {y: index * 100, height: 100}}});
    outer().props.onContentSizeChange(390, count * 100);
  });
  return {root, handle, unmount, pinned, rows, outer, rowHost};
}

test('all loaded rows remain mounted when expanding an earlier tool; measured tail stays navigable', async () => {
  const f = await fixture();
  await flushFrames();
  await act(async () => {
    f.outer().props.onScrollBeginDrag();
    f.outer().props.onScroll({nativeEvent: {contentOffset: {y: 250}, layoutMeasurement: {height: 500}, contentSize: {height: 8000}}});
    f.outer().props.onScrollEndDrag();
  });
  mockScrollTo.mockClear();
  const tailBefore = f.rowHost(79);
  await act(async () => f.root.root.findAll(node => node.props.accessibilityLabel === 'expand-first-tool' && node.props.onPress)[0].props.onPress());
  await act(async () => {
    f.rowHost(0).props.onLayout({nativeEvent: {layout: {y: 0, height: 284}}});
    for (let index = 1; index < 80; index += 1) f.rowHost(index).props.onLayout({nativeEvent: {layout: {y: index * 100 + 184, height: 100}}});
    f.outer().props.onContentSizeChange(390, 8184);
  });
  await flushFrames();
  expect(f.rowHost(79)).toBe(tailBefore);
  expect(f.root.root.findAllByType(Text).some(node => node.props.children === 'tail-fixture-79')).toBe(true);
  expect(f.unmount).not.toHaveBeenCalled();
  expect(mockScrollTo).toHaveBeenLastCalledWith({y: 434, animated: false});
  await act(async () => f.handle.current!.adjacent(1));
  expect(mockScrollTo).toHaveBeenLastCalledWith({y: 484, animated: true});
  await act(async () => f.handle.current!.bottom());
  expect(mockScrollTo).toHaveBeenLastCalledWith({y: 7684, animated: true});
  const inner = f.root.root.findAllByType(ScrollView).find(node => node.props.accessibilityLabel === 'inner-tool-scroll')!;
  expect(inner.props.style).toMatchObject({height: 184, flexGrow: 0});
  expect(inner.props.nestedScrollEnabled).toBe(true);
  expect(f.outer().props.nestedScrollEnabled).toBe(true);
  await act(async () => f.root.unmount());
});

test('expansion cancels a queued bottom follow and collapse does not steal reading position', async () => {
  const f = await fixture();
  expect(frames.size).toBe(1); // Initial incoming-content follow is queued.
  await act(async () => f.root.root.findAll(node => node.props.accessibilityLabel === 'expand-first-tool' && node.props.onPress)[0].props.onPress());
  expect(f.pinned).toHaveBeenLastCalledWith(false);
  await act(async () => {
    f.rowHost(0).props.onLayout({nativeEvent: {layout: {y: 0, height: 284}}});
    f.outer().props.onContentSizeChange(390, 8184);
  });
  await flushFrames();
  expect(mockScrollTo).not.toHaveBeenCalled();
  await act(async () => f.root.root.findAll(node => node.props.accessibilityLabel === 'expand-first-tool' && node.props.onPress)[0].props.onPress());
  await act(async () => {
    f.rowHost(0).props.onLayout({nativeEvent: {layout: {y: 0, height: 100}}});
    f.outer().props.onContentSizeChange(390, 8000);
  });
  await flushFrames();
  expect(mockScrollTo).not.toHaveBeenCalled();
  expect(f.unmount).not.toHaveBeenCalled();
  expect(f.rowHost(79)).toBeTruthy();
  await act(async () => f.root.unmount());
});

test('navigation animation does not capture an intermediate reading anchor before expanding', async () => {
  const f = await fixture(10);
  await flushFrames();
  await act(async () => f.handle.current!.top());
  await act(async () => f.handle.current!.adjacent(1));
  expect(mockScrollTo).toHaveBeenLastCalledWith({y: 100, animated: true});
  await act(async () => {
    f.outer().props.onMomentumScrollBegin();
    f.outer().props.onScroll({nativeEvent: {contentOffset: {y: 40}, layoutMeasurement: {height: 500}, contentSize: {height: 1000}}});
    f.outer().props.onScroll({nativeEvent: {contentOffset: {y: 100}, layoutMeasurement: {height: 500}, contentSize: {height: 1000}}});
    f.outer().props.onMomentumScrollEnd();
  });
  mockScrollTo.mockClear();
  await act(async () => f.root.root.findAll(node => node.props.accessibilityLabel === 'expand-first-tool' && node.props.onPress)[0].props.onPress());
  await act(async () => {
    f.rowHost(0).props.onLayout({nativeEvent: {layout: {y: 0, height: 284}}});
    for (let index = 1; index < 10; index += 1) f.rowHost(index).props.onLayout({nativeEvent: {layout: {y: 184 + index * 100, height: 100}}});
    f.outer().props.onContentSizeChange(390, 1184);
  });
  await flushFrames();
  expect(mockScrollTo).toHaveBeenLastCalledWith({y: 284, animated: false});
  await act(async () => f.root.unmount());
});


test('bottom navigation animation keeps follow enabled instead of simulating a user scroll away', async () => {
  const f = await fixture(10);
  await flushFrames();
  await act(async () => f.handle.current!.top());
  mockScrollTo.mockClear();
  await act(async () => f.handle.current!.bottom());
  await act(async () => {
    f.outer().props.onMomentumScrollBegin();
    f.outer().props.onScroll({nativeEvent: {contentOffset: {y: 200}, layoutMeasurement: {height: 500}, contentSize: {height: 1000}}});
    f.outer().props.onScroll({nativeEvent: {contentOffset: {y: 500}, layoutMeasurement: {height: 500}, contentSize: {height: 1000}}});
    f.outer().props.onMomentumScrollEnd();
    f.outer().props.onContentSizeChange(390, 1100);
  });
  await flushFrames();
  expect(f.pinned).toHaveBeenLastCalledWith(true);
  expect(mockScrollTo).toHaveBeenLastCalledWith({y: 600, animated: false});
  await act(async () => f.root.unmount());
});


test('prepending loaded older history anchors the same visible real message', async () => {
  const f = await fixture(6);
  await flushFrames();
  await act(async () => {
    f.outer().props.onScrollBeginDrag();
    f.outer().props.onScroll({nativeEvent: {contentOffset: {y: 80}, layoutMeasurement: {height: 300}, contentSize: {height: 600}}});
    f.outer().props.onScrollEndDrag();
  });
  mockScrollTo.mockClear();
  const before = f.rowHost(3);
  const older = {...message(-1), uiMessageId: 'older-ui'};
  await act(async () => f.root.update(<ConversationMessageList ref={f.handle} messages={[older, ...f.rows]} onPinnedChange={f.pinned} renderMessage={row => <ExpandingRow message={row} unmount={f.unmount} />} />));
  await act(async () => {
    for (let index = 0; index < 6; index += 1) f.rowHost(index).props.onLayout({nativeEvent: {layout: {y: 100 + index * 100, height: 100}}});
    f.outer().props.onContentSizeChange(390, 700);
  });
  await flushFrames();
  expect(mockScrollTo).toHaveBeenLastCalledWith({y: 180, animated: false});
  expect(f.rowHost(3)).toBe(before);
  expect(f.unmount).not.toHaveBeenCalled();
  await act(async () => f.root.unmount());
});
