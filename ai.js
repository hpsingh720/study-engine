// Gemini API client, page retrieval from your books, and all generation prompts.
class QuotaError extends Error { constructor(m, daily, retryMs) { super(m); this.daily = daily; this.retryMs = retryMs; } }

const COLS = {
  ref: { label: 'Reference', hint: 'Harrison, Bailey & Love, Williams…' },
  mbbs: { label: 'Indian MBBS', hint: 'Davidson, SRB, Dutta, Ghai…' },
  amc: { label: 'Australia / AMC', hint: 'Murtagh, eTG, AMC handbook…' }
};
const ROLES = {
  ref: 'Reference textbook', mbbs: 'MBBS textbook', amc: 'AMC / Australian source',
  'mcq-mbbs': 'MCQ book (MBBS)', 'mcq-amc': 'Question bank (AMC / AMEDEX)', practical: 'Practical / spotter book'
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

  async call(opts) {
    try { return await this._call(opts); }
    catch (e) {
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
    try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { throw new QuotaError('Network error — offline?', false, 30000); }
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
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(this.key)}`);
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
  let top = [];
  for (const b of books) {
    await DB.each('pages', 'bookId', b.id, pg => {
      const s = scorePage(pg.text, terms);
      if (s > 0) {
        top.push({ s, bookId: b.id, p: pg.p, text: pg.text, book: b.short || b.name });
        if (top.length > maxPages * 6) { top.sort((a, c) => c.s - a.s); top.length = maxPages * 3; }
      }
    });
  }
  top.sort((a, c) => c.s - a.s);
  const out = []; let chars = 0;
  for (const x of top) {
    if (out.length >= maxPages) break;
    if (chars + x.text.length > maxChars && out.length) continue;
    out.push(x); chars += x.text.length;
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
  async sheet(topic) {
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
- comparison.rows: ONLY real differences between the Indian MBBS answer and the Australian/AMC answer — first-line drugs and doses, investigation of choice, thresholds and targets, setting (GP, rural, retrieval, referral), screening and prevention programs, legal duties (driving, notification, consent, mandatory reporting), Aboriginal and Torres Strait Islander considerations. 4–10 rows. "trap" = how the AMC exam typically tests that difference.
- comparison.same: one or two lines on what is the same, so the student can skip it.
- comparison.mustKnow: Australia-only facts with no Indian equivalent (programs, laws, local epidemiology, brand-specific practice).

Return JSON exactly in this shape:
{"sections":{"patho":{"ref":"","mbbs":"","amc":""},"clinical":{"ref":"","mbbs":"","amc":""},"investigations":{"ref":"","mbbs":"","amc":""},"management":{"ref":"","mbbs":"","amc":""},"pearls":{"ref":"","mbbs":"","amc":""}},
"comparison":{"bottomLine":"","rows":[{"aspect":"","india":"","australia":"","trap":"","cite":""}],"same":"","mustKnow":[""]}}`;
    const out = await AI.call({ prompt, system: SYSTEM_TUTOR, temperature: 0.25 });
    if (!out.sections) throw new Error('AI reply missing sections');
    const sources = [];
    Object.entries(src).forEach(([col, arr]) => arr.forEach(x => sources.push({ col, bookId: x.bookId, p: x.p, book: x.book })));
    const sheet = { id: topic.id, topicId: topic.id, sections: out.sections, comparison: out.comparison || {}, sources, model: AI.model, created: Date.now() };
    await DB.put('sheets', sheet);
    return sheet;
  },

  async mcqs(topic, nAmc = 10, nMbbs = 8) {
    const sheet = await DB.get('sheets', topic.id);
    let pages = [];
    if (sheet?.sources?.length) {
      for (const s of sheet.sources.slice(0, 10)) { const pg = await DB.get('pages', [s.bookId, s.p]); if (pg) pages.push({ ...s, text: pg.text }); }
    } else {
      pages = [...await retrieve(topic, 'ref', 4, 18000), ...await retrieve(topic, 'mbbs', 3, 12000), ...await retrieve(topic, 'amc', 4, 18000)];
    }
    const existing = (await DB.byIndex('mcqs', 'topicId', topic.id)).filter(m => !m.deleted).slice(-50).map(m => '- ' + m.stem.slice(0, 110)).join('\n');
    const sheetText = sheet ? JSON.stringify({ management: sheet.sections?.management, comparison: sheet.comparison }).slice(0, 14000) : '';
    const prompt = `Write ${nAmc} AMC-style and ${nMbbs} Indian-MBBS-style MCQs on: ${topic.name}.

Factual basis — the revision sheet and book excerpts below. Prefer facts from them; cite pages when used.
SHEET: ${sheetText}

EXCERPTS:
${excerptBlock(pages).slice(0, 45000) || '(none)'}

AMC style: Australian setting (GP clinic, ED, rural hospital), a real patient vignette (age, sex, presentation, key findings, sometimes results), single best answer, EXACTLY 5 options, Australian drugs/guidelines. Typical leads: "most likely diagnosis", "most appropriate next step", "best initial investigation", "most appropriate management".
MBBS style: Indian university / NEET-PG clinical style, EXACTLY 4 options.

QUALITY RULES
- Test only high-yield, examinable decisions: diagnosis, next step, investigation of choice, first-line treatment, complication, contraindication, the AMC-specific differences. No trivia, no eponyms for their own sake.
- No "all of the above"/"none of the above". Options parallel and similar length. Distractors must be plausible (what a weaker student would pick). Exactly one defensible answer.
- Spread the correct letter evenly across positions.
- explanation: first line "Answer: <option text>" then 1–3 lines why, then one short line per wrong option ("B — ...").
- Do not repeat these existing questions:
${existing || '(none yet)'}

Return JSON: {"mcqs":[{"type":"AMC","stem":"","options":["","","","",""],"answer":0,"explanation":"","difficulty":"medium","cite":""}]}`;
    const out = await AI.call({ prompt, system: SYSTEM_TUTOR, temperature: 0.55 });
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
    src: extra.src || 'ai', keyedBy: m.keyedBy || (extra.src ? 'book' : 'ai'), img: extra.img || null,
    flagged: 0, created: Date.now()
  };
}

async function askTutor(topic, question, context = '') {
  const sheet = topic ? await DB.get('sheets', topic.id) : null;
  const sheetCtx = sheet ? JSON.stringify({ sections: sheet.sections, comparison: sheet.comparison }).slice(0, 16000) : '';
  return AI.call({
    json: false, system: SYSTEM_TUTOR + ' Answer in short bullet points. When Indian and Australian practice differ, say both clearly.',
    prompt: `${topic ? 'Topic: ' + topic.name + '\nRevision sheet: ' + sheetCtx : ''}\n${context ? 'Context: ' + context : ''}\n\nStudent question: ${question}`
  });
}
