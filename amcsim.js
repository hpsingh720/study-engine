// A practice run of the AMC MCQ exam, built like the real one: 150 questions, 3½ hours, 20 of them
// unscored trial items you are not told about, and adaptive — each answer moves an estimate of your
// ability, and the next question is chosen near it. The result is reported the way the AMC reports
// it, on a 0–500 scale with the pass at 250.
//
// The score is an estimate from your own question bank, not the AMC's: it tells you whether you are
// near the line and where the points are being lost, not the exact number you will get.

const AMCSim = {
  FORMS: {
    full: { n: 150, pilot: 20, mins: 210, label: 'Full exam', hint: '150 questions · 3 h 30 min' },
    half: { n: 75, pilot: 10, mins: 105, label: 'Half', hint: '75 questions · 1 h 45 min' },
    quick: { n: 30, pilot: 4, mins: 42, label: 'Quick', hint: '30 questions · 42 min' }
  },
  // The exam's clinical areas and roughly how much of it each takes.
  AREAS: [
    { k: 'adult', label: 'Adult health', share: 0.5, sys: ['CVS', 'RESP', 'GIT', 'RENAL', 'ENDO', 'NEURO', 'HAEM', 'ID', 'MSK', 'DERM', 'SURG', 'ORTHO', 'EMERG', 'EYEENT'] },
    { k: 'women', label: "Women's health", share: 0.15, sys: ['OBS', 'GYN'] },
    { k: 'child', label: 'Child health', share: 0.15, sys: ['PAEDS'] },
    { k: 'mental', label: 'Mental health', share: 0.1, sys: ['PSYCH'] },
    { k: 'pop', label: 'Population health & ethics', share: 0.1, sys: ['ETHICS'] }
  ],
  PASS_THETA: 0.4,     // ability at which a candidate answers ~60% of mid-difficulty items: the 250 line
  s: null,

  area(sys) { return (this.AREAS.find(a => a.sys.includes(sys)) || this.AREAS[0]).k; },
  load() { try { this.s = JSON.parse(localStorage.getItem('amcsim') || 'null'); } catch (e) { this.s = null; } return this.s; },
  save() { try { localStorage.setItem('amcsim', JSON.stringify(this.s)); } catch (e) {} },

  // How hard a question is, on the same scale as ability: its tag, adjusted by how people (you) did on it.
  async difficulty(pool) {
    const stats = {};
    for (const a of await DB.live('attempts')) { const x = stats[a.mcqId] ||= [0, 0]; x[0] += a.correct ? 1 : 0; x[1]++; }
    const out = {};
    for (const m of pool) {
      let b = { easy: -1, medium: 0, hard: 1 }[String(m.difficulty || 'medium').toLowerCase()] ?? 0;
      const st = stats[m.id];
      if (st && st[1] >= 2) b += Math.max(-1, Math.min(1, (0.6 - st[0] / st[1]) * 2));
      out[m.id] = b;
    }
    return out;
  },

  async pool() {
    const all = (await DB.live('mcqs')).filter(m => !m.flagged && !m.merged && !qBroken(m) && (m.options || []).length >= 4 && !isMulti(m));
    // AMC-style questions first; clinical MBBS ones make up the numbers if the AMC bank is still small.
    const amc = all.filter(m => m.type === 'AMC' || ['AMEDEX', 'PYQ'].includes(qBank(m)));
    return amc.length >= 150 ? amc : [...amc, ...all.filter(m => !amc.includes(m) && m.type !== 'IMG')];
  },

  async start(form) {
    const F = this.FORMS[form];
    const pool = await this.pool();
    if (pool.length < F.n) { toast(`Only ${pool.length} usable questions — ${F.n} are needed for this. Try a shorter form.`, 8000); return; }
    // Trial items sit anywhere after the first few, as in the real exam; nobody is told which.
    const slots = [...Array(F.n).keys()].slice(5);
    const pilot = shuffle(slots).slice(0, F.pilot);
    this.s = { id: 'amc-' + uid(), form, n: F.n, limit: F.mins * 60, used: 0, at: Date.now(), theta: 0, k: 0, i: 0, items: [], pilot, done: false };
    this.save();
    location.hash = '#/amc/run';
  },

  async next() {
    const s = this.s;
    const pool = await this.pool();
    const used = new Set(s.items.map(x => x.id));
    const b = await this.difficulty(pool);
    // The area furthest behind its share of the paper goes next.
    const count = {}; s.items.forEach(x => { count[x.area] = (count[x.area] || 0) + 1; });
    const total = s.items.length + 1;
    const avail = pool.filter(m => !used.has(m.id));
    const areas = this.AREAS.filter(a => avail.some(m => this.area(m.system) === a.k))
      .sort((x, y) => ((count[x.k] || 0) / total - x.share) - ((count[y.k] || 0) / total - y.share));
    const want = areas[0]?.k;
    const cands = avail.filter(m => this.area(m.system) === want);
    // Near the current estimate, with a little randomness so two runs are not identical.
    cands.sort((x, y) => Math.abs(b[x.id] - s.theta) - Math.abs(b[y.id] - s.theta));
    const pick = shuffle(cands.slice(0, 6))[0] || avail[0];
    if (!pick) return null;
    const item = { id: pick.id, b: b[pick.id] ?? 0, area: this.area(pick.system), system: pick.system, pilot: s.pilot.includes(s.items.length), c: null, ok: null, secs: 0, shown: Date.now() };
    s.items.push(item);
    this.save();
    return item;
  },

  answer(choice) {
    const s = this.s, it = s.items[s.items.length - 1];
    if (!it || it.c != null) return;
    it.c = choice;
    it.secs = Math.round((Date.now() - it.shown) / 1000);
    return it;
  },

  async mark(it, m) {
    it.ok = isRight(m, it.c) ? 1 : 0;
    // Trial items do not move the estimate, exactly as they do not count in the real exam.
    if (!it.pilot) {
      const s = this.s;
      const p = 1 / (1 + Math.exp(-(s.theta - it.b)));
      s.k++;
      s.theta = Math.max(-4, Math.min(4, s.theta + Math.max(0.25, 2.2 / (s.k + 1)) * (it.ok - p)));
    }
    await DB.put('attempts', { id: uid(), mcqId: m.id, topicId: m.topicId, system: m.system, type: m.type, choice: it.c, correct: it.ok, ts: Date.now(), session: this.s.id });
    this.save();
  },

  scaled(theta) { return Math.max(0, Math.min(500, Math.round(250 + 100 * (theta - this.PASS_THETA)))); },

  async finish() {
    const s = this.s; if (!s || s.done) return;
    s.done = true;
    const scored = s.items.filter(x => !x.pilot && x.c != null);
    const byArea = {}, bySystem = {};
    for (const x of scored) {
      const a = byArea[x.area] ||= [0, 0]; a[1]++; if (x.ok) a[0]++;
      const y = bySystem[x.system || '—'] ||= [0, 0]; y[1]++; if (x.ok) y[0]++;
    }
    s.score = this.scaled(s.theta);
    const test = {
      id: s.id, kind: 'amcsim', title: `AMC simulation · ${this.FORMS[s.form].label}`, mode: 'exam', date: Date.now(),
      total: s.n, answered: s.items.filter(x => x.c != null).length, correct: scored.filter(x => x.ok).length,
      scoredTotal: scored.length, duration: s.used, score: s.score, theta: s.theta, byArea, bySystem,
      qs: s.items.map(x => x.id), ans: Object.fromEntries(s.items.map(x => [x.id, x.c])), pilot: s.items.filter(x => x.pilot).map(x => x.id)
    };
    await DB.put('tests', test);
    s.testId = test.id;
    this.save();
  },

  tick() {
    const s = this.s; if (!s || s.done) return;
    const now = Date.now();
    s.used += Math.min(5, (now - (s.at || now)) / 1000);
    s.at = now;
    const left = Math.max(0, s.limit - s.used);
    const el = document.getElementById('amc-clock');
    if (el) {
      el.textContent = `${Math.floor(left / 3600)}:${String(Math.floor(left % 3600 / 60)).padStart(2, '0')}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
      el.classList.toggle('warn-t', left < 600);
    }
    if (Math.round(s.used) % 10 === 0) this.save();
    if (left <= 0) { this.finish().then(() => { location.hash = '#/amc/result'; }); }
  }
};
window.AMCSim = AMCSim;

Views.amc = async (sub) => {
  const s = AMCSim.load();
  if (sub === 'run' && s && !s.done) {
    let it = s.items[s.items.length - 1];
    if (!it || it.ok != null) it = await AMCSim.next();
    if (!it) { await AMCSim.finish(); location.hash = '#/amc/result'; return ''; }
    const m = await DB.get('mcqs', it.id);
    const img = m.img ? (await DB.get('media', m.img))?.data : '';
    s.at = Date.now(); AMCSim.save();
    clearInterval(AMCSim._t); AMCSim._t = setInterval(() => AMCSim.tick(), 1000);
    return `<div class="page amc-run">
      <div class="amc-bar"><span>Question ${s.items.length} of ${s.n}</span><span id="amc-clock" class="mono">—</span>
        <button class="btn ghost sm" data-act="amcEnd">End exam</button></div>
      ${bar(pct(s.items.length - 1, s.n))}
      <section class="card mt q-card">
        <div class="q-stem read">${md(m.stem)}</div>
        ${img ? `<img class="q-img" src="${img}" alt="" data-act="zoomImg">` : ''}
        <div class="opts">${m.options.map((o, k) => `<button class="opt" data-act="amcPick" data-k="${k}"><span class="opt-l">${'ABCDE'[k]}</span><span>${md(cleanOpt(o, m.options))}</span></button>`).join('')}</div>
        <button class="btn primary full mt" data-act="amcNext" id="amc-next" disabled>Next</button>
      </section>
      <p class="muted small center mt">Answers are final once you move on.</p></div>`;
  }
  if (sub === 'result' && s?.done) {
    const t = await DB.get('tests', s.testId);
    const pass = t.score >= 250;
    const rows = AMCSim.AREAS.map(a => { const x = t.byArea[a.k]; return x ? `<div class="srow"><span class="srow-n">${a.label}</span><div class="stack"><i class="s-ok" style="width:${pct(x[0], x[1])}%"></i></div><span class="small muted">${pct(x[0], x[1])}% · ${x[0]}/${x[1]}</span></div>` : ''; }).join('');
    const avg = Math.round((t.duration || 0) / Math.max(1, t.answered));
    const wrong = s.items.filter(x => !x.ok && x.c != null);
    return `<div class="page"><header class="page-head"><div><p class="eyebrow"><a class="link" href="#/practice">Practice</a></p><h1>AMC simulation</h1></div></header>
      <section class="card amc-score ${pass ? 'ok' : 'bad'}">
        <p class="eyebrow">Estimated score</p><div class="big-num">${t.score}<span class="muted"> / 500</span></div>
        <p>${pass ? 'Above' : 'Below'} the pass mark of 250 · ${t.correct} of ${t.scoredTotal} scored questions right · ${avg} s per question (exam pace is 84 s)</p>
        <p class="muted small">An estimate from your own question bank, not the AMC's scoring. Use it to see where you stand and where marks are lost.</p>
      </section>
      <section class="card mt"><div class="card-head"><h3>By area</h3></div><div class="srows">${rows}</div></section>
      <section class="card mt"><div class="card-head"><h3>Review</h3><span class="muted small">${wrong.length} wrong</span></div>
        <div class="row gap wrap"><button class="btn primary" data-act="amcReview" ${wrong.length ? '' : 'disabled'}>Go through the wrong ones</button><a class="btn" href="#/amc">New exam</a></div></section></div>`;
  }
  const pool = await AMCSim.pool();
  const past = (await DB.all('tests')).filter(t => t.kind === 'amcsim').sort((a, b) => b.date - a.date).slice(0, 6);
  return `<div class="page"><header class="page-head"><div><p class="eyebrow"><a class="link" href="#/practice">Practice</a></p><h1>AMC exam simulator</h1></div></header>
    ${s && !s.done ? `<section class="card due"><div class="row between mid"><div><b>Exam in progress</b><br><span class="muted small">Question ${s.items.length} of ${s.n}</span></div><a class="btn primary" href="#/amc/run">Continue</a></div></section>` : ''}
    <section class="card mt"><p class="muted">Built like the real exam: adaptive, timed, with unscored trial questions you are not told about. Scored on the AMC's 0–500 scale; 250 passes.</p>
      <div class="menu mt">${Object.entries(AMCSim.FORMS).map(([k, f]) => `<button class="btn full" data-act="amcStart" data-form="${k}" ${pool.length < f.n ? 'disabled' : ''}><span><b>${f.label}</b><br><small class="muted">${f.hint}${pool.length < f.n ? ` · needs ${f.n} questions` : ''}</small></span></button>`).join('')}</div>
      <p class="muted small mt">${pool.length} questions available.</p></section>
    ${past.length ? `<section class="card mt"><div class="card-head"><h3>Past attempts</h3></div><div class="list">${past.map(t => `<div class="row between pad"><span>${fmtDate(t.date)} · ${esc(t.title.split('· ')[1] || '')}</span><b class="${t.score >= 250 ? 'ok-t' : 'warn-t'}">${t.score}</b></div>`).join('')}</div></section>` : ''}
  </div>`;
};

Object.assign(A, {
  amcStart(el) {
    const s = AMCSim.load();
    if (s && !s.done && !confirm('An exam is in progress. Start a new one and abandon it?')) return;
    AMCSim.start(el.dataset.form);
  },
  amcPick(el) {
    $$('.amc-run .opt').forEach(b => b.classList.toggle('sel', b === el));
    const n = $('#amc-next'); if (n) n.disabled = false;
    AMCSim._choice = +el.dataset.k;
  },
  async amcNext(el) {
    if (el.dataset.busy || AMCSim._choice == null) return;
    el.dataset.busy = '1'; el.disabled = true;
    const it = AMCSim.answer(AMCSim._choice);
    AMCSim._choice = null;
    if (it) await AMCSim.mark(it, await DB.get('mcqs', it.id));
    if (AMCSim.s.items.length >= AMCSim.s.n) { await AMCSim.finish(); location.hash = '#/amc/result'; return; }
    App.render();
  },
  async amcEnd() {
    if (!confirm('End the exam now? Unanswered questions count as not attempted.')) return;
    clearInterval(AMCSim._t);
    await AMCSim.finish();
    location.hash = '#/amc/result';
  },
  async amcReview() {
    const s = AMCSim.load();
    const ids = s.items.filter(x => !x.ok && x.c != null).map(x => x.id);
    Practice.start({ ids, title: 'AMC simulation — the ones you got wrong', mode: 'tutor', chosen: true, kind: 'review' });
  }
});

ROUTES.push([/^#\/amc(?:\/(\w+))?$/, m => Views.amc(m[1])]);
// The clock only runs on the exam page.
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/amc/run')) clearInterval(AMCSim._t); });
