// Gemini API client, page retrieval from your books, and all generation prompts.
class QuotaError extends Error { constructor(m, daily, retryMs) { super(m); this.daily = daily; this.retryMs = retryMs; } }

const COLS = {
  ref: { label: 'Reference', hint: 'Harrison, Bailey & Love, Williams…' },
  mbbs: { label: 'Indian MBBS', hint: 'Davidson, SRB, Dutta, Ghai…' },
  amc: { label: 'Australia / AMC', hint: 'Murtagh, eTG, AMC handbook…' }
};
const ROLES = {
  ref: 'Reference textbook', mbbs: 'MBBS textbook', amc: 'AMC / Australian source',
  'mcq-mbbs': 'MCQ book (MBBS)', 'mcq-amc': 'Question bank (AMC / AMEDEX)', 'mcq-uworld': 'Question bank (UWorld)', practical: 'Practical / spotter book', reader: 'Reading copy only (phone / iPad)'
};
const SECTIONS = {
  patho: 'Pathophysiology', clinical: 'Clinical features', investigations: 'Investigations',
  management: 'Management', pearls: 'Pearls & red flags'
};

const AI = {
  lastCall: 0,
  get key() { return localStorage.getItem('gem_key') || ''; },
  get model() { return localStorage.getItem('gem_model') || 'gemini-2.5-flash'; },
  get bulkModel() { return localStorage.getItem('gem_bulk') || 'gemini-2.5-flash-lite'; },
  get rpm() { return Math.max(1, +localStorage.getItem('gem_rpm') || 8); },

  // Models that ran out of their free daily allowance (checked again after a few hours).
  isOut(m) { return +(localStorage.getItem('gem_out_' + m) || 0) > Date.now(); },
  markOut(m) { localStorage.setItem('gem_out_' + m, String(Date.now() + 3 * 3600 * 1000)); },
  async call(opts) {
    const want = opts.model || this.model;
    // Main model used up for today → sheets and questions carry on with the lighter model instead of waiting.
    if (this.isOut(want) && want !== this.bulkModel && !this.isOut(this.bulkModel)) opts = { ...opts, model: this.bulkModel, _fellBack: true };
    try { return await this._call(opts); }
    catch (e) {
      const used0 = opts.model || this.model;
      if (e instanceof QuotaError && (e.daily || /exceeded your current quota/i.test(e.message || '')) && !opts._quotaFallback) {
        if (e.daily) this.markOut(used0);
        if (used0 !== this.bulkModel && !this.isOut(this.bulkModel)) return this.call({ ...opts, model: this.bulkModel, _quotaFallback: true });
      }
      // 503 "busy": Google's servers are overloaded for that model. Wait a moment, then fall back to the lighter model.
      if (e instanceof QuotaError && /busy/i.test(e.message || '') && (opts._busy || 0) < 2) {
        await sleep(opts._busy ? 1500 : 2500);
        const used = opts.model || this.model;
        const alt = opts._busy && this.bulkModel !== used ? this.bulkModel : used;
        return this.call({ ...opts, model: alt, _busy: (opts._busy || 0) + 1 });
      }
      // Google retires models for new users and names the replacement — switch to it automatically and retry once.
      const m = /no longer available|not found|not supported|deprecated/i.test(e.message || '') && (e.message.match(/use (?:models\/)?(gemini-[\w.\-]+)/i) || [])[1];
      const used = opts.model || this.model;
      if (m && m !== used && !opts._retried) {
        if (used === this.model) localStorage.setItem('gem_model', m);
        if (used === this.bulkModel) localStorage.setItem('gem_bulk', m);
        return this.call({ ...opts, model: m, _retried: true });
      }
      if (/no longer available|not found for API|is not supported/i.test(e.message || '') && !opts._retried) {
        const best = await this.autoPick().catch(() => null);
        if (best) return this.call({ ...opts, model: opts.model === undefined || used === this.model ? best.main : best.bulk, _retried: true });
      }
      throw e;
    }
  },

  // Pick the newest general-purpose Flash and Flash-Lite models this key can use.
  async autoPick() {
    const ms = (await this.listModels()).filter(m => /^gemini-\d/.test(m) && !/tts|image|audio|live|embedding|vision|thinking-exp|computer|robotics|native/i.test(m));
    const ver = m => parseFloat((m.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const stable = m => /preview|exp/.test(m) ? 0 : 1;
    const rank = (a, b) => ver(b) - ver(a) || stable(b) - stable(a) || a.length - b.length;
    const flash = ms.filter(m => /flash/.test(m) && !/lite/.test(m)).sort(rank);
    const lite = ms.filter(m => /flash-lite/.test(m)).sort(rank);
    if (!flash.length) return null;
    const best = { main: flash[0], bulk: lite[0] && ver(lite[0]) >= ver(flash[0]) - 0.5 ? lite[0] : flash[0] };
    localStorage.setItem('gem_model', best.main); localStorage.setItem('gem_bulk', best.bulk);
    return best;
  },

  // Straight to Google; if this network blocks it (e.g. hostel WiFi), go through the user's Cloudflare relay instead.
  async gfetch(url, init) {
    const relay = Providers.relay();
    const via = () => fetch(relay + '/?u=' + encodeURIComponent(url), init);
    if (relay && this._viaRelay) { try { return await via(); } catch (e) { this._viaRelay = false; } }
    try { return await fetch(url, init); }
    catch (e) {
      if (!relay) throw e;
      const r = await via(); this._viaRelay = true; return r;
    }
  },

  async _call({ prompt, images = [], system, json = true, temperature = 0.35, model }) {
    if (!this.key) throw new Error('Add your Gemini API key in Settings first.');
    const parts = [{ text: prompt }];
    for (const im of images) {
      const [head, data] = im.split(',');
      parts.push({ inline_data: { mime_type: head.match(/data:(.*?);/)[1], data } });
    }
    const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (json) body.generationConfig.responseMimeType = 'application/json';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || this.model)}:generateContent?key=${encodeURIComponent(this.key)}`;
    let res;
    try { res = await this.gfetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { const q = new QuotaError(Providers.relay() ? 'Network error — offline? (also tried your relay)' : 'Network error — offline? If this WiFi blocks Gemini, set up the relay in Settings', false, 30000); q.net = true; throw q; }
    this.lastCall = Date.now();
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = d.error || {};
      const det = JSON.stringify(err.details || []);
      if (res.status === 429) {
        const m = det.match(/"retryDelay":"(\d+)/);
        const daily = /PerDay|per_day|daily/i.test(det + ' ' + (err.message || ''));
        throw new QuotaError(err.message || 'Rate limit', daily, m ? +m[1] * 1000 + 1500 : 60000);
      }
      if (res.status >= 500) throw new QuotaError('Gemini is busy right now (' + res.status + ') — Google’s servers are overloaded; try again in a minute', false, 20000);
      throw new Error(err.message || 'Gemini error ' + res.status);
    }
    const cand = d.candidates?.[0];
    const text = (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    if (!text) throw new Error('Empty AI reply (' + (cand?.finishReason || d.promptFeedback?.blockReason || 'unknown') + ')');
    return json ? parseJSON(text) : text;
  },

  async listModels() {
    const r = await this.gfetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(this.key)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Could not list models');
    return (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace('models/', ''));
  }
};

function parseJSON(t) {
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('AI returned invalid JSON');
  }
}

// ---------- Retrieval: find the most relevant pages for a topic ----------
const STOP = new Set(['approach', 'disorders', 'disorder', 'disease', 'diseases', 'other', 'care', 'principles', 'management', 'syndrome', 'common',
  'problems', 'conditions', 'australia', 'australian', 'and', 'the', 'with', 'children', 'pregnancy', 'chronic', 'acute', 'tests', 'emergencies', 'health']);

function topicTerms(topic) {
  const parts = topic.name.toLowerCase().split(/[(),&\/:;–—]| and | vs /).map(s => s.trim()).filter(Boolean);
  const terms = new Set((topic.kw || []).map(k => k.toLowerCase()));
  parts.forEach(p => { if (p.length >= 3 && !(STOP.has(p))) terms.add(p.replace(/'s\b/, '')); });
  return [...terms].filter(t => t.length >= 3 && !STOP.has(t)).map(t => ({
    t, w: t.includes(' ') ? 3 : 1.6,
    re: new RegExp((t.length <= 5 ? '\\b' : '') + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]?') + (t.length <= 5 ? '\\b' : ''), 'g')
  }));
}

function scorePage(text, terms) {
  const lt = text.toLowerCase();
  const head = lt.slice(0, 220);
  let score = 0, hit = 0;
  for (const { t, w, re } of terms) {
    re.lastIndex = 0;
    const c = Math.min(20, (lt.match(re) || []).length);
    if (!c) continue;
    hit++;
    score += w * (1 + Math.log(c));
    if (head.includes(t)) score += w * 3;
  }
  if (!hit) return 0;
  score *= 1 + 0.35 * (hit - 1);
  const digits = (lt.match(/\d/g) || []).length;
  const ratio = digits / Math.max(1, lt.length);
  if (ratio > 0.18) return 0; // book index / reference lists
  if (ratio > 0.1) score *= 0.4;
  return score;
}

async function retrieve(topic, col, maxPages = 6, maxChars = 32000) {
  const books = (await DB.all('books')).filter(b => b.role === col);
  if (!books.length) return [];
  const terms = topicTerms(topic);
  // Best few pages from EACH book, so every book of this role gets a say (not just the biggest one).
  const per = [];
  for (const b of books) {
    let top = [];
    await DB.each('pages', 'bookId', b.id, pg => {
      const s = scorePage(pg.text, terms);
      if (s > 0) {
        top.push({ s, bookId: b.id, p: pg.p, text: pg.text, book: b.short || b.name });
        if (top.length > 24) { top.sort((a, c) => c.s - a.s); top.length = 8; }
      }
    });
    top.sort((a, c) => c.s - a.s);
    if (top.length) per.push(top.slice(0, 8));
  }
  if (!per.length) return [];
  const best = Math.max(...per.map(t => t[0].s));
  // Books that genuinely cover this topic (e.g. Nelson for a paeds topic, not for MI).
  const relevant = per.filter(t => t[0].s >= best * 0.35).sort((x, y) => y[0].s - x[0].s);
  const limit = Math.min(10, maxPages + Math.max(0, relevant.length - 1) * 2), budget = maxChars + Math.max(0, relevant.length - 1) * 8000;
  const out = []; let chars = 0;
  for (let round = 0; round < 8 && out.length < limit; round++) {
    for (const t of relevant) {
      const x = t[round];
      if (!x || out.length >= limit) continue;
      if (round > 0 && x.s < best * 0.25) continue;
      if (chars + Math.min(x.text.length, 9000) > budget && out.length) continue;
      out.push(x); chars += Math.min(x.text.length, 9000);
    }
  }
  return out.sort((a, c) => a.book.localeCompare(c.book) || a.p - c.p);
}

function excerptBlock(pages) {
  return pages.map(x => `[${x.book} p.${x.p}]\n${x.text.slice(0, 9000)}`).join('\n\n');
}

async function topicListText() {
  const ts = await DB.live('topics');
  return ts.map(t => `${t.id}|${t.name}`).join('\n');
}

const SYSTEM_TUTOR = 'You are an expert medical educator. Your student is an Indian final-year MBBS student who is also preparing for the AMC Part 1 MCQ exam (Australia). Be accurate, concise and exam-focused. Never invent page numbers.';

// ---------- Generators ----------
const Gen = {
  async sheet(topic, ctx) {
    const sysName = SEED.systems.find(s => s.code === topic.system)?.name || topic.system;
    const src = {};
    src.ref = await retrieve(topic, 'ref', 6, 30000);
    src.mbbs = await retrieve(topic, 'mbbs', 5, 24000);
    src.amc = await retrieve(topic, 'amc', 6, 30000);
    const block = c => src[c].length ? excerptBlock(src[c]) : '(no excerpts uploaded for this column)';
    const prompt = `TOPIC: ${topic.name}  (system: ${sysName})

Write a high-yield revision sheet from the student's own books, plus an "AMC comparison guide" so that after reading the topic in Indian books the student knows exactly what is different for the AMC — without rereading the whole topic in Murtagh.

=== COLUMN "ref" — reference textbooks ===
${block('ref')}

=== COLUMN "mbbs" — Indian MBBS textbooks ===
${block('mbbs')}

=== COLUMN "amc" — Australian / AMC sources ===
${block('amc')}

RULES
- Each column must reflect its own sources. Cite inline like [Harrison p.2045] using the bracket labels above.
- If a column has no excerpts, or they don't cover a point, you may use standard knowledge of that kind of source, but begin that cell with "(general knowledge)". For the amc column use current Australian practice (eTG, Murtagh, RACGP Red Book, Austroads, Australian Immunisation Handbook, RCH guidelines).
- High-yield only: what examiners ask. Bullets that start with "- ", at most 8 per cell, short lines. Keep doses, cut-offs and criteria when the source gives them. Use **bold** for the single most-tested fact in a cell.
- pearls: include the small bedside concepts and examination tricks that separate look-alikes (e.g. direction of visible peristalsis: stomach left → right vs transverse colon right → left), plus red flags.
- comparison.rows: ONLY real differences between the Indian MBBS answer and the Australian/AMC answer — first-line drugs and doses, investigation of choice, thresholds and targets, setting (GP, rural, retrieval, referral), screening and prevention programs, legal duties (driving, notification, consent, mandatory reporting), Aboriginal and Torres Strait Islander considerations. 4–10 rows. "trap" = how the AMC exam typically tests that difference.
- comparison.same: one or two lines on what is the same, so the student can skip it.
- comparison.mustKnow: Australia-only facts with no Indian equivalent (programs, laws, local epidemiology, brand-specific practice).

Return JSON exactly in this shape:
{"sections":{"patho":{"ref":"","mbbs":"","amc":""},"clinical":{"ref":"","mbbs":"","amc":""},"investigations":{"ref":"","mbbs":"","amc":""},"management":{"ref":"","mbbs":"","amc":""},"pearls":{"ref":"","mbbs":"","amc":""}},
"comparison":{"bottomLine":"","rows":[{"aspect":"","india":"","australia":"","trap":"","cite":""}],"same":"","mustKnow":[""]}}`;
    const out = ctx?.provider ? await Providers.call(ctx.provider, { prompt, system: SYSTEM_TUTOR, temperature: 0.25, maxTokens: 12000 }) : await AI.call({ prompt, system: SYSTEM_TUTOR, temperature: 0.25 });
    if (!out.sections) throw new Error('AI reply missing sections');
    const sources = [];
    Object.entries(src).forEach(([col, arr]) => arr.forEach(x => sources.push({ col, bookId: x.bookId, p: x.p, book: x.book })));
    const sheet = { id: topic.id, topicId: topic.id, sections: out.sections, comparison: out.comparison || {}, sources, model: ctx?.provider ? ctx.provider.name + ' ' + ctx.provider.model : AI.model, created: Date.now() };
    await DB.put('sheets', sheet);
    return sheet;
  },

  async mcqs(topic, nAmc = 10, nMbbs = 8, ctx) {
    const sheet = await DB.get('sheets', topic.id);
    let pages = [];
    if (sheet?.sources?.length) {
      for (const s of sheet.sources.slice(0, 10)) { const pg = await DB.get('pages', [s.bookId, s.p]); if (pg) pages.push({ ...s, text: pg.text }); }
    } else {
      pages = [...await retrieve(topic, 'ref', 4, 18000), ...await retrieve(topic, 'mbbs', 3, 12000), ...await retrieve(topic, 'amc', 4, 18000)];
    }
    const existing = (await DB.byIndex('mcqs', 'topicId', topic.id)).filter(m => !m.deleted).slice(-50).map(m => '- ' + m.stem.slice(0, 110)).join('\n');
    const sheetText = sheet ? JSON.stringify({ management: sheet.sections?.management, comparison: sheet.comparison }).slice(0, 14000) : '';
    const real = (await DB.byIndex('mcqs', 'topicId', topic.id)).filter(m => !m.deleted && !m.flagged && ['AMEDEX', 'PYQ'].includes(qBank(m)) && !qBroken(m) && !m.oldFormat).slice(0, 4);
    const examples = real.map(m => `Q: ${m.stem}\n${m.options.map((o, i) => String.fromCharCode(65 + i) + ') ' + o).join('\n')}\nAnswer: ${String.fromCharCode(65 + m.ans)}`).join('\n\n');
    const prompt = `Write ${nAmc} AMC-style and ${nMbbs} Indian-MBBS-style MCQs on: ${topic.name}.
${examples ? `\nREAL EXAM QUESTIONS on this topic — match their style, length and difficulty exactly (do not copy them):\n${examples}\n` : ''}
Only write questions that are highly relevant and conceptual (UWorld-like reasoning: next best step, mechanism, distinguishing two close diagnoses). Fewer, better questions beat many easy ones. Every wrong option must be something a real junior doctor could choose.

Factual basis — the revision sheet and book excerpts below. Prefer facts from them; cite pages when used.
SHEET: ${sheetText}

EXCERPTS:
${excerptBlock(pages).slice(0, 45000) || '(none)'}

AMC style: Australian setting (GP clinic, ED, rural hospital), a real patient vignette (age, sex, presentation, key findings, sometimes results), single best answer, EXACTLY 5 options, Australian drugs/guidelines. Typical leads: "most likely diagnosis", "most appropriate next step", "best initial investigation", "most appropriate management".
MBBS style: Indian university / NEET-PG clinical style, EXACTLY 4 options.

QUALITY RULES
- Test only high-yield, examinable decisions: diagnosis, next step, investigation of choice, first-line treatment, complication, contraindication, the AMC-specific differences. No trivia, no eponyms for their own sake.
- About 1 in 5 questions should test a small bedside concept that separates look-alike answers — an examination trick or sign that changes the diagnosis (e.g. direction of visible peristalsis: gastric outlet obstruction moves left → right, transverse colon right → left; whether you can get above a swelling; dullness that shifts). Build a real vignette around it. Mark these with "pearl": true.
- "master": one short line — the exact fact a student must know to never miss this question.
- No "all of the above"/"none of the above". Options parallel and similar length. Distractors must be plausible (what a weaker student would pick). Exactly one defensible answer.
- Spread the correct letter evenly across positions.
- explanation: first line "Answer: <option text>" then 1–3 lines why, then one short line per wrong option ("B — ...").
- Do not repeat these existing questions:
${existing || '(none yet)'}

Return JSON: {"mcqs":[{"type":"AMC","stem":"","options":["","","","",""],"answer":0,"explanation":"","difficulty":"medium","cite":"","pearl":false,"master":""}]}`;
    const out = ctx?.provider ? await Providers.call(ctx.provider, { prompt, system: SYSTEM_TUTOR, temperature: 0.55, maxTokens: 12000 }) : await AI.call({ prompt, system: SYSTEM_TUTOR, temperature: 0.55 });
    const list = (out.mcqs || []).map(m => cleanMcq(m, topic)).filter(Boolean);
    await DB.putMany('mcqs', list);
    return list.length;
  }
};

function cleanMcq(m, topic, extra = {}) {
  const options = (m.options || []).map(o => String(o).replace(/^\s*[A-Ea-e][.)]\s+/, '').trim()).filter(Boolean);
  let ans = typeof m.answer === 'string' && /^[A-E]$/i.test(m.answer.trim()) ? m.answer.trim().toUpperCase().charCodeAt(0) - 65 : +m.answer;
  const toIdx = a => typeof a === 'string' && /^[A-E]$/i.test(a.trim()) ? a.trim().toUpperCase().charCodeAt(0) - 65 : +a;
  let multi = Array.isArray(m.answers) ? [...new Set(m.answers.map(toIdx))].filter(i => i >= 0 && i < options.length).sort() : null;
  if (multi && multi.length > 1 && !(ans >= 0 && ans < options.length)) ans = multi[0];
  if (!multi || multi.length < 2) multi = null;
  if (!m.stem || options.length < 3 || !(ans >= 0 && ans < options.length)) return null;
  const type = extra.type || (m.type === 'MBBS' ? 'MBBS' : m.type === 'IMG' ? 'IMG' : 'AMC');
  return {
    id: uid(), topicId: topic?.id || m.topicId || '', system: topic?.system || extra.system || '',
    type, stem: String(m.stem).trim(), options, ans, ...(multi ? { multi } : {}),
    expl: asText(m.explanation || ''), cite: m.cite || '', difficulty: m.difficulty || 'medium',
    ...(m.pearl ? { pearl: 1 } : {}), ...(m.master ? { masterLine: asText(m.master) } : {}),
    src: extra.src || 'ai', keyedBy: m.keyedBy || (extra.src ? 'book' : 'ai'), img: extra.img || null,
    flagged: 0, created: Date.now()
  };
}

// After a wrong answer: which pages of YOUR books to read first, and exactly what to master.
async function findRefs(m, max = 4) {
  const topic = m.topicId ? await DB.get('topics', m.topicId) : null;
  const correct = correctSet(m).map(i => m.options[i]).join(' ');
  const words = (m.stem + ' ' + correct).toLowerCase().match(/[a-z][a-z-]{5,}/g) || [];
  const freq = {}; words.forEach(w => { if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1; });
  const kw = Object.keys(freq).sort((x, y) => y.length - x.length).slice(0, 8);
  const terms = topicTerms({ name: topic?.name || '', kw: [...(topic?.kw || []), ...kw, ...correct.toLowerCase().split(/[,;/]/).map(x => x.trim()).filter(x => x.length > 3)] });
  if (!terms.length) return [];
  const books = (await DB.all('books')).filter(b => ['ref', 'mbbs', 'amc'].includes(b.role));
  const per = [];
  for (const b of books) {
    let best = [];
    await DB.each('pages', 'bookId', b.id, pg => {
      const sc = scorePage(pg.text, terms);
      if (sc > 0) { best.push({ s: sc, bookId: b.id, size: b.size, p: pg.p, book: b.short || b.name, role: b.role, text: pg.text }); if (best.length > 12) { best.sort((x, y) => y.s - x.s); best.length = 3; } }
    });
    best.sort((x, y) => y.s - x.s); per.push(...best.slice(0, 2));
  }
  per.sort((x, y) => y.s - x.s);
  // AMC source first when it is close, because that is the exam's answer.
  return per.slice(0, max);
}

async function masterQuestion(m, chosen) {
  let refs = await findRefs(m).catch(() => []);
  // No books on this device: use the page links the laptop prepared earlier (no page text, just where to read).
  if (!refs.length && m.refs?.length) refs = m.refs.map(r => ({ ...r, text: '' }));
  const topic = m.topicId ? await DB.get('topics', m.topicId) : null;
  const L = i => String.fromCharCode(65 + i);
  const ch = chosen == null ? [] : Array.isArray(chosen) ? chosen : [chosen];
  const prompt = `A student preparing for the AMC MCQ exam got this question wrong.
${topic ? 'Topic: ' + topic.name + '\n' : ''}Question: ${m.stem}
Options: ${m.options.map((o, i) => L(i) + '. ' + o).join(' | ')}
Correct: ${letters(correctSet(m))}${ch.length ? '   Student chose: ' + ch.map(L).join(', ') : ''}
Explanation given: ${String(m.expl || '').slice(0, 1500)}

Pages from the student's own books (labels in brackets):
${refs.map(r => `[${r.book} p.${r.p}]\n${(r.text || '(page text not on this device — judge from the book and page)').slice(0, 3500)}`).join('\n\n') || '(no matching pages on this device)'}

Return JSON {"read":[{"ref":"[Book p.N]","why":"what to read there, in a few words"}],"master":["3–5 short bullets: the exact facts, numbers, discriminating features or bedside signs to master so this trap never catches them again"],"trap":"one line: why the wrong choice was tempting and how to tell them apart"}
"read": 1–3 entries, ONLY from the bracket labels above and only if they really cover this; best first; empty array if none fit.`;
  const out = await AI.call({ prompt, system: SYSTEM_TUTOR, temperature: 0.2 });
  const read = (out.read || []).map(r => { const mm = String(r.ref || '').match(/\[?(.+?) p\.(\d+)\]?/); const hit = mm && refs.find(x => x.book === mm[1].trim() && x.p === +mm[2]); return hit ? { book: hit.book, bookId: hit.bookId, size: hit.size, p: hit.p, why: asText(r.why || '') } : null; }).filter(Boolean);
  if (!read.length) refs.slice(0, 2).forEach(r => read.push({ book: r.book, bookId: r.bookId, size: r.size, p: r.p, why: '' }));
  m.master = { read, points: (out.master || []).map(asText).filter(Boolean).slice(0, 6), trap: asText(out.trap || ''), at: Date.now() };
  await DB.put('mcqs', m);
  return m.master;
}

// "Ask your books": find the exact lines in your own books that answer a question (e.g. "define normal labour").
const SEARCH_STOP = new Set(('what is are the of a an in on for and or to by from with as at per acc according its it this that these those how why which when where who whom ' +
  'define definition defined meaning means explain describe description about tell me give list write short note notes book books page chapter text textbook ' +
  'mention mentioned regarding related do does did can could should would will use used using also into than then there their your my our').split(' '));
// Short names people use for their books → words to match in the book title.
const BOOK_ALIASES = { 'b and l': 'bailey', 'b&l': 'bailey', 'bl': 'bailey', 'bailey': 'bailey', 'love': 'bailey', 'srb': 'srb', 'dutta': 'dutta', 'dc dutta': 'dutta', 'harrison': 'harrison', 'davidson': 'davidson', 'murtagh': 'murtagh', 'williams': 'williams', 'ghai': 'ghai', 'op ghai': 'ghai', 'nelson': 'nelson', 'kumar': 'kumar', 'robbins': 'robbins', 'guyton': 'guyton', 'park': 'park', 'red book': 'redbook', 'austroads': 'austroads', 'handbook': 'handbook', 'anthology': 'anthology' };
function pickBook(q, books) {
  // "... from b and l", "... in Dutta", "acc to Harrison"
  const m = q.match(/\b(?:from|in|acc(?:ording)?(?: to)?|as per|per)\s+([a-z&. ]{1,30})$/);
  const tail = (m ? m[1] : '').replace(/\./g, '').trim();
  if (!tail) return { q, filter: null };
  const key = BOOK_ALIASES[tail] || tail.split(' ').find(w => w.length > 3 && books.some(b => (b.name || '').toLowerCase().includes(w)));
  const hits = key ? books.filter(b => (b.name || '').toLowerCase().replace(/[^a-z]/g, '').includes(key.replace(/[^a-z]/g, ''))) : [];
  return hits.length ? { q: q.slice(0, m.index).trim(), filter: new Set(hits.map(b => b.id)) } : { q, filter: null };
}
const SPELL_PAIRS = [['labor', 'labour'], ['tumor', 'tumour'], ['color', 'colour'], ['behavior', 'behaviour'], ['hemorrh', 'haemorrh'], ['hem', 'haem'], ['anem', 'anaem'], ['anesth', 'anaesth'],
  ['gynec', 'gynaec'], ['pediat', 'paediat'], ['orthoped', 'orthopaed'], ['cesar', 'caesar'], ['ischem', 'ischaem'], ['leukem', 'leukaem'], ['septicem', 'septicaem'], ['edema', 'oedema'], ['esoph', 'oesoph'],
  ['estro', 'oestro'], ['fetus', 'foetus'], ['fetal', 'foetal'], ['diarrhea', 'diarrhoea'], ['center', 'centre'], ['fiber', 'fibre'], ['liter', 'litre'], ['iz', 'is']];
function spellVariants(w) {
  const out = new Set([w]);
  for (const [us, uk] of SPELL_PAIRS) { if (w.includes(uk)) out.add(w.replace(uk, us)); else if (w.includes(us)) out.add(w.replace(us, uk)); }
  return [...out];
}
// Scanned pages with pictures leave junk characters ("�:: ,�� · h $"). Keep only real words and numbers.
function cleanOcr(t) {
  return t.replace(/[^\x20-\x7E°±≤≥µ×–—…‘’“”■•→↑↓]/g, ' ').split(/\s+/).filter(w => {
    if (!w) return false;
    if (/[;{}?!$|_¢]/.test(w.slice(0, -1)) || /^[-(]?[A-Za-z][;:]?$/.test(w) && !/^(a|A|I)$/.test(w) || /^[()\-]+$/.test(w) || /^-[A-Za-z]{1,2}$/.test(w)) return false;
    const good = (w.match(/[A-Za-z0-9]/g) || []).length;
    return good >= Math.max(1, w.length * 0.5) || /^[-–—:;,.()\/%■•…]$/.test(w);
  }).join(' ').replace(/(\s[,;:.·])+(?=\s)/g, '').replace(/\s{2,}/g, ' ').trim();
}
// Short forms people type → the words books use ("complications of MI" must find "myocardial infarction").
const MED_ABBR = { mi: 'myocardial infarction', acs: 'acute coronary syndrome', cad: 'coronary artery disease', ihd: 'ischaemic heart disease', hf: 'heart failure', ccf: 'congestive cardiac failure', af: 'atrial fibrillation', htn: 'hypertension',
  copd: 'chronic obstructive pulmonary disease', tb: 'tuberculosis', pe: 'pulmonary embolism', dvt: 'deep vein thrombosis', ards: 'acute respiratory distress syndrome', ckd: 'chronic kidney disease', aki: 'acute kidney injury', uti: 'urinary tract infection',
  dka: 'diabetic ketoacidosis', dm: 'diabetes mellitus', gdm: 'gestational diabetes', sle: 'systemic lupus erythematosus', ra: 'rheumatoid arthritis', cva: 'stroke', tia: 'transient ischaemic attack', gbs: 'guillain-barre syndrome',
  ibd: 'inflammatory bowel disease', ibs: 'irritable bowel syndrome', gerd: 'gastro-oesophageal reflux', gord: 'gastro-oesophageal reflux', pud: 'peptic ulcer', ugib: 'upper gastrointestinal bleeding', pph: 'postpartum haemorrhage', aph: 'antepartum haemorrhage',
  iugr: 'fetal growth restriction', fgr: 'fetal growth restriction', pih: 'pregnancy induced hypertension', pcos: 'polycystic ovary syndrome', bph: 'benign prostatic hyperplasia', ttp: 'thrombotic thrombocytopenic purpura', itp: 'immune thrombocytopenia', dic: 'disseminated intravascular coagulation' };
async function searchBooks(query, max = 6) {
  query = String(query).replace(/\b[A-Za-z]{2,4}\b/g, w => MED_ABBR[w.toLowerCase()] && !/^(pe|ra|dm|hf)$/i.test(w) || (MED_ABBR[w.toLowerCase()] && w === w.toUpperCase()) ? MED_ABBR[w.toLowerCase()] : w);
  let q = query.toLowerCase().replace(/[^a-z0-9\s&'.-]/g, ' ').replace(/\s+/g, ' ').trim();
  const allBooks = (await DB.all('books')).filter(b => ['ref', 'mbbs', 'amc', 'reader'].includes(b.role));
  const pick = pickBook(q, allBooks); q = pick.q;
  const wantDef = /defin|what is|what are|meaning|means/.test(query.toLowerCase());
  // Guideline bodies the teacher names ("according to WHO", "FIGO staging"): the passage MUST mention them.
  const ORGS = { who: /\bWHO\b|World Health Organi[sz]ation/, figo: /\bFIGO\b/, nice: /\bNICE\b/, rcog: /\bRCOG\b/, acog: /\bACOG\b/, icmr: /\bICMR\b/, nhmrc: /\bNHMRC\b/, racgp: /\bRACGP\b/, ranzcog: /\bRANZCOG\b/, cdc: /\bCDC\b/, aha: /\bAHA\b/, esc: /\bESC\b/, gina: /\bGINA\b/, gold: /\bGOLD\b/, kdigo: /\bKDIGO\b/, ada: /\bADA\b/, iap: /\bIAP\b/ };
  const orgs = Object.keys(ORGS).filter(k => (k === 'who' ? (/\bWHO\b/.test(query) || /(according to|acc(\.|ording)? to|as per|per|by|of|the) who\b|\bwho (criteria|classification|definition|grading|guideline|staging|grade)/i.test(query)) : new RegExp('\\b' + k + '\\b', 'i').test(query)));
  const orgOk = text => orgs.every(k => ORGS[k].test(text));
  const words = [...new Set(q.replace(/[&.]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !SEARCH_STOP.has(w) && !orgs.includes(w)))];
  if (!words.length) return [];
  // Word families: "hernioplasty" also finds hernia / herniorrhaphy.
  const stems = words.filter(w => w.length >= 8).map(w => w.slice(0, 5));
  // British/American spellings: labor = labour, hemorrhage = haemorrhage, edema = oedema…
  const vars = words.map(spellVariants);
  const phrase = words.join(' ');
  const phrases = words.length > 1 ? vars.reduce((acc, v) => acc.flatMap(a => v.map(x => a ? a + ' ' + x : x)), ['']).slice(0, 8) : [];
  const terms = topicTerms({ name: '', kw: [...new Set([...phrases, ...vars.flat(), ...stems])] });
  const defCue = /^.{0,60}?(is defined as|defined as|is said to be|refers to|is called|is termed|is known as|is the |is a |is an |means |may be defined|:|—|-)/;
  // Books also write it backwards: "Series of events … is called 'labor'". Then the definition starts at that sentence.
  const sentStart = (lt, i) => { const a = Math.max(lt.lastIndexOf('. ', i), lt.lastIndexOf('\n\n', i)); return a < 0 ? 0 : a + 2; };
  const atWord = (lt, i) => i === 0 || !/[a-z]/.test(lt[i - 1]);      // "normal labour" must not match inside "abnormal labour"
  let defStrong = false;
  const defIn = (lt, list) => {
    defStrong = false;
    // Strongest: a "DEFINITION" heading with the term just before it (chapter title) or just after it.
    let d = lt.indexOf('definition');
    while (d >= 0) {
      const near = lt.slice(Math.max(0, d - 300), d + 500);
      if (list.some(ph => { const k = near.indexOf(ph); return k >= 0 && atWord(near, k); })) { defStrong = true; return d + 'definition'.length; }
      d = lt.indexOf('definition', d + 10);
    }
    for (const ph of list) {
      let i = lt.indexOf(ph);
      while (i >= 0) {
        if (atWord(lt, i) && defCue.test(lt.slice(i + ph.length, i + ph.length + 80))) return i;
        if (atWord(lt, i) && /(is|are) (called|termed|known as|defined as)\s*['"‘“]?\s*$/.test(lt.slice(Math.max(0, i - 30), i))) return sentStart(lt, i);
        i = lt.indexOf(ph, i + 1);
      }
    }
    return -1;
  };
  const head = words.length > 1 ? vars[vars.length - 1] : [];   // "normal labour" → also the definition of "labour" itself
  const phraseDef = lt => defIn(lt, phrases.length ? phrases : vars.flat());
  const headDef = lt => head.length ? defIn(lt, head) : -1;
  const books = pick.filter ? allBooks.filter(b => pick.filter.has(b.id)) : allBooks;
  const has1 = (lt, w) => lt.includes(w) || (w.length >= 8 && lt.includes(w.slice(0, 5)));
  const has = (lt, w) => spellVariants(w).some(v => has1(lt, v));
  let top = [];
  for (const b of books) {
    await DB.each('pages', 'bookId', b.id, pg => {
      const lt = pg.text.toLowerCase();
      const n = words.filter(w => has(lt, w)).length;
      if (!n || (words.length >= 2 && n < Math.ceil(words.length / 2))) return; // the page must contain the main words
      if (orgs.length && !orgOk(pg.text)) return;                    // "according to WHO": only pages that mention WHO
      let sc = scorePage(pg.text, terms) * (1 + n);
      if (phrases.some(ph => lt.includes(ph))) sc *= 3;              // the exact phrase ("normal labour"), not just the single words
      if (wantDef && phraseDef(lt) >= 0) sc *= defStrong ? 8 : 4;                    // …followed by "is defined as / is the…" = the definition line
      else if (wantDef && headDef(lt) >= 0) sc *= 3;               // the main word's own definition ("…is called 'labor'")
      if (sc > 0) { top.push({ s: sc, bookId: b.id, size: b.size, p: pg.p, book: b.short || b.name, role: b.role, text: pg.text }); if (top.length > 120) { top.sort((x, y) => y.s - x.s); top.length = 40; } }
    });
  }
  // Offline AI: add pages whose MEANING matches, even without the exact words.
  const sem = await semanticHits(q, books).catch(() => []);
  const byKey = new Map(top.map(t => [t.bookId + ':' + t.p, t]));
  const maxS = Math.max(1, ...top.map(t => t.s));
  for (const h of sem) {
    const k = h.bookId + ':' + h.p, cur = byKey.get(k);
    if (cur) { cur.s += h.sim * maxS * 1.5; cur.semOff = h.off; }
    else if (h.sim > 0.42) { const pg = await DB.get('pages', [h.bookId, h.p]); const b = books.find(x => x.id === h.bookId); if (pg && b && orgOk(pg.text)) { const t = { s: h.sim * maxS * 1.2, bookId: b.id, size: b.size, p: h.p, book: b.short || b.name, role: b.role, text: pg.text, semOff: h.off }; top.push(t); byKey.set(k, t); } }
  }
  top.sort((x, y) => y.s - x.s); top = top.slice(0, 40);
  const res = [];
  for (const pg of top) {
    // Cut out the few lines around the best match (not the whole page).
    const text = pg.text.replace(/[ \t]+/g, ' '), lt = text.toLowerCase();
    let bestPos = -1, bestSc = -1;
    let dpos = wantDef ? phraseDef(lt) : -1; if (wantDef && dpos < 0) dpos = headDef(lt);
    const strong = defStrong;
    if (dpos >= 0) { bestPos = dpos; bestSc = strong ? 80 : 40; }
    for (const w of dpos >= 0 ? [] : [...phrases, ...vars.flat(), ...stems, ...orgs]) {
      let i = lt.indexOf(w);
      while (i >= 0) {
        const win = lt.slice(Math.max(0, i - 250), i + 350);
        let sc = 0; for (const x of words) if (has(win, x)) sc += 3;
        if (phrases.some(ph => win.includes(ph))) sc += 6;
        if (orgs.length && orgOk(text.slice(Math.max(0, i - 250), i + 350))) sc += 10;   // WHO mentioned right here
        if (wantDef && /is defined as|defined as|definition|refers to|is the process|is a |is an |means |consists of/.test(win)) sc += 5;
        if (sc > bestSc) { bestSc = sc; bestPos = i; }
        i = lt.indexOf(w, i + w.length);
      }
    }
    if (bestPos < 0 && pg.semOff != null) { bestPos = Math.min(text.length - 1, pg.semOff + 40); bestSc = 4; }
    if (bestPos < 0) continue;
    let a2 = Math.max(0, bestPos - 220), b2 = Math.min(text.length, bestPos + 420);
    const before = text.lastIndexOf('. ', bestPos); if (before > a2 - 120 && before >= 0) a2 = Math.max(0, before + 2);
    if (dpos >= 0 && strong) a2 = Math.max(0, bestPos - 10);   // start right at the DEFINITION heading
    const after = text.indexOf('. ', bestPos + 120); if (after > 0 && after < b2 + 150) b2 = after + 1;
    const passage = (a2 > 0 ? '…' : '') + text.slice(a2, b2).replace(/\n+/g, ' ').trim() + (b2 < text.length ? '…' : '');
    res.push({ book: pg.book, bookId: pg.bookId, size: pg.size, p: pg.p, role: pg.role, passage: cleanOcr(passage), terms: [...new Set(vars.flat())], score: bestSc * 4 + pg.s });
  }
  res.sort((x, y) => y.score - x.score);
  const per = {}, out = [];
  for (const r of res) { if ((per[r.bookId] = (per[r.bookId] || 0) + 1) > (pick.filter ? 4 : 2)) continue; out.push(r); if (out.length >= max) break; }
  return out;
}

async function semanticHits(q, books) {
  if (!(await DB.count('vecs'))) return [];
  const [qv] = await Semantic.embed([q]);
  const allow = new Set(books.map(b => b.id)), hits = [];
  await DB.each('vecs', null, null, v => {
    if (!allow.has(v.bookId)) return;
    let dot = 0; const a = v.v; for (let i = 0; i < a.length; i++) dot += a[i] * qv[i];
    const sim = dot / 127;
    if (sim > 0.3) { hits.push({ bookId: v.bookId, p: v.p, off: v.off, sim }); if (hits.length > 400) { hits.sort((x, y) => y.sim - x.sim); hits.length = 120; } }
  });
  hits.sort((x, y) => y.sim - x.sim);
  const seen = new Set(), out = [];
  for (const h of hits) { const k = h.bookId + ':' + h.p; if (seen.has(k)) continue; seen.add(k); out.push(h); if (out.length >= 25) break; }
  return out;
}

async function explainFromBooks(query, results) {
  return AI.call({ json: false, system: SYSTEM_TUTOR,
    prompt: `A medical student was asked by a teacher: "${query}". Teachers want the exact textbook wording.
Here are passages from the student's own books:
${results.map(r => `[${r.book} p.${r.p}] ${r.passage}`).join('\n\n')}

Reply in this order:
1. **Book definition / answer** — quote the best line(s) word for word, with the [Book p.N] label. Do not reword the quote.
2. **In simple words** — 2–3 short lines.
3. **Must-say points** — 3–5 bullets an examiner expects (numbers, criteria, stages).
If the passages don't contain the answer, say so plainly and give the standard textbook definition, marked "(general knowledge)".` });
}

// Questions you ask while studying must answer in seconds, even while the background work keeps the keys busy:
// ask your key and both friends' keys at once (fast Lite models) and take the first reply; then try the other free AIs.
async function fastAI({ prompt, json = false, system }) {
  const cap = (pr, ms) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error('slow')), ms))]);
  const gem = Providers.active().filter(p => /generativelanguage/.test(p.base || '') && !p.ocrOnly);
  const quick = [AI.key ? AI.call({ prompt, json, system, model: AI.bulkModel }) : Promise.reject(new Error('no key')),
    ...gem.slice(0, 2).map(p => Providers.call({ ...p, model: /lite/.test(p.model) ? p.model : AI.bulkModel }, { prompt, json, system, maxTokens: 2000 }))];
  try { return await cap(Promise.any(quick), 20000); } catch (e) {}
  for (const p of Providers.active().filter(p => !p.ocrOnly && !p.ocrApi && !gem.includes(p))) {
    try { return await cap(Providers.call(p, { prompt, json, system, maxTokens: 2000 }), 20000); } catch (e) {}
  }
  throw new Error('All the AIs are busy right now — try again in a minute.');
}

async function askTutor(topic, question, context = '') {
  const sheet = topic ? await DB.get('sheets', topic.id) : null;
  const sheetCtx = sheet ? JSON.stringify({ sections: sheet.sections, comparison: sheet.comparison }).slice(0, 5000) : '';
  return fastAI({
    json: false, system: SYSTEM_TUTOR + ' Answer in short bullet points. When Indian and Australian practice differ, say both clearly.',
    prompt: `${topic ? 'Topic: ' + topic.name + '\nRevision sheet: ' + sheetCtx : ''}\n${context ? 'Context: ' + context : ''}\n\nStudent question: ${question}`
  });
}

// Online help for "Ask books": the AI rewrites the question into textbook wording, then picks the best passages and answers from them.
async function aiSearchAssist(q, results, canSearch, _second) {
  const fast = { model: AI.bulkModel, json: true };
  let all = results.slice();
  // Search again in textbook wording when the first try found little — or when the AI says the pages don't answer it.
  if (canSearch && (results.length < 3 || _second)) {
    const r = await AI.call({ ...fast, prompt: `A medical student searched their textbooks for: "${q}".\nWrite 4 short alternative searches using the exact words a textbook heading or sentence would use (expand abbreviations, synonyms, the operation's or condition's other names, e.g. "hernioplasty" → "mesh repair of inguinal hernia", "Lichtenstein repair"; "types of MI" → "classification of acute myocardial infarction"). Keep any book name they gave (e.g. "from davidson").\nReturn JSON {"queries":["…","…","…","…"]}` }).catch(() => null);
    const fresh = [];
    for (const alt of (r?.queries || []).slice(0, 4)) for (const x of await searchBooks(alt, 6).catch(() => [])) fresh.push(x);
    all = _second ? [...fresh, ...all] : [...all, ...fresh];
  }
  const seen = new Set(); all = all.filter(x => { const k = x.bookId + ':' + x.p; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 16);
  if (!all.length) {
    const a = await AI.call({ model: AI.bulkModel, json: false, prompt: `Answer this medical question for an MBBS/AMC student in 4–8 short bullet points: ${q}\nStart with: "(Not found in your books — general knowledge)"` });
    return { results: [], answer: a };
  }
  const list = all.map((x, i) => `[${i + 1}] ${x.book} p.${x.p}: ${String(x.passage).slice(0, 600)}`).join('\n');
  const r2 = await AI.call({ ...fast, prompt: `Question from a medical student: "${q}"\nPassages from their own textbooks:\n${list}\n\nGive a COMPLETE, correct exam answer.\nReturn JSON {"best":[numbers of passages that actually answer it, best first],"points":["one short point per item — use the books' wording where a passage covers it and end with its number like [3]; add anything important the passages miss from standard textbook knowledge, ending with (general)"]}\nUse 4–10 points, grouped logically. No paragraphs. Only list a passage in "best" if it is really about the question.` });
  const best = (r2?.best || []).map(n => all[n - 1]).filter(Boolean);
  if (!best.length && canSearch && !_second) return aiSearchAssist(q, results, canSearch, true);
  const rest = all.filter(x => !best.includes(x));
  const pts = Array.isArray(r2?.points) ? r2.points : String(r2?.answer || '').split(/\n+/);
  const answer = (best.length ? '' : '(Your books’ pages didn’t cover this directly — points marked general are standard knowledge)\n') + pts.map(x => '- ' + String(x).replace(/^[-•\s]+/, '').replace(/\[(\d+)\]/g, (m, n) => { const y = all[n - 1]; return y ? ` (${y.book.replace(/'s Principles and Pr.*/, '')} p.${y.p})` : ''; })).join('\n');
  return { results: best.length ? [...best, ...rest.slice(0, 4)] : rest.slice(0, 6), answer };
}
