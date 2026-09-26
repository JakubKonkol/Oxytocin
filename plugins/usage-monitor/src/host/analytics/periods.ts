/** Calendar periods in the system's local time zone (docs/plan/08-usage-monitor.md §12). */
export type Period = 'day' | 'week' | 'month' | 'block5h';
export type WeekStart = 'monday' | 'sunday';

export interface Range {
  from: number;
  to: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function startOfWeek(ts: number, weekStartsOn: WeekStart = 'monday'): number {
  const d = new Date(startOfDay(ts));
  const offset = weekStartsOn === 'monday' ? (d.getDay() + 6) % 7 : d.getDay();
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

export function startOfMonth(ts: number): number {
  const d = new Date(startOfDay(ts));
  d.setDate(1);
  return d.getTime();
}

/** The calendar period containing `ts` (block5h is computed from events, see blocks.ts). */
export function periodRange(period: Exclude<Period, 'block5h'>, ts: number, weekStartsOn: WeekStart = 'monday'): Range {
  if (period === 'day') {
    const from = startOfDay(ts);
    return { from, to: addDays(from, 1) };
  }
  if (period === 'week') {
    const from = startOfWeek(ts, weekStartsOn);
    return { from, to: addDays(from, 7) };
  }
  const from = startOfMonth(ts);
  const d = new Date(from);
  d.setMonth(d.getMonth() + 1);
  return { from, to: d.getTime() };
}

/** Stable key of a period instance (budget alerts fire once per key and threshold). */
export function periodKey(period: Period, from: number): string {
  const d = new Date(from);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (period === 'block5h') return `block5h:${day}T${pad(d.getHours())}`;
  if (period === 'month') return `month:${day.slice(0, 7)}`;
  return `${period}:${day}`;
}
