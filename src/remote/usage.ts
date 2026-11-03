export type UsageFilters = {
  range: '24h' | 'today' | 'yesterday' | '7d' | '30d';
  providerId: string;
  agentName: string;
  model: string;
};
export const metricKeys = [
  'requests',
  'succeeded',
  'failed',
  'cancelled',
  'usageReported',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'totalTokens',
  'successRate',
  'inputRatio',
  'outputRatio',
  'cacheRatio',
] as const;
export type UsageMetrics = Record<(typeof metricKeys)[number], number>;
export type UsageBucket = UsageMetrics & {
  timestamp: number;
  periodStart: number;
  periodEnd: number;
};
export type UsageSnapshot = {
  schemaVersion: '1.0';
  generatedAt: number;
  timeZone: string;
  range: { start: number; end: number };
  granularity: 'hour' | '4h' | 'day';
  summary: UsageMetrics;
  buckets: UsageBucket[];
  heatmap: Array<{ date: string; timestamp: number; requests: number }>;
  options: {
    providers: Array<{ id: string; name: string }>;
    agents: string[];
    models: string[];
  };
};
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const number = (v: any) =>
  typeof v === 'number' &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER;
const timestamp = (v: any) => number(v) && v <= 8_640_000_000_000_000;
const text = (v: any) => typeof v === 'string' && v.length <= 512;
export function validateUsage(value: any): UsageSnapshot {
  const metrics = (v: any) =>
    object(v) && metricKeys.every(key => number(v[key]));
  try {
    if (!text(value?.timeZone)) throw new Error();
    new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(0);
  } catch {
    throw new Error('remote_usage_invalid');
  }
  if (
    !object(value) ||
    value.schemaVersion !== '1.0' ||
    !timestamp(value.generatedAt) ||
    !object(value.range) ||
    !timestamp(value.range.start) ||
    !timestamp(value.range.end) ||
    value.range.end < value.range.start ||
    !['hour', '4h', 'day'].includes(value.granularity) ||
    !metrics(value.summary) ||
    !Array.isArray(value.buckets) ||
    value.buckets.length > 64 ||
    !value.buckets.every(
      (b: any) =>
        metrics(b) &&
        timestamp(b.timestamp) &&
        timestamp(b.periodStart) &&
        timestamp(b.periodEnd) &&
        b.periodStart <= b.periodEnd &&
        b.periodStart >= value.range.start &&
        b.periodEnd <= value.range.end &&
        (value.buckets.indexOf(b) === 0 ||
          b.timestamp > value.buckets[value.buckets.indexOf(b) - 1].timestamp),
    ) ||
    !Array.isArray(value.heatmap) ||
    value.heatmap.length > 366 ||
    !value.heatmap.every(
      (d: any) =>
        object(d) &&
        typeof d.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(d.date) &&
        Number.isFinite(Date.parse(d.date + 'T12:00:00Z')) &&
        timestamp(d.timestamp) &&
        number(d.requests),
    ) ||
    !object(value.options) ||
    !Array.isArray(value.options.providers) ||
    value.options.providers.length > 200 ||
    !value.options.providers.every(
      (p: any) => object(p) && text(p.id) && text(p.name),
    ) ||
    !['agents', 'models'].every(
      key =>
        Array.isArray(value.options[key]) &&
        value.options[key].length <= 200 &&
        value.options[key].every(text),
    )
  )
    throw new Error('remote_usage_invalid');
  return value;
}
export const emptyMetrics: UsageMetrics = Object.fromEntries(
  metricKeys.map(key => [key, 0]),
) as UsageMetrics;
export function compactUsage(value = 0) {
  const units = [
    { scale: 1, suffix: '' },
    { scale: 1e3, suffix: 'K' },
    { scale: 1e6, suffix: 'M' },
    { scale: 1e9, suffix: 'B' },
  ];
  let index = value >= 1e9 ? 3 : value >= 1e6 ? 2 : value >= 1e3 ? 1 : 0;
  if (index < 3 && Math.round((value / units[index].scale) * 10) / 10 >= 1000)
    index++;
  return `${Number((value / units[index].scale).toFixed(1))}${
    units[index].suffix
  }`;
}
export function activityLevel(requests: number) {
  return requests <= 0
    ? 0
    : requests <= 20
    ? 1
    : requests <= 50
    ? 2
    : requests <= 100
    ? 3
    : 4;
}
