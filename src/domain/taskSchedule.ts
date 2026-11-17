type Schedule = {dailyTimes?: unknown; dailyTime?: unknown; monthlySchedules?: unknown; monthlyDays?: unknown; monthlyTime?: unknown};
export type MonthlySchedule = {day: number; time: string};
export function dailyTimes(task: Schedule): string[] {
  return Array.isArray(task.dailyTimes) ? task.dailyTimes.filter((item): item is string => typeof item === 'string') : typeof task.dailyTime === 'string' ? [task.dailyTime] : [];
}
export function monthlySchedules(task: Schedule): MonthlySchedule[] {
  if (Array.isArray(task.monthlySchedules)) return task.monthlySchedules.filter((item): item is MonthlySchedule => !!item && typeof item.day === 'number' && typeof item.time === 'string');
  return (Array.isArray(task.monthlyDays) ? task.monthlyDays : []).filter((day): day is number => typeof day === 'number').map(day => ({day, time: typeof task.monthlyTime === 'string' ? task.monthlyTime : '09:00'}));
}
