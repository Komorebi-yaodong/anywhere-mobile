import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';

import type {RemoteRequest} from '../remote/api';
import {AppIcon} from './AppIcon';
import {useThemedStyles} from './theme';

type Option = {value: string; label: string};
type Field = {key: string; label: string; type: string; options?: string[]};
type Task = {id: string; name: string; enabled: boolean};
type Catalog = {ok: true; section: 'tasks'; schema: Field[]; options: Record<string, Option[]>; items?: Task[]; id?: string; revision?: string; value?: Record<string, unknown>};
type Editor = {creating: boolean; detail: Catalog; id: string; draft: Record<string, unknown>} | null;
type Picker = {title: string; options: Option[]; values: string[]; multiple?: boolean; onChange: (values: string[]) => void} | null;

const C = {background: '#FAF8F3', surface: '#FFFFFF', surfaceMuted: '#F2F0E9', text: '#292724', muted: '#79746C', line: '#E7E1D8', primary: '#C96849', primarySoft: '#F9E5DB', success: '#478561', danger: '#B84E52', overlay: 'rgba(39,36,31,.34)'};
const triggerLabels: Record<string, string> = {interval: '按间隔', daily: '每天', weekly: '每周', monthly: '每月', single: '单次'};
const routeLabels: Record<string, string> = {general: '通用', superior: '高级', fast: '快速'};
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function string(value: unknown) { return typeof value === 'string' ? value : ''; }
function strings(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function valueLabel(options: Option[], value: unknown, fallback = '请选择') { return options.find(item => item.value === value)?.label || string(value) || fallback; }

function defaultTask(): Record<string, unknown> {
  return {name: '', description: '', enabled: true, promptKey: '__DEFAULT__', triggerType: 'daily', dailyTime: '09:00', intervalMinutes: 60, intervalStartTime: '', weeklyDays: [1], weeklyTime: '09:00', monthlyDays: [1], monthlyTime: '09:00', singleDate: '', singleTime: '09:00', modelRoute: 'general', extraMcp: [], extraSkills: [], autoSaveProjectId: '', autoSave: true, autoClose: false};
}

export function TaskSettings({desktopId, request, onChanged, refreshSignal}: {desktopId: string; request: RemoteRequest; onChanged: () => void; refreshSignal: number}) {
  const s = useThemedStyles(styles);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try { setCatalog(await request<Catalog>(desktopId, 'management.catalog', {section: 'tasks'})); }
    catch (cause) { setError(message(cause, '读取定时任务失败，请在顶部刷新后重试。')); }
    finally { setBusy(false); }
  }, [desktopId, request]);
  useEffect(() => { load().catch(() => undefined); }, [load, refreshSignal]);

  const open = async (id: string) => {
    setBusy(true); setError('');
    try {
      const detail = await request<Catalog>(desktopId, 'management.catalog', {section: 'tasks', id});
      setEditor({creating: false, detail, id, draft: {...defaultTask(), ...(detail.value || {})}});
    } catch (cause) { setError(message(cause, '无法读取任务设置。')); }
    finally { setBusy(false); }
  };
  const create = () => {
    if (!catalog) return;
    setEditor({creating: true, detail: catalog, id: '', draft: defaultTask()});
  };
  const update = (patch: Record<string, unknown>) => setEditor(current => current ? {...current, draft: {...current.draft, ...patch}} : current);
  const toggle = async (task: Task) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const detail = await request<Catalog>(desktopId, 'management.catalog', {section: 'tasks', id: task.id});
      await request(desktopId, 'management.mutate', {section: 'tasks', id: task.id, operation: 'patch', expectedRevision: detail.revision, patch: {enabled: !task.enabled}}, 60_000);
      await load(); onChanged();
    } catch (cause) { setError(message(cause, '无法更新任务开关。')); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!editor || busy) return;
    const name = string(editor.draft.name).trim();
    if (!name) { setError('请输入任务名称。'); return; }
    const id = editor.creating ? name : editor.id;
    setBusy(true); setError('');
    try {
      await request(desktopId, 'management.mutate', {
        section: 'tasks', id, operation: editor.creating ? 'create' : 'patch',
        ...(editor.creating ? {} : {expectedRevision: editor.detail.revision}),
        patch: editor.draft,
      }, 60_000);
      setEditor(null); await load(); onChanged();
    } catch (cause) { setError(message(cause, '保存任务失败，请检查时间和频率。')); }
    finally { setBusy(false); }
  };
  const remove = () => {
    if (!editor || editor.creating) return;
    setBusy(true); setError('');
    request(desktopId, 'management.mutate', {section: 'tasks', id: editor.id, operation: 'delete', expectedRevision: editor.detail.revision, confirmed: true}, 60_000)
      .then(async () => { setEditor(null); await load(); onChanged(); })
      .catch(cause => setError(message(cause, '删除任务失败。')))
      .finally(() => setBusy(false));
  };
  const tasks = catalog?.items || [];
  return <View style={s.root}>
    {error ? <Text style={s.error}>{error}</Text> : null}
    {busy && !catalog ? <ActivityIndicator color={C.primary} /> : null}
    <ScrollView style={s.scroll} contentContainerStyle={s.list} keyboardShouldPersistTaps="handled">
      {tasks.map(task => <View key={task.id} style={s.taskCard}>
        <Pressable style={s.taskPress} onPress={() => open(task.id)} disabled={busy}>
          <View style={s.icon}><AppIcon name="tasks" size={20} color={C.primary} /></View>
          <View style={s.taskCopy}><Text numberOfLines={1} style={s.taskName}>{task.name || task.id}</Text><Text numberOfLines={1} style={s.taskMeta}>{task.enabled ? '已启用' : '已停用'}</Text></View>
        </Pressable>
        <Switch value={task.enabled} disabled={busy} trackColor={{false: C.line, true: '#B9D8C3'}} thumbColor={task.enabled ? C.success : C.surface} onValueChange={() => toggle(task)} />
      </View>)}
      {!busy && catalog && !tasks.length ? <View style={s.empty}><Text style={s.emptyTitle}>暂无定时任务</Text></View> : null}
    </ScrollView>
    <Pressable style={s.add} onPress={create} disabled={busy || !catalog}><AppIcon name="＋" size={19} color="#fff" /><Text style={s.addText}>新建定时任务</Text></Pressable>
    <TaskEditor editor={editor} busy={busy} picker={picker} onPicker={setPicker} onClose={() => setEditor(null)} onUpdate={update} onSave={save} onDelete={remove} />
  </View>;
}

function TaskEditor({editor, busy, picker, onPicker, onClose, onUpdate, onSave, onDelete}: {editor: Editor; busy: boolean; picker: Picker; onPicker: (value: Picker) => void; onClose: () => void; onUpdate: (patch: Record<string, unknown>) => void; onSave: () => void; onDelete: () => void}) {
  const s = useThemedStyles(styles);
  if (!editor) return null;
  const draft = editor.draft;
  const options = editor.detail.options || {};
  const trigger = string(draft.triggerType) || 'daily';
  const choose = (title: string, key: string, values: string[], choices: Option[], multiple = false) => onPicker({title, options: choices, values, multiple, onChange: next => onUpdate({[key]: multiple ? next : next[0] || ''})});
  const multiNumbers = (label: string, key: 'weeklyDays' | 'monthlyDays', optionsFor: Option[]) => <Pressable style={s.selectRow} onPress={() => choose(label, key, strings((draft[key] as number[] | undefined)?.map(String)), optionsFor, true)}><Text style={s.label}>{label}</Text><View style={s.selectRight}><Text numberOfLines={1} style={s.selectText}>{(draft[key] as number[] || []).map(value => optionsFor.find(item => item.value === String(value))?.label || value).join('、') || '请选择'}</Text><AppIcon name="›" size={17} color={C.muted} /></View></Pressable>;
  const weeklyOptions = weekdays.map((label, value) => ({value: String(value), label}));
  const monthlyOptions = Array.from({length: 31}, (_, index) => ({value: String(index + 1), label: `${index + 1} 日`}));
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}><View style={s.overlay}><View style={s.editor}>
    <View style={s.editorHeader}><Text style={s.editorTitle}>{editor.creating ? '新建定时任务' : '编辑定时任务'}</Text><Pressable onPress={onClose} disabled={busy}><Text style={s.link}>关闭</Text></Pressable></View>
    <ScrollView contentContainerStyle={s.editorScroll} keyboardShouldPersistTaps="handled">
      <View style={s.field}><Text style={s.label}>任务名称</Text><TextInput value={string(draft.name)} onChangeText={name => onUpdate({name})} placeholder="例如：每日整理" placeholderTextColor={C.muted} style={s.input} /></View>
      <View style={s.field}><Text style={s.label}>任务内容</Text><TextInput value={string(draft.description)} onChangeText={description => onUpdate({description})} placeholder="输入要执行的内容" placeholderTextColor={C.muted} style={[s.input, s.multiline]} multiline textAlignVertical="top" /></View>
      <Toggle label="启用任务" value={draft.enabled === true} onChange={enabled => onUpdate({enabled})} />
      <Pressable style={s.selectRow} onPress={() => choose('选择助手', 'promptKey', [string(draft.promptKey)], options.assistant || [])}><Text style={s.label}>助手</Text><View style={s.selectRight}><Text numberOfLines={1} style={s.selectText}>{valueLabel(options.assistant || [], draft.promptKey, '默认助手')}</Text><AppIcon name="›" size={17} color={C.muted} /></View></Pressable>
      <Pressable style={s.selectRow} onPress={() => choose('执行频率', 'triggerType', [trigger], Object.entries(triggerLabels).map(([value, label]) => ({value, label})))}><Text style={s.label}>频率</Text><View style={s.selectRight}><Text style={s.selectText}>{triggerLabels[trigger] || trigger}</Text><AppIcon name="›" size={17} color={C.muted} /></View></Pressable>
      {trigger === 'interval' ? <><NumberField label="间隔分钟" value={draft.intervalMinutes} onChange={intervalMinutes => onUpdate({intervalMinutes})} /><TimeField label="开始时间（可选）" value={string(draft.intervalStartTime)} onChange={intervalStartTime => onUpdate({intervalStartTime})} /></> : null}
      {trigger === 'daily' ? <TimeField label="每日时间" value={string(draft.dailyTime)} onChange={dailyTime => onUpdate({dailyTime})} /> : null}
      {trigger === 'weekly' ? <>{multiNumbers('执行星期', 'weeklyDays', weeklyOptions)}<TimeField label="每周时间" value={string(draft.weeklyTime)} onChange={weeklyTime => onUpdate({weeklyTime})} /></> : null}
      {trigger === 'monthly' ? <>{multiNumbers('执行日期', 'monthlyDays', monthlyOptions)}<TimeField label="每月时间" value={string(draft.monthlyTime)} onChange={monthlyTime => onUpdate({monthlyTime})} /></> : null}
      {trigger === 'single' ? <><View style={s.field}><Text style={s.label}>执行日期</Text><TextInput value={string(draft.singleDate)} onChangeText={singleDate => onUpdate({singleDate})} placeholder="YYYY-MM-DD" placeholderTextColor={C.muted} style={s.input} /></View><TimeField label="执行时间" value={string(draft.singleTime)} onChange={singleTime => onUpdate({singleTime})} /></> : null}
      <Pressable style={s.selectRow} onPress={() => choose('默认助手路线', 'modelRoute', [string(draft.modelRoute) || 'general'], Object.entries(routeLabels).map(([value, label]) => ({value, label})))}><Text style={s.label}>执行路线</Text><View style={s.selectRight}><Text style={s.selectText}>{routeLabels[string(draft.modelRoute)] || '通用'}</Text><AppIcon name="›" size={17} color={C.muted} /></View></Pressable>
      <Pressable style={s.selectRow} onPress={() => choose('额外 MCP', 'extraMcp', strings(draft.extraMcp), options.mcp || [], true)}><Text style={s.label}>额外 MCP</Text><View style={s.selectRight}><Text numberOfLines={1} style={s.selectText}>{strings(draft.extraMcp).length ? `${strings(draft.extraMcp).length} 项` : '不添加'}</Text><AppIcon name="›" size={17} color={C.muted} /></View></Pressable>
      <Pressable style={s.selectRow} onPress={() => choose('额外 Skill', 'extraSkills', strings(draft.extraSkills), options.skills || [], true)}><Text style={s.label}>额外 Skill</Text><View style={s.selectRight}><Text numberOfLines={1} style={s.selectText}>{strings(draft.extraSkills).length ? `${strings(draft.extraSkills).length} 项` : '不添加'}</Text><AppIcon name="›" size={17} color={C.muted} /></View></Pressable>
      <Pressable style={s.selectRow} onPress={() => choose('保存项目', 'autoSaveProjectId', [string(draft.autoSaveProjectId)], options.project || [])}><Text style={s.label}>保存项目</Text><View style={s.selectRight}><Text numberOfLines={1} style={s.selectText}>{valueLabel(options.project || [], draft.autoSaveProjectId, '不分组')}</Text><AppIcon name="›" size={17} color={C.muted} /></View></Pressable>
      <Toggle label="自动保存" value={draft.autoSave !== false} onChange={autoSave => onUpdate({autoSave})} />
      <Toggle label="完成后关闭" value={draft.autoClose === true} onChange={autoClose => onUpdate({autoClose})} />
    </ScrollView>
    <View style={s.editorBottom}>{!editor.creating ? <Pressable style={s.delete} onPress={onDelete} disabled={busy}><Text style={s.deleteText}>删除</Text></Pressable> : null}<Pressable style={[s.save, busy && s.disabled]} onPress={onSave} disabled={busy}><Text style={s.saveText}>{busy ? '正在保存…' : '保存任务'}</Text></Pressable></View>
    <TaskPicker picker={picker} onClose={() => onPicker(null)} />
  </View></View></Modal>;
}

function TaskPicker({picker, onClose}: {picker: Picker; onClose: () => void}) {
  const s = useThemedStyles(styles);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected(picker?.values || []), [picker]);
  if (!picker) return null;
  const select = (value: string) => setSelected(current => picker.multiple
    ? (current.includes(value) ? current.filter(item => item !== value) : [...current, value])
    : [value]);
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}><View style={s.pickerOverlay}><View style={s.picker}><Text style={s.editorTitle}>{picker.title}</Text><ScrollView style={s.pickerScroll}>{picker.options.map(option => { const active = selected.includes(option.value); return <Pressable key={option.value} style={[s.option, active && s.optionActive]} onPress={() => select(option.value)}><Text style={s.optionText}>{option.label}</Text><Text style={s.optionCheck}>{active ? '✓' : ''}</Text></Pressable>; })}</ScrollView><View style={s.pickerActions}><Pressable style={s.pickerCancel} onPress={onClose}><Text style={s.pickerCancelText}>取消</Text></Pressable><Pressable style={s.pickerConfirm} onPress={() => { picker.onChange(selected); onClose(); }}><Text style={s.pickerConfirmText}>确定</Text></Pressable></View></View></View></Modal>;
}


function TimeField({label, value, onChange}: {label: string; value: string; onChange: (value: string) => void}) { const s = useThemedStyles(styles); return <View style={s.field}><Text style={s.label}>{label}</Text><TextInput value={value} onChangeText={onChange} placeholder="HH:mm" placeholderTextColor={C.muted} style={s.input} keyboardType="numbers-and-punctuation" /></View>; }
function NumberField({label, value, onChange}: {label: string; value: unknown; onChange: (value: number) => void}) { const s = useThemedStyles(styles); return <View style={s.field}><Text style={s.label}>{label}</Text><TextInput value={String(value || '')} onChangeText={raw => onChange(Number(raw) || 0)} keyboardType="number-pad" style={s.input} /></View>; }
function Toggle({label, value, onChange}: {label: string; value: boolean; onChange: (value: boolean) => void}) { const s = useThemedStyles(styles); return <Pressable style={s.toggle} onPress={() => onChange(!value)}><Text style={s.label}>{label}</Text><Switch value={value} onValueChange={onChange} trackColor={{false: C.line, true: '#B9D8C3'}} thumbColor={value ? C.success : C.surface} /></Pressable>; }

const styles = StyleSheet.create({
  root: {flex: 1, minHeight: 0, backgroundColor: C.background}, error: {paddingHorizontal: 18, paddingTop: 8, color: C.danger, fontSize: 13}, scroll: {flex: 1, minHeight: 0}, list: {padding: 16, paddingTop: 8, paddingBottom: 18, gap: 10},
  pickerOverlay: {flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay}, picker: {maxHeight: '76%', gap: 10, padding: 20, borderTopLeftRadius: 26, borderTopRightRadius: 26, backgroundColor: C.background}, pickerScroll: {maxHeight: 380}, option: {minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7, paddingHorizontal: 13, borderRadius: 14, backgroundColor: C.surfaceMuted}, optionActive: {backgroundColor: C.primarySoft, borderWidth: 1, borderColor: C.primary}, optionText: {flex: 1, color: C.text, fontSize: 14}, optionCheck: {width: 22, color: C.primary, fontSize: 18, fontWeight: '900', textAlign: 'right'}, pickerActions: {flexDirection: 'row', gap: 10}, pickerCancel: {flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: C.surfaceMuted}, pickerCancelText: {color: C.text, fontWeight: '800'}, pickerConfirm: {flex: 1.2, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: C.primary}, pickerConfirmText: {color: '#fff', fontWeight: '800'},
  taskCard: {minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, borderRadius: 19, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface}, taskPress: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 11}, icon: {width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: C.primarySoft}, taskCopy: {flex: 1, minWidth: 0, gap: 4}, taskName: {color: C.text, fontSize: 15, fontWeight: '800'}, taskMeta: {color: C.muted, fontSize: 12}, empty: {marginTop: 10, padding: 22, alignItems: 'center', borderRadius: 18, backgroundColor: C.surfaceMuted}, emptyTitle: {fontSize: 14, color: C.muted},
  add: {minHeight: 52, marginHorizontal: 16, marginTop: 6, marginBottom: 13, borderRadius: 17, backgroundColor: C.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8}, addText: {color: '#fff', fontWeight: '800'},
  overlay: {flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay}, editor: {maxHeight: '93%', borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: C.background}, editorHeader: {height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line}, editorTitle: {fontSize: 20, fontWeight: '800', color: C.text}, editorScroll: {padding: 18, gap: 12}, field: {gap: 7}, label: {fontSize: 14, fontWeight: '800', color: C.text}, input: {minHeight: 48, paddingHorizontal: 13, borderWidth: 1, borderColor: C.line, borderRadius: 14, backgroundColor: C.surface, color: C.text}, multiline: {minHeight: 112, paddingTop: 11}, selectRow: {minHeight: 55, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line}, selectRight: {flex: 1, minWidth: 0, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 3}, selectText: {maxWidth: 190, color: C.muted, fontSize: 13}, toggle: {minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line}, editorBottom: {flexDirection: 'row', gap: 10, padding: 14, borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.line}, save: {flex: 1, minHeight: 49, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: C.primary}, saveText: {color: '#fff', fontWeight: '800'}, delete: {minHeight: 49, minWidth: 74, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#F6E3E3'}, deleteText: {color: C.danger, fontWeight: '800'}, disabled: {opacity: .45}, link: {color: C.primary, fontWeight: '800'},
});
