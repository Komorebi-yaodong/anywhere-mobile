import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, {
  Circle,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from 'react-native-svg';
import type { RemoteRequest } from '../remote/api';
import {
  activityLevel,
  compactUsage,
  emptyMetrics,
  type UsageBucket,
  type UsageFilters,
} from '../remote/usage';
import { useUsageStatistics } from '../hooks/useUsageStatistics';
import { useTheme, useThemedStyles } from './theme';
import { TextInput } from './ThemedNative';

const ranges = [
  { value: '24h', label: '最近24小时' },
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: '7d', label: '最近7天' },
  { value: '30d', label: '最近30天' },
] as const;
const percent = (value = 0) => `${(value * 100).toFixed(1)}%`;
const exact = (value = 0) => value.toLocaleString('en-US');
export function usagePeriod(
  bucket: Pick<UsageBucket, 'periodStart' | 'periodEnd'>,
  timeZone?: string,
) {
  const show = (time: number) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(time);
  return `${show(bucket.periodStart)} – ${show(bucket.periodEnd)}`;
}
// Monotone Hermite interpolation: observations stay exact and curves never overshoot.
export function usageLine(points: Array<{ x: number; y: number }>) {
  if (!points.length) return '';
  const slopes = points
    .slice(1)
    .map((p, i) => (p.y - points[i].y) / (p.x - points[i].x));
  const tangents = points.map((_, i) =>
    i === 0
      ? slopes[0]
      : i === points.length - 1
      ? slopes[i - 1]
      : slopes[i - 1] * slopes[i] <= 0
      ? 0
      : (2 * slopes[i - 1] * slopes[i]) / (slopes[i - 1] + slopes[i]),
  );
  slopes.forEach((slope, i) => {
    if (!slope) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const norm = Math.hypot(tangents[i] / slope, tangents[i + 1] / slope);
      if (norm > 3) {
        tangents[i] *= 3 / norm;
        tangents[i + 1] *= 3 / norm;
      }
    }
  });
  return points.reduce((line, p, i) => {
    if (!i) return `M ${p.x} ${p.y}`;
    const previous = points[i - 1],
      third = (p.x - previous.x) / 3;
    return `${line} C ${previous.x + third} ${
      previous.y + third * tangents[i - 1]
    } ${p.x - third} ${p.y - third * tangents[i]} ${p.x} ${p.y}`;
  }, '');
}
function Trend({
  buckets,
  metric,
  title,
  color,
  timeZone,
}: {
  buckets: UsageBucket[];
  metric: 'requests' | 'totalTokens';
  title: string;
  color: string;
  timeZone?: string;
}) {
  const s = useThemedStyles(styles),
    { colors } = useTheme();
  const [selected, setSelected] = useState<number | null>(null);
  const maximum = Math.max(1, ...buckets.map(item => item[metric]));
  const points = buckets.map((item, i) => ({
    x: 40 + (i * 286) / Math.max(1, buckets.length - 1),
    y: 136 - (item[metric] * 106) / maximum,
  }));
  const detail = selected === null ? null : buckets[selected];
  return (
    <View style={s.card}>
      <Text style={s.heading}>{title}</Text>
      <Svg
        accessibilityLabel={title}
        width="100%"
        height={178}
        viewBox="0 0 342 178"
      >
        {[0, 0.5, 1].map(ratio => (
          <React.Fragment key={ratio}>
            <Line
              x1={40}
              x2={326}
              y1={136 - ratio * 106}
              y2={136 - ratio * 106}
              stroke={colors.line}
            />
            <SvgText
              x={34}
              y={140 - ratio * 106}
              textAnchor="end"
              fontSize={10}
              fill={colors.muted}
            >
              {compactUsage(maximum * ratio)}
            </SvgText>
          </React.Fragment>
        ))}
        <Path
          d={usageLine(points)}
          stroke={color}
          strokeWidth={2.5}
          fill="none"
        />
        {points.map((p, i) => (
          <React.Fragment key={i}>
            <Circle cx={p.x} cy={p.y} r={selected === i ? 4 : 2} fill={color} />
            <Rect
              accessibilityLabel={`${usagePeriod(buckets[i], timeZone)} ${exact(
                buckets[i][metric],
              )}`}
              x={p.x - 143 / Math.max(1, points.length - 1)}
              y={20}
              width={286 / Math.max(1, points.length - 1)}
              height={126}
              fill="transparent"
              onPress={() => setSelected(i)}
            />
          </React.Fragment>
        ))}
        {[0, Math.floor((buckets.length - 1) / 2), buckets.length - 1]
          .filter(
            (i, index, all) =>
              i >= 0 && i < buckets.length && all.indexOf(i) === index,
          )
          .map(i => {
            const label = new Intl.DateTimeFormat('en-US', {
              timeZone,
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              hourCycle: 'h23',
            }).format(buckets[i].periodStart);
            return (
              <SvgText
                key={i}
                x={points[i].x}
                y={160}
                textAnchor={
                  i === 0
                    ? 'start'
                    : i === buckets.length - 1
                    ? 'end'
                    : 'middle'
                }
                fontSize={10}
                fill={colors.muted}
              >
                {label}
              </SvgText>
            );
          })}
      </Svg>
      {detail ? (
        <Text accessibilityLiveRegion="polite" style={s.detail}>
          {usagePeriod(detail, timeZone)} · {exact(detail[metric])}
        </Text>
      ) : null}
    </View>
  );
}
export function UsageStatistics({
  desktopId,
  request,
  active,
  refreshSignal = 0,
}: {
  desktopId: string;
  request: RemoteRequest;
  active: boolean;
  refreshSignal?: number;
}) {
  const s = useThemedStyles(styles),
    { colors, dark } = useTheme();
  const [filters, setFilters] = useState<UsageFilters>({
    range: '24h',
    providerId: '',
    agentName: '',
    model: '',
  });
  const [picker, setPicker] = useState<
    'providerId' | 'agentName' | 'model' | null
  >(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false),
    [heatDay, setHeatDay] = useState('');
  const { data, loading, error } = useUsageStatistics({
    desktopId,
    request,
    active,
    filters,
    refreshSignal,
  });
  const summary = data?.summary || emptyMetrics,
    buckets = data?.buckets || [];
  const heat = data?.heatmap || [];
  const heatColors = dark
    ? ['#2D2A26', '#34533E', '#487951', '#65A86F', '#9ED3AD']
    : ['#F2F0E9', '#DAEAD7', '#A7CDA0', '#6AA563', '#386C4B'];
  const offset = heat.length
    ? (new Date(heat[0].date + 'T12:00:00').getDay() + 6) % 7
    : 0;
  const columns = Math.max(1, Math.ceil((offset + heat.length) / 7));
  const agent = (name: string) =>
    name === '__DEFAULT__' ? '默认智能体' : name;
  const choices = useMemo(
    () =>
      picker === 'providerId'
        ? (data?.options.providers || []).map(item => ({
            value: item.id,
            label: item.name || '未知服务商',
          }))
        : (picker === 'agentName'
            ? data?.options.agents || []
            : data?.options.models || []
          ).map(value => ({
            value,
            label: picker === 'agentName' ? agent(value) : value,
          })),
    [data, picker],
  );
  const cards = [
    ['请求数', exact(summary.requests), `${exact(summary.succeeded)} 次成功`],
    [
      '成功率',
      percent(summary.successRate),
      `${exact(summary.failed)} 次失败 · ${exact(summary.cancelled)} 次取消`,
    ],
    [
      '总 Token',
      compactUsage(summary.totalTokens),
      `${exact(summary.usageReported)} 次返回用量`,
    ],
    [
      '输入 Token',
      compactUsage(summary.inputTokens),
      `占比 ${percent(summary.inputRatio)}`,
    ],
    [
      '输出 Token',
      compactUsage(summary.outputTokens),
      `占比 ${percent(summary.outputRatio)}`,
    ],
    [
      '缓存 Token',
      compactUsage(summary.cachedTokens),
      `命中率 ${percent(summary.cacheRatio)}`,
    ],
  ];
  return (
    <ScrollView
      accessibilityLabel="数据统计页面"
      contentContainerStyle={s.page}
      keyboardShouldPersistTaps="handled"
    >
      <View style={s.ranges}>
        {ranges.map(range => (
          <Pressable
            key={range.value}
            accessibilityRole="button"
            accessibilityState={{ selected: filters.range === range.value }}
            onPress={() => {
              setFilters(current => ({ ...current, range: range.value }));
              setHeatDay('');
            }}
            style={[s.range, filters.range === range.value && s.chosen]}
          >
            <Text
              style={[s.small, filters.range === range.value && s.chosenText]}
            >
              {range.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={s.filters}>
        {(['providerId', 'agentName', 'model'] as const).map((key, i) => (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={`筛选${['服务商', '智能体', '模型'][i]}`}
            style={s.filter}
            onPress={() => {
              setQuery('');
              setPicker(key);
            }}
          >
            <Text numberOfLines={1} style={s.small}>
              {filters[key]
                ? key === 'providerId'
                  ? data?.options.providers.find(
                      item => item.id === filters[key],
                    )?.name || '所选服务商'
                  : key === 'agentName'
                  ? agent(filters[key])
                  : filters[key]
                : ['全部服务商', '全部智能体', '全部模型'][i]}{' '}
              ▾
            </Text>
          </Pressable>
        ))}
      </View>
      {loading ? (
        <ActivityIndicator
          accessibilityLabel="正在读取统计"
          color={colors.primary}
        />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      ) : null}
      <View style={s.cards}>
        {cards.map(([title, value, meta]) => (
          <View key={title} style={[s.card, s.metric]}>
            <Text style={s.small}>{title}</Text>
            <Text style={s.value}>{value}</Text>
            <Text style={s.meta}>{meta}</Text>
          </View>
        ))}
      </View>
      <Trend
        key={`${JSON.stringify(filters)}-requests`}
        buckets={buckets}
        title="调用量趋势"
        metric="requests"
        timeZone={data?.timeZone}
        color={colors.primary}
      />
      <Trend
        key={`${JSON.stringify(filters)}-tokens`}
        buckets={buckets}
        title="Token 用量趋势"
        metric="totalTokens"
        timeZone={data?.timeZone}
        color={colors.success}
      />
      <View style={s.card}>
        <Text style={s.heading}>调用活跃度</Text>
        <Text style={s.meta}>
          最近一年 · {exact(heat.reduce((sum, day) => sum + day.requests, 0))}{' '}
          次调用
        </Text>
        <Svg
          width="100%"
          height={108}
          viewBox={`0 0 ${columns * 6 + 4} 66`}
          accessibilityLabel="年度调用热力图"
        >
          {heat.map((day, i) => (
            <Rect
              key={day.date}
              accessibilityLabel={`${day.date} ${exact(day.requests)} 次调用`}
              x={Math.floor((i + offset) / 7) * 6 + 2}
              y={((i + offset) % 7) * 7 + 3}
              width={5}
              height={6}
              rx={1}
              fill={heatColors[activityLevel(day.requests)]}
              onPress={() =>
                setHeatDay(`${day.date} · ${exact(day.requests)} 次调用`)
              }
            />
          ))}
        </Svg>
        {heatDay ? <Text style={s.detail}>{heatDay}</Text> : null}
        <View style={s.legend}>
          <Text style={s.meta}>少</Text>
          {heatColors.map((color, i) => (
            <View
              key={color}
              accessibilityLabel={
                ['0', '1–20', '21–50', '51–100', '101+'][i] + ' 次调用'
              }
              style={[s.legendBox, { backgroundColor: color }]}
            />
          ))}
          <Text style={s.meta}>多</Text>
        </View>
      </View>
      <View style={s.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(current => !current)}
        >
          <Text style={s.heading}>用量明细 {expanded ? '▴' : '▾'}</Text>
        </Pressable>
        {expanded
          ? buckets.map(bucket => (
              <View key={bucket.timestamp} style={s.row}>
                <Text style={s.small}>
                  {usagePeriod(bucket, data?.timeZone)}
                </Text>
                <Text style={s.detail}>
                  {exact(bucket.requests)} 次 ·{' '}
                  {compactUsage(bucket.totalTokens)} Token
                </Text>
                <Text style={s.meta}>
                  输入 {compactUsage(bucket.inputTokens)} · 输出{' '}
                  {compactUsage(bucket.outputTokens)} · 缓存{' '}
                  {compactUsage(bucket.cachedTokens)}
                </Text>
              </View>
            ))
          : null}
      </View>
      <Modal
        visible={active && picker !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setPicker(null)}
      >
        <View style={[s.modal, { backgroundColor: colors.overlay }]}>
          <View style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.heading}>
                选择
                {picker === 'providerId'
                  ? '服务商'
                  : picker === 'agentName'
                  ? '智能体'
                  : '模型'}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setPicker(null)}
              >
                <Text style={s.chosenText}>关闭</Text>
              </Pressable>
            </View>
            <Search value={query} onChange={setQuery} />
            <ScrollView keyboardShouldPersistTaps="handled">
              {[{ value: '', label: '全部' }, ...choices]
                .filter(
                  item =>
                    !query.trim() ||
                    item.label
                      .toLowerCase()
                      .includes(query.trim().toLowerCase()),
                )
                .map(item => (
                  <Pressable
                    key={item.value}
                    accessibilityRole="button"
                    style={s.option}
                    onPress={() => {
                      if (picker)
                        setFilters(current => ({
                          ...current,
                          [picker]: item.value,
                        }));
                      setHeatDay('');
                      setPicker(null);
                    }}
                  >
                    <Text style={s.small}>{item.label}</Text>
                  </Pressable>
                ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
function Search({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  const s = useThemedStyles(styles);
  return (
    <TextInput
      accessibilityLabel="搜索统计筛选项"
      placeholder="搜索"
      value={value}
      onChangeText={onChange}
      style={s.search}
    />
  );
}
const styles = StyleSheet.create({
  page: { padding: 18, paddingBottom: 40, gap: 14 },
  ranges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  range: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: '#F2F0E9',
  },
  chosen: { backgroundColor: '#F9E5DB' },
  chosenText: { color: '#C96849', fontWeight: '600' },
  filters: { flexDirection: 'row', gap: 6 },
  filter: {
    flex: 1,
    minWidth: 0,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E7E1D8',
    backgroundColor: '#FFFFFF',
  },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E7E1D8',
  },
  metric: { width: '48%', flexGrow: 1 },
  heading: { fontSize: 16, fontWeight: '700', color: '#292724' },
  small: { fontSize: 13, color: '#706B63' },
  value: {
    fontSize: 25,
    fontWeight: '700',
    color: '#292724',
    marginVertical: 8,
  },
  meta: { fontSize: 11, color: '#706B63', marginTop: 5 },
  detail: { fontSize: 12, color: '#292724', marginTop: 6 },
  error: { color: '#B84E52', fontSize: 13 },
  legend: {
    flexDirection: 'row',
    gap: 5,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  legendBox: { width: 12, height: 12, borderRadius: 2 },
  row: { paddingVertical: 12, borderBottomWidth: 1, borderColor: '#E7E1D8' },
  modal: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#FFFFFF',
    padding: 22,
    paddingBottom: 32,
    maxHeight: '75%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
  },
  option: { paddingVertical: 16, borderBottomWidth: 1, borderColor: '#E7E1D8' },
  search: {
    borderWidth: 1,
    borderColor: '#E7E1D8',
    padding: 12,
    borderRadius: 12,
    color: '#292724',
    marginBottom: 8,
  },
});
