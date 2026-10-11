import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, ensureProfile, exportAll, importAll, type Day, type Meal, type Overate, type Profile, type Weight } from './db';
import {
  SHIFT_INFO, addDays, avg7, checkinTime, diffDays, fmtMD, isPostNight, kcalTarget, latestJin, logicalDate,
  mealTypeAt, mondayOf, overeatAfterNight, reportTip, shiftOf, today, weekCompletion, weekday, weeklyReport,
} from './logic';
import { RECIPES, SNACKS, type Recipe } from './data/recipes';
import { WORKOUTS, totalSeconds, type Workout } from './data/workouts';
import { DEFAULT_KCAL, preparePhoto, recognize } from './photo';

type Tab = 'today' | 'food' | 'move' | 'trend';
type Sheet =
  | { kind: 'checkin' }
  | { kind: 'settings' }
  | { kind: 'meal'; meal: Meal }
  | { kind: 'recipe'; recipe: Recipe }
  | { kind: 'workout'; workout: Workout }
  | null;

const seedPick = <T,>(arr: T[], seed: string, offset = 0): T | undefined => {
  if (!arr.length) return undefined;
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return arr[(h + offset) % arr.length];
};

const fmtJin = (n: number) => n.toFixed(1);
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;

export default function App() {
  const profile = useLiveQuery(() => db.profile.get('me'));
  const meals = useLiveQuery(() => db.meals.toArray(), []) ?? [];
  const days = useLiveQuery(() => db.days.toArray(), []) ?? [];
  const weights = useLiveQuery(() => db.weights.toArray(), []) ?? [];
  const [tab, setTab] = useState<Tab>('today');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(today());
  const autoOpened = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { ensureProfile(); }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(today()), 60000);
    const onVis = () => document.visibilityState === 'visible' && setNow(today());
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 2200); };

  const dayRec = days.find((d) => d.date === now);
  const needCheckin = !!profile && checkinTime(profile, now) !== null && !dayRec?.checkedIn;

  useEffect(() => {
    if (needCheckin && !autoOpened.current && !sheet) { autoOpened.current = true; setSheet({ kind: 'checkin' }); }
  }, [needCheckin, sheet]);

  if (!profile) return <div className="app"><p className="muted center mt">加载中…</p></div>;

  const jin = latestJin(weights, profile.startJin);
  const target = kcalTarget(profile, avg7(weights, now) ?? jin);

  const onPhoto = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const ts = Date.now();
      const date = logicalDate(profile, ts);
      const mealType = mealTypeAt(profile, ts);
      const { upload, thumb } = await preparePhoto(file);
      const ai = await recognize(profile.aiEndpoint, upload);
      const base = ai ? Math.round(ai.total) : DEFAULT_KCAL[mealType] ?? 500;
      await db.meals.add({
        date, mealType, items: ai?.items ?? [], baseKcal: base, portion: 1, totalKcal: base, thumb,
        estimated: ai ? 'ai' : 'default', createdAt: ts,
      });
      flash(ai ? `已记录 ${mealType} · 约 ${base} kcal` : `已记录 ${mealType} · 按常见份量估 ${base} kcal`);
    } catch {
      flash('照片处理失败，再拍一次试试');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const takePhoto = () => fileRef.current?.click();

  return (
    <div className="app">
      <div className="blob a" /><div className="blob b" />
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />

      {tab === 'today' && (
        <TodayView profile={profile} now={now} meals={meals} days={days} weights={weights} target={target}
          needCheckin={needCheckin} busy={busy} onPhoto={takePhoto} onSheet={setSheet} />
      )}
      {tab === 'food' && <FoodView meals={meals} now={now} onSheet={setSheet} onPhoto={takePhoto} busy={busy} target={target} />}
      {tab === 'move' && <MoveView profile={profile} now={now} day={dayRec} days={days} onSheet={setSheet} />}
      {tab === 'trend' && <TrendView profile={profile} now={now} meals={meals} days={days} weights={weights} target={target} onSheet={setSheet} />}

      <TabBar tab={tab} setTab={setTab} />

      {sheet && (
        <div className="sheet-bg" onClick={() => sheet.kind !== 'workout' && setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {sheet.kind === 'checkin' && <CheckinSheet profile={profile} now={now} jin={jin} onDone={(m) => { setSheet(null); if (m) flash(m); }} />}
            {sheet.kind === 'settings' && <SettingsSheet profile={profile} onClose={() => setSheet(null)} flash={flash} />}
            {sheet.kind === 'meal' && <MealSheet meal={sheet.meal} onClose={() => setSheet(null)} />}
            {sheet.kind === 'recipe' && <RecipeSheet recipe={sheet.recipe} onClose={() => setSheet(null)} />}
            {sheet.kind === 'workout' && <WorkoutSheet workout={sheet.workout} now={now} day={dayRec} onClose={(m) => { setSheet(null); if (m) flash(m); }} />}
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ---------------- Today ---------------- */

function TodayView(props: {
  profile: Profile; now: string; meals: Meal[]; days: Day[]; weights: Weight[]; target: number;
  needCheckin: boolean; busy: boolean; onPhoto: () => void; onSheet: (s: Sheet) => void;
}) {
  const { profile, now, meals, days, weights, target, needCheckin, busy, onPhoto, onSheet } = props;
  const shift = shiftOf(profile, now);
  const postNight = isPostNight(profile, now);
  const todays = meals.filter((m) => m.date === now).sort((a, b) => a.createdAt - b.createdAt);
  const eaten = todays.reduce((s, m) => s + m.totalKcal, 0);
  const remaining = target - eaten;
  const [offset, setOffset] = useState(0);

  const hour = new Date().getHours();
  const slot: Recipe['slots'][number] = postNight && hour < 14 ? '下班' : hour < 10 ? '早' : '正餐';
  const pool = RECIPES.filter((r) => r.slots.includes(slot) && r.kcal <= remaining);
  const rec = seedPick(pool, now + slot, offset);
  const snack = seedPick(SNACKS.filter((s) => s.kcal <= Math.max(remaining, 80)), now, offset);

  const nightSeed = shift === 'N' ? now : addDays(now, -1);
  const offShiftMeal = seedPick(RECIPES.filter((r) => r.protein && r.slots.includes('下班')), nightSeed);

  const workout = pickWorkout(profile, now);
  const dayDone = !!days.find((d) => d.date === now)?.exerciseDone?.length;
  const monthStart = now.slice(0, 8) + '01';
  const done = weekCompletion(meals, now);
  const binge = overeatAfterNight(profile, days, monthStart, now);
  const a = avg7(weights, now);
  const b = avg7(weights, addDays(now, -7));

  return (
    <>
      <div className="top">
        <div>
          <div className="brand">Ease</div>
          <div className="sub">{fmtMD(now)} 周{weekday(now)}</div>
        </div>
        <div className="row">
          <span className={`shift-chip ${shift}`}>{postNight ? '下夜班' : SHIFT_INFO[shift].name}{SHIFT_INFO[shift].hours && !postNight ? ` · ${SHIFT_INFO[shift].hours}` : ''}</span>
          <button className="icon-btn" aria-label="设置" onClick={() => onSheet({ kind: 'settings' })}><Gear /></button>
        </div>
      </div>

      <div className="metrics" style={{ marginBottom: 14 }}>
        <div className="metric"><b>{done}/7</b><span>本周记录完成</span></div>
        <div className="metric"><b>{binge}</b><span>本月夜班后吃多</span></div>
        <div className="metric"><b>{a != null && b != null ? signed(a - b) : '—'}</b><span>7 日均重变化(斤)</span></div>
      </div>

      {needCheckin && (
        <button className="card sand" style={{ width: '100%', textAlign: 'left' }} onClick={() => onSheet({ kind: 'checkin' })}>
          <h2 style={{ marginBottom: 4 }}>今天还没打卡</h2>
          <div className="small muted">称个重，回答一个问题，10 秒</div>
        </button>
      )}

      {shift === 'N' && offShiftMeal && (
        <div className="card green">
          <h2>今晚 23:00 夜班</h2>
          <div className="small">出门前先吃一份顶饱餐。下班餐已定好：</div>
          <button className="btn mt" style={{ background: '#F2EADF', color: 'var(--green)' }} onClick={() => onSheet({ kind: 'recipe', recipe: offShiftMeal })}>
            {offShiftMeal.name} · {offShiftMeal.kcal} kcal
          </button>
        </div>
      )}
      {postNight && offShiftMeal && (
        <div className="card green">
          <h2>辛苦了，先吃下班餐</h2>
          <div className="small">到家先吃它，吃完再睡：</div>
          <button className="btn mt" style={{ background: '#F2EADF', color: 'var(--green)' }} onClick={() => onSheet({ kind: 'recipe', recipe: offShiftMeal })}>
            {offShiftMeal.name} · {offShiftMeal.kcal} kcal
          </button>
        </div>
      )}
      {shift === 'P' && hour >= 20 && (
        <div className="card sand small">23:00 下班，回家饿了就吃<b> {seedPick(SNACKS, now)?.name}</b>，别再点夜宵。</div>
      )}

      <div className="card">
        <div className="ring-wrap">
          <Ring value={eaten} max={target} />
          <div className="ring-text">
            <span>今天还可以吃</span>
            <b style={{ color: remaining < 0 ? 'var(--warn)' : undefined }}>{Math.abs(remaining)} <small style={{ fontSize: 14 }}>kcal</small></b>
            <span>{remaining < 0 ? '已超出，没关系，看周均' : `已吃 ${eaten} / 目标 ${target}`}</span>
          </div>
        </div>
      </div>

      <button className="big-btn" onClick={onPhoto} disabled={busy} style={{ marginBottom: 14 }}>
        <Camera /> {busy ? '识别中…' : '拍一下这顿饭'}
      </button>

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{slot === '下班' ? '下班餐' : slot === '早' ? '早餐吃这个' : '下一餐吃这个'}</h2>
          <button className="btn ghost" onClick={() => setOffset(offset + 1)}>换一个</button>
        </div>
        {rec ? (
          <button className="mt" style={{ textAlign: 'left', width: '100%' }} onClick={() => onSheet({ kind: 'recipe', recipe: rec })}>
            <div className="row between"><b style={{ fontSize: 17 }}>{rec.name}</b><span className="tag">{rec.kcal} kcal · {rec.minutes} 分钟</span></div>
            <div className="small muted mt">不想做：{rec.takeout}</div>
          </button>
        ) : (
          <div className="mt small">剩余额度不多，饿了来一份 <b>{snack?.name}</b>（{snack?.kcal} kcal）。</div>
        )}
      </div>

      <div className="card sand row between">
        <div><b>今天动一动</b><div className="small muted">{workout.name} · 约 {Math.round(totalSeconds(workout) / 60)} 分钟{dayDone ? ' · 已完成' : ''}</div></div>
        <button className="btn solid" onClick={() => onSheet({ kind: 'workout', workout })}>开始</button>
      </div>

      {todays.length > 0 && (
        <div className="card">
          <h2>今天吃了</h2>
          {todays.map((m) => <MealRow key={m.id} meal={m} onClick={() => onSheet({ kind: 'meal', meal: m })} />)}
        </div>
      )}
    </>
  );
}

function MealRow({ meal, onClick }: { meal: Meal; onClick: () => void }) {
  const t = new Date(meal.createdAt);
  const names = meal.items.map((i) => i.name).join('、');
  return (
    <button className="meal" style={{ width: '100%', textAlign: 'left' }} onClick={onClick}>
      {meal.thumb ? <img src={meal.thumb} alt="" /> : <div className="ph" />}
      <div className="grow">
        <div className="row"><b>{meal.mealType}</b><span className="small muted">{t.getHours()}:{String(t.getMinutes()).padStart(2, '0')}</span></div>
        <div className="small muted">{names || (meal.estimated === 'default' ? '按常见份量估算' : '')}{meal.portion !== 1 ? ` · ${meal.portion < 1 ? '少' : '多'}` : ''}</div>
      </div>
      <span className="k">{meal.totalKcal}</span>
    </button>
  );
}

function Ring({ value, max }: { value: number; max: number }) {
  const r = 42, c = 2 * Math.PI * r;
  const p = Math.min(1, value / max);
  return (
    <svg width="104" height="104" viewBox="0 0 104 104">
      <circle cx="52" cy="52" r={r} fill="none" stroke="var(--card)" strokeWidth="12" />
      {p > 0 && <circle cx="52" cy="52" r={r} fill="none" stroke={value > max ? 'var(--warn)' : 'var(--teal)'} strokeWidth="12" strokeLinecap="round"
        strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 52 52)" />}
      <text x="52" y="58" textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--green)">{Math.round(p * 100)}%</text>
    </svg>
  );
}

/* ---------------- Check-in ---------------- */

function CheckinSheet({ profile, now, jin, onDone }: { profile: Profile; now: string; jin: number; onDone: (msg?: string) => void }) {
  const [val, setVal] = useState(Math.round(jin * 10) / 10);
  const [editing, setEditing] = useState(false);
  const yesterdayPostNight = isPostNight(profile, addDays(now, -1));
  const save = async (overate?: Overate) => {
    await db.weights.put({ date: now, jin: Math.round(val * 10) / 10 });
    const d = (await db.days.get(now)) ?? { date: now };
    await db.days.put({ ...d, checkedIn: true, overate });
    onDone('打卡完成');
  };
  const skip = async () => {
    const d = (await db.days.get(now)) ?? { date: now };
    await db.days.put({ ...d, checkedIn: true });
    onDone();
  };
  return (
    <>
      <h3>今日打卡</h3>
      <div className="small muted">体重（斤）</div>
      <div className="stepper">
        <button onClick={() => setVal(Math.round((val - 0.1) * 10) / 10)}>−</button>
        {editing ? (
          <input autoFocus inputMode="decimal" defaultValue={val} className="val" style={{ width: 140, border: 0, background: 'transparent' }}
            onBlur={(e) => { const n = parseFloat(e.target.value); if (n > 50 && n < 400) setVal(n); setEditing(false); }} />
        ) : (
          <div className="val" onClick={() => setEditing(true)}>{fmtJin(val)}<small> 斤</small></div>
        )}
        <button onClick={() => setVal(Math.round((val + 0.1) * 10) / 10)}>+</button>
      </div>
      <div className="small muted center" style={{ marginBottom: 16 }}>点数字可直接输入</div>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>{yesterdayPostNight ? '下夜班那天吃多了吗？' : '昨天吃多了吗？'}</div>
      <div className="seg">
        <button className="btn" onClick={() => save('none')}>没有</button>
        <button className="btn" onClick={() => save('some')}>有点</button>
        <button className="btn" onClick={() => save('lot')}>明显</button>
      </div>
      <button className="small muted mt" style={{ width: '100%' }} onClick={skip}>今天跳过</button>
    </>
  );
}

/* ---------------- Food ---------------- */

function FoodView({ meals, now, onSheet, onPhoto, busy, target }: { meals: Meal[]; now: string; onSheet: (s: Sheet) => void; onPhoto: () => void; busy: boolean; target: number }) {
  const [showLib, setShowLib] = useState(false);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(now, -i));
  return (
    <>
      <div className="top"><div className="brand">饮食</div></div>
      <button className="big-btn" onClick={onPhoto} disabled={busy} style={{ marginBottom: 14 }}><Camera /> {busy ? '识别中…' : '拍一下这顿饭'}</button>
      {dates.map((d) => {
        const ms = meals.filter((m) => m.date === d).sort((a, b) => a.createdAt - b.createdAt);
        if (!ms.length) return null;
        const sum = ms.reduce((s, m) => s + m.totalKcal, 0);
        return (
          <div className="card" key={d}>
            <div className="row between"><h2 style={{ margin: 0 }}>{d === now ? '今天' : `${fmtMD(d)} 周${weekday(d)}`}</h2>
              <span className="tag">{sum} / {target} kcal</span></div>
            <div className="mt">{ms.map((m) => <MealRow key={m.id} meal={m} onClick={() => onSheet({ kind: 'meal', meal: m })} />)}</div>
          </div>
        );
      })}
      <div className="card sand">
        <div className="row between"><h2 style={{ margin: 0 }}>快手菜库 · {RECIPES.length} 道</h2>
          <button className="btn ghost" onClick={() => setShowLib(!showLib)}>{showLib ? '收起' : '展开'}</button></div>
        {showLib && RECIPES.slice().sort((a, b) => a.kcal - b.kcal).map((r) => (
          <button key={r.id} className="meal" style={{ width: '100%', textAlign: 'left' }} onClick={() => onSheet({ kind: 'recipe', recipe: r })}>
            <div className="grow"><b>{r.name}</b><div className="small muted">{r.minutes} 分钟{r.spicy ? ' · ' + '辣'.repeat(r.spicy) : ''}</div></div>
            <span className="k">{r.kcal}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function MealSheet({ meal, onClose }: { meal: Meal; onClose: () => void }) {
  const setPortion = async (p: number) => {
    await db.meals.update(meal.id!, { portion: p, totalKcal: Math.round(meal.baseKcal * p) });
    onClose();
  };
  const [manual, setManual] = useState('');
  return (
    <>
      <h3>{meal.mealType}</h3>
      {meal.thumb && <img src={meal.thumb} alt="" style={{ width: '100%', borderRadius: 20, maxHeight: 220, objectFit: 'cover' }} />}
      {meal.items.length > 0 && (
        <ul className="list-clean small">{meal.items.map((i, k) => <li key={k}>{i.name} · 约 {i.kcal} kcal</li>)}</ul>
      )}
      {meal.estimated === 'default' && <p className="small muted">照片识别还未接入，暂按常见外卖份量估算。</p>}
      <div style={{ fontWeight: 600, margin: '14px 0 8px' }}>份量</div>
      <div className="seg">
        {[[0.7, '少'], [1, '正常'], [1.3, '多']].map(([p, l]) => (
          <button key={l} className={`btn ${meal.portion === p ? 'sel' : ''}`} onClick={() => setPortion(p as number)}>{l} · {Math.round(meal.baseKcal * (p as number))}</button>
        ))}
      </div>
      <div className="field mt">
        <span className="small">知道准确热量？</span>
        <input inputMode="numeric" placeholder="kcal" value={manual} onChange={(e) => setManual(e.target.value)} />
      </div>
      <div className="row mt">
        <button className="btn ghost grow" onClick={async () => { await db.meals.delete(meal.id!); onClose(); }}>删除</button>
        <button className="btn solid grow" onClick={async () => {
          const n = parseInt(manual, 10);
          if (n > 0) await db.meals.update(meal.id!, { baseKcal: n, portion: 1, totalKcal: n, estimated: 'manual' });
          onClose();
        }}>完成</button>
      </div>
    </>
  );
}

function RecipeSheet({ recipe, onClose }: { recipe: Recipe; onClose: () => void }) {
  return (
    <>
      <h3>{recipe.name}</h3>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <span className="tag">约 {recipe.kcal} kcal</span><span className="tag">{recipe.minutes} 分钟</span>
        {recipe.spicy > 0 && <span className="tag">{'辣'.repeat(recipe.spicy)}</span>}
        {recipe.protein && <span className="tag">高蛋白</span>}
      </div>
      <div className="card"><b>食材</b><div className="small mt">{recipe.ingredients}</div>
        <ol className="list-clean small">{recipe.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></div>
      <div className="card sand"><b>不想做就点外卖</b><div className="small mt">{recipe.takeout}</div></div>
      <button className="btn solid" style={{ width: '100%', padding: 14 }} onClick={onClose}>知道了</button>
    </>
  );
}

/* ---------------- Move ---------------- */

function pickWorkout(profile: Profile, now: string) {
  const stretch = isPostNight(profile, now) || shiftOf(profile, now) === 'N';
  const pool = WORKOUTS.filter((w) => w.kind === (stretch ? 'stretch' : 'light'));
  return seedPick(pool, now)!;
}

function MoveView({ profile, now, day, days, onSheet }: { profile: Profile; now: string; day?: Day; days: Day[]; onSheet: (s: Sheet) => void }) {
  const w = pickWorkout(profile, now);
  const mon = mondayOf(now);
  const weekDone = days.filter((d) => d.date >= mon && d.date <= now && d.exerciseDone?.length).length;
  const [steps, setSteps] = useState(day?.steps?.toString() ?? '');
  const [sleep, setSleep] = useState(day?.sleepHours?.toString() ?? '');
  const saveField = async (patch: Partial<Day>) => {
    const d = (await db.days.get(now)) ?? { date: now };
    await db.days.put({ ...d, ...patch });
  };
  const doneToday = !!day?.exerciseDone?.length;
  return (
    <>
      <div className="top"><div className="brand">运动</div><span className="tag">本周已动 {weekDone} 天</span></div>
      <div className="card green">
        <h2>{doneToday ? '今天已完成，想再来一组？' : '今天动一动'}</h2>
        <div className="small">{w.name} · 约 {Math.round(totalSeconds(w) / 60)} 分钟 · {w.kind === 'stretch' ? '舒展' : '低冲击'}</div>
        <button className="big-btn teal mt" onClick={() => onSheet({ kind: 'workout', workout: w })}>开始</button>
      </div>
      <div className="card">
        <h2>今天的数据</h2>
        <div className="field"><span>步数</span>
          <input inputMode="numeric" placeholder="同步后自动填" value={steps} onChange={(e) => setSteps(e.target.value)}
            onBlur={() => saveField({ steps: steps ? parseInt(steps, 10) : undefined })} /></div>
        <div className="field"><span>昨晚睡了（小时）</span>
          <input inputMode="decimal" placeholder="可不填" value={sleep} onChange={(e) => setSleep(e.target.value)}
            onBlur={() => saveField({ sleepHours: sleep ? parseFloat(sleep) : undefined })} /></div>
        <div className="small muted mt">接入「健康」App 自动同步后，这里不用再填。</div>
      </div>
      <div className="card sand">
        <h2>全部组合</h2>
        {WORKOUTS.map((x) => (
          <button key={x.id} className="meal" style={{ width: '100%', textAlign: 'left' }} onClick={() => onSheet({ kind: 'workout', workout: x })}>
            <div className="grow"><b>{x.name}</b><div className="small muted">{x.kind === 'stretch' ? '舒展' : '低冲击'} · 约 {Math.round(totalSeconds(x) / 60)} 分钟</div></div>
          </button>
        ))}
      </div>
    </>
  );
}

function WorkoutSheet({ workout, now, day, onClose }: { workout: Workout; now: string; day?: Day; onClose: (msg?: string) => void }) {
  const [i, setI] = useState(-1); // -1 = not started
  const [left, setLeft] = useState(workout.moves[0].seconds);
  const [paused, setPaused] = useState(false);
  const finished = useRef(false);
  const total = totalSeconds(workout);

  useEffect(() => {
    if (i < 0 || paused) return;
    const t = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => clearInterval(t);
  }, [i, paused]);

  useEffect(() => {
    if (i < 0 || left > 0) return;
    if (i + 1 < workout.moves.length) {
      try { navigator.vibrate?.(200); } catch { /* ignore */ }
      setI(i + 1); setLeft(workout.moves[i + 1].seconds);
    } else if (!finished.current) {
      finished.current = true;
      (async () => {
        const d = (await db.days.get(now)) ?? day ?? { date: now };
        await db.days.put({ ...d, exerciseDone: [...(d.exerciseDone ?? []), workout.id] });
        onClose('完成！今天的运动已打卡');
      })();
    }
  }, [left, i, workout, now, day, onClose]);

  const elapsed = i < 0 ? 0 : workout.moves.slice(0, i).reduce((s, m) => s + m.seconds, 0) + (workout.moves[i].seconds - left);
  const cur = workout.moves[Math.max(0, i)];
  const next = workout.moves[i + 1];

  return (
    <>
      <h3>{workout.name}</h3>
      <div className="progress"><i style={{ width: `${(elapsed / total) * 100}%` }} /></div>
      {i < 0 ? (
        <>
          <ol className="list-clean small">{workout.moves.filter((m) => m.name !== '休息').map((m, k) => <li key={k}>{m.name} · {m.seconds} 秒</li>)}</ol>
          <button className="big-btn teal mt" onClick={() => setI(0)}>开始</button>
          <button className="small muted mt" style={{ width: '100%' }} onClick={() => onClose()}>先不做</button>
        </>
      ) : (
        <div className="timer">
          <div className="move">{cur.name}</div>
          <div className="small muted">{cur.tip}</div>
          <div className="count">{left}</div>
          <div className="small muted">{next ? `下一个：${next.name}` : '最后一个'}</div>
          <div className="row mt">
            <button className="btn ghost grow" onClick={() => onClose()}>结束</button>
            <button className="btn grow" onClick={() => setPaused(!paused)}>{paused ? '继续' : '暂停'}</button>
            <button className="btn solid grow" onClick={() => setLeft(0)}>跳过</button>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- Trend ---------------- */

function TrendView({ profile, now, meals, days, weights, target, onSheet }: {
  profile: Profile; now: string; meals: Meal[]; days: Day[]; weights: Weight[]; target: number; onSheet: (s: Sheet) => void;
}) {
  const r = weeklyReport(profile, meals, days, weights, now);
  const a = avg7(weights, now);
  const monthDays = useMemo(() => {
    const first = now.slice(0, 8) + '01';
    const out: string[] = [];
    for (let d = first; d.slice(0, 7) === now.slice(0, 7); d = addDays(d, 1)) out.push(d);
    return out;
  }, [now]);
  const sleepDays = days.filter((d) => d.sleepHours && diffDays(d.date, now) < 7 && diffDays(d.date, now) >= 0);
  const avgSleep = sleepDays.length ? sleepDays.reduce((s, d) => s + (d.sleepHours ?? 0), 0) / sleepDays.length : null;

  return (
    <>
      <div className="top"><div className="brand">趋势</div>
        <button className="icon-btn" aria-label="设置" onClick={() => onSheet({ kind: 'settings' })}><Gear /></button></div>

      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>体重</h2>
          <span className="tag">7 日均重 {a != null ? fmtJin(a) : '—'} · 目标 {profile.goalJin}</span></div>
        <WeightChart weights={weights} now={now} goal={profile.goalJin} />
        <div className="small muted">浅色点是每天的体重，绿线是 7 日均重，只看绿线的方向。</div>
      </div>

      <div className="card green">
        <h2>本周小结 · {fmtMD(r.mon)}–{fmtMD(r.sun)}</h2>
        <div className="metrics">
          <div className="metric" style={{ background: 'rgba(242,234,223,.12)' }}><b style={{ color: '#F2EADF' }}>{r.done}/7</b><span style={{ color: '#DCE6DD' }}>记录完成<br />上周 {r.doneLast}</span></div>
          <div className="metric" style={{ background: 'rgba(242,234,223,.12)' }}><b style={{ color: '#F2EADF' }}>{r.binge}</b><span style={{ color: '#DCE6DD' }}>夜班后吃多<br />上周 {r.bingeLast}</span></div>
          <div className="metric" style={{ background: 'rgba(242,234,223,.12)' }}><b style={{ color: '#F2EADF' }}>{r.change != null ? signed(r.change) : '—'}</b><span style={{ color: '#DCE6DD' }}>均重变化<br />斤</span></div>
        </div>
        <div className="small mt">{reportTip(r)}</div>
        <div className="small mt" style={{ opacity: .75 }}>参考：日均 {r.avgKcal ?? '—'} kcal（目标 {target}）{avgSleep != null ? ` · 近 7 天平均睡眠 ${avgSleep.toFixed(1)} 小时` : ''}</div>
      </div>

      <div className="card">
        <h2>本月排班</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
          {'一二三四五六日'.split('').map((w) => <div key={w} className="small muted center">{w}</div>)}
          {Array.from({ length: (new Date(monthDays[0] + 'T00:00:00').getDay() + 6) % 7 }, (_, k) => <div key={'e' + k} />)}
          {monthDays.map((d) => {
            const s = shiftOf(profile, d);
            const isToday = d === now;
            return (
              <div key={d} className="center" style={{
                borderRadius: 12, padding: '6px 0', fontSize: 12,
                background: s === 'N' ? 'var(--green)' : s === 'R' ? 'transparent' : 'var(--card)',
                color: s === 'N' ? '#F2EADF' : 'var(--ink)', outline: isToday ? '2px solid var(--teal)' : 'none',
              }}>
                <div>{+d.slice(8)}</div><b style={{ fontSize: 11 }}>{s === 'R' ? '休' : s}</b>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function WeightChart({ weights, now, goal }: { weights: Weight[]; now: string; goal: number }) {
  const span = 30;
  const dates = Array.from({ length: span }, (_, i) => addDays(now, i - span + 1));
  const pts = dates.map((d) => ({ d, w: weights.find((x) => x.date === d)?.jin ?? null, a: avg7(weights, d) }));
  const vals = [goal, ...pts.flatMap((p) => [p.w, p.a]).filter((x): x is number => x != null)];
  if (vals.length < 2) return <div className="small muted" style={{ padding: '28px 0' }} >打卡 3 天后这里会出现体重曲线。</div>;
  const lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  const W = 320, H = 150, L = 30, R = 8, T = 10, B = 22;
  const X = (i: number) => L + (i / (span - 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const avgPath = pts.map((p, i) => (p.a != null ? `${X(i)},${Y(p.a)}` : null)).filter(Boolean);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', margin: '10px 0 6px' }}>
      {[lo, (lo + hi) / 2, hi].map((v) => (
        <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeWidth="1" />
          <text x={L - 4} y={Y(v) + 4} fontSize="10" textAnchor="end" fill="var(--muted)">{Math.round(v)}</text></g>
      ))}
      <line x1={L} x2={W - R} y1={Y(goal)} y2={Y(goal)} stroke="var(--brown)" strokeDasharray="4 4" strokeWidth="1.2" />
      <text x={W - R} y={Y(goal) - 4} fontSize="10" textAnchor="end" fill="var(--brown)">目标 {goal}</text>
      {pts.map((p, i) => p.w != null && <circle key={p.d} cx={X(i)} cy={Y(p.w)} r="3" fill="var(--teal)" opacity=".35" />)}
      {avgPath.length > 1 && <polyline points={avgPath.join(' ')} fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
      <text x={L} y={H - 6} fontSize="10" fill="var(--muted)">{fmtMD(dates[0])}</text>
      <text x={W - R} y={H - 6} fontSize="10" textAnchor="end" fill="var(--muted)">今天</text>
    </svg>
  );
}

/* ---------------- Settings ---------------- */

function SettingsSheet({ profile, onClose, flash }: { profile: Profile; onClose: () => void; flash: (m: string) => void }) {
  const [p, setP] = useState<Profile>(profile);
  const curIdx = (((profile.anchorIndex + diffDays(profile.anchorDate, today())) % profile.shiftPattern.length) + profile.shiftPattern.length) % profile.shiftPattern.length;
  const [todayIdx, setTodayIdx] = useState(curIdx);
  const importRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP({ ...p, [k]: v });
  const pat = (p.shiftPattern.toUpperCase().replace(/[^APNR]/g, '') || 'APNRR');
  const labels = pat.split('').map((c, i) => {
    if (c !== 'R') return c === 'N' ? '夜' : c;
    const nth = pat.slice(0, i + 1).split('').filter((x) => x === 'R').length;
    return pat.split('R').length > 2 ? `休${nth}` : '休';
  });

  const save = async () => {
    await db.profile.put({ ...p, shiftPattern: pat, anchorDate: today(), anchorIndex: Math.min(todayIdx, pat.length - 1) });
    flash('已保存');
    onClose();
  };

  const doExport = async () => {
    const json = await exportAll();
    const name = `ease-backup-${today()}.json`;
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Ease 备份' }); } catch { return; }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = name; a.click();
    }
    await db.profile.update('me', { lastBackup: today() });
  };

  const [pending, setPending] = useState<File | null>(null);
  const doImport = async (f?: File | null) => {
    if (!f) return;
    setPending(null);
    try {
      await importAll(await f.text());
      flash('已恢复备份');
      onClose();
    } catch (e) {
      flash(e instanceof Error ? e.message : '导入失败');
    }
  };

  const n = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, parseFloat(e.target.value) as never);

  return (
    <>
      <h3>设置</h3>
      <div className="card">
        <div className="field"><span>年龄</span><input inputMode="numeric" defaultValue={p.age} onChange={n('age')} /></div>
        <div className="field"><span>身高（cm）</span><input inputMode="numeric" defaultValue={p.heightCm} onChange={n('heightCm')} /></div>
        <div className="field"><span>目标体重（斤）</span><input inputMode="decimal" defaultValue={p.goalJin} onChange={n('goalJin')} /></div>
        <div className="field"><span>目标日期</span><input type="date" className="wide" defaultValue={p.goalDate} onChange={(e) => set('goalDate', e.target.value)} /></div>
      </div>
      <div className="card">
        <h2>排班规律</h2>
        <div className="field"><span>轮转规律</span><input className="wide" defaultValue={p.shiftPattern} onChange={(e) => set('shiftPattern', e.target.value)} /></div>
        <div className="field"><span>今天是</span>
          <div className="row wrap" style={{ justifyContent: 'flex-end', gap: 6 }}>{labels.map((l, i) => (
            <button key={i} className={`btn ${todayIdx === i ? 'sel' : ''}`} style={{ padding: '8px 11px' }} onClick={() => setTodayIdx(i)}>{l}</button>
          ))}</div></div>
        <div className="small muted">A 08–15 · P 15–23 · N 夜班 23–次日 08 · R 休息。换科室时改这里一次即可。</div>
      </div>
      <div className="card">
        <h2>数据</h2>
        <div className="row">
          <button className="btn grow" onClick={doExport}>备份到「文件」</button>
          <button className="btn ghost grow" onClick={() => importRef.current?.click()}>从备份恢复</button>
          <input ref={importRef} type="file" accept="application/json" hidden onChange={(e) => setPending(e.target.files?.[0] ?? null)} />
        </div>
        {pending && (
          <div className="row mt">
            <span className="small grow">恢复会覆盖当前所有记录</span>
            <button className="btn ghost" onClick={() => setPending(null)}>取消</button>
            <button className="btn solid" onClick={() => doImport(pending)}>确认恢复</button>
          </div>
        )}
        <div className="small muted mt">上次备份：{profile.lastBackup ?? '还没有'}</div>
        <div className="field mt"><span className="small">识别服务地址</span>
          <input className="wide" placeholder="接入后自动填写" defaultValue={p.aiEndpoint ?? ''} onChange={(e) => set('aiEndpoint', e.target.value.trim() || undefined)} /></div>
      </div>
      <button className="big-btn" onClick={save}>保存</button>
    </>
  );
}

/* ---------------- Chrome ---------------- */

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: [Tab, string, React.ReactElement][] = [
    ['today', '今日', <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" strokeLinecap="round" /></svg>],
    ['food', '饮食', <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12h16a8 8 0 0 1-16 0Z" /><path d="M9 8c0-2 2-2 2-4M13 8c0-2 2-2 2-4" strokeLinecap="round" /></svg>],
    ['move', '运动', <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="14" cy="4.5" r="2" /><path d="M8 21l3-6 3 2v4M6 12l3-4h5l3 4M11 15l1-7" strokeLinecap="round" strokeLinejoin="round" /></svg>],
    ['trend', '趋势', <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 17l5-5 4 3 7-8" strokeLinecap="round" strokeLinejoin="round" /></svg>],
  ];
  return (
    <nav className="tabbar"><div className="tabbar-inner">
      {items.map(([k, label, icon]) => (
        <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{icon}{label}</button>
      ))}
    </div></nav>
  );
}

const Gear = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--brown)" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" strokeLinecap="round" /></svg>
);
const Camera = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 8h3l2-3h6l2 3h3v11H4z" strokeLinejoin="round" /><circle cx="12" cy="13" r="3.5" /></svg>
);
