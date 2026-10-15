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
          Queue.setStatus(Queue._laneOf?.[job.id] || 'local', `Reading ${book.short} — page ${i}/${pdf.numPages}`);
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
      for (const c of chunk(textPages, 8)) await Queue.add('mcqtext', { bookId: book.id, pages: c }, 4);
      const visual = [...new Set([...imgPages, ...scanned])].sort((a, b) => a - b);
      for (const c of chunk(visual, 4)) await Queue.add('mcqvision', { bookId: book.id, pages: c }, 4);
    } else if (book.role === 'practical') {
      const all = [...new Set([...imgPages, ...scanned])].sort((a, b) => a - b);
      for (const p of all) await Queue.add('practical', { bookId: book.id, page: p }, 5);
    }
    book.status = scanned.length && ['ref', 'mbbs', 'amc'].includes(book.role) ? 'ocr' : (book.role.startsWith('mcq') || book.role === 'practical') ? 'importing' : 'ready';
    await DB.put('books', book);
  },

  async ocr(job, ctx) {
    const book = await DB.get('books', job.payload.bookId); if (!book) return;
    const done = job.payload.done || [];
    if (ctx?.provider) {
      // A free vision AI reads the scanned pages — much faster than OCR on the laptop.
      const todo = job.payload.pages.filter(p => !done.includes(p));
      for (let i = 0; i < todo.length; i += 3) {
        const batch = todo.slice(i, i + 3);
        Queue.setStatus(ctx.lane, `${ctx.provider.name}: reading ${book.short} — pages ${batch.join(', ')}`);
        const images = []; for (const p of batch) images.push((await renderPage(book, p, 1700)).toDataURL('image/jpeg', 0.82));
        const txt = await Providers.call(ctx.provider, { json: false, temperature: 0, images,
          prompt: `Transcribe ALL text on these ${batch.length} scanned medical textbook pages, in reading order, keeping headings, bullet points, table rows and drug doses. No commentary. Output exactly:\n=== PAGE 1 ===\n<text>\n=== PAGE 2 ===\n<text> …` });
        const parts = txt.split(/===\s*PAGE\s*(\d+)\s*===/i);
        for (let k = 1; k < parts.length; k += 2) {
          const idx = +parts[k] - 1, text = (parts[k + 1] || '').trim();
          if (batch[idx] && text.length > 30) await DB.put('pages', { bookId: book.id, p: batch[idx], text, ocr: 2 });
        }
        if (parts.length < 3 && txt.trim().length > 30) await DB.put('pages', { bookId: book.id, p: batch[0], text: txt.trim(), ocr: 2 });
        done.push(...batch); job.payload.done = done; await DB.put('queue', job);
        await sleep(Math.max(0, 60000 / ctx.provider.rpm));
      }
      return;
    }
    const worker = await getOcrWorker(ctx?.lane || 'local');
    for (const p of job.payload.pages) {
      if (done.includes(p)) continue;
      Queue.setStatus(ctx?.lane || 'local', `OCR ${book.short} — page ${p}`);
      const canvas = await renderPage(book, p, 1700);
      const { data } = await worker.recognize(canvas);
      const text = (data.text || '').replace(/[ \t]+/g, ' ').trim();
      if (text.length > 30) await DB.put('pages', { bookId: book.id, p, text, ocr: 1 });
      done.push(p); job.payload.done = done; await DB.put('queue', job);
    }
    const left = (await DB.all('queue')).filter(j => j.kind === 'ocr' && j.payload.bookId === book.id && j.id !== job.id && j.status !== 'done');
    if (!left.length) { book.status = 'ready'; await DB.put('books', book); }
  },

  async mcqtext(job, ctx) {
    const book = await DB.get('books', job.payload.bookId); if (!book) return;
    const pages = [];
    for (const p of job.payload.pages) { const pg = await DB.get('pages', [book.id, p]); if (pg) pages.push(pg); }
    if (!pages.length) return;
    const first = pages[0].p, last = pages[pages.length - 1].p;
    const extra = await DB.get('pages', [book.id, last + 1]); // next page only to finish a question cut off at the end
    const prompt = `Below is text from pages ${first}–${last} of the question book "${book.name}"${extra ? `, plus page ${last + 1} for context` : ''}.
${IMPORT_RULES(first, last, extra ? last + 1 : null)}

${ctx?.provider ? 'Leave "topicId" as "" (it is assigned later).' : 'TOPIC LIST (id|name):\n' + await topicListText()}

PAGES:
${pages.map(pg => `--- page ${pg.p} ---\n${pg.text}`).join('\n').slice(0, 70000)}
${extra ? `--- page ${last + 1} (CONTEXT ONLY: use it just to complete a question that started on page ${last}) ---\n${extra.text.slice(0, 8000)}` : ''}

Return JSON: {"mcqs":[{"type":"AMC","stem":"","options":[""],"answer":0,"explanation":"","topicId":"","keyedBy":"book"}]}`;
    const out = await bulkCall(ctx, { prompt, system: SYSTEM_IMPORT, temperature: 0 });
    await saveImported(out.mcqs || [], book, first);
  },

  async mcqvision(job, ctx) {
    const book = await DB.get('books', job.payload.bookId); if (!book) return;
    const pgs = job.payload.pages, first = pgs[0], last = pgs[pgs.length - 1];
    const hasNext = last + 1 <= (book.pages || 0);
    const canvases = [];
    const px = ctx?.provider ? 1150 : 1600;
    for (const p of pgs) canvases.push(await renderPage(book, p, px));
    if (hasNext) canvases.push(await renderPage(book, last + 1, ctx?.provider ? 900 : 1200));
    const images = canvases.map(c => c.toDataURL('image/jpeg', 0.8));
    const texts = [];
    if (!ctx?.provider) for (const p of [...pgs, ...(hasNext ? [last + 1] : [])]) { const pg = await DB.get('pages', [book.id, p]); if (pg) texts.push(`--- page ${p} text ---\n${pg.text.slice(0, 7000)}`); }
    const prompt = `${texts.length ? 'Extracted page text (use it for exact wording; the images show pictures and layout):\n' + texts.join('\n') + '\n\n' : ''}The images are pages of the question bank "${book.name}": images 0–${pgs.length - 1} are pages ${pgs.join(', ')}${hasNext ? `, and the LAST image is page ${last + 1} (CONTEXT ONLY, to finish a question cut off at the end of page ${last})` : ''}. They may be photos of a computer screen — read through glare and skew.
${IMPORT_RULES(first, last, hasNext ? last + 1 : null)}
- If a question has a clinical image (ECG, X-ray, CT, photo, slide), give "figure":{"image":<0-based image index>,"box_2d":[ymin,xmin,ymax,xmax]} normalised 0–1000 within that image. Otherwise "figure":null.

${ctx?.provider ? 'Leave "topicId" as "" (it is assigned later).' : 'TOPIC LIST (id|name):\n' + await topicListText()}

Return JSON: {"mcqs":[{"type":"AMC","stem":"","options":[""],"answer":0,"explanation":"","topicId":"","keyedBy":"book","figure":null}]}`;
    const out = await bulkCall(ctx, { prompt, images, system: SYSTEM_IMPORT, temperature: 0 });
    await saveImported(out.mcqs || [], book, first, canvases);
  },

  async practical(job, ctx) {
    const book = await DB.get('books', job.payload.bookId); if (!book) return;
    const p = job.payload.page;
    const canvas = await renderPage(book, p, ctx?.provider ? 1150 : 1600);
    const pg = await DB.get('pages', [book.id, p]);
    const prompt = `This is page ${p} of the practical / spotter book "${book.name}".${pg ? '\nPage text (ground truth for captions):\n' + pg.text.slice(0, 4000) : ''}

Find clinically meaningful images: ECGs, X-rays, CT/MRI/US, clinical photographs, gross specimens, histology slides, instruments, charts like partograms. Ignore logos, decorative art, plain tables and text-only diagrams.
For each image (max 4) write ONE exam spotter MCQ in AMC style: short clinical vignette + a clear lead-in ("most likely diagnosis", "next step", "identify the instrument and its use"), EXACTLY 5 options, using the page caption/text as the source of truth.
Give its bounding box as box_2d [ymin,xmin,ymax,xmax] normalised 0–1000. Explanation: "Answer: <text>", why, the key visual signs to recognise, one short line per wrong option.
Assign the ONE closest topic id from the list (or "").

${ctx?.provider ? 'Leave "topicId" as "" (it is assigned later).' : 'TOPIC LIST (id|name):\n' + await topicListText()}

Return JSON: {"items":[{"box_2d":[0,0,1000,1000],"caption":"","topicId":"","stem":"","options":["","","","",""],"answer":0,"explanation":""}]}  — or {"items":[]} if there is nothing useful.`;
    const out = await bulkCall(ctx, { prompt, images: [canvas.toDataURL('image/jpeg', 0.8)], system: SYSTEM_TUTOR, temperature: 0.3 });
    const topics = Object.fromEntries((await DB.live('topics')).map(t => [t.id, t]));
    const list = [];
    for (const it of out.items || []) {
      const crop = cropBox(canvas, it.box_2d); if (!crop) continue;
      const mediaId = 'img-' + uid();
      await DB.put('media', { id: mediaId, data: await compressImage(crop, 1200, 0.8), kind: 'spotter', caption: it.caption || '' });
      const t = topics[it.topicId] || await matchTopic(`${it.caption || ''} ${it.stem} ${(it.options || []).join(' ')} ${it.explanation || ''}`);
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
    const list = batch.map((m, i) => `#${i}${m.img ? ' [HAS IMAGE]' : ''} (${m.type})\nQ: ${m.stem}\nOptions: ${m.options.map((o, k) => String.fromCharCode(65 + k) + '. ' + o).join(' | ')}\nAnswer: ${letters(correctSet(m))}\nWhy: ${String(m.expl || '').slice(0, 500)}`).join('\n\n');
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

const SYSTEM_IMPORT = 'You are a meticulous data-entry assistant digitising the student\'s own purchased question bank for private study. Completeness and exactness matter more than anything: never skip, merge, summarise or rewrite questions.';
const IMPORT_RULES = (first, last, ctxPage) => `Extract EVERY multiple-choice question that STARTS on pages ${first}–${last}. Do not skip any — the student needs the complete bank.
- If a question starts on page ${last} and continues onto ${ctxPage ? 'page ' + ctxPage : 'the next page'}, ${ctxPage ? 'finish it using page ' + ctxPage : 'include whatever is present'}. Do NOT include questions that start on ${ctxPage ? 'page ' + ctxPage : 'a later page'}, and do NOT include the tail end of a question that started before page ${first} (the previous batch has it).
- Copy the stem and every option EXACTLY as written (fix only obvious OCR/spacing errors). Keep all options in their original order. Do not put A–E letters inside the option text.
- Answer: use the book's answer ("keyedBy":"book"). Only if the book shows no answer, choose the best one yourself and set "keyedBy":"ai".
- If MORE THAN ONE option is correct (old-style AMC \"could be due to / which are true\" questions, or the key lists several letters), give ALL of them in "answers" as 0-based indexes, e.g. "answers":[1,2,3], and set "answer" to the first.
- Explanation: copy the book's explanation IN FULL, word for word, including the notes on each wrong option. Only if the book has none, write: "Answer: <text>", 1–3 lines why, and one short line per wrong option.
- Assign each question to the ONE closest topic id from the list (or "" if none fits).
- type: "AMC" for Australian / AMC / AMEDEX-style (usually 5 options), otherwise "MBBS".
- Ignore headers, footers, page numbers, adverts and answer-key-only pages.`;

let _termCache = null;
async function matchTopic(text) {
  if (!_termCache) _termCache = (await DB.live('topics')).map(t => ({ t, terms: topicTerms(t) }));
  let best = null, bs = 0;
  for (const x of _termCache) { const sc = scorePage(text, x.terms); if (sc > bs) { bs = sc; best = x.t; } }
  return bs >= 2 ? best : null;
}
async function saveImported(raw, book, firstPage, canvases) {
  const topics = Object.fromEntries((await DB.live('topics')).map(t => [t.id, t]));
  const list = [];
  for (const m of raw) {
    const t = topics[m.topicId] || await matchTopic(`${m.stem} ${(m.options || []).join(' ')} ${m.explanation || ''}`);
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

const _ocrWorkers = {};
async function getOcrWorker(lane = 'local') {
  if (_ocrWorkers[lane]) return _ocrWorkers[lane];
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload = res; s.onerror = () => rej(new Error('Could not load OCR engine (offline?)'));
      document.head.appendChild(s);
    });
  }
  _ocrWorkers[lane] = await Tesseract.createWorker('eng');
  return _ocrWorkers[lane];
}

// ---------- Queue ----------
const BULK_KINDS = ['mcqtext', 'mcqvision', 'practical'];
const Queue = {
  running: {}, status: {}, paused: {}, hits: {}, last: {},
  pauseMsg: '', manualPause: false, claimed: new Set(),
  listeners: new Set(),
  wake: null,
  emit() { this.listeners.forEach(f => { try { f(); } catch (e) {} }); },
  setStatus(lane, txt) { this.status[lane] = txt; this.emit(); },
  get pausedUntil() { return this.paused.ai || 0; },
  set pausedUntil(v) { this.paused.ai = v; },
  set limitHits(v) { this.hits.ai = v; },

  async add(kind, payload, prio = 5) {
    const j = { id: uid(), kind, lane: LOCAL_KINDS.includes(kind) ? 'local' : 'ai', payload, prio, status: 'pending', tries: 0, created: Date.now() + Math.random() };
    await DB.put('queue', j);
    this.kick();
    return j;
  },
  // Which jobs each lane may take: local = OCR/reading, ai = Gemini (everything AI), p:<id> = free providers (bulk + OCR if it can see images).
  accepts(lane, j, prov) {
    if (lane.startsWith('local')) return j.lane === 'local';
    if (lane === 'ai') return j.lane === 'ai' && !j.noGemini;
    if (!prov || j.noProv) return false;
    if (j.kind === 'mcqtext') return true;
    if (prov.vision && (j.kind === 'mcqvision' || j.kind === 'practical' || j.kind === 'ocr')) return true;
    return false;
  },
  providerOcr() { return Providers.active().some(p => p.vision); },
  async next(lane, prov) {
    const pend = (await DB.byIndex('queue', 'status', 'pending')).filter(j => !this.claimed.has(j.id));
    let c = pend.filter(j => this.accepts(lane, j, prov));
    if (lane === 'ai') {
      const localBusy = pend.some(j => j.lane === 'local') || (await DB.byIndex('queue', 'status', 'running')).some(j => j.lane === 'local');
      if (localBusy) c = c.filter(j => j.kind !== 'sheet' && j.kind !== 'mcqgen');
    }
    // Providers help with OCR only when there is no import work for them.
    if (lane.startsWith('p:')) { const bulk = c.filter(j => j.kind !== 'ocr'); if (bulk.length) c = bulk; }
    c.sort((a, b) => a.prio - b.prio || a.created - b.created);
    return c[0];
  },
  // Several OCR workers on the laptop at once (one per spare CPU core, max 3).
  localLanes() { const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)); return Array.from({ length: n }, (_, i) => i ? 'local' + (i + 1) : 'local'); },
  lanes() { return [...this.localLanes(), 'ai', ...Providers.active().map(p => 'p:' + p.id)]; },
  kick() { this.lanes().forEach(l => this.loop(l)); },
  async holdWake(on) {
    try {
      if (on && localStorage.getItem('keepAwake') === '0') on = false;
      if (on && !this.wake && navigator.wakeLock) { this.wake = await navigator.wakeLock.request('screen'); this.wake.addEventListener('release', () => { this.wake = null; }); }
      if (!on && this.wake) { await this.wake.release(); this.wake = null; }
    } catch (e) {}
  },
  async loop(lane) {
    if (this.running[lane]) return;
    const isAI = !lane.startsWith('local');
    this.running[lane] = true; this.holdWake(true);
    try {
      while (true) {
        const prov = lane.startsWith('p:') ? Providers.get(lane.slice(2)) : null;
        if (lane.startsWith('p:') && !(prov && prov.key && prov.model && prov.on !== false)) break;
        if (isAI && (this.manualPause || Date.now() < (this.paused[lane] || 0))) break;
        if (lane === 'ai' && !AI.key) { this.pauseMsg = 'Add your Gemini API key in Settings to start AI jobs.'; break; }
        const j = await this.next(lane, prov);
        if (!j) break;
        if (this.claimed.has(j.id)) { await sleep(30); continue; }
        this.claimed.add(j.id);
        try {
          if (isAI) {
            const rpm = prov ? prov.rpm : AI.rpm, lastT = prov ? (this.last[lane] || 0) : AI.lastCall;
            const wait = lastT + 60000 / rpm - Date.now();
            if (wait > 0) { this.setStatus(lane, `${prov ? prov.name : 'Gemini'}: waiting for rate limit…`); await sleep(wait); }
            this.last[lane] = Date.now();
          }
          j.status = 'running'; await DB.put('queue', j);
          const name = j.payload.topicId ? (await DB.get('topics', j.payload.topicId))?.name : (await DB.get('books', j.payload.bookId))?.short;
          this.setStatus(lane, `${prov ? prov.name + ': ' : lane === 'ai' ? 'Gemini: ' : ''}${JOB_LABEL[j.kind]}${name ? ' — ' + name : ''}`);
          try {
            (this._laneOf ||= {})[j.id] = lane;
            await Handlers[j.kind](j, { lane, provider: prov });
            this.hits[lane] = 0;
            j.status = 'done'; j.finished = Date.now(); delete j.error;
          } catch (e) {
            console.warn('Job failed', lane, j.kind, e);
            if (e instanceof QuotaError) {
              j.status = 'pending';
              this.hits[lane] = (this.hits[lane] || 0) + 1;
              if (e.daily || this.hits[lane] >= 4) {
                this.paused[lane] = Date.now() + 30 * 60 * 1000; this.hits[lane] = 0;
                const msg = `${prov ? prov.name : 'Gemini'} limit reached — resting 30 min, the others keep working. (${String(e.message || '').slice(0, 160)})`;
                if (lane === 'ai') this.pauseMsg = msg; else this.status[lane] = msg;
                setTimeout(() => this.loop(lane), 30 * 60 * 1000 + 1000);
              } else { this.setStatus(lane, `${prov ? prov.name : 'Gemini'}: rate limited — retrying shortly (${this.hits[lane]}/4)`); await sleep(Math.max(e.retryMs, 20000)); }
            } else {
              if (lane === 'ai' && /RECITATION/i.test(e.message || '') && Providers.active().length) {
                j.noGemini = 1; j.status = 'pending'; j.error = 'Blocked by Gemini’s copyright filter — handing it to ' + Providers.active().map(p => p.name).join(' / ');
                await DB.put('queue', j); this.emit(); continue;
              }
              if (prov && /too large|reduce your message|context length|maximum context|too many tokens|payload/i.test(e.message || '')) {
                j.noProv = 1; j.status = 'pending'; delete j.error; await DB.put('queue', j); this.emit(); continue;
              }
              j.tries++; j.error = (prov ? prov.name + ': ' : '') + String(e.message || e).slice(0, 300);
              if (/RECITATION/i.test(e.message || '')) j.error = 'Gemini’s copyright filter blocked these pages. Add a free Groq/Mistral/GitHub key in Settings, then press Retry — they can import them.';
              j.status = j.tries >= 3 ? 'failed' : 'pending';
              if (j.status === 'pending') await sleep(4000);
            }
          }
          await DB.put('queue', j);
          if (j.status !== 'pending' && j.payload.bookId) await markBookIfFinished(j.payload.bookId);
          this.emit();
          if (j.status === 'done' && ['merge', 'sheet', 'mcqgen', 'mcqtext', 'mcqvision', 'practical'].includes(j.kind)) App.softRefresh();
        } finally { this.claimed.delete(j.id); }
      }
    } finally {
      this.running[lane] = false;
      if (!(this.paused[lane] > Date.now())) this.status[lane] = '';
      if (!Object.values(this.running).some(Boolean)) this.holdWake(false);
      this.emit();
      if (lane === 'ai' && this.pausedUntil > Date.now() && !this.manualPause) {
        clearTimeout(this._retry); this._retry = setTimeout(() => this.kick(), this.pausedUntil - Date.now() + 1000);
      }
      if (lane.startsWith('local')) setTimeout(() => this.loop('ai'), 500);
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
    for (const j of await DB.byIndex('queue', 'status', 'failed')) { j.status = 'pending'; j.tries = 0; if (/too large|reduce your message/i.test(j.error || '')) j.noProv = 1; await DB.put('queue', j); }
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
    const qs = (await DB.byIndex('mcqs', 'topicId', id)).filter(m => !m.deleted && !m.merged && !m.flagged && m.src === 'ai'); // only AI-written questions; book/AMEDEX questions are never merged or hidden
    if (qs.length < 4) continue;
    qs.sort((a, b) => a.stem.localeCompare(b.stem)); // rough grouping so related stems share a batch
    for (let i = 0; i < qs.length; i += 30) { await Queue.add('merge', { topicId: id, ids: qs.slice(i, i + 30).map(m => m.id) }, prio); n++; }
  }
  return n;
}
