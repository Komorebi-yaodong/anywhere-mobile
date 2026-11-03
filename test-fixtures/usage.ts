import { emptyMetrics, type UsageSnapshot } from '../src/remote/usage';
export function usageFixture(requests = 7): UsageSnapshot {
  const summary = {
    ...emptyMetrics,
    requests,
    succeeded: requests,
    successRate: requests ? 1 : 0,
    inputTokens: requests ? 100 : 0,
    outputTokens: requests ? 30 : 0,
    cachedTokens: requests ? 20 : 0,
    totalTokens: requests ? 130 : 0,
  };
  return {
    schemaVersion: '1.0',
    generatedAt: 1800000000000,
    timeZone: 'Asia/Shanghai',
    range: { start: 1799996400000, end: 1800000000001 },
    granularity: 'hour',
    summary,
    buckets: [
      {
        ...summary,
        timestamp: 1799996400000,
        periodStart: 1799996400000,
        periodEnd: 1800000000000,
      },
    ],
    heatmap: [{ date: '2026-11-03', timestamp: 1793635200000, requests }],
    options: {
      providers: [{ id: 'p1', name: 'Fixture provider' }],
      agents: ['__DEFAULT__', 'Code'],
      models: ['fixture-model'],
    },
  };
}
