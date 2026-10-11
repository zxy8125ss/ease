import Dexie, { type Table } from 'dexie';

export type Overate = 'none' | 'some' | 'lot';
export type ShiftCode = 'A' | 'P' | 'N' | 'R';

export interface Profile {
  id: 'me';
  age: number;
  heightCm: number;
  startJin: number;
  goalJin: number;
  goalDate: string; // YYYY-MM-DD
  shiftPattern: string; // e.g. APNRR
  anchorDate: string; // a date whose shift is known
  anchorIndex: number; // index in pattern for anchorDate
  aiEndpoint?: string; // Worker URL for photo recognition
  lastBackup?: string;
}

export interface MealItem { name: string; kcal: number }

export interface Meal {
  id?: number;
  date: string; // logical date (night-shift early hours belong to shift day)
  mealType: string;
  items: MealItem[];
  baseKcal: number; // AI estimate at portion 1.0
  portion: number; // 0.7 / 1 / 1.3
  totalKcal: number;
  thumb?: string;
  estimated: 'ai' | 'default' | 'manual';
  createdAt: number;
}

export interface Day {
  date: string;
  steps?: number;
  sleepHours?: number;
  exerciseDone?: string[];
  overate?: Overate; // answer about the previous day, asked at check-in
  checkedIn?: boolean;
}

export interface Weight { date: string; jin: number }

class EaseDB extends Dexie {
  profile!: Table<Profile, string>;
  meals!: Table<Meal, number>;
  days!: Table<Day, string>;
  weights!: Table<Weight, string>;
  constructor() {
    super('ease');
    this.version(1).stores({
      profile: 'id',
      meals: '++id, date, createdAt',
      days: 'date',
      weights: 'date',
    });
  }
}

export const db = new EaseDB();

export const DEFAULT_PROFILE: Profile = {
  id: 'me',
  age: 29,
  heightCm: 170,
  startJin: 145,
  goalJin: 135,
  goalDate: '2027-01-11',
  shiftPattern: 'APNRR',
  anchorDate: '2026-10-11',
  anchorIndex: 1,
};

export async function ensureProfile(): Promise<Profile> {
  const p = await db.profile.get('me');
  if (p) return p;
  await db.profile.put(DEFAULT_PROFILE);
  return DEFAULT_PROFILE;
}

export async function exportAll(): Promise<string> {
  const data = {
    app: 'ease',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: await db.profile.toArray(),
    meals: await db.meals.toArray(),
    days: await db.days.toArray(),
    weights: await db.weights.toArray(),
  };
  return JSON.stringify(data);
}

export async function importAll(json: string) {
  const data = JSON.parse(json);
  if (data.app !== 'ease') throw new Error('不是 Ease 的备份文件');
  await db.transaction('rw', db.profile, db.meals, db.days, db.weights, async () => {
    await Promise.all([db.profile.clear(), db.meals.clear(), db.days.clear(), db.weights.clear()]);
    await db.profile.bulkPut(data.profile);
    await db.meals.bulkPut(data.meals);
    await db.days.bulkPut(data.days);
    await db.weights.bulkPut(data.weights);
  });
}
