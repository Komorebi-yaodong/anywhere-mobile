import {useThemedStyles} from './theme';
import React from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import type {ConversationTask} from '../remote/api';
import {AppIcon} from './AppIcon';

const C = {background: '#FAF8F3', surface: '#FFFFFF', mutedSurface: '#F2F0E9', text: '#292724', muted: '#79746C', line: '#E7E1D8', primary: '#C96849', success: '#478561', overlay: 'rgba(39, 36, 31, 0.34)'};

function statusLabel(status: ConversationTask['status']): string {
  if (status === 'completed') return '已完成';
  if (status === 'in_progress') return '进行中';
  return '待开始';
}

function StatusMark({status}: {status: ConversationTask['status']}) {
  const styles = useThemedStyles(baseStyles);
  if (status === 'completed') return <View style={[styles.mark, styles.markDone]}><Text style={styles.markCheck}>✓</Text></View>;
  if (status === 'in_progress') return <View style={[styles.mark, styles.markDoing]}><View style={styles.markDot} /></View>;
  return <View style={[styles.mark, styles.markPending]} />;
}

export function ConversationTaskSheet({visible, tasks, onClose}: {visible: boolean; tasks?: ConversationTask[]; onClose: () => void}) {
  const styles = useThemedStyles(baseStyles);
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const done = safeTasks.filter(task => task.status === 'completed').length;
  return <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}><View style={styles.overlay}><Pressable style={StyleSheet.absoluteFill} onPress={onClose} /><View style={styles.sheet}><View style={styles.handle} /><View style={styles.header}><View style={styles.titleRow}><View style={styles.icon}><AppIcon name="tasks" size={19} color={C.primary} /></View><View><Text style={styles.title}>当前会话任务</Text><Text style={styles.subtitle}>{safeTasks.length ? `${done}/${safeTasks.length} 已完成` : '暂无任务进度'}</Text></View></View><Pressable onPress={onClose}><Text style={styles.close}>完成</Text></Pressable></View><ScrollView style={styles.scroll} contentContainerStyle={styles.list}>{safeTasks.length ? safeTasks.map((task, index) => <View key={`${task.content}-${index}`} style={styles.task}><View style={styles.taskTop}><StatusMark status={task.status} /><View style={styles.taskCopy}><View style={styles.taskHeading}><Text style={[styles.taskText, task.status === 'completed' && styles.completed]}>{task.content}</Text><Text style={[styles.status, task.status === 'completed' ? styles.statusDone : task.status === 'in_progress' ? styles.statusDoing : styles.statusPending]}>{statusLabel(task.status)}</Text></View>{(task.steps || []).map((step, stepIndex) => <View key={`${step.content}-${stepIndex}`} style={styles.step}><StatusMark status={step.status} /><Text style={[styles.stepText, step.status === 'completed' && styles.completed]}>{step.content}</Text></View>)}</View></View></View>) : <View style={styles.empty}><Text style={styles.emptyTitle}>暂时没有任务</Text><Text style={styles.emptyText}>当 Agent 使用 task_write 更新当前会话任务时，会实时显示在这里。</Text></View>}</ScrollView></View></View></Modal>;
}

const baseStyles = StyleSheet.create({
  overlay: {flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay},
  sheet: {maxHeight: '76%', minHeight: 210, padding: 18, paddingBottom: 30, gap: 14, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: C.background},
  handle: {alignSelf: 'center', width: 42, height: 5, borderRadius: 3, backgroundColor: '#A49D92'},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  icon: {width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#F9E5DB'},
  title: {color: C.text, fontSize: 17, fontWeight: '600'},
  subtitle: {color: C.muted, fontSize: 12, marginTop: 2},
  close: {color: C.primary, fontWeight: '600'},
  scroll: {maxHeight: 470},
  list: {gap: 10, paddingBottom: 6},
  task: {padding: 13, borderRadius: 18, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface},
  taskTop: {flexDirection: 'row', gap: 10},
  taskCopy: {flex: 1, minWidth: 0, gap: 9},
  taskHeading: {flexDirection: 'row', gap: 8, alignItems: 'flex-start'},
  taskText: {flex: 1, color: C.text, fontSize: 15, fontWeight: '600', lineHeight: 21},
  status: {fontSize: 11, fontWeight: '600', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8, overflow: 'hidden'},
  statusDone: {color: C.success, backgroundColor: '#E5F2E9'},
  statusDoing: {color: C.primary, backgroundColor: '#F9E5DB'},
  statusPending: {color: C.muted, backgroundColor: C.mutedSurface},
  step: {flexDirection: 'row', gap: 8, alignItems: 'flex-start'},
  stepText: {flex: 1, color: C.muted, fontSize: 13, lineHeight: 19},
  mark: {width: 17, height: 17, marginTop: 2, borderRadius: 9, alignItems: 'center', justifyContent: 'center'},
  markDone: {backgroundColor: C.success},
  markDoing: {borderWidth: 2, borderColor: C.primary},
  markPending: {borderWidth: 1.5, borderColor: '#B9B1A7'},
  markDot: {width: 5, height: 5, borderRadius: 3, backgroundColor: C.primary},
  markCheck: {color: '#fff', fontSize: 11, fontWeight: '600'},
  completed: {color: '#938C82', textDecorationLine: 'line-through'},
  empty: {alignItems: 'center', gap: 6, padding: 24, borderRadius: 18, backgroundColor: C.mutedSurface},
  emptyTitle: {color: C.text, fontSize: 16, fontWeight: '600'},
  emptyText: {color: C.muted, textAlign: 'center', fontSize: 13, lineHeight: 19},
});
