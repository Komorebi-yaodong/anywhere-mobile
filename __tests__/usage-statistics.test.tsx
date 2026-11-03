import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, Text, type AppStateStatus } from 'react-native';
import {
  UsageStatistics,
  usageLine,
  usagePeriod,
} from '../src/components/UsageStatistics';
import { useUsageStatistics } from '../src/hooks/useUsageStatistics';
import {
  activityLevel,
  compactUsage,
  validateUsage,
  type UsageFilters,
} from '../src/remote/usage';
import { usageFixture } from '../test-fixtures/usage';
import type { RemoteRequest } from '../src/remote/api';
const filters: UsageFilters = {
  range: '24h',
  providerId: '',
  agentName: '',
  model: '',
};
function button(root: TestRenderer.ReactTestRenderer, text: string) {
  return root.root
    .findAll(
      node =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function',
    )
    .find(node =>
      node.findAllByType(Text).some(child => child.props.children === text),
    )!;
}
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});
it('validates bounded DTOs, fixed activity levels, decimal units and Desktop timezone', () => {
  const fixture = usageFixture();
  expect(validateUsage(fixture)).toBe(fixture);
  for (const value of [
    { ...fixture, schemaVersion: '2' },
    { ...fixture, timeZone: 'invalid/zone' },
    { ...fixture, buckets: Array(65).fill(fixture.buckets[0]) },
    { ...fixture, summary: { ...fixture.summary, totalTokens: NaN } },
  ])
    expect(() => validateUsage(value)).toThrow();
  expect([0, 1, 20, 21, 50, 51, 100, 101, 1e6].map(activityLevel)).toEqual([
    0, 1, 1, 2, 2, 3, 3, 4, 4,
  ]);
  expect([999, 1000, 418000, 999960, 1e9].map(compactUsage)).toEqual([
    '999',
    '1K',
    '418K',
    '1M',
    '1B',
  ]);
  expect(
    usagePeriod({ periodStart: 0, periodEnd: 3600000 }, 'Asia/Shanghai'),
  ).toContain('08:00');
  expect(
    usageLine([
      { x: 0, y: 1 },
      { x: 10, y: 5 },
      { x: 20, y: 1 },
    ]),
  ).not.toMatch(/NaN|undefined/);
});
it('renders all cards and graphs with zero data, filters by read only, and expands details', async () => {
  const request = jest.fn().mockResolvedValue(usageFixture(0));
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <UsageStatistics
        desktopId="desktop-fixture"
        request={request as RemoteRequest}
        active
      />,
    );
  });
  for (const label of [
    '请求数',
    '成功率',
    '总 Token',
    '输入 Token',
    '输出 Token',
    '缓存 Token',
    '调用活跃度',
  ])
    expect(
      root.root.findAllByType(Text).some(node => node.props.children === label),
    ).toBe(true);
  expect(JSON.stringify(root.toJSON())).not.toContain('暂无调用记录');
  await act(async () => button(root, '最近7天').props.onPress());
  expect(request).toHaveBeenLastCalledWith(
    'desktop-fixture',
    'workspace.usage.get',
    { ...filters, range: '7d' },
    20000,
  );
  await act(async () =>
    root.root
      .findAll(
        node =>
          node.props.accessibilityLabel === '筛选智能体' && node.props.onPress,
      )[0]
      .props.onPress(),
  );
  await act(async () => button(root, '默认智能体').props.onPress());
  expect(request).toHaveBeenLastCalledWith(
    'desktop-fixture',
    'workspace.usage.get',
    { ...filters, range: '7d', agentName: '__DEFAULT__' },
    20000,
  );
  await act(async () =>
    root.root
      .findAll(
        node =>
          node.props.accessibilityRole === 'button' &&
          node.props.accessibilityState?.expanded === false,
      )[0]
      .props.onPress(),
  );
  expect(
    root.root.findAll(node => node.props.accessibilityState?.expanded === true),
  ).not.toHaveLength(0);
  expect(
    request.mock.calls.every(call => call[1] === 'workspace.usage.get'),
  ).toBe(true);
  await act(async () => root.unmount());
});
it('ignores in-flight background replies and resumes with a new read, without polling an unsupported Desktop', async () => {
  jest.useFakeTimers();
  let state!: ReturnType<typeof useUsageStatistics>,
    listener!: (state: AppStateStatus) => void,
    resolve!: (value: unknown) => void;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, callback: any) => {
      listener = callback;
      return { remove: jest.fn() };
    });
  const request = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    )
    .mockRejectedValue(
      Object.assign(new Error('unavailable'), {
        code: 'remote_method_unavailable',
      }),
    );
  function Scope() {
    state = useUsageStatistics({
      desktopId: 'fixture',
      request: request as RemoteRequest,
      active: true,
      filters,
    });
    return null;
  }
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<Scope />);
  });
  await act(async () => listener('background'));
  await act(async () => {
    resolve(usageFixture(99));
  });
  expect(state.data).toBeNull();
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => listener('active'));
  expect(state.error).toContain('请更新 Desktop');
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

it('serializes reads, rejects stale scope replies, preserves same-filter results on failure and pauses hidden/background', async () => {
  jest.useFakeTimers();
  let state!: ReturnType<typeof useUsageStatistics>,
    listener!: (state: AppStateStatus) => void;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, callback: any) => {
      listener = callback;
      return { remove: jest.fn() };
    });
  let resolveOld!: (value: unknown) => void;
  const request = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(usageFixture(9));
  function Harness({
    id = 'a',
    active = true,
    range = '24h',
    refresh = 0,
  }: {
    id?: string;
    active?: boolean;
    range?: UsageFilters['range'];
    refresh?: number;
  }) {
    state = useUsageStatistics({
      desktopId: id,
      active,
      filters: { ...filters, range },
      refreshSignal: refresh,
      request: request as RemoteRequest,
    });
    return null;
  }
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<Harness />);
  });
  await act(async () => root.update(<Harness id="b" range="7d" />));
  expect(request).toHaveBeenCalledTimes(1);
  expect(state.data).toBeNull();
  await act(async () => {
    resolveOld(usageFixture(1));
  });
  expect(state.data?.summary.requests).toBe(9);
  expect(request).toHaveBeenCalledTimes(2);
  request.mockRejectedValue(new Error('offline'));
  await act(async () => root.update(<Harness id="b" range="7d" refresh={1} />));
  expect(state.data?.summary.requests).toBe(9);
  expect(state.error).toContain('读取失败');
  await act(async () => listener('background'));
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(request).toHaveBeenCalledTimes(3);
  request.mockResolvedValue(usageFixture(10));
  await act(async () => listener('active'));
  expect(state.data?.summary.requests).toBe(10);
  await act(async () =>
    root.update(<Harness id="b" active={false} range="7d" refresh={1} />),
  );
  const reads = request.mock.calls.length;
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(request).toHaveBeenCalledTimes(reads);
  await act(async () => root.unmount());
});
