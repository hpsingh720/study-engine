// Study planner: spreads each system's remaining topics over the days until its deadline,
// keeping biweekly test days and a final revision day free of new topics.
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return todayStr(d); }

async function biweeklyDates(until) {
  const tests = (await DB.live('tests')).filter(t => t.kind === 'biweekly').sort((a, b) => b.date - a.date);
  const firstDone = (await DB.live('topics')).filter(t => t.doneAt).map(t => t.doneAt).sort((a, b) => a - b)[0];
  let d = tests[0] ? addDays(todayStr(new Date(tests[0].date)), 14) : firstDone ? addDays(todayStr(new Date(firstDone)), 14) : addDays(todayStr(), 14);
  if (d < todayStr()) d = todayStr();
  const out = new Set();
  while (d <= until) { out.add(d); d = addDays(d, 14); }
  return out;
}

// Returns { days:[{date, kind:'study'|'biweekly'|'revision'|'off', topics:[...]}], left, studyDays, pace, status }
async function buildPlan(code, prefs, topics) {
  const target = prefs.targets?.[code];
  if (!target) return null;
  const today = todayStr();
  const start = (prefs.starts?.[code] && prefs.starts[code] > today) ? prefs.starts[code] : today;
  const perWeek = +prefs.studyDays || 6;
  const off = new Set(perWeek <= 5 ? [0, 6] : perWeek === 6 ? [0] : []); // Sunday (and Saturday) off
  const ts = topics.filter(t => t.system === code).sort((a, b) => a.order - b.order);
  const doneToday = ts.filter(t => t.done && t.doneAt && todayStr(new Date(t.doneAt)) === today);
  const todo = [...doneToday, ...ts.filter(t => !t.done)];
  const bw = await biweeklyDates(target);
  const days = [];
  for (let d = start; d <= target; d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00').getDay();
    let kind = 'study';
    if (d === target && d !== start) kind = 'revision';
    else if (bw.has(d)) kind = 'biweekly';
    else if (off.has(wd)) kind = 'off';
    days.push({ date: d, kind, topics: [] });
  }
  const study = days.filter(x => x.kind === 'study');
  if (!study.length && days.length) { days[0].kind = 'study'; study.push(days[0]); }
  const n = todo.length, k = study.length;
  if (k) for (let i = 0; i < k; i++) study[i].topics = todo.slice(Math.ceil(i * n / k), Math.ceil((i + 1) * n / k)); // front-loaded: spare days fall just before the deadline
  const overdue = target < today && ts.some(t => !t.done);
  return { days, left: ts.filter(t => !t.done).length, total: ts.length, studyDays: k, pace: k ? n / k : n, target, start, overdue };
}

async function plansForToday() {
  const [prefs, topics] = await Promise.all([Prefs.get(), DB.live('topics')]);
  const out = [];
  for (const s of SEED.systems) {
    const plan = await buildPlan(s.code, prefs, topics);
    if (!plan) continue;
    const today = plan.days.find(d => d.date === todayStr());
    out.push({ code: s.code, plan, today });
  }
  return out;
}
