import type { Day, Meal, Profile, ShiftCode, Weight } from './db';

// ---------- dates ----------
export const pad = (n: number) => String(n).padStart(2, '0');
export const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => toDateStr(new Date());
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
export const diffDays = (a: string, b: string) => dayNum(b) - dayNum(a);
export const addDays = (s: string, n: number) => {
  const t = new Date((dayNum(s) + n) * 864e5);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
export const fmtMD = (s: string) => `${+s.slice(5, 7)}月${+s.slice(8, 10)}日`;
export const weekday = (s: string) => '日一二三四五六'[new Date(dayNum(s) * 864e5).getUTCDay()];
export const mondayOf = (s: string) => {
  const w = new Date(dayNum(s) * 864e5).getUTCDay();
  return addDays(s, -((w + 6) % 7));
};

// ---------- shifts ----------
export const SHIFT_INFO: Record<ShiftCode, { name: string; hours: string }> = {
  A: { name: 'A 班', hours: '08:00–15:00' },
  P: { name: 'P 班', hours: '15:00–23:00' },
  N: { name: '夜班', hours: '23:00–次日 08:00' },
  R: { name: '休息', hours: '' },
};

export function shiftOf(p: Profile, date: string): ShiftCode {
  const pat = p.shiftPattern.toUpperCase();
  const len = pat.length || 1;
  const idx = (((p.anchorIndex + diffDays(p.anchorDate, date)) % len) + len) % len;
  const c = pat[idx] as ShiftCode;
  return 'APNR'.includes(c) ? c : 'R';
}

/** 下夜班当天 */
export const isPostNight = (p: Profile, date: string) =>
  shiftOf(p, date) === 'R' && shiftOf(p, addDays(date, -1)) === 'N';

/** 晨间打卡提醒时间；null 表示当天不打卡 */
export function checkinTime(p: Profile, date: string): string | null {
  if (isPostNight(p, date)) return null;
  const s = shiftOf(p, date);
  if (s === 'A') return '15:30';
  if (s === 'N') return '10:30';
  return '10:00';
}

/** 记录归属日期：夜班的凌晨（0–8 点）算上班当天 */
export function logicalDate(p: Profile, ts: number): string {
  const d = new Date(ts);
  const ds = toDateStr(d);
  if (d.getHours() < 8 && shiftOf(p, addDays(ds, -1)) === 'N') return addDays(ds, -1);
  return ds;
}

export function mealTypeAt(p: Profile, ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  if (logicalDate(p, ts) !== toDateStr(d) || (h >= 23 && shiftOf(p, toDateStr(d)) === 'N')) return '夜班餐';
  if (h >= 5 && h < 10) return '早餐';
  if (h >= 10 && h < 14) return '午餐';
  if (h >= 14 && h < 17) return '加餐';
  if (h >= 17 && h < 21) return '晚餐';
  return '夜宵';
}

// ---------- calories ----------
export function bmr(p: Profile, jin: number) {
  return 10 * (jin / 2) + 6.25 * p.heightCm - 5 * p.age - 161;
}
export function kcalTarget(p: Profile, jin: number) {
  return Math.max(1300, Math.round((bmr(p, jin) * 1.375 - 450) / 50) * 50);
}

// ---------- weight ----------
export function avg7(weights: Weight[], date: string): number | null {
  const xs = weights.filter((w) => { const d = diffDays(w.date, date); return d >= 0 && d < 7; });
  if (xs.length < 3) return null;
  return xs.reduce((s, w) => s + w.jin, 0) / xs.length;
}
export function latestJin(weights: Weight[], fallback: number) {
  if (!weights.length) return fallback;
  return [...weights].sort((a, b) => (a.date < b.date ? 1 : -1))[0].jin;
}

// ---------- core metrics ----------
export function weekCompletion(meals: Meal[], date: string) {
  const mon = mondayOf(date);
  const counts: Record<string, number> = {};
  meals.forEach((m) => { if (diffDays(mon, m.date) >= 0 && diffDays(mon, m.date) < 7) counts[m.date] = (counts[m.date] || 0) + 1; });
  return Object.values(counts).filter((c) => c >= 2).length;
}

/** 夜班后暴食：下夜班当天“明显吃多”，在次日打卡时回答 */
export function overeatAfterNight(p: Profile, days: Day[], from: string, to: string) {
  return days.filter((d) => d.overate === 'lot' && d.date >= from && d.date <= to && isPostNight(p, addDays(d.date, -1))).length;
}

export function weeklyReport(p: Profile, meals: Meal[], days: Day[], weights: Weight[], date: string) {
  const mon = mondayOf(date);
  const sun = addDays(mon, 6);
  const lastMon = addDays(mon, -7);
  const done = weekCompletion(meals, date);
  const doneLast = weekCompletion(meals, lastMon);
  const binge = overeatAfterNight(p, days, mon, sun);
  const bingeLast = overeatAfterNight(p, days, lastMon, addDays(lastMon, 6));
  const ref = date < sun ? date : sun;
  const a = avg7(weights, ref);
  const b = avg7(weights, addDays(ref, -7));
  const change = a != null && b != null ? a - b : null;
  const weekMeals = meals.filter((m) => m.date >= mon && m.date <= sun);
  const kcalDays = new Set(weekMeals.map((m) => m.date)).size;
  const avgKcal = kcalDays ? Math.round(weekMeals.reduce((s, m) => s + m.totalKcal, 0) / kcalDays) : null;
  return { mon, sun, done, doneLast, binge, bingeLast, change, avgKcal };
}

export function reportTip(r: ReturnType<typeof weeklyReport>) {
  if (r.done === 0 && r.doneLast === 0) return '第一周，先养成习惯：每顿饭拍一张就行。';
  if (r.binge > 0) return '吃多主要发生在下夜班后：上夜班前把下班餐定好，到家先吃它。';
  if (r.done < 5) return `本周有 ${r.done} 天记了 2 餐以上，下周先保证午饭和晚饭各拍一张。`;
  if (r.change != null && r.change > 0.4) return '均重略有上升，下周少点一次重油外卖试试。';
  return '节奏不错，保持现在的记录习惯就好。';
}
