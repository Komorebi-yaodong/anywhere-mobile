import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import type {RemoteRequest} from '../remote/api';
import {AppIcon} from './AppIcon';
import {useThemedStyles} from './theme';

type ToggleSection = 'mcp' | 'skills';
type ToggleItem = {id: string; name: string; enabled: boolean; revision: string; tags?: string[]};
type DetailsReply = {ok: true; section: ToggleSection; items: ToggleItem[]};
type GeneralReply = {
  ok: true;
  section: 'general';
  revision: string;
  value: {displayName: string};
};

const C = {
  background: '#FAF8F3', surface: '#FFFFFF', surfaceMuted: '#F2F0E9',
  text: '#292724', muted: '#79746C', line: '#E7E1D8', primary: '#C96849',
  primarySoft: '#F9E5DB', success: '#478561', danger: '#B84E52',
};

function message(error: unknown, fallback: string) {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    remote_identifier_invalid: '此项无法从 Mobile 管理，请在 Desktop 检查名称后重试。',
    remote_workspace_item_not_found: '该项已在 Desktop 发生变化，请在顶部刷新后重试。',
    remote_workspace_revision_conflict: 'Desktop 配置已更新，请刷新后再修改。',
    remote_skill_root_not_configured: 'Desktop 尚未配置 Skill 目录。',
  };
  return messages[code] || (error instanceof Error ? error.message : fallback);
}

export function SimpleManagementSettings({
  section,
  desktopId,
  request,
  onChanged,
  refreshSignal,
}: {
  section: ToggleSection | 'general';
  desktopId: string;
  request: RemoteRequest;
  onChanged: () => void;
  refreshSignal: number;
}) {
  const s = useThemedStyles(styles);
  const [items, setItems] = useState<ToggleItem[]>([]);
  const [general, setGeneral] = useState<GeneralReply | null>(null);
  const [nickname, setNickname] = useState('');
  const [query, setQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState('__all__');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await request<DetailsReply | GeneralReply>(
        desktopId,
        'workspace.management.details.get',
        {section},
      );
      if (section === 'general') {
        const detail = result as GeneralReply;
        setGeneral(detail);
        setNickname(detail.value?.displayName || '');
      } else {
        const nextItems = (result as DetailsReply).items || [];
        setItems(nextItems);
        if (section === 'mcp') {
          setSelectedTag(current =>
            current !== '__all__' && !nextItems.some(item => item.tags?.includes(current))
              ? '__all__'
              : current,
          );
        }
      }
    } catch (cause) {
      setError(message(cause, '读取设置失败，请在顶部刷新后重试。'));
    } finally {
      setBusy(false);
    }
  }, [desktopId, request, section]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load, refreshSignal]);

  const toggle = async (item: ToggleItem) => {
    if (busy) return;
    const nextEnabled = !item.enabled;
    setItems(current => current.map(value => value.id === item.id ? {...value, enabled: nextEnabled} : value));
    setBusy(true);
    setError('');
    try {
      await request(
        desktopId,
        'workspace.management.patch',
        {section, id: item.id, expectedRevision: item.revision, patch: {enabled: nextEnabled}},
        60_000,
      );
      await load();
      onChanged();
    } catch (cause) {
      setError(message(cause, '更新开关失败，请刷新后重试。'));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const saveNickname = async () => {
    if (!general || busy) return;
    const displayName = nickname.trim();
    if (!displayName) {
      setError('请输入昵称。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request(
        desktopId,
        'workspace.management.patch',
        {
          section: 'general',
          id: '',
          expectedRevision: general.revision,
          patch: {displayName},
        },
        60_000,
      );
      await load();
      onChanged();
    } catch (cause) {
      setError(message(cause, '保存昵称失败，请刷新后重试。'));
    } finally {
      setBusy(false);
    }
  };

  if (section === 'general') {
    return (
      <View style={s.root}>
        {error ? <Text style={s.error}>{error}</Text> : null}
        {!general && busy ? <ActivityIndicator color={C.primary} /> : null}
        {general ? (
          <View style={s.generalPage}>
            <View style={s.profileCard}>
              <View style={s.avatar}><Text style={s.avatarText}>{(nickname || 'U').slice(0, 1).toUpperCase()}</Text></View>
              <View style={s.profileCopy}><Text style={s.profileTitle}>昵称</Text><Text style={s.profileMeta}>用于 Desktop 与移动端显示</Text></View>
            </View>
            <View style={s.field}><Text style={s.fieldLabel}>昵称</Text><TextInput value={nickname} onChangeText={setNickname} maxLength={12} placeholder="输入昵称" placeholderTextColor={C.muted} style={s.input} /></View>
            <Pressable disabled={busy || !nickname.trim()} style={[s.save, (busy || !nickname.trim()) && s.disabled]} onPress={saveNickname}>
              <Text style={s.saveText}>{busy ? '正在保存…' : '保存昵称'}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  const title = section === 'mcp' ? 'MCP 服务' : 'Skill 服务';
  const mcpTags = section === 'mcp'
    ? [...new Set(items.flatMap(item => item.tags || []))].sort((left, right) => left.localeCompare(right, 'zh-CN'))
    : [];
  const keyword = query.trim().toLocaleLowerCase('zh-CN');
  const visibleItems = items.filter(item => {
    const tags = section === 'mcp' ? item.tags || [] : [];
    const tagMatches = section !== 'mcp' || selectedTag === '__all__' || tags.includes(selectedTag);
    if (!tagMatches) return false;
    if (!keyword) return true;
    const haystack = [item.name || item.id, item.id, ...tags].join(' ').toLocaleLowerCase('zh-CN');
    return haystack.includes(keyword);
  });
  return (
    <View style={s.root}>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={s.search}><AppIcon name="search" size={17} color={C.muted} /><TextInput value={query} onChangeText={setQuery} placeholder={section === 'mcp' ? '搜索 MCP 名称、ID 或标签' : '搜索 Skill 名称'} placeholderTextColor={C.muted} style={s.searchInput} /></View>
      {section === 'mcp' && mcpTags.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tagFilters}>
        <Pressable accessibilityLabel="筛选全部 MCP 标签" style={[s.tagFilter, selectedTag === '__all__' && s.tagFilterActive]} onPress={() => setSelectedTag('__all__')}><Text style={[s.tagFilterText, selectedTag === '__all__' && s.tagFilterTextActive]}>全部标签</Text></Pressable>
        {mcpTags.map(tag => <Pressable key={tag} accessibilityLabel={`筛选 MCP 标签 ${tag}`} style={[s.tagFilter, selectedTag === tag && s.tagFilterActive]} onPress={() => setSelectedTag(tag)}><Text style={[s.tagFilterText, selectedTag === tag && s.tagFilterTextActive]}>{tag}</Text></Pressable>)}
      </ScrollView> : null}
      {busy && !items.length ? <ActivityIndicator color={C.primary} /> : null}
      <ScrollView style={s.scroll} contentContainerStyle={s.list} keyboardShouldPersistTaps="handled">
        {visibleItems.map(item => (
          <View key={item.id} style={s.itemCard}>
            <View style={s.itemIcon}><AppIcon name={section === 'mcp' ? 'mcp' : 'skills'} size={20} color={C.primary} /></View>
            <View style={s.itemCopy}>
              <Text numberOfLines={1} style={s.itemName}>{item.name || item.id}</Text>
              {section === 'mcp' && item.tags?.length ? <View style={s.itemTags}>{item.tags.map(tag => <View key={tag} style={s.itemTag}><Text style={s.itemTagText}>{tag}</Text></View>)}</View> : null}
            </View>
            <Switch
              value={item.enabled}
              disabled={busy}
              trackColor={{false: C.line, true: '#B9D8C3'}}
              thumbColor={item.enabled ? C.success : C.surface}
              onValueChange={() => toggle(item)}
            />
          </View>
        ))}
        {!busy && !visibleItems.length ? <View style={s.empty}><Text style={s.emptyTitle}>{items.length ? '没有匹配的筛选结果' : `暂无${title}`}</Text></View> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, minHeight: 0, backgroundColor: C.background},
  error: {paddingHorizontal: 18, paddingTop: 8, color: C.danger, fontSize: 13},
  search: {minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 8, paddingHorizontal: 13, borderRadius: 16, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface},
  searchInput: {flex: 1, minWidth: 0, paddingVertical: 8, color: C.text, fontSize: 14},
  tagFilters: {gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 2},
  tagFilter: {paddingHorizontal: 11, paddingVertical: 7, borderRadius: 99, backgroundColor: C.surfaceMuted},
  tagFilterActive: {backgroundColor: C.primarySoft},
  tagFilterText: {color: C.muted, fontSize: 12, fontWeight: '700'},
  tagFilterTextActive: {color: C.primary},
  scroll: {flex: 1, minHeight: 0},
  list: {padding: 16, paddingTop: 8, paddingBottom: 22, gap: 10},
  itemCard: {minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 13, borderRadius: 18, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface},
  itemIcon: {width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primarySoft},
  itemCopy: {flex: 1, minWidth: 0, gap: 5},
  itemName: {minWidth: 0, color: C.text, fontSize: 15, fontWeight: '800'},
  itemTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 4},
  itemTag: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 7, backgroundColor: C.surfaceMuted},
  itemTagText: {color: C.muted, fontSize: 10, fontWeight: '700'},
  empty: {marginTop: 8, padding: 22, alignItems: 'center', borderRadius: 18, backgroundColor: C.surfaceMuted},
  emptyTitle: {color: C.muted, fontSize: 14},
  generalPage: {padding: 18, gap: 16},
  profileCard: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface},
  avatar: {width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primarySoft},
  avatarText: {fontSize: 21, fontWeight: '800', color: C.primary},
  profileCopy: {flex: 1, gap: 3}, profileTitle: {fontSize: 16, fontWeight: '800', color: C.text}, profileMeta: {fontSize: 12, color: C.muted},
  field: {gap: 7}, fieldLabel: {color: C.text, fontSize: 14, fontWeight: '800'},
  input: {minHeight: 49, paddingHorizontal: 13, borderWidth: 1, borderColor: C.line, borderRadius: 15, backgroundColor: C.surface, color: C.text},
  save: {minHeight: 51, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: C.primary}, saveText: {color: '#fff', fontWeight: '800'}, disabled: {opacity: 0.45},
});
