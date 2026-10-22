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

// ---------- Third opinion on disputed answers ----------
// When the second AI disagreed, a third AI (seeing the book's key, the dispute and the explanation) decides.
// Book key upheld → the warning disappears. Otherwise the warning stays, with the reason.
JOB_LABEL.arbit = 'Third opinion on disputed answers';
async function queueArbit(prio = 7.5) {
  const queued = new Set((await DB.all('queue')).filter(j => j.kind === 'arbit' && j.status !== 'done').flatMap(j => j.payload.ids));
  const all = (await DB.live('mcqs')).filter(m => m.disputed && !m.arbit && !queued.has(m.id));
  let n = 0;
  for (let i = 0; i < all.length; i += 6) { await Queue.add('arbit', { ids: all.slice(i, i + 6).map(m => m.id) }, prio); n++; }
  return n;
}
Handlers.arbit = async function (job, ctx) {
  const qs = (await Promise.all(job.payload.ids.map(id => DB.get('mcqs', id)))).filter(m => m && m.disputed && !m.arbit);
  if (!qs.length) return;
  const L = i => String.fromCharCode(65 + i);
  const prompt = `You are the senior examiner settling disputes between an answer key and a reviewer. For each question decide which answer is correct by current guidelines (Australian AMC practice; Indian MBBS for MBBS-style). Real exam banks (AMEDEX, recalls) are usually right — overturn the key only when it is clearly wrong.
Return JSON {"results":[{"id":"…","correct":"A-E","winner":"key|reviewer|unclear","why":"max 25 words, the deciding fact"}]}

${qs.map(m => `[${m.id}] (${BANK_LABEL[qBank(m)] || ''})
${m.stem}
${m.options.map((o, i) => `${L(i)}) ${o}`).join('\n')}
Key: ${letters(correctSet(m))}. Reviewer chose: ${L(m.disputed.ai)} — "${m.disputed.why}"
Key's explanation: ${String(m.expl || '').slice(0, 600)}`).join('\n\n')}`;
  const out = await bulkCall(ctx, { prompt, json: true, maxTokens: 3000 });
  const res = Array.isArray(out?.results) ? out.results : [];
  const clean = v => String(v ?? '').replace(/[\[\]\s"']/g, '');
  let matched = 0;
  for (const [i, m] of qs.entries()) {
    const r = res.find(x => clean(x?.id) === m.id) || (res.length === qs.length ? res[i] : null); if (!r) continue;
    matched++;
    const pick = String(r.correct || '').trim().toUpperCase().charCodeAt(0) - 65;
    const keyWins = r.winner === 'key' || (r.winner !== 'reviewer' && correctSet(m).includes(pick));
    m.arbit = { winner: keyWins ? 'key' : r.winner === 'reviewer' ? 'reviewer' : 'unclear', why: String(r.why || '').slice(0, 200), at: Date.now() };
    if (keyWins) { m.verified = 1; m.upheld = { ai: m.disputed.ai, why: m.arbit.why }; delete m.disputed; }
    await DB.put('mcqs', m);
  }
  if (!matched) throw new Error('Third-opinion reply did not match — will retry');
};

// ---------- New questions on the SAME concepts (for system tests) ----------
// Like NEET practice: the test repeats questions you did, plus fresh ones built on the same ideas.
JOB_LABEL.twins = 'Writing new questions on concepts you studied';
async function queueTwins(system, prio = 3) {
  const last = await Practice.lastByQ();
  const have = new Set((await DB.live('mcqs')).filter(m => m.twinOf).map(m => m.twinOf));
  const queued = new Set((await DB.all('queue')).filter(j => j.kind === 'twins' && j.status !== 'done').flatMap(j => j.payload.ids));
  const done = new Set((await DB.live('topics')).filter(t => t.done && (!system || t.system === system)).map(t => t.id));
  const src = (await DB.live('mcqs')).filter(m => done.has(m.topicId) && last[m.id] && !m.twinOf && !have.has(m.id) && !queued.has(m.id) && !m.flagged && !qBroken(m) && ['AMEDEX', 'PYQ', 'UWORLD', 'MBBS'].includes(qBank(m)));
  // Wrong answers first — those concepts need another go.
  src.sort((a, b) => (last[a.id].correct - last[b.id].correct) || (last[a.id].ts - last[b.id].ts));
  let n = 0;
  for (let i = 0; i < Math.min(src.length, 60); i += 6) { await Queue.add('twins', { ids: src.slice(i, i + 6).map(m => m.id) }, prio); n++; }
  return n;
}
Handlers.twins = async function (job, ctx) {
  const qs = (await Promise.all(job.payload.ids.map(id => DB.get('mcqs', id)))).filter(Boolean);
  if (!qs.length) return;
  const L = i => String.fromCharCode(65 + i);
  const prompt = `For EACH question below, write ONE new exam question that tests the SAME concept from a different angle — new patient, new vignette, ask a different step (e.g. diagnosis → next step, or a look-alike that must be told apart). Same style and difficulty, same number of options, single best answer, plausible distractors. Australian practice for AMC-style (5 options), Indian MBBS for MBBS-style (4 options). Never copy the original wording.
Return JSON {"mcqs":[{"of":"<original id>","type":"AMC|MBBS","stem":"","options":[""],"answer":"A","explanation":"Answer: … then why, then one line per wrong option","master":"the one fact to know"}]}

${qs.map(m => `[${m.id}] (${m.type})
${m.stem}
${m.options.map((o, i) => `${L(i)}) ${o}`).join('\n')}
Answer: ${letters(correctSet(m))}`).join('\n\n')}`;
  const out = await bulkCall(ctx, { prompt, json: true, maxTokens: 6000 });
  const clean = v => String(v ?? '').replace(/[\[\]\s"']/g, '');
  const list = [];
  for (const [i, r] of (Array.isArray(out?.mcqs) ? out.mcqs : []).entries()) {
    const orig = qs.find(m => m.id === clean(r.of)) || qs[i]; if (!orig) continue;
    const topic = await DB.get('topics', orig.topicId);
    const m = cleanMcq({ ...r, type: orig.type === 'MBBS' ? 'MBBS' : 'AMC' }, topic || { id: orig.topicId, system: orig.system });
    if (m) { m.twinOf = orig.id; m.gen = 'twin'; list.push(m); }
  }
  if (!list.length) throw new Error('No new questions came back — will retry');
  await DB.putMany('mcqs', list);
};

// System test: done topics of one system — questions you did (wrong ones first), unseen ones, and the new same-concept ones.
async function startSystemTest(system, count = 40) {
  const topics = (await DB.live('topics')).filter(t => t.system === system);
  const done = new Set(topics.filter(t => t.done).map(t => t.id));
  if (!done.size) return toast('Finish at least one topic of this system first (topic → its questions → mark done).', 6000);
  const all = (await DB.live('mcqs')).filter(m => done.has(m.topicId) && !m.flagged && !m.merged && !qBroken(m));
  const last = await Practice.lastByQ();
  const seen = shuffle(all.filter(m => last[m.id] && !m.twinOf)).sort((a, b) => last[a.id].correct - last[b.id].correct);
  const twins = shuffle(all.filter(m => m.twinOf));
  const fresh = shuffle(all.filter(m => !last[m.id] && !m.twinOf));
  const take = (arr, n) => arr.splice(0, Math.max(0, n));
  let ids = [...take(seen, Math.round(count * 0.45)), ...take(twins, Math.round(count * 0.3)), ...take(fresh, Math.round(count * 0.25))];
  for (const rest of [seen, twins, fresh]) if (ids.length < count) ids.push(...take(rest, count - ids.length));
  ids = shuffle(ids).map(m => m.id);
  if (!ids.length) return toast('No questions for these topics yet.');
  queueTwins(system).then(n => n && Queue.kick()).catch(() => {});   // more same-concept questions for next time
  const full = done.size === topics.length;
  await Practice.start({ kind: 'systest', title: `${sysName(system)} — ${full ? 'full system' : done.size + '/' + topics.length + ' topics'} test`, ids, count: ids.length });
}
