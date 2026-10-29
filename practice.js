// MCQ sessions: topic tests (tutor mode), biweekly exams (timed), mistakes, custom.
const AMC_SECONDS_PER_Q = 84; // AMC Part 1: 150 questions in 3.5 hours
const MODES = {
  tutor: { mode: 'tutor', timed: false, label: 'Tutor — no timer', hint: 'Explanation after every question. Best right after reading a topic.' },
  timed: { mode: 'tutor', timed: true, label: 'Tutor + AMC timer', hint: '84 seconds per question on the clock, explanation after each.' },
  exam: { mode: 'exam', timed: true, label: 'Exam — timed', hint: 'AMC pace, no answers until the end. Like the real thing.' }
};

const Practice = {
  s: null,
  load() { try { this.s = JSON.parse(localStorage.getItem('session') || 'null'); } catch (e) { this.s = null; } },
  save() { try { localStorage.setItem('session', JSON.stringify(this.s)); } catch (e) {} },
  clear() { this.s = null; localStorage.removeItem('session'); },

  async lastByQ() {
    const last = {};
    (await DB.live('attempts')).sort((a, b) => a.ts - b.ts).forEach(a => { last[a.mcqId] = a; });
    return last;
  },

  async pool({ topicIds, systems, type = 'ALL', source = 'all', count = 20, weightMistakes = false, bank = 'all', onlyRead = false }) {
    let all = (await DB.live('mcqs')).filter(m => !m.flagged && !m.merged && !qBroken(m));
    if (bank === 'real') all = all.filter(m => ['AMEDEX', 'PYQ'].includes(qBank(m)));
    else if (bank !== 'all') all = all.filter(m => qBank(m) === bank);
    // Half a chapter read should mean questions on that half. Without this a system test asks
    // about everything in the subject, most of which has not been opened yet.
    if (onlyRead) {
      const read = new Set((await DB.live('topics')).filter(t => t.done).map(t => t.id));
      all = all.filter(m => read.has(m.topicId));
    }
    if (topicIds) { const set = new Set(topicIds); all = all.filter(m => set.has(m.topicId)); }
    if (systems?.length) all = all.filter(m => systems.includes(m.system));
    if (type !== 'ALL') all = all.filter(m => m.type === type);
    const last = await this.lastByQ();
    if (source === 'unseen') all = all.filter(m => !last[m.id]);
    if (source === 'mistakes') all = all.filter(m => last[m.id] && !last[m.id].correct);
    if (source === 'due') { const due = await dueSet(); all = all.filter(m => due.has(m.id)); }
    shuffle(all);
    if (weightMistakes) {
      const rank = m => !last[m.id] ? 1 : (last[m.id].correct ? 2 : 0);
      all.sort((a, b) => rank(a) - rank(b));
    }
    all = shuffle(all.slice(0, count));
    // Mix image questions in at intervals (≈ 1 in 5).
    const txt = all.filter(m => m.type !== 'IMG'), img = all.filter(m => m.type === 'IMG');
    const out = [];
    txt.forEach((m, i) => { out.push(m); if ((i + 1) % 4 === 0 && img.length) out.push(img.shift()); });
    return [...out, ...img].map(m => m.id);
  },

  // Ask how to take the test (unless it's the biweekly exam, a form that already chose, or a saved preference).
  async start(opts) {
    if (opts.kind === 'biweekly' || opts.chosen) return this._start(opts);
    const pref = localStorage.getItem('modePref') || 'ask';
    if (pref !== 'ask') return this._start({ ...opts, ...MODES[pref] });
    this._pending = opts;
    openModal(`<h3>How do you want to do this?</h3><div class="menu">
      ${Object.entries(MODES).map(([k, m]) => `<button class="btn full ${k === 'tutor' ? '' : ''}" data-act="pickMode" data-m="${k}"><span><b>${m.label}</b><br><small class="muted">${m.hint}</small></span></button>`).join('')}
      <label class="inline small mt"><input type="checkbox" id="mode-remember"> Remember my choice (change it in Settings)</label></div>`);
    return true;
  },

  async _start(opts) {
    const qs = opts.ids?.length ? opts.ids : await this.pool(opts);
    if (!qs.length) { toast('No questions here yet. Generate MCQs or upload a question bank first.'); return false; }
    this.s = {
      id: uid(), kind: opts.kind || 'custom', title: opts.title || 'Practice', mode: opts.mode || 'tutor',
      topicId: opts.topicId || null, qs, idx: 0, ans: {}, sel: null, start: Date.now(),
      limit: (opts.mode === 'exam' || opts.timed) ? qs.length * AMC_SECONDS_PER_Q : 0, finished: false
    };
    this.save();
    if (location.hash === '#/session') App.render(); else location.hash = '#/session';
    return true;
  },

  async record(m, choice) {
    const a = { id: uid(), mcqId: m.id, topicId: m.topicId, system: m.system, type: m.type, choice, correct: isRight(m, choice) ? 1 : 0, ts: Date.now(), session: this.s.id };
    await DB.put('attempts', a);
  },

  async answer(m, choice) {
    const s = this.s;
    s.ans[m.id] = { c: choice, ok: isRight(m, choice) ? 1 : 0 };
    if (s.mode === 'tutor') { s.ans[m.id].rec = 1; await this.record(m, choice); }
    this.save();
  },

  async finish() {
    const s = this.s; if (!s || s.finished) return;
    const mcqs = {};
    for (const id of s.qs) { const m = await DB.get('mcqs', id); if (m) mcqs[id] = m; }
    const byType = {}, bySystem = {}; let correct = 0, answered = 0;
    for (const id of s.qs) {
      const m = mcqs[id]; if (!m) continue;
      const a = s.ans[id];
      if (a) { answered++; if (a.ok) correct++; if (!a.rec) { await this.record(m, a.c); a.rec = 1; } }
      const t = byType[m.type] ||= [0, 0]; t[1]++; if (a?.ok) t[0]++;
      const y = bySystem[m.system || '—'] ||= [0, 0]; y[1]++; if (a?.ok) y[0]++;
    }
    const test = {
      id: s.id, kind: s.kind, title: s.title, mode: s.mode, date: Date.now(), topicId: s.topicId,
      total: s.qs.length, answered, correct, duration: Math.round((Date.now() - s.start) / 1000),
      byType, bySystem, qs: s.qs, ans: Object.fromEntries(Object.entries(s.ans).map(([k, v]) => [k, v.c]))
    };
    await DB.put('tests', test);
    s.finished = true; s.testId = test.id; this.save();
  }
};

// Biweekly test: everything finished since the last biweekly (at least the last 14 days), mistakes weighted.
async function startBiweekly() {
  const prefs = await Prefs.get();
  const tests = (await DB.live('tests')).filter(t => t.kind === 'biweekly').sort((a, b) => b.date - a.date);
  const since = Math.min(tests[0]?.date || 0, Date.now() - 14 * 86400000) || Date.now() - 14 * 86400000;
  const topics = await DB.live('topics');
  let ids = topics.filter(t => t.done && (t.doneAt || 0) >= since).map(t => t.id);
  if (!ids.length) ids = topics.filter(t => t.done).map(t => t.id);
  if (!ids.length) { toast('Finish a topic first — the biweekly test covers what you have completed.'); return; }
  await Practice.start({ kind: 'biweekly', title: `Biweekly test · ${ids.length} topics`, mode: 'exam', topicIds: ids, count: prefs.biweeklyCount || 40, weightMistakes: true });
}

async function biweeklyStatus() {
  const tests = (await DB.live('tests')).filter(t => t.kind === 'biweekly').sort((a, b) => b.date - a.date);
  const last = tests[0]?.date || 0;
  const doneTopics = (await DB.live('topics')).filter(t => t.done);
  const since = last || 0;
  const newSince = doneTopics.filter(t => (t.doneAt || 0) > since).length;
  const nextIn = last ? Math.ceil((last + 14 * 86400000 - Date.now()) / 86400000) : 0;
  return { last, nextIn, due: doneTopics.length > 0 && nextIn <= 0, newSince, anyDone: doneTopics.length };
}

// Spaced repetition: right answers come back after 1, 3, 7, 16, 35, 90 days; wrong ones the next day.
const SR_DAYS = [1, 3, 7, 16, 35, 90];
async function dueSet() {
  const by = {};
  (await DB.live('attempts')).forEach(a => { (by[a.mcqId] ||= []).push(a); });
  const now = Date.now(), due = new Set();
  for (const [id, arr] of Object.entries(by)) {
    arr.sort((a, b) => a.ts - b.ts);
    const last = arr[arr.length - 1];
    let streak = 0; for (let i = arr.length - 1; i >= 0 && arr[i].correct; i--) streak++;
    const days = streak ? SR_DAYS[Math.min(streak, SR_DAYS.length) - 1] : 1;
    if (now - last.ts >= days * 86400000 - 3 * 3600000) due.add(id);
  }
  const live = new Set((await DB.live('mcqs')).filter(m => !m.flagged && !m.merged).map(m => m.id));
  return new Set([...due].filter(id => live.has(id)));
}
async function startDue() {
  await Practice.start({ kind: 'revision', title: 'Due for revision', mode: 'tutor', source: 'due', count: 60 });
}
