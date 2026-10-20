// Part 2: an AI review of every question (fix / drop / move to the right topic), and answer labels hidden on pictures.
LOCAL_KINDS.push('maskimg');
JOB_LABEL.review = 'Reviewing questions';
JOB_LABEL.maskimg = 'Hiding answer labels on pictures';

async function queueReview(prio = 6) {
  const queued = new Set((await DB.all('queue')).filter(j => j.kind === 'review' && j.status !== 'done').flatMap(j => j.payload.ids));
  const all = (await DB.live('mcqs')).filter(m => !m.merged && !m.reviewed && !queued.has(m.id));
  // Real bank questions first, then AI-written; batches of 8 from the same system (so the topic list fits).
  const rank = m => ({ AMEDEX: 0, PYQ: 1, UWORLD: 2, MBBS: 3, SPOT: 4, AI: 5 })[qBank(m)] ?? 6;
  all.sort((a, b) => rank(a) - rank(b) || String(a.system).localeCompare(String(b.system)));
  let n = 0, batch = [], sys = null;
  const flush = async () => { if (batch.length) { await Queue.add('review', { ids: batch.map(m => m.id), system: sys }, prio + (rank(batch[0]) > 2 ? 1 : 0)); n++; } batch = []; };
  for (const m of all) { if (m.system !== sys || batch.length >= 8) { await flush(); sys = m.system; } batch.push(m); }
  await flush();
  return n;
}

Handlers.review = async function (job, ctx) {
  const qs = (await Promise.all(job.payload.ids.map(id => DB.get('mcqs', id)))).filter(m => m && !m.deleted && !m.reviewed);
  if (!qs.length) return;
  const topics = (await DB.live('topics')).filter(t => !job.payload.system || t.system === job.payload.system);
  const byName = new Map(topics.map(t => [t.name.toLowerCase(), t]));
  const L = i => String.fromCharCode(65 + i);
  const block = qs.map(m => `[${m.id}] bank: ${qBank(m)} · filed under: ${(topics.find(t => t.id === m.topicId) || {}).name || '?'}${m.img ? ' · has a picture' : ''}
Q: ${m.stem}
${m.options.map((o, i) => `${L(i)}) ${o}`).join('\n')}
Keyed answer: ${correctSet(m).map(L).join(', ')}`).join('\n\n');
  const prompt = `You are checking questions in a medical student's question bank (Australian AMC Part 1 + Indian MBBS).
Topics in this subject: ${topics.map(t => t.name).join(' | ')}

For EACH question return {"id":"…","verdict":"keep|fix|drop","reason":"3–8 words","topic":"exact topic name from the list that it really tests","oldFormat":true/false,"quality":1-5, and for "fix" also "stem","options":[…no letters…],"answer":"A-E"}.
Rules:
- drop ONLY if: garbled/unreadable text, question text missing or unanswerable, it needs a picture/table/graph that is not given (and it has no picture), or the answer is given away in the stem. For bank AI only, also drop if quality < 4 (obvious answer, silly options, not exam-relevant, not standard/Australian practice).
- fix if usable but: options carry the book's own letters ("B Sodium valproate"), OCR typos, answer-key text mixed into the stem (e.g. "OA Phenytoin."), or the keyed answer is clearly wrong (only if certain). Keep the medical meaning of real bank questions exactly.
- oldFormat: true for old-style stems without a patient scenario ("X is associated with…", incomplete sentence).
- bank UWORLD (US exam): drop if it tests US-only content (US law/insurance, US screening schedules, drugs or systems not used in Australia); otherwise keep.
- keep everything else. Real bank questions (AMEDEX/PYQ) are kept even if easy.
Return JSON {"results":[…]}.

${block}`;
  const out = await bulkCall(ctx, { prompt, json: true, maxTokens: 6000 });
  const res = Array.isArray(out?.results) ? out.results : Array.isArray(out) ? out : [];
  if (!res.length) throw new Error('AI returned no review');
  const clean = v => String(v ?? '').replace(/[\[\]\s"']/g, '');
  let matched = 0;
  for (const [i, m] of qs.entries()) {
    const r = res.find(x => x && clean(x.id) === m.id) || (res.length === qs.length && !res.some(x => qs.some(q => clean(x?.id) === q.id)) ? res[i] : null);
    if (!r) continue; matched++;
    m.reviewed = Date.now(); m.review = { v: r.verdict, why: String(r.reason || '').slice(0, 80), q: +r.quality || null };
    if (r.oldFormat) m.oldFormat = 1;
    if (r.topic) { const t = byName.get(String(r.topic).toLowerCase().trim()); if (t && t.id !== m.topicId) { m.movedFrom = m.topicId; m.topicId = t.id; m.system = t.system; } }
    if (r.verdict === 'drop') { m.flagged = 1; m.flagReason = 'AI review: ' + m.review.why; }
    if (r.verdict === 'fix' && r.stem && Array.isArray(r.options) && r.options.length >= 3) {
      const ai = typeof r.answer === 'string' ? r.answer.trim().toUpperCase().charCodeAt(0) - 65 : +r.answer;
      if (ai >= 0 && ai < r.options.length) { m.orig ||= { stem: m.stem, options: m.options, ans: m.ans }; m.stem = String(r.stem); m.options = r.options.map(String); m.ans = ai; delete m.multi; }
    }
    await DB.put('mcqs', m);
  }
  if (!matched) throw new Error('AI review reply did not match the questions — will retry');
};

// Pictures: read the words printed on them and cover any that give the answer away (shown again after answering).
async function queueMasks() {
  const queued = new Set((await DB.all('queue')).filter(j => j.kind === 'maskimg' && j.status !== 'done').map(j => j.payload.id));
  let n = 0;
  for (const m of await DB.live('mcqs')) if (m.img && !m.mask2 && !queued.has(m.id)) { await Queue.add('maskimg', { id: m.id }, 6); n++; }
  return n;
}
Handlers.maskimg = async function (job, ctx) {
  const m = await DB.get('mcqs', job.payload.id); if (!m || !m.img) return;
  const media = await DB.get('media', m.img); if (!media?.data) return;
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = media.data; });
  const worker = await getOcrWorker(ctx?.lane || 'local');
  const { data } = await worker.recognize(img, {}, { blocks: true, text: true });
  const words = data.words || (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => l.words || [])));
  // Cover every printed word of 3+ letters (labels, arrows' names, captions) — short marks like ECG leads (II, V1) stay.
  const hits = words.filter(w => (w.confidence ?? 100) >= 45 && String(w.text || '').replace(/[^A-Za-z]/g, '').length >= 3);
  const area = img.naturalWidth * img.naturalHeight || 1;
  const textArea = hits.reduce((a, w) => a + (w.bbox.x1 - w.bbox.x0) * (w.bbox.y1 - w.bbox.y0), 0);
  const huge = hits.some(w => (w.bbox.y1 - w.bbox.y0) > img.naturalHeight * 0.12);
  m.maskTried = 1; m.mask2 = 1;
  if (textArea > area * 0.18 || huge) { m.flagged = 1; m.flagReason = 'picture is only text (bad crop)'; }
  if (hits.length) {
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0); g.fillStyle = '#fff';
    for (const w of hits) { const b = w.bbox; g.fillRect(b.x0 - 4, b.y0 - 3, b.x1 - b.x0 + 8, b.y1 - b.y0 + 6); }
    const id = 'mask-' + m.img; await DB.put('media', { id, data: c.toDataURL('image/jpeg', 0.85), kind: 'masked' });
    m.imgMask = id;
  }
  await DB.put('mcqs', m);
};

// NotebookLM: copy the question and open the subject's notebook.
function notebookLinks() { return String(localStorage.getItem('nblm') || '').split('\n').map(l => l.split('|').map(x => x.trim())).filter(x => x[0] && /^https?:/.test(x[1] || '')).map(([name, url]) => ({ name, url })); }

// Double-check: a second AI answers each question blind (without seeing the key). Agreement = trusted;
// disagreement = "disputed", shown on the question so you check it in Murtagh / the guidelines.
JOB_LABEL.verify = 'Double-checking answers';
async function queueVerify(prio = 8) {
  const queued = new Set((await DB.all('queue')).filter(j => j.kind === 'verify' && j.status !== 'done').flatMap(j => j.payload.ids));
  const all = (await DB.live('mcqs')).filter(m => !m.merged && !m.flagged && m.verified == null && !queued.has(m.id) && !qBroken(m));
  let n = 0;
  for (let i = 0; i < all.length; i += 10) { await Queue.add('verify', { ids: all.slice(i, i + 10).map(m => m.id) }, prio); n++; }
  return n;
}
Handlers.verify = async function (job, ctx) {
  const qs = (await Promise.all(job.payload.ids.map(id => DB.get('mcqs', id)))).filter(m => m && !m.deleted && m.verified == null);
  if (!qs.length) return;
  const L = i => String.fromCharCode(65 + i);
  const prompt = `Answer each exam question yourself (Australian AMC practice; Indian MBBS for MBBS-style ones). Think like an examiner.
Return JSON {"results":[{"id":"…","answer":"A-E","confidence":1-5,"why":"max 15 words"}]}

${qs.map(m => `[${m.id}]\n${m.stem}\n${m.options.map((o, i) => `${L(i)}) ${o}`).join('\n')}`).join('\n\n')}`;
  const out = await bulkCall(ctx, { prompt, json: true, maxTokens: 3000 });
  const res = Array.isArray(out?.results) ? out.results : [];
  const clean = v => String(v ?? '').replace(/[\[\]\s"']/g, '');
  let matched = 0;
  for (const [i, m] of qs.entries()) {
    const r = res.find(x => clean(x?.id) === m.id) || (res.length === qs.length ? res[i] : null); if (!r || !r.answer) continue;
    matched++;
    const pick = String(r.answer).trim().toUpperCase().charCodeAt(0) - 65, keyed = correctSet(m);
    if (keyed.includes(pick)) { m.verified = 1; delete m.disputed; }
    else if ((+r.confidence || 0) >= 4) { m.verified = 0; m.disputed = { ai: pick, why: String(r.why || '').slice(0, 120) }; }
    else m.verified = 1;   // the second AI wasn't sure — keep the book's answer
    await DB.put('mcqs', m);
  }
  if (!matched) throw new Error('Double-check reply did not match — will retry');
};

// Mind maps made on the phone or iPad have no book figures (the books live on the laptop):
// the laptop adds them by itself and Sync brings them back.
async function fillMindmapFigs() {
  if (!(await DB.all('books')).some(b => ['ref', 'mbbs', 'amc'].includes(b.role))) return 0;
  let n = 0;
  for (const s of await DB.all('sheets')) {
    if (!s.mindmap || s.mindmap.figsDone) continue;
    const t = await DB.get('topics', s.id); if (!t) continue;
    if (!(s.mindmap.figs || []).length) s.mindmap.figs = await bookFigures(t).catch(() => []);
    s.mindmap.figsDone = 1; await DB.put('sheets', s); n++;
  }
  return n;
}
