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
      drop.addEventListener('drop', async e => stageFiles(await filesFromDrop(e.dataTransfer)));
    }
  }
};

async function stageFiles(files) {
  // Skip books already in the Library (same file = same size), so the whole folder can be selected safely.
  const allBooks = await DB.all('books');
  // A book whose saved copy can't be read: adding the same PDF again repairs it (keeps all its progress).
  const lost = new Map(allBooks.filter(b => b.fileLost).map(b => [b.size, b]));
  let repaired = 0;
  for (const f of files) {
    const b = lost.get(f.size); if (!b || !/pdf$/i.test(f.type || f.name)) continue;
    await DB.put('files', { id: b.id, blob: f }); delete b.fileLost; b.status = 'ocr'; await DB.put('books', b); PdfCache.delete(b.id);
    for (const j of await DB.all('queue')) if (j.payload?.bookId === b.id && j.status === 'failed') { j.status = 'pending'; j.tries = 0; await DB.put('queue', j); }
    lost.delete(f.size); repaired++;
  }
  if (repaired) { toast(`Repaired ${repaired} book${repaired > 1 ? 's' : ''} — carrying on where it stopped`, 6000); Queue.kick(); }
  const have = new Set(allBooks.filter(b => b.kind === 'pdf').map(b => b.size));
  App.staged.forEach(e => { if (e.files.length === 1) have.add(e.files[0].size); });
  const pathOf = f => (f._path || f.webkitRelativePath || f.name).replace(/\\/g, '/');
  // Subfolder name (e.g. "CVS" in AMC/CVS/file.pdf) — not the top folder you picked.
  const dirOf = f => { const p = pathOf(f).split('/'); return p.length > 2 ? p[p.length - 2] : ''; };
  // Files sitting in subject subfolders are usually question-bank parts (e.g. AMEDEX per system).
  const roleOf = f => { const r = guessRole(f.name); return r === 'ref' && dirOf(f) ? 'mcq-amc' : r; };
  const zips = files.filter(f => /\.(zip|rar|7z)$/i.test(f.name));
  const isPdf = f => /pdf$/i.test(f.type || f.name);
  const isImg = f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name);
  const other = files.filter(f => !isPdf(f) && !isImg(f) && !zips.includes(f) && !/^(\.|desktop\.ini|thumbs\.db)/i.test(f.name));
  let pdfs = files.filter(isPdf);
  const dup = pdfs.filter(f => have.has(f.size));
  pdfs = pdfs.filter(f => !have.has(f.size));
  pdfs.sort((a, b) => pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true }));
  pdfs.forEach(f => {
    have.add(f.size);
    const dir = dirOf(f), base = f.name.replace(/\.pdf$/i, '');
    const name = dir && !base.toLowerCase().includes(dir.toLowerCase()) ? `${dir} – ${base}` : base;
    App.staged.push({ files: [f], name, role: roleOf(f) });
  });
  // Photos: one question bank per folder (e.g. "CVS (photos)").
  const groups = {};
  files.filter(isImg).forEach(f => (groups[dirOf(f)] ||= []).push(f));
  Object.entries(groups).forEach(([dir, imgs]) => {
    imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    App.staged.push({ files: imgs, name: imgs.length > 1 ? `${dir || 'Question bank'} (${imgs.length} photos)` : imgs[0].name, role: 'mcq-amc' });
  });
  const msg = [];
  if (pdfs.length) msg.push(`${pdfs.length} new`);
  if (dup.length) msg.push(`${dup.length} already in your Library — skipped`);
  if (zips.length) msg.push(`${zips.length} zip file${zips.length > 1 ? 's' : ''} skipped — right-click it → “Extract All”, then add the folder`);
  if (other.length) msg.push(`${other.length} other file${other.length > 1 ? 's' : ''} (not PDF/photo) ignored`);
  if (msg.length) toast(msg.join(' · '), 9000);
  App.render(true);
}
// Dropped folders: walk inside them and collect every file.
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (en, path) => {
    if (en.isFile) { const f = await new Promise((r, j) => en.file(r, j)); f._path = path + f.name; out.push(f); return; }
    const rd = en.createReader(); let batch;
    do { batch = await new Promise((r, j) => rd.readEntries(r, j)); for (const c of batch) await walk(c, path + en.name + '/'); } while (batch.length);
  };
  for (const en of entries) await walk(en, '');
  return out;
}

// ---------- Actions ----------
const A = {
  closeModal,
  async quickPractice() { await Practice.start({ kind: 'custom', title: 'Mixed practice', mode: 'tutor', count: 20, weightMistakes: true }); },
  async startMistakes() { await Practice.start({ kind: 'mistakes', title: 'Mistake bank', mode: 'tutor', source: 'mistakes', count: 40 }); },
  startBiweekly,
  async pickMode(el) {
    const k = el.dataset.m; if ($('#mode-remember')?.checked) localStorage.setItem('modePref', k);
    const opts = Practice._pending; closeModal(); if (opts) await Practice._start({ ...opts, ...MODES[k] });
  },
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
  planAll(el) { sessionStorage.setItem('planAll', sessionStorage.getItem('planAll') === el.dataset.sys ? '' : el.dataset.sys); App.render(true); },
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
    const m = await DB.get('mcqs', s.qs[s.idx]);
    const toggle = cur => { const a = Array.isArray(cur) ? [...cur] : []; const k = a.indexOf(i); k >= 0 ? a.splice(k, 1) : a.push(i); return a.sort(); };
    if (s.mode === 'exam') { const c = isMulti(m) ? toggle(s.ans[m.id]?.c) : i; if (Array.isArray(c) && !c.length) delete s.ans[m.id]; else s.ans[m.id] = { c, ok: isRight(m, c) ? 1 : 0 }; }
    else s.sel = isMulti(m) ? toggle(s.sel) : i;
    Practice.save(); App.render(true);
  },
  async checkQ() {
    const s = Practice.s; if (s.sel == null || (Array.isArray(s.sel) && !s.sel.length)) return;
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
    openModal(`<form data-submit="askQSend"><h3>Ask about this question</h3><textarea name="q" rows="3">Why is ${letters(correctSet(m))} correct and not ${letters(s.ans[m.id]?.c ?? 0)}?</textarea>
      <div id="askq-out" class="read mt"></div><div class="row gap mt end"><button type="button" class="btn" data-act="closeModal">Close</button><button class="btn primary">Ask</button></div></form>`);
  },
  async masterQ(el) {
    const m = await DB.get('mcqs', el.dataset.id); if (!m) return;
    let ch = null; try { ch = JSON.parse(el.dataset.ch || 'null'); } catch (e) {}
    el.disabled = true; el.innerHTML = '<span class="spin"></span>Finding the right pages in your books…';
    try {
      if (!(await hasBooks()) && Sync.on()) {
        // Books live on the laptop: let it search them, then pull the answer back.
        el.innerHTML = '<span class="spin"></span>Asking your laptop to search your books…';
        await Sync.run(); await PageRelay.askMaster(m.id, ch);
        const d = await PageRelay.waitFor('mcqs:' + m.id, x => x.master?.at, 30000);
        if (d) { Object.assign(m, { master: d.master }); await DB.put('mcqs', { ...m, _dirty: 0 }, { fromSync: true }); }
        else { el.innerHTML = '<span class="spin"></span>Laptop didn’t answer — working it out here (without page numbers)…'; await masterQuestion(m, ch); }
      } else await masterQuestion(m, ch);
      const box = $('#master-' + m.id); if (box) box.outerHTML = masterBlock(m, ch);
    } catch (e) { el.disabled = false; el.textContent = 'Where do I master this?'; toast(e.message, 6000); }
  },
  async openRef(el) {
    let bookId = el.dataset.book; const p = +el.dataset.p, size = +el.dataset.size || 0;
    let book = await DB.get('books', bookId);
    // Not this exact book here? Use a reading copy of the same file (same size) if you added one to this device.
    if (!book && size) { book = (await DB.all('books')).find(b => b.size === size) || null; if (book) bookId = book.id; }
    const [pg, file] = await Promise.all([DB.get('pages', [bookId, p]), book ? DB.get('files', bookId) : null]);
    if (!book || !file) return openRemotePage(el.dataset.book, p, el.textContent.trim());
    openModal(`<h3>${esc(book.short || book.name)} — page ${p}</h3><div id="ref-img" class="mt"></div>${pg ? `<details class="mt"><summary class="small">Page text</summary><div class="read small">${esc(pg.text).replace(/\n/g, '<br>')}</div></details>` : ''}<div class="row end mt"><button class="btn" data-act="closeModal">Close</button></div>`);
    if (file) { try { const c = await renderPage(book, p, 1400); c.style.width = '100%'; c.style.height = 'auto'; $('#ref-img').appendChild(c); } catch (e) {} }
    else if (!pg) $('#ref-img').innerHTML = '<p class="muted">This book’s pages are only on your laptop.</p>';
  },
  async skipOcr(el) {
    const b = await DB.get('books', el.dataset.id); if (!b) return;
    openModal(`<h3>Skip reading “${esc(b.short || b.name)}”?</h3><p>The pages already read stay and are used in your sheets. The rest of this scanned book won’t be read, which frees the laptop for your other books.</p><div class="row gap end mt"><button class="btn" data-act="closeModal">Keep reading</button><button class="btn primary" data-act="skipOcrYes" data-id="${b.id}">Skip reading</button></div>`);
  },
  async skipOcrYes(el) { const n = await skipOcr(el.dataset.id); closeModal(); toast(`Stopped reading that book (${n} batches removed)`); App.render(true); },
  wAll() { sessionStorage.setItem('wAll', sessionStorage.getItem('wAll') === '1' ? '' : '1'); App.render(true); },
  async flagQ() {
    const s = Practice.s; const m = await DB.get('mcqs', s.qs[s.idx]); m.flagged = 1; await DB.put('mcqs', m);
    toast('Flagged — it won’t appear in practice again.');
  },
  closeResults() { Practice.clear(); history.length > 1 ? history.back() : (location.hash = '#/'); },
  async retryWrong(el) {
    const t = await DB.get('tests', el.dataset.test);
    const ids = []; for (const id of t.qs) { const m = await DB.get('mcqs', id); if (m && t.ans[id] != null && !isRight(m, t.ans[id])) ids.push(id); }
    Practice.s = { id: uid(), kind: 'retry', title: 'Retry: ' + t.title, mode: 'tutor', topicId: t.topicId, qs: shuffle(ids), idx: 0, ans: {}, sel: null, start: Date.now(), limit: 0, finished: false };
    Practice.save(); location.hash = '#/session'; App.render();
  },
  async aiReview(el) {
    const t = await DB.get('tests', el.dataset.test); const out = $('#ai-review');
    out.innerHTML = '<p class="muted"><span class="spin"></span>Analysing…</p>';
    const items = [];
    for (const id of t.qs) { const m = await DB.get('mcqs', id); if (m && t.ans[id] != null && !isRight(m, t.ans[id])) items.push(`Q: ${m.stem}\nOptions: ${m.options.map((o, i) => String.fromCharCode(65 + i) + '. ' + o).join(' | ')}\nStudent chose ${letters(t.ans[id])}, correct ${letters(correctSet(m))}. Topic: ${m.topicId}`); }
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
  async bookFirst(el) {
    let n = 0;
    for (const j of await DB.all('queue')) if (j.payload?.bookId === el.dataset.id && j.status === 'pending') { j.prio = 0.1; await DB.put('queue', j); n++; }
    toast(n ? `This book jumps the queue (${n} jobs).` : 'Nothing waiting for this book.'); App.render(true);
  },
  async delBook(el) { if (!confirm('Remove this book from the laptop? Sheets and questions already made from it stay.')) return; await deleteBook(el.dataset.id); App.render(true); },

  // Settings
  async testKey() {
    const msg = $('#key-msg'); const key = $('input[name=key]').value.trim(); localStorage.setItem('gem_key', key);
    msg.textContent = 'Checking…';
    try {
      const ms = await AI.listModels(); $('#models').innerHTML = ms.map(m => `<option value="${m}">`).join('');
      const best = await AI.autoPick();
      if (best) { const a = $('input[name=model]'), b = $('input[name=bulk]'); if (a) a.value = best.main; if (b) b.value = best.bulk; }
      msg.textContent = `Key works. ${ms.length} models available. Picked the newest: ${best ? best.main + ' (main) and ' + best.bulk + ' (bulk)' : 'none found — type a model name'}. Click Save.`;
      Queue.pausedUntil = 0; Queue.limitHits = 0;
    }
    catch (e) { msg.textContent = 'Problem: ' + e.message; }
  },
  async testProvider(el) {
    const id = el.dataset.id, msg = $('#pmsg_' + id);
    const key = $(`input[name=key_${id}]`).value.trim(); let model = $(`input[name=model_${id}]`).value.trim();
    const baseIn = $(`input[name=base_${id}]`); const nameIn = $(`input[name=name_${id}]`);
    Providers.save(id, { key, ...(baseIn ? { base: baseIn.value.trim() } : {}), ...(nameIn && nameIn.value.trim() ? { name: nameIn.value.trim() } : {}) });
    if (baseIn && !baseIn.value.trim()) { msg.textContent = 'Paste the address first (it ends in /v1).'; return; }
    msg.textContent = 'Checking…';
    try {
      const p = Providers.get(id);
      let ms = []; try { ms = await Providers.models(p); } catch (e) {}
      if (ms.length) $('#pm_' + id).innerHTML = ms.map(m => `<option value="${esc(m)}">`).join('');
      if (!model || (ms.length && !ms.includes(model))) {
        const pick = ((p.vision || p.custom) ? ms.find(m => /scout|maverick|pixtral|mistral-small|vision|-vl|glm-4v|4\.1-mini|4o-mini/i.test(m)) : null) || ms.find(m => /:free$/.test(m) && /llama|qwen|gemma|mistral|deepseek/i.test(m)) || ms.find(m => /llama|qwen|gpt-oss/i.test(m)) || ms[0] || p.model;
        model = pick || ''; $(`input[name=model_${id}]`).value = model;
      }
      Providers.save(id, { model, on: true });
      const ping = () => Providers.call(Providers.get(id), { prompt: 'Reply with JSON {"ok":true}', json: true, maxTokens: 400 });
      let out;
      try { out = await ping(); }
      catch (e) {
        // "Balance insufficient" = this model is paid. Try the others until a free one answers, image-reading ones first.
        if (!/balance|insufficient|credit|payment|billing|not free|upgrade|quota|permission|not have access|not found|does not exist/i.test(e.message) || !ms.length) throw e;
        const score = m => (/vl|vision|4\.1v|4\.5v|glm-4v|pixtral|scout/i.test(m) ? 0 : 10) + (/(^|[^0-9])(7|8|9)b/i.test(m) ? 0 : /(1\.5|3|4)b/i.test(m) ? 2 : 4) + (/embed|rerank|bge|whisper|tts|speech|flux|stable-diffusion|kolors|wan|video|image-/i.test(m) ? 100 : 0);
        const cands = ms.filter(m => m !== model).sort((x, y) => score(x) - score(y)).filter(m => score(m) < 100).slice(0, 15);
        for (const m of cands) {
          msg.textContent = `That model is paid — trying ${m}…`;
          Providers.save(id, { model: m }); model = m; $(`input[name=model_${id}]`).value = m;
          try { out = await ping(); break; } catch (e2) { if (!/balance|insufficient|credit|payment|billing|not free|upgrade|permission|not have access|not found|does not exist|json/i.test(e2.message)) throw e2; }
        }
        if (!out) throw new Error('none of the free models answered. Check the Models page on their site for ones marked “Free”, type the exact name in Model, and Test again.');
      }
      // Can this model see images? Send a tiny picture; if it refuses, it only gets text jobs.
      let vision = false;
      if (PROVIDER_PRESETS[id].vision || PROVIDER_PRESETS[id].custom) {
        const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(0, 0, 64, 64);
        try { const t = await Providers.call(Providers.get(id), { prompt: 'What colour is this square? One word.', images: [c.toDataURL('image/png')], json: false, maxTokens: 20 }); vision = /red/i.test(t); } catch (e) { vision = false; }
      }
      Providers.save(id, { vision });
      msg.textContent = out.ok ? `Works with ${model}${vision ? ' — reads images too' : ' — text only (pick a vision model from the list for scanned pages)'}. Saved, it will start helping now.` : 'Replied, but oddly — try another model.';
      Queue.kick();
    } catch (e) { msg.textContent = 'Problem: ' + e.message; }
  },
  async copyRelay() {
    let code = '';
    try { code = await (await fetch('relay-worker.js', { cache: 'no-store' })).text(); } catch (e) {}
    if (!code) return toast('Could not load the relay code — are you online?');
    try { await navigator.clipboard.writeText(code); toast('Relay code copied — paste it in Cloudflare'); }
    catch (e) { openModal(`<h3>Relay code</h3><textarea rows="16" readonly>${esc(code)}</textarea><div class="row end mt"><button class="btn" data-act="closeModal">Close</button></div>`); }
  },
  async testRelay() {
    const msg = $('#relay-msg'); const url = ($('input[name=relay]').value || '').trim().replace(/\/$/, '');
    if (!/^https:\/\//.test(url)) { msg.textContent = 'Paste the address first (starts with https://).'; return; }
    msg.textContent = 'Checking…';
    try {
      const t = await (await fetch(url + '/')).text();
      if (/Relay is working/.test(t)) { localStorage.setItem('relay', url); msg.textContent = 'Relay works. Saved — now Test NVIDIA again.'; }
      else msg.textContent = 'That address answered, but not with the relay code. Paste the code again in Cloudflare and Deploy.';
    } catch (e) { msg.textContent = 'Could not reach it. Check the address, and that you clicked Deploy.'; }
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

// Phone: show a page the laptop sends over (kept on the phone afterwards, so it opens instantly next time).
async function openRemotePage(bookId, p, label) {
  const show = d => { const box = $('#ref-img'); if (!box) return; box.innerHTML = `<img src="${d.data}" alt="${esc(label)}" style="width:100%;height:auto">${d.text ? `<details class="mt"><summary class="small">Page text</summary><div class="read small">${esc(d.text).replace(/\n/g, '<br>')}</div></details>` : ''}`; };
  openModal(`<h3>${esc(label)}</h3><div id="ref-img" class="mt"><p class="muted"><span class="spin"></span>Asking your laptop for this page…</p></div><div class="row end mt"><button class="btn" data-act="closeModal">Close</button></div>`);
  const cached = await DB.get('media', PageRelay.pid(bookId, p));
  if (cached?.data) return show(cached);
  if (!Sync.on()) { $('#ref-img').innerHTML = '<p class="muted">This book is on your laptop. Turn on Sync (Settings) so the laptop can send pages to this device.</p>'; return; }
  try {
    let d = await PageRelay.getRecord('media:' + PageRelay.pid(bookId, p));
    if (!d) {
      await PageRelay.askPage(bookId, p, label);
      const box = $('#ref-img'); if (box) box.innerHTML = '<p class="muted"><span class="spin"></span>Asking your laptop for this page… (it needs to be on, with the app open — usually 10–20 seconds)</p>';
      d = await PageRelay.waitFor('media:' + PageRelay.pid(bookId, p), x => !!x.data);
    }
    if (d) { await DB.put('media', { ...d, _dirty: 0 }, { fromSync: true }); show(d); }
    else { const box = $('#ref-img'); if (box) box.innerHTML = '<p class="muted">Your laptop didn’t answer yet. Check it is on with the app open. Your request is saved — the page will be here next time you tap.</p>'; }
  } catch (e) { const box = $('#ref-img'); if (box) box.innerHTML = `<p class="warn-t">${esc(e.message)}</p>`; }
}

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
      const a = await askTutor(t, q, `MCQ: ${m.stem}\nOptions: ${m.options.map((o, i) => String.fromCharCode(65 + i) + '. ' + o).join(' | ')}\nKeyed answer: ${letters(correctSet(m))}\nExplanation: ${m.expl}`);
      out.innerHTML = md(a);
      if (t) { const n = await getNote(t.id); (n.doubts ||= []).push({ q: q + ' (about an MCQ)', a, ts: Date.now() }); await DB.put('notes', n); }
    } catch (e) { out.innerHTML = `<p class="warn-t">${esc(e.message)}</p>`; }
  },
  async customPractice(form) {
    const d = new FormData(form);
    const f = { systems: d.getAll('sys'), type: d.get('type'), source: d.get('source'), count: Math.max(5, Math.min(150, +d.get('count') || 20)), mode: d.get('mode') };
    localStorage.setItem('pform', JSON.stringify(f));
    await Practice.start({ ...MODES[f.mode] || MODES.tutor, chosen: true, kind: 'custom', title: f.systems.length === 1 ? sysName(f.systems[0]) : f.systems.length ? `${f.systems.length} systems` : 'All systems', ...f, weightMistakes: f.source === 'all', mode: (MODES[f.mode] || MODES.tutor).mode });
  },
  async saveAI(form) {
    const d = new FormData(form);
    localStorage.setItem('gem_key', d.get('key').trim()); localStorage.setItem('gem_model', d.get('model').trim() || 'gemini-2.5-flash'); localStorage.setItem('gem_rpm', d.get('rpm')); localStorage.setItem('gem_bulk', (d.get('bulk') || '').trim() || 'gemini-2.5-flash-lite'); Queue.pausedUntil = 0; Queue.limitHits = 0;
    Queue.pauseMsg = ''; Queue.kick(); toast('Saved');
  },
  async saveProviders(form) {
    const d = new FormData(form);
    localStorage.setItem('relay', (d.get('relay') || '').trim());
    Providers.list().forEach(p => Providers.save(p.id, { key: (d.get('key_' + p.id) || '').trim(), model: (d.get('model_' + p.id) || '').trim(), rpm: Math.max(1, +d.get('rpm_' + p.id) || p.rpm), on: true, ...(p.custom ? { base: (d.get('base_' + p.id) || '').trim(), name: (d.get('name_' + p.id) || '').trim() || p.name } : {}) }));
    Object.keys(Queue.paused).forEach(k => { if (k.startsWith('p:')) Queue.paused[k] = 0; });
    toast('Saved'); Queue.kick(); App.render(true);
  },
  async saveGoals(form) {
    const d = new FormData(form); const p = await Prefs.get();
    p.exams = p.exams.map((e, i) => ({ name: d.get('en' + i) || e.name, date: d.get('ed' + i) || '' }));
    p.daily = +d.get('daily') || 30; p.biweeklyCount = +d.get('bw') || 40; p.studyDays = +d.get('sd') || 6;
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
  ocrWorkers(el) { localStorage.setItem('ocrWorkers', el.value); toast('Saved — takes effect after the current pages (or reload the page)'); },
  bgRun(el) { localStorage.setItem('bgRun', el.checked ? '1' : '0'); if (el.checked && Object.values(Queue.running).some(Boolean)) KeepAlive.start(); else if (!el.checked) KeepAlive.stop(); toast(el.checked ? 'Will keep working when Chrome is minimised' : 'Off'); },
  keepAwake(el) { localStorage.setItem('keepAwake', el.checked ? '1' : '0'); if (!el.checked) Queue.holdWake(false); else Queue.holdWake(true); toast(el.checked ? 'Screen will stay on' : 'Windows can now turn the display off'); },
  setModePref(el) { localStorage.setItem('modePref', el.value); toast('Saved'); },
  async setFocus(el) { await Prefs.set({ focus: el.value }); App.render(true); },
  async setPlanOrder(el) { const p = await Prefs.get(); p.planOrder = { ...(p.planOrder || {}), [el.dataset.sys]: el.value }; await DB.put('prefs', p); toast(el.value === 'weight' ? 'Plan now starts with the most-asked topics' : 'Plan follows book order'); App.render(true); },
  async setTarget(el) { const p = await Prefs.get(); p.targets = { ...(p.targets || {}), [el.dataset.sys]: el.value }; await DB.put('prefs', p); toast('Deadline saved — plan updated'); App.render(true); },
  async setStart(el) { const p = await Prefs.get(); p.starts = { ...(p.starts || {}), [el.dataset.sys]: el.value }; await DB.put('prefs', p); App.render(true); },
  async addPhotos(el) {
    const n = await getNote(el.dataset.id);
    for (const f of el.files) { const id = 'note-' + uid(); await DB.put('media', { id, data: await compressImage(f, 1800, 0.82), kind: 'photo' }); (n.items ||= []).push({ type: 'photo', mediaId: id, ts: Date.now() }); }
    await DB.put('notes', n); toast(`${el.files.length} photo${el.files.length === 1 ? '' : 's'} added`); App.render(true);
  },
  stageFiles(el) { stageFiles([...el.files]); },
  stageName(el) { App.staged[+el.dataset.i].name = el.value; },
  stageRole(el) { App.staged[+el.dataset.i].role = el.value; },
  stageRoleAll(el) { if (!el.value) return; App.staged.forEach(e => e.role = el.value); App.render(true); },
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
  window.addEventListener('online', () => {
    // Internet is back: wake every helper that was resting because of the outage.
    if (/Network error/i.test(Queue.pauseMsg || '')) { Queue.paused.ai = 0; Queue.pauseMsg = ''; }
    Object.keys(Queue.status).forEach(l => { if (/Network error|could not connect/i.test(Queue.status[l] || '')) Queue.paused[l] = 0; });
    Queue.kick();
  });
  document.addEventListener('click', e => {
    if (Object.values(Queue.running).some(Boolean)) KeepAlive.start();
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
  Queue.startedAt = Date.now();
  try { await Queue.splitTextJobs(); } catch (e) { console.warn(e); }
  try { const n = await Queue.convertVisionToOcr(); if (n) setTimeout(() => toast(`Switched ${n} scanned question-bank jobs to the faster read-then-import route`, 6000), 1500); } catch (e) { console.warn(e); }
  if (AI.key && !localStorage.getItem('gem_picked')) { try { await AI.autoPick(); localStorage.setItem('gem_picked', '1'); } catch (e) {} }
  Queue.listeners.add(() => { const q = $('#qstatus'); if (q) q.innerHTML = queueLine(); const nb = $('#nav-q'); if (nb) nb.hidden = !(Queue.running.local || Queue.running.ai); });
  await App.render();
  Queue.kick();
  if (Sync.on()) { setInterval(() => PageRelay.serve(), 15000); setTimeout(() => PageRelay.serve(), 5000); }
  setTimeout(() => Queue.autoRetry().catch(console.warn), 60000); setInterval(() => Queue.autoRetry().catch(console.warn), 2 * 3600000);
  setTimeout(() => queueRefs().catch(console.warn), 20000); setInterval(() => queueRefs().catch(console.warn), 3600000);
  if (Sync.on()) { Sync.run(); setInterval(() => Sync.run(), 120000); document.addEventListener('visibilitychange', () => { if (!document.hidden) Sync.run(); }); }
  else Sync.set('off');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
