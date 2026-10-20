// Part 2: an AI review of every question (fix / drop / move to the right topic), and answer labels hidden on pictures.
LOCAL_KINDS.push('maskimg');
JOB_LABEL.review = 'Reviewing questions';
JOB_LABEL.maskimg = 'Hiding answer labels on pictures';

async function queueReview(prio = 6) {
  const queued = new Set((await DB.all('queue')).filter(j => j.kind === 'review' && j.status !== 'done').flatMap(j => j.payload.ids));
  const all = (await DB.live('mcqs')).filter(m => !m.merged && !m.reviewed && !queued.has(m.id));
  // Real bank questions first, then AI-written; batches of 8 from the same system (so the topic list fits).
  const rank = m => ({ AMEDEX: 0, PYQ: 1, MBBS: 2, SPOT: 3, AI: 4 })[qBank(m)] ?? 5;
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
- keep everything else. Real bank questions (AMEDEX/PYQ) are kept even if easy.
Return JSON {"results":[…]}.

${block}`;
  const out = await bulkCall(ctx, { prompt, json: true, maxTokens: 6000 });
  const res = Array.isArray(out?.results) ? out.results : Array.isArray(out) ? out : [];
  if (!res.length) throw new Error('AI returned no review');
  for (const m of qs) {
    const r = res.find(x => x && String(x.id) === m.id); if (!r) continue;
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
};

// Pictures: read the words printed on them and cover any that give the answer away (shown again after answering).
async function queueMasks() {
  const queued = new Set((await DB.all('queue')).filter(j => j.kind === 'maskimg' && j.status !== 'done').map(j => j.payload.id));
  let n = 0;
  for (const m of await DB.live('mcqs')) if (m.img && !m.imgMask && !m.maskTried && !queued.has(m.id)) { await Queue.add('maskimg', { id: m.id }, 6); n++; }
  return n;
}
Handlers.maskimg = async function (job, ctx) {
  const m = await DB.get('mcqs', job.payload.id); if (!m || !m.img) return;
  const media = await DB.get('media', m.img); if (!media?.data) return;
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = media.data; });
  const worker = await getOcrWorker(ctx?.lane || 'local');
  const { data } = await worker.recognize(img, {}, { blocks: true, text: true });
  const words = data.words || (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => l.words || [])));
  const optWords = new Set(m.options.join(' ').toLowerCase().match(/[a-z]{4,}/g) || []);
  const hits = words.filter(w => { const t = String(w.text || '').toLowerCase().replace(/[^a-z]/g, ''); return t.length >= 4 && optWords.has(t); });
  m.maskTried = 1;
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
