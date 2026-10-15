// Router, event wiring and start-up.
const ROUTES = [
  [/^#?\/?$/, () => Views.today()],
  [/^#\/systems$/, () => Views.systems()],
  [/^#\/system\/(\w+)$/, m => Views.system(m[1])],
  [/^#\/topic\/([\w-]+)(?:\/(\w+))?$/, m => Views.topic(m[1], m[2])],
  [/^#\/session$/, () => Views.session()],
  [/^#\/practice$/, () => Views.practice()],
  [/^#\/result\/([\w-]+)$/, m => Views.result(m[1])],
  [/^#\/library$/, () => Views.library()],
  [/^#\/progress$/, () => Views.progress()],
  [/^#\/settings$/, () => Views.settings()]
];

const App = {
  staged: [], pad: null, timer: null, _rendering: false,
  async render(keepScroll = false) {
    const y = window.scrollY;
    const h = location.hash || '#/';
    clearInterval(this.timer);
    for (const [re, fn] of ROUTES) {
      const m = h.match(re);
      if (!m) continue;
      try { $('#main').innerHTML = await fn(m); }
      catch (e) { console.error(e); $('#main').innerHTML = empty('Something went wrong', esc(e.message), '<a class="btn" href="#/">Home</a>'); }
      const base = '#/' + (h.split('/')[1] || '');
      $$('.navlink').forEach(a => a.classList.toggle('on', a.getAttribute('href') === base || (base === '#/system' && a.getAttribute('href') === '#/systems') || (base === '#/topic' && a.getAttribute('href') === '#/systems') || ((base === '#/session' || base === '#/result') && a.getAttribute('href') === '#/practice')));
      this.after();
      window.scrollTo(0, keepScroll ? y : 0);
      return;
    }
    location.hash = '#/';
  },
  softRefresh() {
    clearTimeout(this._sr);
    this._sr = setTimeout(() => {
      const h = location.hash;
      const typing = document.activeElement && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName);
      if (h === '#/session' || typing || Views._edit || $('#modal').classList.contains('open')) return;
      if (h.includes('/notes')) return;
      this.render(true);
    }, 600);
  },
  after() {
    const c = $('#pad');
    if (c) { this.pad = new Pad(c); }
    const s = Practice.s;
    if (location.hash === '#/session' && s && !s.finished && s.limit) {
      const tick = () => {
        const left = s.limit - (Date.now() - s.start) / 1000;
        const el = $('#timer'); if (el) { el.textContent = fmtDur(left); el.classList.toggle('low', left < 300); }
        if (left <= 0) { clearInterval(this.timer); Practice.finish().then(() => this.render()); }
      };
      tick(); this.timer = setInterval(tick, 1000);
    }
    const drop = $('#drop');
    if (drop) {
      ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => stageFiles([...e.dataTransfer.files]));
    }
  }
};

function stageFiles(files) {
  const pdfs = files.filter(f => /pdf$/i.test(f.type || f.name));
  const imgs = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
  pdfs.forEach(f => App.staged.push({ files: [f], name: f.name.replace(/\.pdf$/i, ''), role: guessRole(f.name) }));
  if (imgs.length) {
    imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    App.staged.push({ files: imgs, name: imgs.length > 1 ? `Question bank photos (${imgs.length})` : imgs[0].name, role: 'mcq-amc' });
  }
  App.render(true);
}

// ---------- Actions ----------
const A = {
  closeModal,
  async quickPractice() { await Practice.start({ kind: 'custom', title: 'Mixed practice', mode: 'tutor', count: 20, weightMistakes: true }); },
  async startMistakes() { await Practice.start({ kind: 'mistakes', title: 'Mistake bank', mode: 'tutor', source: 'mistakes', count: 40 }); },
  startBiweekly,
  startDue,
  async mergeTopic(el) { const n = await queueMerge([el.dataset.id], 0); toast(n ? 'Combining questions — a minute or two.' : 'Not enough questions to combine yet.'); App.render(true); },
  async mergeEverything() {
    const ids = (await DB.live('topics')).map(t => t.id);
    const n = await queueMerge(ids, 7);
    toast(n ? `Queued ${n} combine jobs. Watch progress here.` : 'Nothing to combine yet — import or generate questions first.'); App.render(true);
  },
  async unmergeTopic(el) {
    if (!confirm('Bring back all original questions for this topic and remove the combined ones?')) return;
    for (const m of await DB.byIndex('mcqs', 'topicId', el.dataset.id)) {
      if (m.src === 'merged' && !m.deleted) { m.deleted = 1; await DB.put('mcqs', m); }
      else if (m.merged) { delete m.merged; delete m.mergeKind; await DB.put('mcqs', m); }
    }
    toast('Originals restored'); App.render(true);
  },
  async practiseSystem(el) { await Practice.start({ kind: 'system', title: sysName(el.dataset.sys), mode: 'tutor', systems: [el.dataset.sys], count: 25, weightMistakes: true }); },
  async genSystem(el) {
    const ids = (await DB.live('topics')).filter(t => t.system === el.dataset.sys).sort((a, b) => a.order - b.order).map(t => t.id);
    const n = await queueTopics(ids, { prio: 3 });
    toast(n ? `Queued ${n} jobs — see Library for progress.` : 'Already queued.'); App.render(true);
  },
  topicFilter(el) { sessionStorage.setItem('tfilter', el.dataset.f); App.render(true); },
  async addTopic(el) {
    openModal(`<form data-submit="addTopicSave" data-sys="${el.dataset.sys}"><h3>New topic in ${sysName(el.dataset.sys)}</h3>
      <label>Name<input name="name" required placeholder="e.g. Infective endocarditis prophylaxis"></label>
      <label>Search words (optional, comma separated)<input name="kw" placeholder="words the books use for it"></label>
      <div class="row gap mt end"><button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary">Add</button></div></form>`);
    setTimeout(() => $('#modal input')?.focus(), 50);
  },
  async doneTopic(el) {
    const t = await DB.get('topics', el.dataset.id);
    t.done = 1; t.doneAt = Date.now(); await DB.put('topics', t);
    const has = (await DB.byIndex('mcqs', 'topicId', t.id)).some(m => !m.deleted && !m.flagged);
    sessionStorage.setItem('leftTab', 'compare'); sessionStorage.setItem('pane', 'q');
    if (has) await Practice.start({ kind: 'topic', title: t.name, mode: 'tutor', topicId: t.id, topicIds: [t.id], count: 60 });
    else { toast('Marked done. No questions for this topic yet.'); App.render(true); }
  },
  async testTopic(el) {
    const t = await DB.get('topics', el.dataset.id);
    sessionStorage.setItem('leftTab', 'compare'); sessionStorage.setItem('pane', 'q');
    await Practice.start({ kind: 'topic', title: t.name, mode: 'tutor', topicId: t.id, topicIds: [t.id], count: 60, weightMistakes: true });
  },
  async undoneTopic(el) { const t = await DB.get('topics', el.dataset.id); t.done = 0; t.doneAt = null; await DB.put('topics', t); App.render(true); },
  async topicMenu(el) {
    const t = await DB.get('topics', el.dataset.id); const books = await hasBooks(); const sheet = await DB.get('sheets', t.id);
    openModal(`<h3>${esc(t.name)}</h3><div class="menu">
      ${books ? `<button class="btn full" data-act="genTopic" data-id="${t.id}" data-force="1">${sheet ? 'Rewrite sheet from books' : 'Generate sheet & MCQs'}</button>` : ''}
      ${sheet ? `<button class="btn full" data-act="printTopic" data-id="${t.id}">Print / save sheet as PDF</button>` : ''}
      <button class="btn full" data-act="renameTopic" data-id="${t.id}">Rename / edit search words</button>
      <button class="btn full ghost danger" data-act="deleteTopic" data-id="${t.id}">Delete topic</button>
      <button class="btn full" data-act="closeModal">Close</button></div>`);
  },
  async genTopic(el) {
    closeModal();
    const n = await queueTopics([el.dataset.id], { prio: 0, force: !!el.dataset.force });
    toast(n ? 'Writing now — this takes about a minute.' : 'Already in the queue.'); App.render(true);
  },
  async renameTopic(el) {
    const t = await DB.get('topics', el.dataset.id);
    openModal(`<form data-submit="renameSave" data-id="${t.id}"><h3>Edit topic</h3><label>Name<input name="name" value="${esc(t.name)}"></label>
      <label>Search words (comma separated)<textarea name="kw" rows="3">${esc((t.kw || []).join(', '))}</textarea></label>
      <p class="muted small">These words are how the app finds the right pages in your books. Rewrite the sheet afterwards to use them.</p>
      <div class="row gap mt end"><button type="button" class="btn" data-act="closeModal">Cancel</button><button class="btn primary">Save</button></div></form>`);
  },
  async deleteTopic(el) {
    if (!confirm('Delete this topic and its sheet? Questions stay in your bank.')) return;
    const t = await DB.get('topics', el.dataset.id); t.deleted = 1; await DB.put('topics', t);
    closeModal(); location.hash = '#/system/' + t.system;
  },
  async printTopic(el) {
    closeModal();
    const t = await DB.get('topics', el.dataset.id); const sheet = await DB.get('sheets', t.id);
    $('#print').innerHTML = `<h1>${esc(t.name)}</h1><p class="muted">${sysName(t.system)} · printed ${fmtDate(Date.now())}</p>
      ${Object.entries(SECTIONS).map(([k, l]) => `<h2>${l}</h2><div class="cols3">${['ref', 'mbbs', 'amc'].map(c => `<section class="col col-${c}"><header><b>${COLS[c].label}</b> <small>${esc(colBooks(sheet, c))}</small></header><div class="read">${md(sheet.sections?.[k]?.[c])}</div></section>`).join('')}</div>`).join('')}
      <h2>What changes for AMC</h2>${comparisonHTML(sheet)}`;
    document.body.classList.add('printing'); window.print();
    setTimeout(() => document.body.classList.remove('printing'), 500);
  },
  editSheet(el) { Views._edit = el.dataset.id + el.dataset.sec; App.render(true); },
  cancelEdit() { Views._edit = null; App.render(true); },
  async saveEdit(el) {
    const sheet = await DB.get('sheets', el.dataset.id);
    $$('textarea.edit').forEach(ta => { (sheet.sections[el.dataset.sec] ||= {})[ta.dataset.col] = ta.value; });
    sheet.edited = Date.now(); await DB.put('sheets', sheet);
    Views._edit = null; toast('Saved'); App.render(true);
  },
  async practiseTopic(el) {
    const t = await DB.get('topics', el.dataset.id);
    sessionStorage.setItem('leftTab', 'compare');
    await Practice.start({ kind: 'topic', title: t.name, mode: 'tutor', topicId: t.id, topicIds: [t.id], type: el.dataset.type, count: 60, weightMistakes: true });
  },
  async moreMcqs(el) { await Queue.add('mcqgen', { topicId: el.dataset.id }, 0); toast('Writing more questions…'); App.render(true); },
  async unflagAll(el) { for (const m of await DB.byIndex('mcqs', 'topicId', el.dataset.id)) if (m.flagged) { m.flagged = 0; await DB.put('mcqs', m); } App.render(true); },

  // Notes
  penColor(el) { if (App.pad) { App.pad.color = el.dataset.c; App.pad.eraser = false; } $$('.swatch').forEach(s => s.classList.toggle('on', s === el)); $('[data-act=penEraser]')?.classList.remove('on'); },
  penEraser(el) { if (App.pad) { App.pad.eraser = !App.pad.eraser; el.classList.toggle('on', App.pad.eraser); } },
  penUndo() { App.pad?.undo(); },
  penClear() { App.pad?.clear(); },
  async saveSketch(el) {
    if (!App.pad || App.pad.isEmpty()) return toast('Nothing written yet.');
    const id = 'note-' + uid();
    await DB.put('media', { id, data: await App.pad.toImage(), kind: 'sketch' });
    const n = await getNote(el.dataset.id); (n.items ||= []).push({ type: 'sketch', mediaId: id, ts: Date.now() }); await DB.put('notes', n);
    App.pad.clear(); toast('Page saved'); App.render(true);
  },
  async delNoteItem(el) {
    if (!confirm('Delete this page/photo?')) return;
    const n = await getNote(el.dataset.id); n.items.splice(+el.dataset.i, 1); await DB.put('notes', n); App.render(true);
  },
  zoomImg(el) { openModal(`<img src="${el.src}" class="zoom" alt=""><div class="row end mt"><button class="btn" data-act="closeModal">Close</button></div>`); },

  // Session
  async pick(el) {
    const s = Practice.s; const i = +el.dataset.i;
    if (s.mode === 'exam') { const m = await DB.get('mcqs', s.qs[s.idx]); s.ans[m.id] = { c: i, ok: i === m.ans ? 1 : 0 }; }
    else s.sel = i;
    Practice.save(); App.render(true);
  },
  async checkQ() {
    const s = Practice.s; if (s.sel == null) return;
    const m = await DB.get('mcqs', s.qs[s.idx]); await Practice.answer(m, s.sel); s.sel = null; Practice.save(); App.render(true);
  },
  nextQ() { const s = Practice.s; s.idx = Math.min(s.qs.length - 1, s.idx + 1); s.sel = null; Practice.save(); App.render(); },
  prevQ() { const s = Practice.s; s.idx = Math.max(0, s.idx - 1); s.sel = null; Practice.save(); App.render(); },
  gotoQ(el) { const s = Practice.s; s.idx = +el.dataset.i; s.sel = null; sessionStorage.setItem('pane', 'q'); Practice.save(); App.render(); },
  leftTab(el) { sessionStorage.setItem('leftTab', el.dataset.k); App.render(true); },
  pane(el) { sessionStorage.setItem('pane', el.dataset.p); App.render(true); },
  async endSession() {
    const s = Practice.s;
    const left = s.qs.length - Object.keys(s.ans).length;
    if (left && !confirm(`${left} question${left === 1 ? '' : 's'} not answered. Finish anyway?`)) return;
    await Practice.finish(); App.render();
  },
  async askQ() {
    const s = Practice.s; const m = await DB.get('mcqs', s.qs[s.idx]);
    openModal(`<form data-submit="askQSend"><h3>Ask about this question</h3><textarea name="q" rows="3">Why is ${String.fromCharCode(65 + m.ans)} correct and not ${String.fromCharCode(65 + (s.ans[m.id]?.c ?? 0))}?</textarea>
      <div id="askq-out" class="read mt"></div><div class="row gap mt end"><button type="button" class="btn" data-act="closeModal">Close</button><button class="btn primary">Ask</button></div></form>`);
  },
  async flagQ() {
    const s = Practice.s; const m = await DB.get('mcqs', s.qs[s.idx]); m.flagged = 1; await DB.put('mcqs', m);
    toast('Flagged — it won’t appear in practice again.');
  },
  closeResults() { Practice.clear(); history.length > 1 ? history.back() : (location.hash = '#/'); },
  async retryWrong(el) {
    const t = await DB.get('tests', el.dataset.test);
    const ids = []; for (const id of t.qs) { const m = await DB.get('mcqs', id); if (m && t.ans[id] != null && t.ans[id] !== m.ans) ids.push(id); }
    Practice.s = { id: uid(), kind: 'retry', title: 'Retry: ' + t.title, mode: 'tutor', topicId: t.topicId, qs: shuffle(ids), idx: 0, ans: {}, sel: null, start: Date.now(), limit: 0, finished: false };
    Practice.save(); location.hash = '#/session'; App.render();
  },
  async aiReview(el) {
    const t = await DB.get('tests', el.dataset.test); const out = $('#ai-review');
    out.innerHTML = '<p class="muted"><span class="spin"></span>Analysing…</p>';
    const items = [];
    for (const id of t.qs) { const m = await DB.get('mcqs', id); if (m && t.ans[id] != null && t.ans[id] !== m.ans) items.push(`Q: ${m.stem}\nOptions: ${m.options.map((o, i) => String.fromCharCode(65 + i) + '. ' + o).join(' | ')}\nStudent chose ${String.fromCharCode(65 + t.ans[id])}, correct ${String.fromCharCode(65 + m.ans)}. Topic: ${m.topicId}`); }
    try {
      const txt = await AI.call({ json: false, system: SYSTEM_TUTOR, prompt: `The student scored ${t.correct}/${t.total} on "${t.title}". Here are the questions they got wrong:\n\n${items.join('\n\n').slice(0, 30000)}\n\nWrite a short review: (1) the 2–4 patterns behind these mistakes (e.g. Indian vs Australian practice confusion, misreading the lead-in, a knowledge gap), (2) for each pattern the exact facts to revise as bullets, (3) one line on exam technique. Be specific and brief.` });
      t.review = txt; await DB.put('tests', t); out.innerHTML = md(txt);
    } catch (e) { out.innerHTML = `<p class="warn-t">${esc(e.message)}</p>`; }
  },

  // Practice form
  pickAllSys() { const boxes = $$('input[name=sys]'); const on = !boxes.every(b => b.checked); boxes.forEach(b => { b.checked = on; b.parentElement.classList.toggle('on', on); }); },

  // Library
  unstage(el) { App.staged.splice(+el.dataset.i, 1); App.render(true); },
  async startIngest() {
    const list = App.staged; App.staged = [];
    toast(`Adding ${list.length} item${list.length === 1 ? '' : 's'}…`);
    await addBooks(list); App.render(true);
  },
  pauseQueue() { Queue.manualPause = true; Queue.emit(); App.render(true); },
  resumeQueue() { Queue.manualPause = false; Queue.pausedUntil = 0; Queue.kick(); App.render(true); },
  async retryFailed() { await Queue.retryFailed(); App.render(true); },
  async clearDone() { await Queue.clearDone(); App.render(true); },
  async genEverything() {
    const prefs = await Prefs.get();
    const topics = (await DB.live('topics')).sort((a, b) => (a.system === prefs.focus ? -1 : 0) - (b.system === prefs.focus ? -1 : 0) || SYS_LIST.findIndex(s => s.code === a.system) - SYS_LIST.findIndex(s => s.code === b.system) || a.order - b.order);
    const n = await queueTopics(topics.map(t => t.id), { prio: 6 });
    toast(n ? `Queued ${n} jobs. Your focus system (${sysName(prefs.focus)}) goes first.` : 'Everything is already generated or queued.');
    App.render(true);
  },
  async delBook(el) { if (!confirm('Remove this book from the laptop? Sheets and questions already made from it stay.')) return; await deleteBook(el.dataset.id); App.render(true); },

  // Settings
  async testKey() {
    const msg = $('#key-msg'); const key = $('input[name=key]').value.trim(); localStorage.setItem('gem_key', key);
    msg.textContent = 'Checking…';
    try { const ms = await AI.listModels(); $('#models').innerHTML = ms.map(m => `<option value="${m}">`).join(''); msg.textContent = `Key works. ${ms.length} models available — e.g. ${ms.filter(m => /flash|pro/.test(m)).slice(0, 4).join(', ')}`; }
    catch (e) { msg.textContent = 'Problem: ' + e.message; }
  },
  async copySql() { try { await navigator.clipboard.writeText(SYNC_SQL); toast('Setup script copied'); } catch (e) { openModal(`<h3>Setup script</h3><textarea rows="16" readonly>${esc(SYNC_SQL)}</textarea><div class="row end mt"><button class="btn" data-act="closeModal">Close</button></div>`); } },
  theme(el) { localStorage.setItem('theme', el.dataset.k); applyTheme(); App.render(true); },
  async exportData() {
    toast('Preparing backup…');
    const out = { app: 'amc-engine', version: 1, exported: Date.now() };
    for (const s of SYNCED) out[s] = (await DB.all(s)).map(({ _dirty, ...o }) => o);
    download(`amc-engine-backup-${todayStr()}.json`, new Blob([JSON.stringify(out)], { type: 'application/json' }));
  }
};

// Form submits
const F = {
  async addTopicSave(form) {
    const d = new FormData(form); const sys = form.dataset.sys;
    const count = (await DB.byIndex('topics', 'system', sys)).length;
    await DB.put('topics', { id: sys.toLowerCase() + '-' + slugify(d.get('name')) + '-' + uid().slice(-4), system: sys, name: d.get('name').trim(), kw: String(d.get('kw') || '').split(',').map(s => s.trim()).filter(Boolean), order: count, done: 0, doneAt: null, custom: 1 });
    closeModal(); App.render(true);
  },
  async renameSave(form) {
    const d = new FormData(form); const t = await DB.get('topics', form.dataset.id);
    t.name = d.get('name').trim() || t.name; t.kw = String(d.get('kw') || '').split(',').map(s => s.trim()).filter(Boolean);
    await DB.put('topics', t); closeModal(); App.render(true);
  },
  async askDoubt(form) {
    const q = new FormData(form).get('q').trim(); if (!q) return;
    const t = await DB.get('topics', form.dataset.id);
    const btn = form.querySelector('button'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Thinking';
    try {
      const a = await askTutor(t, q);
      const n = await getNote(t.id); (n.doubts ||= []).push({ q, a, ts: Date.now() }); await DB.put('notes', n);
      App.render(true);
    } catch (e) { toast(e.message, 5000); btn.disabled = false; btn.textContent = 'Ask'; }
  },
  async askQSend(form) {
    const q = new FormData(form).get('q'); const out = $('#askq-out');
    const s = Practice.s; const m = await DB.get('mcqs', s.qs[s.idx]); const t = m.topicId ? await DB.get('topics', m.topicId) : null;
    out.innerHTML = '<p class="muted"><span class="spin"></span>Thinking…</p>';
    try {
      const a = await askTutor(t, q, `MCQ: ${m.stem}\nOptions: ${m.options.map((o, i) => String.fromCharCode(65 + i) + '. ' + o).join(' | ')}\nKeyed answer: ${String.fromCharCode(65 + m.ans)}\nExplanation: ${m.expl}`);
      out.innerHTML = md(a);
      if (t) { const n = await getNote(t.id); (n.doubts ||= []).push({ q: q + ' (about an MCQ)', a, ts: Date.now() }); await DB.put('notes', n); }
    } catch (e) { out.innerHTML = `<p class="warn-t">${esc(e.message)}</p>`; }
  },
  async customPractice(form) {
    const d = new FormData(form);
    const f = { systems: d.getAll('sys'), type: d.get('type'), source: d.get('source'), count: Math.max(5, Math.min(150, +d.get('count') || 20)), mode: d.get('mode') };
    localStorage.setItem('pform', JSON.stringify(f));
    await Practice.start({ kind: 'custom', title: f.systems.length === 1 ? sysName(f.systems[0]) : f.systems.length ? `${f.systems.length} systems` : 'All systems', ...f, weightMistakes: f.source === 'all' });
  },
  async saveAI(form) {
    const d = new FormData(form);
    localStorage.setItem('gem_key', d.get('key').trim()); localStorage.setItem('gem_model', d.get('model').trim() || 'gemini-2.5-flash'); localStorage.setItem('gem_rpm', d.get('rpm')); localStorage.setItem('gem_bulk', (d.get('bulk') || '').trim() || 'gemini-2.5-flash-lite'); Queue.pausedUntil = 0; Queue.limitHits = 0;
    Queue.pauseMsg = ''; Queue.kick(); toast('Saved');
  },
  async saveGoals(form) {
    const d = new FormData(form); const p = await Prefs.get();
    p.exams = p.exams.map((e, i) => ({ name: d.get('en' + i) || e.name, date: d.get('ed' + i) || '' }));
    p.daily = +d.get('daily') || 30; p.biweeklyCount = +d.get('bw') || 40;
    await DB.put('prefs', p); toast('Saved');
  },
  async saveSync(form) {
    const d = new FormData(form);
    localStorage.setItem('sb_url', d.get('url').trim()); localStorage.setItem('sb_key', d.get('key').trim());
    if (!Sync.on()) { Sync.set('off'); toast('Sync turned off'); return; }
    try { await Sync.test(); toast('Connected — syncing…'); await Sync.run(); App.render(true); }
    catch (e) { toast('Could not connect: ' + e.message, 6000); }
  }
};

// Change / input handlers
const C = {
  async setFocus(el) { await Prefs.set({ focus: el.value }); App.render(true); },
  async setTarget(el) { const p = await Prefs.get(); p.targets = { ...(p.targets || {}), [el.dataset.sys]: el.value }; await DB.put('prefs', p); toast('Target saved'); },
  async addPhotos(el) {
    const n = await getNote(el.dataset.id);
    for (const f of el.files) { const id = 'note-' + uid(); await DB.put('media', { id, data: await compressImage(f, 1800, 0.82), kind: 'photo' }); (n.items ||= []).push({ type: 'photo', mediaId: id, ts: Date.now() }); }
    await DB.put('notes', n); toast(`${el.files.length} photo${el.files.length === 1 ? '' : 's'} added`); App.render(true);
  },
  stageFiles(el) { stageFiles([...el.files]); },
  stageName(el) { App.staged[+el.dataset.i].name = el.value; },
  stageRole(el) { App.staged[+el.dataset.i].role = el.value; },
  async bookRole(el) {
    const b = await DB.get('books', el.dataset.id); b.role = el.value; await DB.put('books', b);
    if (confirm('Re-process this book with its new type?')) { await Queue.add('extract', { bookId: b.id }, 1); }
    App.render(true);
  },
  async importData(el) {
    const f = el.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== 'amc-engine') throw new Error('Not a backup from this app');
      for (const s of SYNCED) if (Array.isArray(d[s])) await DB.putMany(s, d[s]);
      toast('Backup loaded'); App.render();
    } catch (e) { toast('Could not load: ' + e.message, 5000); }
  }
};
const I = {
  saveNote(el) {
    clearTimeout(el._t);
    el._t = setTimeout(async () => { const n = await getNote(el.dataset.id); n.text = el.value; await DB.put('notes', n); const s = $('#note-saved'); if (s) s.textContent = 'Saved'; }, 600);
  }
};

function applyTheme() {
  const t = localStorage.getItem('theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}

async function init() {
  applyTheme();
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const f = A[el.dataset.act]; if (!f) return;
    if (el.tagName === 'BUTTON' && el.type !== 'submit' || el.tagName !== 'BUTTON') e.preventDefault();
    Promise.resolve(f(el, e)).catch(err => { console.error(err); toast(err.message, 5000); });
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.matches('.chip.check input')) el.parentElement.classList.toggle('on', el.checked);
    const f = el.dataset.change && C[el.dataset.change]; if (f) Promise.resolve(f(el)).catch(err => toast(err.message, 5000));
  });
  document.addEventListener('input', e => { const f = e.target.dataset?.input && I[e.target.dataset.input]; if (f) f(e.target); });
  document.addEventListener('submit', e => {
    const form = e.target.closest('[data-submit]'); if (!form) return;
    e.preventDefault(); const f = F[form.dataset.submit];
    if (f) Promise.resolve(f(form)).catch(err => { console.error(err); toast(err.message, 5000); });
  });
  document.addEventListener('keydown', e => {
    if (location.hash !== '#/session' || /TEXTAREA|INPUT/.test(document.activeElement?.tagName) || $('#modal').classList.contains('open')) return;
    const k = e.key.toUpperCase();
    if (/^[A-E]$/.test(k) || /^[1-5]$/.test(k)) { const i = /\d/.test(k) ? +k - 1 : k.charCodeAt(0) - 65; const b = $$('.opt')[i]; if (b && !b.disabled) b.click(); }
    else if (e.key === 'Enter') { ($('[data-act=checkQ]:not([disabled])') || $('[data-act=nextQ]'))?.click(); }
    else if (e.key === 'ArrowRight') $('[data-act=nextQ]')?.click();
    else if (e.key === 'ArrowLeft') $('[data-act=prevQ]:not([disabled])')?.click();
  });
  window.addEventListener('hashchange', () => { Views._edit = null; App.render(); });

  await openDB();
  if ((await DB.meta('seed')) !== SEED_VERSION) {
    const have = new Set((await DB.all('topics')).map(t => t.id));
    await DB.putMany('topics', seedTopics().filter(t => !have.has(t.id)).map(t => ({ ...t, updated: 0 })), { fromSync: true });
    await DB.meta('seed', SEED_VERSION);
  }
  Practice.load();
  await Queue.recover();
  Queue.listeners.add(() => { const q = $('#qstatus'); if (q) q.innerHTML = queueLine(); const nb = $('#nav-q'); if (nb) nb.hidden = !(Queue.running.local || Queue.running.ai); });
  await App.render();
  Queue.kick();
  if (Sync.on()) { Sync.run(); setInterval(() => Sync.run(), 120000); document.addEventListener('visibilitychange', () => { if (!document.hidden) Sync.run(); }); }
  else Sync.set('off');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
