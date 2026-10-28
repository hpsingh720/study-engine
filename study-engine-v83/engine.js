// Book ingestion + background job queue.
// Two lanes run side by side: "local" (text extraction, OCR — free, no AI) and "ai" (Gemini calls, rate-limited).
const LOCAL_KINDS = ['extract', 'ocr', 'refs', 'embed'];
const coolMode = () => (+localStorage.getItem('ocrWorkers') || 2) === 1; // 'Cool' laptop setting: one reader with rests
const JOB_LABEL = {
  refs: 'Linking questions to book pages',
  embed: 'Preparing offline AI search',
  extract: 'Reading book', ocr: 'OCR scanned pages', mcqtext: 'Importing MCQs', mcqvision: 'Importing MCQs from photos',
  practical: 'Making image spotters', figure: 'Attaching question pictures', sheet: 'Writing topic sheet', mcqgen: 'Writing MCQs', merge: 'Combining questions'
};

function guessRole(name) {
  const n = name.toLowerCase();
  if (/uworld|\buw\b|usmle|step ?2/.test(n)) return 'mcq-uworld';
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
const _pdfUsed = new Map();
async function getPdf(bookId) {
  await ensurePdfjs();
  _pdfUsed.set(bookId, Date.now());
  if (PdfCache.has(bookId)) return PdfCache.get(bookId);
  const f = await DB.get('files', bookId);
  if (!f) throw new Error('Original file missing on this device');
  // Read the book in 1 MB pieces only when needed, instead of loading a 1–2 GB scan into memory at once
  // (that is what made Chrome say "the requested file could not be read").
  let pdf;
  try {
    const blob = f.blob;
    class BlobRange extends pdfjsLib.PDFDataRangeTransport {
      requestDataRange(begin, end) {
        blob.slice(begin, end).arrayBuffer().then(b => this.onDataRange(begin, new Uint8Array(b))).catch(err => console.warn('range read', err));
      }
    }
    let whole = null;
    if (blob.size < 700 * 1024 * 1024) { try { whole = await blob.arrayBuffer(); } catch (e) { whole = null; } }
    if (whole) pdf = await pdfjsLib.getDocument({ data: whole }).promise;
    else {
      const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer());
      pdf = await pdfjsLib.getDocument({ range: new BlobRange(blob.size, head), rangeChunkSize: 4 << 20, disableAutoFetch: false, disableStream: true }).promise;
    }
  } catch (e) {
    if (/NotReadable|could not be read/i.test((e && (e.name + ' ' + e.message)) || '')) {
      const b = await DB.get('books', bookId); if (b) { b.fileLost = 1; b.status = 'partial'; await DB.put('books', b); }
      throw new Error('This book’s saved copy can’t be read. In Library, add the same PDF again — it will repair this book and carry on.');
    }
    throw e;
  }
  // Keep a few books open. Close the least-recently-used one only after a delay,
  // so a worker still reading it can finish (closing it straight away froze that worker for ever).
  if (PdfCache.size >= 5) {
    const old = [...PdfCache.keys()].filter(k => k !== bookId).sort((a, b) => (_pdfUsed.get(a) || 0) - (_pdfUsed.get(b) || 0))[0];
    const v = PdfCache.get(old); PdfCache.delete(old);
    setTimeout(() => { if (!PdfCache.has(old)) v.destroy?.(); }, 5 * 60 * 1000);
  }
  PdfCache.set(bookId, pdf);
  return pdf;
}
// Give up on one PDF step after `ms` instead of waiting for ever.
function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);
}
function dropPdf(bookId) { const v = PdfCache.get(bookId); PdfCache.delete(bookId); if (v) setTimeout(() => { if (!PdfCache.has(bookId) || PdfCache.get(bookId) !== v) v.destroy?.(); }, 10 * 60000); }

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
  let pdf = await getPdf(book.id), page;
  try { page = await withTimeout(pdf.getPage(p), 60000, 'open page'); }
  catch (e) { dropPdf(book.id); pdf = await getPdf(book.id); page = await withTimeout(pdf.getPage(p), 60000, 'open page'); }
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(3, target / Math.max(v1.width, v1.height)) });
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  const task = page.render({ canvasContext: ctx, viewport: vp });
  try { await withTimeout(task.promise, 300000, 'draw page ' + p); } catch (e) { try { task.cancel(); } catch (x) {} throw e; }
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
  // Offline AI search: make meaning-vectors for every page of a book that doesn't have them yet.
  async embed(job) {
    const book = await DB.get('books', job.payload.bookId); if (!book) return;
    const pages = []; await DB.each('pages', 'bookId', book.id, pg => pages.push(pg));
    let batch = [], meta = [], done = 0;
    const flush = async () => {
      if (!batch.length) return;
      const vs = await Semantic.embed(batch);
      await DB.putMany('vecs', vs.map((v, i) => ({ ...meta[i], v: Semantic.quant(v) })));
      batch = []; meta = [];
    };
    for (const pg of pages) {
      if (await DB.get('vecs', [book.id, pg.p, 0])) continue;
      Semantic.chunks(pg.text).forEach((ch, c) => { batch.push(ch.text); meta.push({ bookId: book.id, p: pg.p, c, off: ch.off }); });
      if (batch.length >= 8) { await flush(); await sleep(coolMode() ? 2500 : 400); } // short rests keep the laptop cool
      if (++done % 50 === 0) Queue.setStatus(Queue._laneOf?.[job.id] || 'local', `Preparing offline AI search — ${book.short} (${done}/${pages.length} pages)`);
    }
    await flush();
  },

  // Link each question of one topic to the best pages in your books, so phones can show "Read first" even when the laptop is off.
  async refs(job) {
    const topic = await DB.get('topics', job.payload.topicId); if (!topic) return;
    const pagesNow = await DB.count('pages');
    // Redo links when many new book pages have been read since (e.g. a scanned book finished).
    const qs = (await DB.byIndex('mcqs', 'topicId', topic.id)).filter(m => !m.deleted && (!m.refs || (m.refsN || 0) < pagesNow * 0.9));
    if (!qs.length) return;
    const books = (await DB.all('books')).filter(b => ['ref', 'mbbs', 'amc'].includes(b.role));
    if (!books.length) return; // e.g. a phone with only reading copies: leave the laptop's links alone
    const tTerms = topicTerms(topic);
    // Candidate pages for the topic (read once), then score each question against just those.
    const cand = [];
    for (const b of books) {
      const best = [];
      await DB.each('pages', 'bookId', b.id, pg => { const sc = scorePage(pg.text, tTerms); if (sc > 0) { best.push({ s: sc, bookId: b.id, size: b.size, p: pg.p, book: b.short || b.name, text: pg.text }); if (best.length > 60) { best.sort((x, y) => y.s - x.s); best.length = 25; } } });
      best.sort((x, y) => y.s - x.s); cand.push(...best.slice(0, 25));
    }
    let n = 0;
    for (const m of qs) {
      const correct = correctSet(m).map(i => m.options[i]).join(' ');
      const words = ((m.stem + ' ' + correct).toLowerCase().match(/[a-z][a-z-]{5,}/g) || []).filter(w => !STOP.has(w));
      const kw = [...new Set(words)].sort((x, y) => y.length - x.length).slice(0, 8);
      const qTerms = topicTerms({ name: '', kw: [...kw, ...correct.toLowerCase().split(/[,;/]/).map(x => x.trim()).filter(x => x.length > 3)] });
      const scored = cand.map(c => ({ ...c, q: qTerms.length ? scorePage(c.text, qTerms) : 0 })).filter(c => c.q > 0).sort((x, y) => (y.q + y.s * 0.2) - (x.q + x.s * 0.2));
      const seen = new Set(), refs = [];
      for (const c of scored) { if (seen.has(c.bookId)) continue; seen.add(c.bookId); refs.push({ book: c.book, bookId: c.bookId, size: c.size, p: c.p }); if (refs.length >= 3) break; }
      m.refs = refs; m.refsN = pagesNow; await DB.put('mcqs', m); n++;
      if (n % 25 === 0) Queue.setStatus(Queue._laneOf?.[job.id] || 'local', `Linking questions to book pages — ${topic.name} (${n}/${qs.length})`);
    }
  },

  async extract(job) {
    const book = await DB.get('books', job.payload.bookId);
    if (!book) return;
    book.status = 'reading'; await DB.put('books', book);
    const scanned = job.payload.scanned || [], imgPages = job.payload.imgPages || [];
    if (book.kind === 'images') {
      for (let i = 1; i <= book.pages; i++) scanned.push(i);
    } else {
      let pdf = await withTimeout(getPdf(book.id), 10 * 60000, 'open book');
      book.pages = pdf.numPages;
      let batch = [];
      const start = job.payload.from || 1;
      await ensurePdfjs(); const OPS = pdfjsLib.OPS;
      for (let i = start; i <= pdf.numPages; i++) {
        let page, tc;
        try {
          page = await withTimeout(pdf.getPage(i), 60000, 'page ' + i);
          tc = await withTimeout(page.getTextContent(), 60000, 'text of page ' + i);
        } catch (e) {
          // A page that hangs: reopen the book once and retry; if it hangs again, read it later by OCR.
          dropPdf(book.id); pdf = await withTimeout(getPdf(book.id), 10 * 60000, 'reopen book');
          try { page = await withTimeout(pdf.getPage(i), 60000, 'page ' + i); tc = await withTimeout(page.getTextContent(), 60000, 'text of page ' + i); }
          catch (e2) { scanned.push(i); dropPdf(book.id); pdf = await getPdf(book.id); continue; }
        }
        if (i % 5 === 0) Queue.setStatus(Queue._laneOf?.[job.id] || 'local', `Reading ${book.short} — page ${i}/${pdf.numPages}`);
        const text = tc.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (text.length >= 80) batch.push({ bookId: book.id, p: i, text }); else scanned.push(i);
        if ((book.role === 'practical' || book.role.startsWith('mcq')) && text.length >= 80) {
          let ops = { fnArray: [] }; try { ops = await withTimeout(page.getOperatorList(), 60000, 'pictures on page ' + i); } catch (e) { imgPages.push(i); }
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
      if (batch.length) await DB.putMany('pages', batch);
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
      await addMcqText(book.id, textPages, 0);
      // Scanned PDF pages: read them on the laptop (free), then import as text — far fewer AI tokens than page pictures.
      // Photo sets (screen photos) and text pages with embedded pictures still go to vision.
      if (book.kind === 'pdf') for (const c of chunk(scanned, 4)) await Queue.add('ocr', { bookId: book.id, pages: c, then: 'mcqtext' }, 3);
      const visual = [...new Set([...imgPages, ...(book.kind === 'pdf' ? [] : scanned)])].sort((a, b) => a - b);
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
    if (ctx?.provider?.ocrApi) {
      // OCR.space: one page per request (pictures must stay under 1 MB).
      for (const p of job.payload.pages) {
        if (done.includes(p)) continue;
        Queue.setStatus(ctx.lane, `${ctx.provider.name}: reading ${book.short} — page ${p}`);
        const c = await renderPage(book, p, 1600);
        let url = c.toDataURL('image/jpeg', 0.7); if (url.length * 0.75 > 950000) url = c.toDataURL('image/jpeg', 0.45);
        const text = (await Providers.ocrPage(ctx.provider, url)).replace(/[ \t]+/g, ' ').trim();
        if (text.length > 30) await DB.put('pages', { bookId: book.id, p, text, ocr: 3 });
        (Queue.ocrTimes ||= []).push(Date.now()); (Queue.ocrWho ||= []).push(ctx.provider.name);
        done.push(p); job.payload.done = done; await DB.put('queue', job);
        await sleep(Math.max(0, 60000 / ctx.provider.rpm));
      }
      if (job.payload.then === 'mcqtext') await addMcqText(book.id, job.payload.pages, 1);
      return;
    }
    if (ctx?.provider) {
      // A free vision AI reads the scanned pages — much faster than OCR on the laptop.
      const todo = job.payload.pages.filter(p => !done.includes(p));
      for (let i = 0; i < todo.length; i += 3) {
        const batch = todo.slice(i, i + 3);
        Queue.setStatus(ctx.lane, `${ctx.provider.name}: reading ${book.short} — pages ${batch.join(', ')}`);
        const images = []; for (const p of batch) images.push((await renderPage(book, p, 1400)).toDataURL('image/jpeg', 0.78)); // a bit smaller: quicker to draw and send, still sharp enough to read
        const txt = await Providers.call(ctx.provider, { json: false, temperature: 0, images,
          prompt: `Transcribe ALL text on these ${batch.length} scanned medical textbook pages, in reading order, keeping headings, bullet points, table rows and drug doses. No commentary. Output exactly:\n=== PAGE 1 ===\n<text>\n=== PAGE 2 ===\n<text> …` });
        const parts = txt.split(/===\s*PAGE\s*(\d+)\s*===/i);
        for (let k = 1; k < parts.length; k += 2) {
          const idx = +parts[k] - 1, text = (parts[k + 1] || '').trim();
          if (batch[idx] && text.length > 30) await DB.put('pages', { bookId: book.id, p: batch[idx], text, ocr: 2 });
        }
        if (parts.length < 3 && txt.trim().length > 30) await DB.put('pages', { bookId: book.id, p: batch[0], text: txt.trim(), ocr: 2 });
        for (const _ of batch) (Queue.ocrTimes ||= []).push(Date.now()), (Queue.ocrWho ||= []).push(ctx.provider.name);
        done.push(...batch); job.payload.done = done; await DB.put('queue', job);
        await sleep(Math.max(0, 60000 / ctx.provider.rpm));
      }
      if (job.payload.then === 'mcqtext') await addMcqText(book.id, job.payload.pages, 1);
      return;
    }
    for (const p of job.payload.pages) {
      if (done.includes(p)) continue;
      const worker = await getOcrWorker(ctx?.lane || 'local'); _ocrUses[ctx?.lane || 'local'] = (_ocrUses[ctx?.lane || 'local'] || 0) + 1;
      Queue.setStatus(ctx?.lane || 'local', `OCR ${book.short} — page ${p}`);
      // Pages that timed out before get drawn smaller on the retry, so they finish.
      const canvas = await renderPage(book, p, (job.tries || job.rounds) ? 1200 : 1700);
      const { data } = await worker.recognize(canvas);
      if (coolMode()) await sleep(3000); // Cool setting: let the processor rest between pages
      const text = (data.text || '').replace(/[ \t]+/g, ' ').trim();
      if (text.length > 30) await DB.put('pages', { bookId: book.id, p, text, ocr: 1 });
      (Queue.ocrTimes ||= []).push(Date.now()); (Queue.ocrWho ||= []).push('Laptop');
      done.push(p); job.payload.done = done; await DB.put('queue', job);
    }
    if (job.payload.then === 'mcqtext') { await addMcqText(book.id, job.payload.pages, 1); return; }
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

${job.payload.ocr ? '- This text was read from scanned pages by OCR: silently fix OCR mistakes (broken words, wrong letters, stray symbols) but do not change meaning.\n' : ''}- "page": the page number the question starts on. "hasFigure": true if the question refers to a picture, ECG, X-ray, scan, photo or "the image shown".

Return JSON: {"mcqs":[{"type":"AMC","stem":"","options":[""],"answer":0,"explanation":"","topicId":"","keyedBy":"book","page":${first},"hasFigure":false}]}`;
    const out = await bulkCall(ctx, { prompt, system: SYSTEM_IMPORT, temperature: 0 });
    await saveImported(out.mcqs || [], book, first, null, !!job.payload.ocr);
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
      const m = cleanMcq(it, t, { type: 'IMG', src: `${book.short} p.${p}`, img: mediaId, system: t?.system || '' }); m.spot = 1;
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

  async figure(job, ctx) {
    const book = await DB.get('books', job.payload.bookId); const m = await DB.get('mcqs', job.payload.mcqId);
    if (!book || !m || m.img) return;
    const pages = [job.payload.page, job.payload.page + 1].filter(p => p <= (book.pages || 0));
    const canvases = []; for (const p of pages) canvases.push(await renderPage(book, p, ctx?.provider ? 1150 : 1500));
    const out = await bulkCall(ctx, { temperature: 0, images: canvases.map(c => c.toDataURL('image/jpeg', 0.8)),
      prompt: `These are page ${pages.join(' and ')} of a question book. Find the clinical picture (ECG, X-ray, CT, photo, slide, chart) that belongs to this question:\n"${m.stem.slice(0, 300)}"\nReturn JSON {"image":<0-based index of the page image>,"box_2d":[ymin,xmin,ymax,xmax]} normalised 0–1000, or {"image":null} if there is no such picture.` });
    if (out.image == null || !canvases[out.image]) return;
    const crop = cropBox(canvases[out.image], out.box_2d); if (!crop) return;
    const id = 'img-' + uid();
    await DB.put('media', { id, data: await compressImage(crop, 1200, 0.8), kind: 'qbank' });
    m.img = id; m.type = 'IMG'; await DB.put('mcqs', m);
  },

  async sheet(job, ctx) {
    const t = await DB.get('topics', job.payload.topicId); if (!t) return;
    await Gen.sheet(t, ctx);
  },
  async mcqgen(job, ctx) {
    const t = await DB.get('topics', job.payload.topicId); if (!t) return;
    await Gen.mcqs(t, job.payload.amc ?? 10, job.payload.mbbs ?? 8, ctx);
  },
  // Turn a finished lecture transcript into questions (see lectures.js).
  async lectureMcqs(job) {
    if (typeof Lectures === 'undefined') return;
    await Lectures.generate(job.payload.lectureId);
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
async function saveImported(raw, book, firstPage, canvases, scannedSrc) {
  const topics = Object.fromEntries((await DB.live('topics')).map(t => [t.id, t]));
  const list = [];
  for (const m of raw) {
    const t = topics[m.topicId] || await matchTopic(`${m.stem} ${(m.options || []).join(' ')} ${m.explanation || ''}`);
    let img = null;
    if (m.figure && canvases && canvases[m.figure.image]) {
      const crop = cropBox(canvases[m.figure.image], m.figure.box_2d);
      if (crop) { img = 'img-' + uid(); await DB.put('media', { id: img, data: await compressImage(crop, 1200, 0.8), kind: 'qbank' }); }
    }
    const forcedType = img ? 'IMG' : (book.role === 'mcq-amc' || book.role === 'mcq-uworld' ? 'AMC' : (m.type === 'AMC' ? 'AMC' : 'MBBS'));
    const pg = +m.page || firstPage;
    const q = cleanMcq(m, t, { type: forcedType, src: `${book.short} p.${pg}`, img, system: t?.system || '' });
    if (q) { list.push(q); if (scannedSrc && m.hasFigure && !img) q._fig = pg; }
  }
  await DB.putMany('mcqs', list);
  for (const q of list) if (q._fig) await Queue.add('figure', { bookId: book.id, page: q._fig, mcqId: q.id }, 5);
}

const _ocrWorkers = {};
const _ocrUses = {};
async function getOcrWorker(lane = 'local') {
  // The OCR engine slows down as it builds up memory: start a fresh one every 60 pages.
  if (_ocrWorkers[lane] && (_ocrUses[lane] || 0) >= 60) { const w = _ocrWorkers[lane]; delete _ocrWorkers[lane]; _ocrUses[lane] = 0; try { await w.terminate(); } catch (e) {} }
  if (_ocrWorkers[lane]) return _ocrWorkers[lane];
  await ensureTesseract();
  _ocrWorkers[lane] = await Tesseract.createWorker('eng');
  return _ocrWorkers[lane];
}

// Text imports in small pieces (2 pages) so every free AI can take them, not only Gemini.
async function addMcqText(bookId, pages, ocr) {
  for (let i = 0; i < pages.length; i += 2) await Queue.add('mcqtext', ocr ? { bookId, pages: pages.slice(i, i + 2), ocr: 1 } : { bookId, pages: pages.slice(i, i + 2) }, 4);
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
    // Linking questions to pages is light work: only the first page reader does it, the others keep reading scanned pages.
    if (lane.startsWith('local')) return j.lane === 'local' && ((j.kind !== 'refs' && j.kind !== 'embed') || lane === 'local');
    if (lane === 'ai') return j.lane === 'ai' && !j.noGemini;
    if (!prov || j.noProv) return false;
    if (prov.ocrApi) return j.kind === 'ocr'; // OCR.space only reads scanned pages
    if (prov.ocrOnly) return j.kind === 'ocr' && !Queue.pendingAI; // your own key only reads pages while it has no sheets/MCQs to write
    // Topic sheets and new MCQs need a big, careful model: Gemini first; Mistral takes over while Gemini is out for the day.
    if ((j.kind === 'sheet' || j.kind === 'mcqgen') && prov.big) return true; // a second Gemini key writes sheets like the main one
    if (j.kind === 'sheet' || j.kind === 'mcqgen') return prov.id === 'mistral' && (j.noGemini || Date.now() < (this.paused.ai || 0)) && (j.kind === 'mcqgen' || j.prio < 6 || !this._localBusy);
    if (['mcqtext', 'review', 'verify', 'arbit', 'twins'].includes(j.kind)) return true;
    if (prov.vision && (j.kind === 'mcqvision' || j.kind === 'practical' || j.kind === 'ocr' || j.kind === 'figure')) return true;
    return false;
  },
  providerOcr() { return Providers.active().some(p => p.vision); },
  async next(lane, prov) {
    const pend = (await DB.byIndex('queue', 'status', 'pending')).filter(j => !this.claimed.has(j.id));
    this.pendingAI = pend.some(j => j.lane === 'ai' && !j.noGemini && (j.kind === 'sheet' || j.kind === 'mcqgen'));
    let c = pend.filter(j => this.accepts(lane, j, prov));
    this._localBusy = pend.some(j => j.kind === 'extract');
    if (lane === 'ai') {
      // Only wait while books are still being opened (minutes) — not for the scanned-page reading, which can take days.
      const localBusy = pend.some(j => j.kind === 'extract') || (await DB.byIndex('queue', 'status', 'running')).some(j => j.kind === 'extract');
      // Only the big "every topic" batch waits for the scanned books; topics you asked for yourself go first.
      if (localBusy) c = c.filter(j => (j.kind !== 'sheet' && j.kind !== 'mcqgen') || j.prio < 6);
    }
    // Providers help with OCR only when there is no import work for them.
    if (lane.startsWith('p:')) {
      const bulk = c.filter(j => j.kind !== 'ocr'); if (bulk.length) c = bulk;
      // Cheap text imports first; picture jobs are slow and hit limits sooner.
      const w = prov?.big ? { sheet: -2, mcqgen: -1, ocr: 9 } : { sheet: -2, mcqgen: -1, mcqtext: 0, practical: 1, figure: 2, mcqvision: 3 };
      c.sort((a, b) => (w[a.kind] ?? 1) - (w[b.kind] ?? 1) || a.prio - b.prio || a.created - b.created);
      return c[0];
    }
    c.sort((a, b) => a.prio - b.prio || a.created - b.created);
    return c[0];
  },
  // Several OCR workers on the laptop at once (one per spare CPU core, max 3).
  localLanes() { const auto = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)); const n = Math.min(auto, +localStorage.getItem('ocrWorkers') || Math.min(auto, 2)); return Array.from({ length: n }, (_, i) => i ? 'local' + (i + 1) : 'local'); },
  lanes() { return [...this.localLanes(), 'ai', ...Providers.active().map(p => 'p:' + p.id)]; },
  kick() { this.lanes().forEach(l => this.loop(l)); },
  async holdWake(on) {
    if (on) KeepAlive.start(); else KeepAlive.stop();
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
          const name = j.payload.topicId ? (await DB.get('topics', j.payload.topicId))?.name : j.payload.bookId ? (await DB.get('books', j.payload.bookId))?.short : j.payload.system ? sysName(j.payload.system) : '';
          this.setStatus(lane, `${prov ? prov.name + ': ' : lane === 'ai' ? 'Gemini: ' : ''}${JOB_LABEL[j.kind]}${name ? ' — ' + name : ''}`);
          try {
            (this._laneOf ||= {})[j.id] = lane;
            await Handlers[j.kind](j, { lane, provider: prov });
            this.hits[lane] = 0;
            j.status = 'done'; j.finished = Date.now(); delete j.error;
          } catch (e) {
            console.warn('Job failed', lane, j.kind, e);
            // The SERVICE is broken (no credit, bad key, odd reply through the relay) — not the job.
            // Rest that service and give the job back to the others without counting a failed try.
            const svcBroken = prov && !(e instanceof QuotaError) && /balance|insufficient|billing|payment|credit|unexpected reply|unauthori[sz]ed|invalid api key|forbidden|\b40[13]\b|could not connect/i.test(e.message || '');
            if (svcBroken) {
              const long = /balance|insufficient|billing|payment|credit|invalid api key|unauthori/i.test(e.message || '');
              this.paused[lane] = Date.now() + (long ? 6 * 3600 : 30 * 60) * 1000;
              this.status[lane] = `${prov.name} has a problem — resting ${long ? '6 hours' : '30 min'}, the others keep working. (${String(e.message || '').slice(0, 140)}) Fix it in Settings → ${prov.name} → Test.`;
              j.status = 'pending'; delete j.error; await DB.put('queue', j); this.claimed.delete(j.id); this.emit();
              setTimeout(() => this.loop(lane), this.paused[lane] - Date.now() + 1000);
              break;
            }
            if (e instanceof QuotaError && (e.net || !navigator.onLine)) {
              // No internet: not a limit. Just wait and carry on as soon as it is back.
              j.status = 'pending';
              this.setStatus(lane, `${prov ? prov.name : lane.startsWith('local') ? 'Page reader' : 'Gemini'}: no internet — will continue by itself when it is back`);
              await DB.put('queue', j); this.claimed.delete(j.id);
              await Promise.race([sleep(30000), new Promise(r => window.addEventListener('online', r, { once: true }))]);
              continue;
            } else if (e instanceof QuotaError) {
              // A Gemini key out of allowance on this model: carry on with another model of the same key.
              if (prov && e.daily && /generativelanguage/.test(prov.base || '')) {
                const nm = await Providers.nextGeminiModel(prov, e.perDay).catch(() => null);
                if (nm) { j.status = 'pending'; await DB.put('queue', j); this.claimed.delete(j.id); this.setStatus(lane, `${prov.name}: ${prov.model} used up for now — switching to ${nm}`); this.emit(); continue; }
              }
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
                if (j.kind === 'mcqtext' && j.payload.pages.length > 1) {
                  // Split into single pages that fit, instead of leaving it all for Gemini.
                  for (const pg of j.payload.pages) await Queue.add('mcqtext', { ...j.payload, pages: [pg] }, j.prio);
                  j.status = 'done'; j.error = 'split into single pages'; await DB.put('queue', j); this.emit(); continue;
                }
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
  // One-time: pending picture-import jobs on scanned PDF pages → read on laptop, then cheap text import.
  async convertVisionToOcr() {
    if (localStorage.getItem('convertedV2')) return;
    const books = Object.fromEntries((await DB.all('books')).map(b => [b.id, b]));
    let n = 0;
    for (const j of await DB.byIndex('queue', 'status', 'pending')) {
      if (j.kind !== 'mcqvision') continue;
      const b = books[j.payload.bookId]; if (!b || b.kind !== 'pdf') continue;
      const scanned = [];
      for (const p of j.payload.pages) if (!(await DB.get('pages', [b.id, p]))) scanned.push(p);
      if (scanned.length !== j.payload.pages.length) continue; // has real text + pictures → keep as vision
      await DB.del('queue', j.id);
      await DB.put('queue', { ...j, id: uid(), kind: 'ocr', lane: 'local', prio: 3, payload: { bookId: b.id, pages: scanned, then: 'mcqtext' } });
      n++;
    }
    localStorage.setItem('convertedV2', '1');
    if (n) console.log('Converted', n, 'vision jobs to OCR→text');
    return n;
  },
  // One-time: break big pending text-import jobs into 2-page pieces so the free AIs can take them too.
  async splitTextJobs() {
    if (localStorage.getItem('splitV3')) return 0;
    let n = 0;
    for (const j of await DB.byIndex('queue', 'status', 'pending')) {
      if (j.kind !== 'mcqtext' || j.payload.pages.length <= 2) { if (j.kind === 'mcqtext' && j.noProv) { delete j.noProv; await DB.put('queue', j); } continue; }
      for (let i = 0; i < j.payload.pages.length; i += 2) await DB.put('queue', { ...j, id: uid(), noProv: undefined, created: j.created + i / 1000, payload: { ...j.payload, pages: j.payload.pages.slice(i, i + 2) } });
      await DB.del('queue', j.id); n++;
    }
    localStorage.setItem('splitV3', '1');
    return n;
  },
  async recover() {
    for (const j of await DB.byIndex('queue', 'status', 'running')) { j.status = 'pending'; await DB.put('queue', j); }
  },
  async retryFailed() {
    for (const j of await DB.byIndex('queue', 'status', 'failed')) {
      // Big text imports: retry as 2-page pieces that every free AI can take (instead of waiting for Gemini only).
      if (j.kind === 'mcqtext' && j.payload.pages.length > 2) {
        await addMcqText(j.payload.bookId, j.payload.pages, j.payload.ocr ? 1 : 0);
        await DB.del('queue', j.id); continue;
      }
      j.status = 'pending'; j.tries = 0; delete j.noProv; delete j.error; await DB.put('queue', j);
    }
    this.kick();
  },
  // Every 2 hours: give failed jobs another go (up to 3 extra rounds each), so you don't have to press Retry.
  // Jobs that failed only because the PDF/OCR library didn't download: give them back, uncounted.
  async reviveLibFails() {
    let n = 0;
    for (const j of await DB.byIndex('queue', 'status', 'failed')) {
      if (!/pdfjsLib is not defined|Tesseract is not defined|Could not load OCR engine|page reader/i.test(j.error || '')) continue;
      j.status = 'pending'; j.tries = 0; j.rounds = 0; delete j.error; delete j.noProv; await DB.put('queue', j); n++;
    }
    if (n) this.kick();
    return n;
  },
  async autoRetry() {
    await this.reviveLibFails().catch(() => {});
    let n = 0;
    for (const j of await DB.byIndex('queue', 'status', 'failed')) {
      if ((j.rounds || 0) >= 3) continue;
      if (j.payload?.bookId) { const b = await DB.get('books', j.payload.bookId); if (b?.fileLost) continue; }
      j.rounds = (j.rounds || 0) + 1; j.status = 'pending'; j.tries = 0; delete j.noProv; await DB.put('queue', j); n++;
    }
    if (n) this.kick();
    return n;
  },
  async clearDone() { for (const j of await DB.byIndex('queue', 'status', 'done')) await DB.del('queue', j.id); }
};

async function queueRefs() {
  if (!(await DB.all('books')).some(b => ['ref', 'mbbs', 'amc'].includes(b.role))) return 0;
  const queued = new Set((await DB.all('queue')).filter(j => j.kind === 'refs' && j.status !== 'done').map(j => j.payload.topicId));
  const pagesNow = await DB.count('pages');
  const need = new Set(); for (const m of await DB.all('mcqs')) if (!m.deleted && m.topicId && (!m.refs || (m.refsN || 0) < pagesNow * 0.9)) need.add(m.topicId);
  let n = 0; for (const t of need) if (!queued.has(t)) { await Queue.add('refs', { topicId: t }, 1.5); n++; }
  return n;
}

// Stop reading a scanned book (pages already read are kept and used).
async function skipOcr(bookId) {
  let n = 0;
  for (const j of await DB.all('queue')) if (j.kind === 'ocr' && j.payload?.bookId === bookId && j.status !== 'done') {
    // Question banks still import what was read so far.
    if (j.payload.then === 'mcqtext' && (j.payload.done || []).length) await addMcqText(bookId, j.payload.done, 1);
    await DB.del('queue', j.id); n++;
  }
  const b = await DB.get('books', bookId); if (b) { b.ocrSkipped = 1; if (b.status === 'ocr' || b.status === 'partial') b.status = 'ready'; await DB.put('books', b); }
  return n;
}

async function queueEmbeds() {
  const queued = new Set((await DB.all('queue')).filter(j => j.kind === 'embed' && j.status !== 'done').map(j => j.payload.bookId));
  let n = 0;
  for (const b of await DB.all('books')) {
    if (!['ref', 'mbbs', 'amc', 'reader'].includes(b.role) || queued.has(b.id)) continue;
    const pages = await DB.count('pages', 'bookId', b.id); if (!pages) continue;
    const vecPages = new Set(); await DB.each('vecs', 'bookId', b.id, v => { if (v.c === 0) vecPages.add(v.p); });
    if (vecPages.size < pages) { await Queue.add('embed', { bookId: b.id }, 1.7); n++; }
  }
  return n;
}

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
