// Book ingestion + background job queue.
// Two lanes run side by side: "local" (text extraction, OCR — free, no AI) and "ai" (Gemini calls, rate-limited).
const LOCAL_KINDS = ['extract', 'ocr'];
const JOB_LABEL = {
  extract: 'Reading book', ocr: 'OCR scanned pages', mcqtext: 'Importing MCQs', mcqvision: 'Importing MCQs from photos',
  practical: 'Making image spotters', sheet: 'Writing topic sheet', mcqgen: 'Writing MCQs', merge: 'Combining questions'
};

function guessRole(name) {
  const n = name.toLowerCase();
  if (/amedex|qbank|q-bank|recall|anthology|handbook.*mcq|amc.*mcq|mcq.*amc/.test(n)) return 'mcq-amc';
  if (/mcq|question|self.?assess|pretest|review/.test(n)) return 'mcq-mbbs';
  if (/practical|spotter|ecg|x-?ray|radiolog|instrument|specimen|osce|atlas|image/.test(n)) return 'practical';
  if (/murtagh|amc|etg|australia|racgp|red book|rch|austroads/.test(n)) return 'amc';
  if (/davidson|srb|dutta|ghai|manipal|bhat|kumar|shah|api text/.test(n)) return 'mbbs';
  return 'ref';
}
function shortName(name) {
  return name.replace(/\.(pdf|jpe?g|png|webp|heic)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28);
}

// ---------- PDF helpers ----------
const PdfCache = new Map();
async function getPdf(bookId) {
  if (PdfCache.has(bookId)) return PdfCache.get(bookId);
  const f = await DB.get('files', bookId);
  if (!f) throw new Error('Original file missing on this device');
  const pdf = await pdfjsLib.getDocument({ data: await f.blob.arrayBuffer() }).promise;
  if (PdfCache.size >= 2) { const [k, v] = PdfCache.entries().next().value; v.destroy?.(); PdfCache.delete(k); }
  PdfCache.set(bookId, pdf);
  return pdf;
}

// Render a page (PDF page or image file) to a canvas, long side ≈ target px.
async function renderPage(book, p, target = 1600) {
  const c = document.createElement('canvas');
  if (book.kind === 'images') {
    const f = await DB.get('files', book.id);
    const blob = f.blobs[p - 1];
    const url = URL.createObjectURL(blob);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, target / Math.max(img.naturalWidth, img.naturalHeight));
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return c;
  }
  const pdf = await getPdf(book.id);
  const page = await pdf.getPage(p);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(3, target / Math.max(v1.width, v1.height)) });
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return c;
}

function cropBox(canvas, box) {
  // box_2d = [ymin, xmin, ymax, xmax] normalised 0–1000
  if (!Array.isArray(box) || box.length !== 4) return null;
  let [y0, x0, y1, x1] = box.map(Number);
  const pad = 12;
  y0 = Math.max(0, y0 - pad); x0 = Math.max(0, x0 - pad); y1 = Math.min(1000, y1 + pad); x1 = Math.min(1000, x1 + pad);
  const w = (x1 - x0) / 1000 * canvas.width, h = (y1 - y0) / 1000 * canvas.height;
  if (w < 60 || h < 60) return null;
  const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h);
  c.getContext('2d').drawImage(canvas, x0 / 1000 * canvas.width, y0 / 1000 * canvas.height, w, h, 0, 0, c.width, c.height);
  return c;
}

// ---------- Adding books ----------
async function addBooks(entries) {
  // entries: [{files:[File], name, role}]
  for (const e of entries) {
    const isPdf = e.files.length === 1 && /pdf$/i.test(e.files[0].type || e.files[0].name);
    const id = uid();
    const book = {
      id, name: e.name, short: shortName(e.name), role: e.role, kind: isPdf ? 'pdf' : 'images',
      size: e.files.reduce((a, f) => a + f.size, 0), pages: isPdf ? 0 : e.files.length,
      textPages: 0, scannedPages: 0, status: 'queued', added: Date.now()
    };
    await DB.put('files', isPdf ? { id, blob: e.files[0] } : { id, blobs: e.files });
    await DB.put('books', book);
    await Queue.add('extract', { bookId: id }, 1);
  }
  try { await navigator.storage?.persist?.(); } catch (e) {}
}

async function deleteBook(id) {
  await DB.delRange('pages', 'bookId', id);
  await DB.del('files', id);
  await DB.del('books', id);
  PdfCache.delete(id);
  for (const j of await DB.all('queue')) if (j.payload?.bookId === id) await DB.del('queue', j.id);
}

// ---------- Job handlers ----------
const Handlers = {
  async extract(job) {
    const book = await DB.get('books', job.payload.bookId);
    if (!book) return;
    book.status = 'reading'; await DB.put('books', book);
    const scanned = job.payload.scanned || [], imgPages = job.payload.imgPages || [];
    if (book.kind === 'images') {
      for (let i = 1; i <= book.pages; i++) scanned.push(i);
    } else {
      const pdf = await getPdf(book.id);
      book.pages = pdf.numPages;
      let batch = [];
      const start = job.payload.from || 1;
      const OPS = pdfjsLib.OPS;
      for (let i = start; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        const text = tc.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (text.length >= 80) batch.push({ bookId: book.id, p: i, text }); else scanned.push(i);
        if ((book.role === 'practical' || book.role.startsWith('mcq')) && text.length >= 80) {
          const ops = await page.getOperatorList();
          if (ops.fnArray.some(f => f === OPS.paintImageXObject || f === OPS.paintJpegXObject || f === OPS.paintInlineImageXObject)) imgPages.push(i);
        }
        page.cleanup();
        if (batch.length >= 40 || i === pdf.numPages) {
          await DB.putMany('pages', batch); batch = [];
          job.payload.from = i + 1; job.payload.scanned = scanned; job.payload.imgPages = imgPages;
          job.progress = i / pdf.numPages; await DB.put('queue', job);
          Queue.status.local = `Reading ${book.short} — page ${i}/${pdf.numPages}`; Queue.emit();
        }
      }
    }
    book.textPages = book.pages - scanned.length; book.scannedPages = scanned.length;
    // Follow-up jobs depend on what kind of book this is.
    const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
    if (['ref', 'mbbs', 'amc'].includes(book.role)) {
      for (const c of chunk(scanned, 10)) await Queue.add('ocr', { bookId: book.id, pages: c }, 2);
    } else if (book.role.startsWith('mcq')) {
      // Pages with pictures (CT, X-ray, ECG, clinical photos) go through vision so the image is kept with its question.
      const withImg = new Set(imgPages);
      const textPages = [];
      await DB.each('pages', 'bookId', book.id, pg => { if (!withImg.has(pg.p)) textPages.push(pg.p); });
      textPages.sort((a, b) => a - b);
      for (const c of chunk(textPages, 5)) await Queue.add('mcqtext', { bookId: book.id, pages: c }, 4);
      const visual = [...new Set([...imgPages, ...scanned])].sort((a, b) => a - b);
      for (const c of chunk(visual, 2)) await Queue.add('mcqvision', { bookId: book.id, pages: c }, 4);
    } else if (book.role === 'practical') {
      const all = [...new Set([...imgPages, ...scanned])].sort((a, b) => a - b);
      for (const p of all) await Queue.add('practical', { bookId: book.id, page: p }, 5);
    }
    book.status = scanned.length && ['ref', 'mbbs', 'amc'].includes(book.role) ? 'ocr' : (book.role.startsWith('mcq') || book.role === 'practical') ? 'importing' : 'ready';
    await DB.put('books', book);
  },

  async ocr(job) {
    const book = await DB.get('books', job.payload.bookId); if (!book) return;
    const worker = await getOcrWorker();
    const done = job.payload.done || [];
    for (const p of job.payload.pages) {
      if (done.includes(p)) continue;
      Queue.status.local = `OCR ${book.short} — page ${p}`; Queue.emit();
      const canvas = await renderPage(book, p, 2000);
      const { data } = await worker.recognize(canvas);
      const text = (data.text || '').replace(/[ \t]+/g, ' ').trim();
      if (text.length > 30) await DB.put('pages', { bookId: book.id, p, text, ocr: 1 });
      done.push(p); job.payload.done = done; await DB.put('queue', job);
    }
    const left = (await DB.all('queue')).filter(j => j.kind === 'ocr' && j.payload.bookId === book.id && j.id !== job.id && j.status !== 'done');
    if (!left.length) { book.status = 'ready'; await DB.put('books', book); }
  },

  async mcqtext(job) {
    const book = await DB.get('books', job.payload.bookId); if (!book) return;
    const pages = [];
    for (const p of job.payload.pages) { const pg = await DB.get('pages', [book.id, p]); if (pg) pages.push(pg); }
    if (!pages.length) return;
    const prompt = `Below is text from pages ${pages[0].p}–${pages[pages.length - 1].p} of the MCQ book "${book.name}".
Extract every COMPLETE multiple-choice question.
- Copy stem and options faithfully; fix only obvious spacing/OCR errors. Do not add A–E letters inside option text.
- If the book gives the answer and/or explanation on these pages, use it and set "keyedBy":"book". If not, choose the best answer yourself, set "keyedBy":"ai", and write a short explanation.
- Explanation format: "Answer: <text>" then 1–3 lines why, then one short line per wrong option.
- Assign each question to the ONE closest topic id from the list below (or "" if none fit).
- type: "AMC" if Australian-style / 5 options, else "MBBS".
- Skip fragments cut off at page edges, answer-key-only pages, and non-questions.

TOPIC LIST (id|name):
${await topicListText()}

PAGES:
${pages.map(pg => `--- page ${pg.p} ---\n${pg.text}`).join('\n').slice(0, 60000)}

Return JSON: {"mcqs":[{"type":"MBBS","stem":"","options":[""],"answer":0,"explanation":"","topicId":"","keyedBy":"book"}]}`;
    const out = await AI.call({ prompt, system: SYSTEM_TUTOR, temperature: 0.1 });
    await saveImported(out.mcqs || [], book, pages[0].p);
  },

  async mcqvision(job) {
    const book = await DB.get('books', job.payload.bookId); if (!book) return;
    const canvases = [];
    for (const p of job.payload.pages) canvases.push(await renderPage(book, p, 1600));
    const images = canvases.map(c => c.toDataURL('image/jpeg', 0.8));
    const texts = [];
    for (const p of job.payload.pages) { const pg = await DB.get('pages', [book.id, p]); if (pg) texts.push(`--- page ${p} text ---\n${pg.text.slice(0, 6000)}`); }
    const prompt = `${texts.length ? 'Extracted page text (use it for exact wording; the images show the pictures and layout):\n' + texts.join('\n') + '\n\n' : ''}These ${images.length} images are photos/screenshots of question-bank pages (book: "${book.name}", pages ${job.payload.pages.join(', ')}). They may be photos of a computer screen — read through glare and skew.
Extract every COMPLETE multiple-choice question (a question cut off at the end of the last page belongs to the next batch — skip it; a question whose start is on an earlier page — skip it).
- Copy stem and options faithfully. If the correct answer / explanation is visible (highlighted option, "correct answer", explanation panel), use it and set "keyedBy":"book". Otherwise choose the best answer, set "keyedBy":"ai".
- Explanation format: "Answer: <text>" then 1–3 lines why, then one short line per wrong option.
- If the question includes a clinical image (ECG, X-ray, CT, photo, slide), give "figure":{"image":<0-based image index>,"box_2d":[ymin,xmin,ymax,xmax]} with coordinates normalised 0–1000 of that image. Otherwise "figure":null.
- Assign the ONE closest topic id from the list (or "").
- type "AMC" for AMC/AMEDEX-style questions.

TOPIC LIST (id|name):
${await topicListText()}

Return JSON: {"mcqs":[{"type":"AMC","stem":"","options":[""],"answer":0,"explanation":"","topicId":"","keyedBy":"book","figure":null}]}`;
    const out = await AI.call({ prompt, images, system: SYSTEM_TUTOR, temperature: 0.1 });
    await saveImported(out.mcqs || [], book, job.payload.pages[0], canvases);
  },

  async practical(job) {
    const book = await DB.get('books', job.payload.bookId); if (!book) return;
    const p = job.payload.page;
    const canvas = await renderPage(book, p, 1600);
    const pg = await DB.get('pages', [book.id, p]);
    const prompt = `This is page ${p} of the practical / spotter book "${book.name}".${pg ? '\nPage text (ground truth for captions):\n' + pg.text.slice(0, 4000) : ''}

Find clinically meaningful images: ECGs, X-rays, CT/MRI/US, clinical photographs, gross specimens, histology slides, instruments, charts like partograms. Ignore logos, decorative art, plain tables and text-only diagrams.
For each image (max 4) write ONE exam spotter MCQ in AMC style: short clinical vignette + a clear lead-in ("most likely diagnosis", "next step", "identify the instrument and its use"), EXACTLY 5 options, using the page caption/text as the source of truth.
Give its bounding box as box_2d [ymin,xmin,ymax,xmax] normalised 0–1000. Explanation: "Answer: <text>", why, the key visual signs to recognise, one short line per wrong option.
Assign the ONE closest topic id from the list (or "").

TOPIC LIST (id|name):
${await topicListText()}

Return JSON: {"items":[{"box_2d":[0,0,1000,1000],"caption":"","topicId":"","stem":"","options":["","","","",""],"answer":0,"explanation":""}]}  — or {"items":[]} if there is nothing useful.`;
    const out = await AI.call({ prompt, images: [canvas.toDataURL('image/jpeg', 0.8)], system: SYSTEM_TUTOR, temperature: 0.3 });
    const topics = Object.fromEntries((await DB.live('topics')).map(t => [t.id, t]));
    const list = [];
    for (const it of out.items || []) {
      const crop = cropBox(canvas, it.box_2d); if (!crop) continue;
      const mediaId = 'img-' + uid();
      await DB.put('media', { id: mediaId, data: await compressImage(crop, 1200, 0.8), kind: 'spotter', caption: it.caption || '' });
      const t = topics[it.topicId];
      const m = cleanMcq(it, t, { type: 'IMG', src: `${book.short} p.${p}`, img: mediaId, system: t?.system || '' });
      if (m) list.push(m);
    }
    await DB.putMany('mcqs', list);
  },

  async merge(job) {
    const t = await DB.get('topics', job.payload.topicId); if (!t) return;
    const batch = [];
    for (const id of job.payload.ids) { const m = await DB.get('mcqs', id); if (m && !m.deleted && !m.merged && !m.flagged) batch.push(m); }
    if (batch.length < 2) return;
    const list = batch.map((m, i) => `#${i}${m.img ? ' [HAS IMAGE]' : ''} (${m.type})\nQ: ${m.stem}\nOptions: ${m.options.map((o, k) => String.fromCharCode(65 + k) + '. ' + o).join(' | ')}\nAnswer: ${String.fromCharCode(65 + m.ans)}\nWhy: ${String(m.expl || '').slice(0, 500)}`).join('\n\n');
    const prompt = `Topic: ${t.name}. Below are ${batch.length} MCQs from the student's bank. The student cannot do thousands of questions repeatedly, so shrink this set WITHOUT losing any examinable fact.

TASK
1. DUPLICATES: questions testing the same fact (just reworded) -> keep the single best one, drop the rest.
2. COMBINE: 2–3 questions about the SAME condition whose facts link naturally (e.g. recognise from picture/vignette -> next step, diagnosis -> first-line treatment, investigation -> management, complication -> its management) -> write ONE harder single-best-answer vignette that can only be answered by using all of those facts. If one source has an image, build the vignette around that image (the student must recognise it to answer). The explanation must explicitly teach EVERY source fact, including the diagnosis the student had to infer.
3. Leave everything else alone — never force unrelated questions together, never make the answer ambiguous.
4. Each source question can be used at most once. Follow current Australian guidelines for AMC-style questions (5 options); MBBS-style questions keep 4 options.

Explanation format: "Answer: <text>", then "Facts tested:" bullets (one per source fact), then one short line per wrong option.

QUESTIONS
${list}

Return JSON: {"duplicates":[{"keep":0,"drop":[3]}],"combined":[{"from":[1,4],"image":1,"type":"AMC","stem":"","options":["","","","",""],"answer":0,"explanation":""}]}
"image" = index of the source whose picture to reuse, or null.`;
    const out = await AI.call({ prompt, system: SYSTEM_TUTOR, temperature: 0.4 });
    const used = new Set();
    for (const d of out.duplicates || []) {
      const keep = batch[d.keep]; if (!keep || used.has(d.keep)) continue;
      for (const i of d.drop || []) { const m = batch[i]; if (!m || m === keep || used.has(i)) continue; used.add(i); m.merged = keep.id; m.mergeKind = 'duplicate'; await DB.put('mcqs', m); }
      used.add(d.keep);
    }
    for (const c of out.combined || []) {
      const src = (c.from || []).filter(i => batch[i] && !used.has(i));
      if (src.length < 2) continue;
      const imgSrc = c.image != null && batch[c.image]?.img ? batch[c.image].img : (src.map(i => batch[i]).find(m => m.img)?.img || null);
      const q = cleanMcq(c, t, { type: imgSrc ? 'IMG' : (c.type === 'MBBS' ? 'MBBS' : 'AMC'), src: 'merged', img: imgSrc, system: t.system });
      if (!q) continue;
      q.keyedBy = 'ai'; q.mergedFrom = src.map(i => batch[i].id);
      await DB.put('mcqs', q);
      for (const i of src) { used.add(i); const m = batch[i]; m.merged = q.id; m.mergeKind = 'combined'; await DB.put('mcqs', m); }
    }
  },

  async sheet(job) {
    const t = await DB.get('topics', job.payload.topicId); if (!t) return;
    await Gen.sheet(t);
  },
  async mcqgen(job) {
    const t = await DB.get('topics', job.payload.topicId); if (!t) return;
    await Gen.mcqs(t, job.payload.amc ?? 10, job.payload.mbbs ?? 8);
  }
};

async function saveImported(raw, book, firstPage, canvases) {
  const topics = Object.fromEntries((await DB.live('topics')).map(t => [t.id, t]));
  const list = [];
  for (const m of raw) {
    const t = topics[m.topicId];
    let img = null;
    if (m.figure && canvases && canvases[m.figure.image]) {
      const crop = cropBox(canvases[m.figure.image], m.figure.box_2d);
      if (crop) { img = 'img-' + uid(); await DB.put('media', { id: img, data: await compressImage(crop, 1200, 0.8), kind: 'qbank' }); }
    }
    const forcedType = img ? 'IMG' : (book.role === 'mcq-amc' ? 'AMC' : (m.type === 'AMC' ? 'AMC' : 'MBBS'));
    const q = cleanMcq(m, t, { type: forcedType, src: `${book.short} p.${firstPage}`, img, system: t?.system || '' });
    if (q) list.push(q);
  }
  await DB.putMany('mcqs', list);
}

let _ocr;
async function getOcrWorker() {
  if (_ocr) return _ocr;
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload = res; s.onerror = () => rej(new Error('Could not load OCR engine (offline?)'));
      document.head.appendChild(s);
    });
  }
  _ocr = await Tesseract.createWorker('eng');
  return _ocr;
}

// ---------- Queue ----------
const Queue = {
  running: { local: false, ai: false },
  status: { local: '', ai: '' },
  pausedUntil: 0, pauseMsg: '', manualPause: false,
  listeners: new Set(),
  wake: null,
  emit() { this.listeners.forEach(f => { try { f(); } catch (e) {} }); },

  async add(kind, payload, prio = 5) {
    const j = { id: uid(), kind, lane: LOCAL_KINDS.includes(kind) ? 'local' : 'ai', payload, prio, status: 'pending', tries: 0, created: Date.now() + Math.random() };
    await DB.put('queue', j);
    this.kick();
    return j;
  },
  async next(lane) {
    const pend = await DB.byIndex('queue', 'status', 'pending');
    let c = pend.filter(j => j.lane === lane);
    if (lane === 'ai') {
      // Topic sheets need every book fully read first.
      const localBusy = pend.some(j => j.lane === 'local') || this.running.local;
      if (localBusy) c = c.filter(j => j.kind !== 'sheet' && j.kind !== 'mcqgen');
    }
    c.sort((a, b) => a.prio - b.prio || a.created - b.created);
    return c[0];
  },
  kick() { this.loop('local'); this.loop('ai'); },
  async holdWake(on) {
    try {
      if (on && !this.wake && navigator.wakeLock) { this.wake = await navigator.wakeLock.request('screen'); this.wake.addEventListener('release', () => { this.wake = null; }); }
      if (!on && this.wake) { await this.wake.release(); this.wake = null; }
    } catch (e) {}
  },
  async loop(lane) {
    if (this.running[lane]) return;
    this.running[lane] = true; this.holdWake(true);
    try {
      while (true) {
        if (lane === 'ai' && (this.manualPause || Date.now() < this.pausedUntil)) break;
        const j = await this.next(lane);
        if (!j) break;
        if (lane === 'ai') {
          if (!AI.key) { this.pauseMsg = 'Add your Gemini API key in Settings to start AI jobs.'; break; }
          const wait = AI.lastCall + 60000 / AI.rpm - Date.now();
          if (wait > 0) { this.status.ai = 'Waiting for rate limit…'; this.emit(); await sleep(wait); }
        }
        j.status = 'running'; await DB.put('queue', j);
        const name = j.payload.topicId ? (await DB.get('topics', j.payload.topicId))?.name : (await DB.get('books', j.payload.bookId))?.short;
        this.status[lane] = `${JOB_LABEL[j.kind]}${name ? ' — ' + name : ''}`; this.pauseMsg = ''; this.emit();
        try {
          await Handlers[j.kind](j);
          j.status = 'done'; j.finished = Date.now(); delete j.error;
        } catch (e) {
          console.warn('Job failed', j.kind, e);
          if (e instanceof QuotaError) {
            j.status = 'pending';
            if (e.daily) { this.pausedUntil = Date.now() + 60 * 60 * 1000; this.pauseMsg = 'Gemini daily limit reached. Retrying every hour — keep this tab open, or come back tomorrow.'; }
            else { this.status[lane] = 'Rate limited — retrying shortly'; this.emit(); await sleep(e.retryMs); }
          } else {
            j.tries++; j.error = String(e.message || e).slice(0, 300);
            j.status = j.tries >= 3 ? 'failed' : 'pending';
            if (j.status === 'pending') await sleep(4000);
          }
        }
        await DB.put('queue', j);
        if (j.status !== 'pending' && j.payload.bookId) await markBookIfFinished(j.payload.bookId);
        this.emit();
        if (j.status === 'done' && ['merge', 'sheet', 'mcqgen', 'mcqtext', 'mcqvision', 'practical'].includes(j.kind)) App.softRefresh();
      }
    } finally {
      this.running[lane] = false; this.status[lane] = '';
      if (!this.running.local && !this.running.ai) this.holdWake(false);
      this.emit();
      if (lane === 'ai' && this.pausedUntil > Date.now() && !this.manualPause) {
        clearTimeout(this._retry); this._retry = setTimeout(() => this.kick(), this.pausedUntil - Date.now() + 1000);
      }
      // Re-check: AI lane may have been waiting on local jobs.
      if (lane === 'local') setTimeout(() => this.loop('ai'), 500);
    }
  },
  async counts() {
    const all = await DB.all('queue');
    const c = { pending: 0, running: 0, done: 0, failed: 0, byKind: {} };
    all.forEach(j => { c[j.status]++; const k = c.byKind[j.kind] ||= { pending: 0, done: 0, failed: 0, running: 0 }; k[j.status]++; });
    c.all = all;
    return c;
  },
  async recover() {
    for (const j of await DB.byIndex('queue', 'status', 'running')) { j.status = 'pending'; await DB.put('queue', j); }
  },
  async retryFailed() {
    for (const j of await DB.byIndex('queue', 'status', 'failed')) { j.status = 'pending'; j.tries = 0; await DB.put('queue', j); }
    this.kick();
  },
  async clearDone() { for (const j of await DB.byIndex('queue', 'status', 'done')) await DB.del('queue', j.id); }
};

async function markBookIfFinished(bookId) {
  const b = await DB.get('books', bookId); if (!b || b.status === 'ready') return;
  const left = (await DB.all('queue')).filter(j => j.payload?.bookId === bookId && (j.status === 'pending' || j.status === 'running'));
  if (left.length) return;
  const failed = (await DB.all('queue')).filter(j => j.payload?.bookId === bookId && j.status === 'failed').length;
  b.status = failed ? 'partial' : 'ready'; await DB.put('books', b);
}

// Queue sheet + MCQ generation for many topics at once.
async function queueTopics(topicIds, { prio = 6, force = false } = {}) {
  const pending = (await DB.all('queue')).filter(j => j.status !== 'done' && j.payload?.topicId);
  const queued = new Set(pending.map(j => j.kind + ':' + j.payload.topicId));
  let n = 0;
  for (const [i, id] of topicIds.entries()) {
    const p = prio + i * 0.001; // finish each topic (sheet → MCQs) before starting the next
    const hasSheet = !!(await DB.get('sheets', id));
    if (!queued.has('sheet:' + id) && (force || !hasSheet)) { await Queue.add('sheet', { topicId: id }, p); n++; }
    const hasMcq = (await DB.byIndex('mcqs', 'topicId', id)).some(m => m.src === 'ai' && !m.deleted);
    if (!queued.has('mcqgen:' + id) && (force || !hasMcq)) { await Queue.add('mcqgen', { topicId: id }, p + 0.0005); n++; }
  }
  return n;
}

// Queue "combine overlapping questions" for topics (batches of 30, similar questions grouped together).
async function queueMerge(topicIds, prio = 7) {
  const pending = new Set((await DB.all('queue')).filter(j => j.kind === 'merge' && j.status !== 'done' && j.status !== 'failed').map(j => j.payload.topicId));
  let n = 0;
  for (const id of topicIds) {
    if (pending.has(id)) continue;
    const qs = (await DB.byIndex('mcqs', 'topicId', id)).filter(m => !m.deleted && !m.merged && !m.flagged && m.src !== 'merged');
    if (qs.length < 4) continue;
    qs.sort((a, b) => a.stem.localeCompare(b.stem)); // rough grouping so related stems share a batch
    for (let i = 0; i < qs.length; i += 30) { await Queue.add('merge', { topicId: id, ids: qs.slice(i, i + 30).map(m => m.id) }, prio); n++; }
  }
  return n;
}
