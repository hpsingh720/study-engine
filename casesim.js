// A clinical case, start to finish, the way the exam runs it: a patient who talks, the history taken
// by voice, examination done with your hands on the drawing (technique checked), tests ordered, the
// case sheet written, then presented to an examiner who asks the viva and marks it.
//
// Two AIs play the parts. The patient knows only what a patient knows — symptoms in their own
// words, never the diagnosis, nothing volunteered that was not asked. The examiner has the whole
// case and your record of what you did, and marks the way examiners do.

const CASE_FORMATS = {
  general: ['Particulars (name, age, sex, occupation, address, date of admission)', 'Chief complaints with duration, in order', 'History of presenting illness', 'Past history', 'Treatment / drug history', 'Personal history', 'Family history', 'Socioeconomic history', 'General physical examination', 'Systemic examination', 'Summary', 'Provisional diagnosis', 'Differential diagnoses', 'Investigations planned', 'Management plan'],
  paeds: ['Particulars and informant (and reliability)', 'Chief complaints with duration', 'History of presenting illness', 'Past history', 'Birth history (antenatal, natal, postnatal)', 'Immunisation history', 'Developmental history', 'Dietary history', 'Family history', 'Socioeconomic history', 'General physical examination with anthropometry', 'Systemic examination', 'Summary', 'Provisional diagnosis', 'Differential diagnoses', 'Investigations planned', 'Management plan'],
  obg: ['Particulars (age, gravida/para/living/abortion, LMP, EDD, gestational age)', 'Chief complaints with duration', 'History of present pregnancy (trimester-wise)', 'Menstrual history', 'Obstetric history (each pregnancy)', 'Past history', 'Personal and family history', 'General physical examination', 'Systemic examination', 'Obstetric examination (inspection, palpation — fundal height, grips — auscultation)', 'Summary', 'Diagnosis', 'Investigations planned', 'Management plan']
};
const SUBJECTS = { medicine: 'Medicine', surgery: 'Surgery', paeds: 'Paediatrics', obg: 'Obstetrics & Gynaecology' };
const LANGS = { hi: 'Hindi', pa: 'Punjabi', en: 'English', mix: 'Hinglish (mixed)' };

// Gemini's 503 ("overloaded") is common and passes in seconds. Every AI step of a case rides it out:
// the lighter model at once, then your other keys (Groq, Mistral), then again after a short wait —
// instead of failing on the first refusal.
async function caseAI(o) {
  const busy = e => /busy|overload|503|500|502|504|429|quota|rate|unavailable|timed out|network|empty ai reply/i.test(String(e?.message || e));
  const waits = [0, 4, 10, 20];
  let last;
  for (let i = 0; i < waits.length; i++) {
    for (let s = waits[i]; s > 0; s--) { caseAI.say?.(`Gemini is busy — trying again in ${s} s (${i + 1} of ${waits.length})`); await sleep(1000); }
    for (const t of (o.model && o.model !== AI.bulkModel ? [o, { ...o, model: AI.bulkModel }] : o.model ? [o, { ...o, model: undefined }] : [o, { ...o, model: AI.bulkModel }])) {
      if (!AI.key) break;
      try { return await AI.call(t); } catch (e) { last = e; if (!busy(e)) throw e; }
    }
    for (const p of Providers.active().filter(p => !p.ocrOnly && !p.ocrApi)) {
      try { return await Providers.call(p, { prompt: o.prompt, json: o.json !== false, system: o.system, temperature: o.temperature ?? 0.4, maxTokens: 8000 }); } catch (e) { last = e; }
    }
  }
  throw new Error(`Gemini is overloaded right now and did not answer after ${waits.length} tries (${String(last?.message || last).slice(0, 80)}). Wait a minute and tap again${Providers.active().length ? '' : ' — or add a free Groq or Mistral key in Settings so they can stand in'}.`);
}

const CaseSim = {
  c: null,
  // The case in memory is the live one; storage is only read when the app opens. Re-reading it on
  // every screen threw away a reply that had arrived while the screen was being redrawn.
  load() { if (this.c) return this.c; try { this.c = JSON.parse(localStorage.getItem('casesim') || 'null'); } catch (e) { this.c = null; } return this.c; },
  save() { try { localStorage.setItem('casesim', JSON.stringify(this.c)); } catch (e) { toast('This device is low on space — the case may not be saved.'); } },
  format(c) {
    // Your own college's case-sheet format, when you have added it in Settings; otherwise the standard one.
    let own = null; try { own = JSON.parse(localStorage.getItem('caseFormats') || 'null'); } catch (e) {}
    const k = c.subject === 'paeds' ? 'paeds' : c.subject === 'obg' ? 'obg' : 'general';
    if ((own?.[c.subject] || own?.[k])?.length) return own[c.subject] || own[k];
    if (c.proforma?.length >= 6) return c.proforma;
    return CASE_FORMATS[k];
  },

  // ---- the book every case is built from ----
  // Every textbook on this device, Boloor (and other clinical-methods books) at the top.
  async books() { return typeof TechBook !== 'undefined' ? (await TechBook.all()).sort((a, b) => ((b.pages >= 3) - (a.pages >= 3)) || TechBook.rank(a) - TechBook.rank(b)) : []; },
  pickedBook(books) { const id = localStorage.getItem('caseBook'); return books.find(b => b.id === id) ? id : (books[0]?.id || 'none'); },

  /**
   * The book's pages for this case. With a condition named, its pages; without, a condition the
   * book itself covers — from its chapters if the subject was built from it, otherwise a page of the
   * book that describes a disease — never one picked from outside the book.
   */
  async bookPages(book, topic) {
    const words = t => String(t).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    if (topic) return TechBook.pagesFor(book, { name: topic, kw: [topic.toLowerCase(), ...words(topic)] }, 5, 24000);
    let recent = []; try { recent = JSON.parse(localStorage.getItem('caseRecent') || '[]'); } catch (e) {}
    const fromTree = shuffle((await DB.live('topics')).filter(t => t.bookId === book.id && !recent.includes(t.name)));
    for (const t of fromTree.slice(0, 4)) {
      const pages = await TechBook.pagesFor(book, t, 5, 24000);
      if (pages.length) return pages;
    }
    const cand = [];
    await DB.each('pages', 'bookId', book.id, pg => {
      // A page about a disease: several of these words, and not the proforma, contents or index.
      const t = pg.text || '';
      if (t.length < 800 || /proforma|case sheet|table of contents|^\s*contents|^\s*index/im.test(t.slice(0, 600))) return;
      const hits = ['clinical features', 'symptoms', 'signs', 'aetiology', 'etiology', 'causes', 'investigation', 'management', 'treatment', 'complications', 'diagnosis'].filter(w => t.toLowerCase().includes(w)).length;
      if (hits >= 2) cand.push(pg.p);
    });
    if (!cand.length) return [];
    const p0 = cand[Math.floor(Math.random() * cand.length)], out = [];
    // The page before as well: a page from the middle of a topic needs the start of it (its heading, the symptoms).
    for (const p of [p0 - 1, p0, p0 + 1, p0 + 2]) { const pg = await DB.get('pages', [book.id, p]); if (pg?.text) out.push({ bookId: book.id, p, text: pg.text, book: book.short || book.name }); }
    return out;
  },

  // The headings the book itself uses for a case sheet, read once and kept.
  async proforma(book) {
    const key = 'caseFormat-' + book.id;
    const have = await DB.get('prefs', key);
    if (have) return have.headings || [];
    const pages = await TechBook.pagesFor(book, { name: 'case sheet proforma', kw: ['case sheet', 'proforma', 'history taking', 'chief complaints', 'presenting complaints', 'general physical examination', 'systemic examination', 'provisional diagnosis'] }, 4, 14000);
    if (!pages.length) return [];
    const out = await caseAI({ temperature: 0.1, prompt: `These are pages from "${book.name}". If they show how this book sets out a clinical case sheet (proforma) for a long case, list its section headings in order, exactly as the book writes them. Otherwise return {"found":false}.
JSON {"found":true,"headings":[""]}

${excerptBlock(pages)}` }).catch(() => null);
    const headings = out?.found ? (out.headings || []).map(String).filter(Boolean).slice(0, 30) : [];
    await DB.put('prefs', { id: key, headings, at: Date.now() });
    return headings;
  },
  voiceFor(p) {
    const female = /^f/i.test(p?.sex || '') || p?.informant && /mother|mata|maa/i.test(p.informant);
    return female ? 'Kore' : 'Charon';
  },
  langCode(c) { return { hi: 'hi-IN', pa: 'pa-IN', en: 'en-IN', mix: 'en-IN' }[c.lang] || 'en-IN'; },

  async create({ subject, topic, lang, kind, difficulty, book: bookId, quick }) {
    const findingKeys = TECHNIQUES.map(t => t.finding).filter(Boolean);
    const book = bookId && bookId !== 'none' ? (await this.books()).find(b => b.id === bookId) : null;
    let pages = [], proforma = Promise.resolve([]);
    if (book) {
      const name = book.short || book.name;
      if ((book.pages || 0) < 3) throw new Error(`${name}'s text is not on this device yet, so no case can be made from it. On the laptop, open the app and leave it open a few minutes — it sends the text. Then on this phone tap "Ask books" once to download it. Or pick another book.`);
      pages = await this.bookPages(book, topic);
      if (!pages.length) throw new Error(topic ? `Could not find "${topic}" in ${name} (${book.pages} pages on this device). Check the spelling, try a shorter name (e.g. "nephrotic" instead of "nephrotic syndrome in children"), or leave it empty for any case from the book.` : `Could not find a disease section in ${name} to build a case from. Type a condition instead.`);
      proforma = this.proforma(book).catch(() => []);
    }
    const fromBook = book ? `
THE BOOK — build this case ONLY from these pages of "${book.name}". The diagnosis must be a condition these pages describe. Every key history point, examination finding, investigation and viva question with its answer must come from these pages, in the book's own terms. Add the page label, like [${book.short || 'Book'} p.N], to the end of each keyHistory item and each viva answer. Never bring in anything the pages do not say.

${excerptBlock(pages)}
` : '';
    const prompt = `${fromBook}Create a realistic ${kind === 'short' ? 'SHORT case' : 'LONG case'} for an Indian MBBS final-year clinical exam in ${SUBJECTS[subject]}${topic ? `, on or around: ${topic}` : ' — pick a condition commonly kept for MBBS finals'}. Difficulty: ${difficulty}.
The patient is a real-feeling Indian patient (rural or urban Punjab/North India unless the condition suggests otherwise). For a child, the history is given by the mother. For obstetrics, a pregnant woman with full obstetric details.

Return JSON:
{"diagnosis":"","differentials":[""],
"patient":{"name":"","age":"","sex":"male|female","occupation":"","place":"","informant":"self or mother/father","personality":"how they talk: anxious / talkative / vague / stoic / in pain…","mood":"calm|anxious|pain|tired"},
"opening":"the first thing they say when you greet them and ask what the problem is — their own words, ONE or two short sentences, no medical terms",
"facts":{"complaints":[{"what":"","duration":""}],"hpi":["each detail a patient could tell if asked: onset, progression, character, aggravating/relieving, associated symptoms, negatives"],"past":[""],"drugs":[""],"personal":[""],"family":[""],"social":[""],"extra":["birth/immunisation/development/diet for a child; menstrual/obstetric for OBG"]},
"keyHistory":["8-15 things an examiner expects the student to have asked — the discriminating questions for this case"],
"exam":{"vitals":{"pulse":"","bp":"","rr":"","temp":"","spo2":""},${findingKeys.map(k => `"${k}":""`).join(',')},"other":{"inspection":"","palpation":"","percussion":"","auscultation":"","system-specific":""}},
"tests":{"name of test":"result"},
"viva":[{"q":"","a":""}]}

RULES
- exam: every key above gets the finding for THIS patient in one short line ("Present — bilateral pitting up to mid-shin", "Absent", "Raised, 6 cm above the sternal angle", "Not applicable"). Consistent with the diagnosis.
- tests: 6-12 relevant investigations with realistic values and units.
- viva: 8 questions an Indian examiner asks on this case, with model answers (short).
- Everything internally consistent.${book ? '\n- "source": the page range used, e.g. "[' + (book.short || 'Book') + ' p.212-214]". Add it to the JSON.' : ''}`;
    const tok = (this._tok = uid());
    const out = await caseAI({ prompt, system: SYSTEM_TUTOR, temperature: book ? 0.5 : 0.8, ...(quick ? { model: AI.bulkModel } : {}) });
    if (tok !== this._tok) return this.c;   // a slower earlier attempt finishing late: the newer patient stays
    if (!out?.patient || !out?.facts) throw new Error('The AI reply was incomplete — try again.');
    this.c = { id: 'case-' + uid(), subject, topic, lang, kind, difficulty, started: Date.now(), stage: 'history', case: out, chat: [], exams: [], tests: [], sheet: {}, presentation: '', viva: [], report: null, mood: out.patient.mood || 'calm',
      book: book ? { id: book.id, name: book.short || book.name } : null,
      // The pages are kept with the case, so the examiner and the viva mark against the same text.
      excerpt: book ? excerptBlock(pages).slice(0, 20000) : '', proforma: await proforma };
    if (book) { try { const r = JSON.parse(localStorage.getItem('caseRecent') || '[]'); localStorage.setItem('caseRecent', JSON.stringify([out.diagnosis, ...r].slice(0, 12))); } catch (e) {} }
    this.save();
    return this.c;
  },

  // ---- the patient ----
  // Who the patient is and how they talk — shared by typed/spoken turns and live talk.
  persona(c = this.c) {
    const k = c.case, p = k.patient;
    const home = { hi: 'Hindi', pa: 'Punjabi', en: 'simple Indian English', mix: 'Hinglish' }[c.lang] || 'simple Indian English';
    return `You are ${p.name}, ${p.age}, ${p.sex}, ${p.occupation} from ${p.place}${p.informant && !/self/i.test(p.informant) ? ` — actually you are the ${p.informant} of the patient, answering for them` : ''}. A medical student is taking your history in a hospital ward. Personality: ${p.personality}.
WHAT YOU KNOW (your own experience, in your own words): ${JSON.stringify(k.facts)}
RULES — stay in character always:
- Answer ONLY what was asked. Never volunteer other symptoms; a student must ask.
- You do not know medical terms or your diagnosis. Never name it. Describe what you feel and notice.
- If asked something not listed, give a natural answer that fits and stays consistent (usually "no" for symptoms not in your story).
- Short: one to three sentences, like real speech. Show feeling where natural (worry, pain, embarrassment).
- If the student is rude or uses jargon, be confused like a real patient.
- LANGUAGE: answer in the language the student is using right now — Punjabi, Hindi or English — the way a real patient from Punjab would. If they switch, you switch. Before they say anything, use ${home}. The student's Punjabi may reach you written in Urdu (Shahmukhi) letters or Latin letters: it is still Punjabi — understand it.`;
  },

  async reply(question) {
    const c = this.c;
    c.chat.push({ who: 'you', text: question, at: Date.now() });
    const system = `${this.persona(c)}
- WRITING: Punjabi always in Gurmukhi script (ਗੁਰਮੁਖੀ), never Urdu/Shahmukhi letters. Hindi in Devanagari. Hinglish in Latin letters. English in English.
Return JSON: {"reply":"","mood":"calm|anxious|pain|tired|confused"}`;
    const convo = c.chat.slice(-24).map(m => `${m.who === 'you' ? 'Student' : 'You'}: ${m.text}`).join('\n');
    let out;
    try { out = await caseAI({ prompt: convo + '\nYou:', system, temperature: 0.7, model: AI.bulkModel }); }
    catch (e) { out = await caseAI({ prompt: convo + '\nYou:', system, temperature: 0.7 }); }
    const text = String(out?.reply || '').trim() || '…';
    c.mood = out?.mood || c.mood;
    c.chat.push({ who: 'patient', text, at: Date.now() });
    this.save();
    return text;
  },

  // The voice follows the script of what is being said, not the language picked at the start.
  langOf(text, c = this.c) {
    if (/[\u0A00-\u0A7F]/.test(text)) return 'pa-IN';
    if (/[\u0900-\u097F]/.test(text)) return 'hi-IN';
    if (/[\u0600-\u06FF]/.test(text)) return 'ur-IN';
    return /[a-z]/i.test(text) ? 'en-IN' : this.langCode(c);
  },

  // What Whisper should expect to hear, written in the right letters — so Punjabi comes out in
  // Gurmukhi rather than Urdu.
  hearing(c = this.c) {
    if (c.lang === 'pa') return { language: 'pa', prompt: 'ਡਾਕਟਰ ਮਰੀਜ਼ ਤੋਂ ਪੁੱਛ ਰਿਹਾ ਹੈ: ਤੁਹਾਨੂੰ ਕੀ ਤਕਲੀਫ਼ ਹੈ? ਕਿੰਨੇ ਦਿਨਾਂ ਤੋਂ? ਬੁਖ਼ਾਰ, ਖੰਘ, ਸਾਹ ਚੜ੍ਹਨਾ, ਪੇਟ ਦਰਦ, ਪਿਸ਼ਾਬ?' };
    if (c.lang === 'hi') return { language: 'hi', prompt: 'डॉक्टर मरीज़ से पूछ रहा है: आपको क्या तकलीफ़ है? कितने दिनों से? बुखार, खांसी, सांस फूलना, पेट दर्द?' };
    return { language: '', prompt: 'A doctor taking a history from a patient in a ward, in English, Hindi or Punjabi.' };
  },

  async speakPatient(text) {
    const c = this.c, p = c.case.patient;
    const style = { anxious: 'sounding worried', pain: 'a little strained, without moaning', tired: 'sounding tired', confused: 'sounding unsure' }[c.mood] || '';
    await Voice.say(text, { lang: this.langOf(text, c), voice: this.voiceFor(p), style });
  },

  // ---- examination outside the technique list ----
  async examOther(request) {
    const k = this.c.case;
    const out = await caseAI({ prompt: `Case findings: ${JSON.stringify(k.exam)}. Diagnosis: ${k.diagnosis}.
A student says: "${request}". Report ONLY what they would find doing exactly that, in one or two lines as an examiner would say it. If what they describe is vague ("examine the heart"), ask what exactly they do (inspect / palpate / percuss / auscultate, and where). Never state the diagnosis.
Return JSON: {"finding":""}`, temperature: 0.3, model: AI.bulkModel }).catch(() => caseAI({ prompt: `Findings: ${JSON.stringify(k.exam)}. Student: "${request}". One-line finding. JSON {"finding":""}` }));
    const f = String(out?.finding || '').trim();
    this.c.exams.push({ kind: 'other', what: request, finding: f, at: Date.now() });
    this.save();
    return f;
  },

  async order(test) {
    const k = this.c.case;
    const have = Object.entries(k.tests || {}).find(([n]) => n.toLowerCase().includes(test.toLowerCase()) || test.toLowerCase().includes(n.toLowerCase()));
    let result = have ? `${have[0]}: ${have[1]}` : '';
    if (!result) {
      const out = await caseAI({ prompt: `Patient with ${k.diagnosis}. Known results: ${JSON.stringify(k.tests)}. The student orders: "${test}". Give a realistic result consistent with the case, one line with units. JSON {"result":""}`, temperature: 0.3, model: AI.bulkModel }).catch(() => ({ result: 'Result not available.' }));
      // Honest about it: a result the book's case did not include is made up to fit.
      result = `${test}: ${out?.result || 'not available'}${this.c.book && out?.result ? ` (not in ${this.c.book.name}'s case — made up to fit)` : ''}`;
    }
    this.c.tests.push({ test, result, at: Date.now() });
    this.save();
    return result;
  },

  // ---- the examiner ----
  async examine() {
    const c = this.c, k = c.case;
    const techLog = c.exams.filter(e => e.kind === 'tech').map(e => `${TECH[e.id]?.name}: ${e.passed ? 'done correctly' : 'MISTAKES — ' + e.misses.join(' | ')}`).join('\n') || 'none';
    const out = await caseAI({ system: SYSTEM_TUTOR, temperature: 0.3, prompt: `You are a strict but fair Indian MBBS final-exam examiner. Mark this ${c.kind} case.

THE CASE (hidden from the student): ${JSON.stringify({ diagnosis: k.diagnosis, differentials: k.differentials, keyHistory: k.keyHistory, exam: k.exam, tests: k.tests })}
${c.excerpt ? `
THE BOOK THE CASE IS FROM (${c.book.name}) — mark against what it says, and add its page label to each missed point and each viva question:
${c.excerpt}
` : ''}

WHAT THE STUDENT ASKED THE PATIENT:
${c.chat.filter(m => m.who === 'you').map(m => '- ' + m.text).join('\n') || '(nothing)'}

EXAMINATION TECHNIQUE (watched by you):
${techLog}
Other examination: ${c.exams.filter(e => e.kind === 'other').map(e => e.what).join('; ') || 'none'}
Tests ordered: ${c.tests.map(t => t.test).join(', ') || 'none'}

DIAGNOSIS GIVEN:
Summary: ${c.dx?.summary || '—'}
Provisional: ${c.dx?.provisional || '(none)'}
Differentials: ${(c.dx?.ddx || []).filter(x => x?.name).map(x => `${x.name} (for: ${x.for || '—'}; against: ${x.against || '—'})`).join(' | ') || '(none)'}
${Object.values(c.sheet || {}).some(v => v?.trim()) ? `Case sheet notes:\n${Object.entries(c.sheet).filter(([, v]) => v?.trim()).map(([h, v]) => `## ${h}\n${v}`).join('\n').slice(0, 6000)}` : ''}
${c.presentation ? `Presented aloud: ${c.presentation}` : ''}

Return JSON:
{"score":0,"verdict":"one line, as an examiner would say it",
"history":{"good":[""],"missed":["key questions not asked"]},
"examination":{"good":[""],"missed":["examinations not done"],"technique":["technique errors seen, said plainly"]},
"presentation":{"good":[""],"improve":[""]},
"diagnosis":{"correct":true,"comment":""},
"viva":["4 questions to ask now, starting from the student's own diagnosis and findings — short, one line each"]}
score is out of 10.` });
    c.report = out;
    c.vivaQs = (out?.viva || []).slice(0, 4);
    c.stage = 'viva';
    this.save();
    return out;
  },

  // Who takes the viva — the same examiner for the whole case.
  examiner(c = this.c) {
    const list = [{ name: 'Dr. Gurpreet Singh Sandhu', sex: 'male', voice: 'Puck' }, { name: 'Dr. Anita Sharma', sex: 'female', voice: 'Kore' },
      { name: 'Dr. R. K. Gupta', sex: 'male', voice: 'Charon' }, { name: 'Dr. Harjeet Kaur Gill', sex: 'female', voice: 'Aoede' }];
    const h = [...String(c?.id || 'x')].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 3);
    return { ...list[h % list.length], age: 56, role: 'examiner' };
  },

  // A nudge for the next step, worked out on the phone at once — no waiting for the AI.
  hint() {
    const c = this.c, k = c.case;
    c.hintN = (c.hintN || 0) + 1;
    const words = t => String(t).toLowerCase().split(/[^a-z\u0900-\u0a7f]+/).filter(w => w.length > 3 && !/^(what|when|with|from|that|this|have|does|your|about|history|patient|there|their|which|ever|since|after|before|asked|ask)$/.test(w));
    const pick = arr => arr.length ? arr[(c.hintN - 1) % arr.length] : null;
    if (c.stage === 'history') {
      // Word stems (first four letters), so "puffy" counts for "puffiness".
      const said = new Set(words(c.chat.filter(m => m.who === 'you').map(m => m.text).join(' ')).map(w => w.slice(0, 4)));
      const left = (k.keyHistory || []).map(x => String(x).replace(/\s*\[[^\]]*\]\s*$/, '')).filter(x => !words(x).some(w => said.has(w.slice(0, 4))));
      const x = pick(left);
      return x ? `Ask about: ${x}` : 'You have covered the key history. Move on to the examination.';
    }
    if (c.stage === 'exam') {
      const done = new Set(c.exams.filter(e => e.kind === 'tech').map(e => e.id));
      const quiet = /^(absent|normal|not (raised|present|applicable|seen|felt|palpable|elicited)|nil|none|no |within normal)/i;
      const want = TECHNIQUES.filter(t => !done.has(t.id) && k.exam?.[t.finding] && !quiet.test(String(k.exam[t.finding]).trim()));
      const x = pick(want);
      if (x) return `Examine: ${x.name}.`;
      if (!c.exams.some(e => e.what === 'Vitals')) return 'Take the vitals.';
      const sys = k.exam?.other || {};
      const area = Object.keys(sys).find(a => sys[a] && !c.exams.some(e => e.kind === 'other' && e.what.toLowerCase().includes(a.split('-')[0])));
      return area ? `Do the ${area} of the system involved — type what you do in "Anything else".` : 'Examination is enough. Order tests.';
    }
    if (c.stage === 'tests') {
      const ordered = c.tests.map(t => t.test.toLowerCase());
      const x = pick(Object.keys(k.tests || {}).filter(n => !ordered.some(o => n.toLowerCase().includes(o) || o.includes(n.toLowerCase()))));
      return x ? `Order: ${x}.` : 'You have the key tests. Go to Diagnosis.';
    }
    if (c.stage === 'dx') {
      const pos = (k.keyHistory || []).slice(0, 3).map(x => String(x).replace(/\s*\[[^\]]*\]\s*$/, ''));
      return `Put together: ${pos.join('; ')}. Which one condition explains all of it? Then list 2–3 that look similar.`;
    }
    if (c.stage === 'viva') return 'Start your answer with a definition or classification, then causes, then what you would do — examiners like that order.';
    return '';
  },

  // The student's diagnosis board, checked: are they thinking along the right lines?
  async interpret() {
    const c = this.c, k = c.case, d = c.dx || {};
    const board = (d.ddx || []).filter(x => x?.name?.trim()).map(x => `- ${x.name} | for: ${x.for || '—'} | against / to rule out: ${x.against || '—'}`).join('\n') || '(none)';
    const out = await caseAI({ system: SYSTEM_TUTOR, temperature: 0.2, model: AI.bulkModel, prompt: `An MBBS final-year student has just finished a ${c.kind} case and committed to a diagnosis. Check their thinking — briefly, like a good senior at the bedside.

THE CASE: ${JSON.stringify({ diagnosis: k.diagnosis, differentials: k.differentials, keyHistory: k.keyHistory, exam: k.exam, tests: k.tests })}
${c.excerpt ? `\nFrom the book (${c.book.name}) — agree with it and cite its page:\n${c.excerpt.slice(0, 9000)}\n` : ''}
THE STUDENT:
One-line summary: ${d.summary || '—'}
Provisional diagnosis: ${d.provisional || '—'}
Differentials:
${board}
Findings they found: ${c.exams.map(e => `${e.kind === 'tech' ? TECH[e.id]?.name : e.what}: ${e.finding}`).join('; ').slice(0, 2500) || 'none'}
Tests they saw: ${c.tests.map(t => t.result).join('; ').slice(0, 1500) || 'none'}

Return JSON:
{"correct":true,"verdict":"one line — right, nearly, or wrong, and why",
"answer":"the diagnosis in full, as an examiner would want it written (with type, cause and complications if any)",
"clues":["the 3-5 findings that point to it"],
"ddx":[{"name":"their differential","ok":true,"comment":"is the for/against right? the one thing that rules it in or out"}],
"missed":["an important differential they did not list"],
"tip":"one line to think better next time"}` });
    c.dxCheck = out;
    this.save();
    return out;
  },

  async gradeViva(q, answer) {
    const k = this.c.case;
    const model = (k.viva || []).map(v => `Q: ${v.q}\nA: ${v.a}`).join('\n');
    const c = this.c;
    const out = await caseAI({ temperature: 0.3, model: AI.bulkModel, prompt: `Examiner's viva on ${k.diagnosis}. Reference answers:\n${model}\n${c.excerpt ? `\nThe book (${c.book.name}) — the answer must agree with it; quote its page in "ideal":\n${c.excerpt.slice(0, 12000)}\n` : ''}\nQuestion: ${q}\nStudent's answer (spoken, transcribed): ${answer || '(no answer)'}\nReturn JSON: {"verdict":"good|partial|wrong","say":"what you say back, one short sentence, like an examiner","ideal":"the answer they should have given, 1-2 lines"}` })
      .catch(() => caseAI({ prompt: `Q: ${q}\nAnswer: ${answer}\nJSON {"verdict":"partial","say":"","ideal":""}` }));
    this.c.viva.push({ q, answer, ...out });
    this.save();
    return out;
  },

  async close() {
    const c = this.c;
    c.stage = 'report'; c.ended = Date.now();
    try {
      const hist = JSON.parse(localStorage.getItem('caseHistory') || '[]');
      hist.unshift({ id: c.id, date: c.ended, subject: c.subject, kind: c.kind, diagnosis: c.case.diagnosis, score: c.report?.score, vivaGood: c.viva.filter(v => v.verdict === 'good').length, vivaN: c.viva.length });
      localStorage.setItem('caseHistory', JSON.stringify(hist.slice(0, 40)));
    } catch (e) {}
    this.save();
  }
};
window.CaseSim = CaseSim;

// ---------- the face ----------

function patientFace(p, mood) {
  const female = /^f/i.test(p?.sex || ''), age = parseInt(p?.age) || 40, child = age < 13, old = age > 58;
  const sikh = /\b(singh|kaur)\b/i.test(p?.name || '');
  // A steady look per patient: the same name always gets the same skin tone and clothes.
  const h = [...String(p?.name || 'x')].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const tones = [['#d2a27c', '#b5845f'], ['#c08d66', '#a2714d'], ['#a8774f', '#8a5f3c'], ['#dcb08c', '#bf9068']];
  const [skin, shade] = tones[h % tones.length];
  const hair = old || p?.role === 'examiner' ? '#9e9a94' : '#231913';
  const examiner = p?.role === 'examiner';
  const cloth = examiner ? '#f3f3ef' : ['#3d5a80', '#6b4f7a', '#2f6b5e', '#8a4b3a', '#4f5d75'][h % 5];
  const dupatta = ['#c2556f', '#d08b3a', '#5e8fb5', '#8a6fb0', '#c76b4a'][(h >>> 3) % 5];
  // Turban colours seen in a Punjab ward: navy, maroon, kesri, white, olive, pink, sky blue. Never
  // black — a black dome on the head read as a cap. Older men more often wear white or navy.
  const turbans = ['#1f3a7a', '#7d1f33', '#e0861c', '#f1eee6', '#4c6b35', '#c4527e', '#4f86c6'];
  const turban = old ? ['#f1eee6', '#1f3a7a', '#f1eee6', '#4f86c6'][(h >>> 5) % 4] : turbans[(h >>> 5) % turbans.length];
  const light = /f1eee6|e0861c|4f86c6/.test(turban);
  const fold = light ? 'rgba(90,60,30,.22)' : 'rgba(0,0,0,.28)', shine = light ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.16)';
  const fifty = turban === '#e0861c' ? '#1f3a7a' : turban === '#f1eee6' ? '#7d1f33' : '#e0861c';   // the thin under-strip at the forehead
  const covered = female && !examiner && (old || age > 45);              // older women here usually keep the dupatta over the head
  const beard = sikh && !female && age > 17, moustache = !female && age > 22 && !beard;
  const eyeY = child ? 104 : 100, eyeS = child ? 1.18 : 1;
  const squint = mood === 'pain', heavy = mood === 'tired';
  const brow = {
    pain: 'M70 87 Q80 90 92 92 M130 87 Q120 90 108 92', anxious: 'M70 90 Q80 84 92 86 M130 90 Q120 84 108 86',
    tired: 'M70 89 Q81 88 92 90 M130 89 Q119 88 108 90', confused: 'M70 88 Q80 82 92 86 M130 86 Q120 89 108 90'
  }[mood] || 'M70 88 Q81 83 92 87 M130 88 Q119 83 108 87';
  const eye = (cx) => `<g class="eye" style="transform-origin:${cx}px ${eyeY}px">
      <path d="M${cx - 12 * eyeS} ${eyeY} Q${cx} ${eyeY - (squint ? 4 : 8) * eyeS} ${cx + 12 * eyeS} ${eyeY} Q${cx} ${eyeY + (squint ? 2 : 6) * eyeS} ${cx - 12 * eyeS} ${eyeY} Z" fill="#f6f1ea"/>
      ${squint ? '' : `<circle cx="${cx}" cy="${eyeY}" r="${5 * eyeS}" fill="#3a2416"/><circle cx="${cx}" cy="${eyeY}" r="${2.3 * eyeS}" fill="#0d0907"/><circle cx="${cx + 1.6}" cy="${eyeY - 1.8}" r="1.3" fill="#fff"/>`}
      <path d="M${cx - 12.5 * eyeS} ${eyeY} Q${cx} ${eyeY - (squint ? 5 : heavy ? 5 : 9) * eyeS} ${cx + 12.5 * eyeS} ${eyeY}" stroke="#2a1a12" stroke-width="2" fill="${heavy ? skin : 'none'}"/></g>`;
  const face = child
    ? 'M58 100 Q58 52 100 50 Q142 52 142 100 Q142 142 100 156 Q58 142 58 100 Z'
    : 'M60 96 Q60 50 100 48 Q140 50 140 96 Q140 136 117 150 Q100 159 83 150 Q60 136 60 96 Z';
  const parts = [];
  // hair falling behind the shoulders
  if (female && !covered) parts.push(`<path d="M58 84 Q50 150 56 196 L144 196 Q150 150 142 84 Z" fill="${hair}"/>`);
  if (covered) parts.push(`<path d="M44 120 Q40 34 100 28 Q160 34 156 120 L162 200 L38 200 Z" fill="${dupatta}"/>`);
  // shoulders and clothes
  parts.push(`<path d="M14 232 Q18 184 68 172 L132 172 Q182 184 186 232 Z" fill="${cloth}"/>`);
  if (!female) parts.push(`<path d="M88 172 L100 198 L112 172" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="3"/><circle cx="100" cy="206" r="2" fill="rgba(255,255,255,.5)"/><circle cx="100" cy="218" r="2" fill="rgba(255,255,255,.5)"/>`);
  else if (!examiner) parts.push(`<path d="M30 190 Q100 222 176 184 L184 206 Q100 244 26 210 Z" fill="${dupatta}" opacity=".92"/>`);
  parts.push(`<path d="M86 138 L86 176 Q100 186 114 176 L114 138 Z" fill="${shade}"/>`);
  if (!covered && !(sikh && !female)) parts.push(`<ellipse cx="59" cy="104" rx="7" ry="12" fill="${skin}"/><ellipse cx="141" cy="104" rx="7" ry="12" fill="${skin}"/>`);
  if (female && !covered) parts.push(`<circle cx="59" cy="117" r="2.6" fill="#d8b04a"/><circle cx="141" cy="117" r="2.6" fill="#d8b04a"/>`);
  parts.push(`<path d="${face}" fill="${skin}"/>`);
  // hair, turban or patka on top
  if (sikh && !female && !child) {
    // A tied pagg: taller and wider than the head, flaring a little towards the top, covering the
    // ears, its layers rising from each ear and meeting in a V over the middle of the forehead.
    const L = [[54, 104, 76], [50, 88, 60], [47, 72, 44], [46, 56, 28], [52, 40, 14]];   // [x at the side, y at the side, y at the centre]
    const bands = L.slice(0, -1).map(([x, y, c], i) => i % 2 ? '' : `<path d="M${x} ${y} L100 ${c} L${200 - x} ${y} L${200 - L[i + 1][0]} ${L[i + 1][1]} L100 ${L[i + 1][2]} L${L[i + 1][0]} ${L[i + 1][1]} Z" fill="${fold}" opacity=".45"/>`).join('');
    const lines = L.map(([x, y, c]) => `M${x} ${y} L100 ${c} L${200 - x} ${y}`).join(' ');
    parts.push(`<path d="M55 110 L45 62 Q43 34 60 22 Q80 9 100 4 Q120 9 140 22 Q157 34 155 62 L145 110 Q140 88 101 81 L100 85 L99 81 Q60 88 55 110 Z" fill="${turban}"/>
      ${bands}<path d="${lines}" fill="none" stroke="${fold}" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M57 98 L100 72 M51 66 L100 40" fill="none" stroke="${shine}" stroke-width="1.6"/>
      <path d="M55 110 Q60 88 99 81 L100 85 L101 81 Q140 88 145 110" fill="none" stroke="${fifty}" stroke-width="3.4" stroke-linejoin="round"/>`);
  }
  // A boy: a patka tied over the joora, the knot sitting on top.
  else if (sikh && !female && child) parts.push(`<path d="M56 96 Q52 50 100 42 Q148 50 144 96 Q132 72 100 68 Q68 72 56 96 Z" fill="${turban}"/>
      <path d="M58 90 Q100 60 142 90" fill="none" stroke="${fold}" stroke-width="2.4"/>
      <circle cx="100" cy="38" r="13" fill="${turban}"/><path d="M90 34 Q100 28 110 34" fill="none" stroke="${fold}" stroke-width="2"/>`);
  else if (covered) parts.push(`<path d="M62 96 Q62 60 100 58 Q138 60 138 96 Q130 70 100 68 Q70 70 62 96 Z" fill="${hair}"/><path d="M50 110 Q48 46 100 40 Q152 46 150 110 Q144 62 100 58 Q56 62 50 110 Z" fill="${dupatta}"/>`);
  else if (female) parts.push(`<path d="M59 102 Q56 50 100 45 Q144 50 141 102 Q134 70 104 62 L100 72 L96 62 Q66 70 59 102 Z" fill="${hair}"/>`);
  else parts.push(`<path d="M59 92 Q57 48 100 44 Q143 48 141 92 Q136 68 118 64 Q100 58 82 64 Q64 68 59 92 Z" fill="${hair}"/>`);
  if (beard) parts.push(`<path d="M61 100 Q60 162 100 182 Q140 162 139 100 Q134 134 118 146 Q100 156 82 146 Q66 134 61 100 Z" fill="${hair}"/>`);
  // features
  parts.push(`<path class="brow" d="${brow}" stroke="${old ? '#8c8882' : '#21160f'}" stroke-width="${female ? 3 : 4.2}" fill="none" stroke-linecap="round"/>`);
  parts.push(eye(child ? 82 : 82), eye(child ? 118 : 118));
  parts.push(`<path d="M100 104 Q97 118 93 123 Q100 128 107 123" stroke="${shade}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`);
  if (female || child) parts.push(`<circle cx="76" cy="122" r="8" fill="#d9625a" opacity=".12"/><circle cx="124" cy="122" r="8" fill="#d9625a" opacity=".12"/>`);
  if (old) parts.push(`<path d="M80 74 Q100 70 120 74 M84 80 Q100 77 116 80 M66 104 l-6 3 M134 104 l6 3 M86 128 Q82 138 84 144 M114 128 Q118 138 116 144" stroke="${shade}" stroke-width="1.4" fill="none" opacity=".7"/>`);
  if (mood === 'pain') parts.push(`<path d="M94 80 L98 84 M106 80 L102 84" stroke="${shade}" stroke-width="1.6"/>`);
  const corners = mood === 'pain' || mood === 'anxious' ? 'M88 140 Q100 134 112 140' : mood === 'tired' ? 'M88 138 Q100 137 112 138' : 'M88 137 Q100 141 112 137';
  parts.push(`<path d="${corners}" stroke="#8f4a44" stroke-width="2.6" fill="none" stroke-linecap="round"/>`);
  parts.push(`<ellipse id="mouth" cx="100" cy="138" rx="9" ry="0.5" fill="#5a2424"/>`);
  if (beard || moustache) parts.push(`<path d="M83 132 Q92 126 100 129 Q108 126 117 132 Q108 137 100 134 Q92 137 83 132 Z" fill="${hair}"/>`);
  // The examiner: white coat over a shirt, stethoscope round the neck, reading glasses.
  if (examiner) parts.push(`<path d="M80 172 L100 232 L120 172 Z" fill="#cdd7e4"/>${female ? '' : '<path d="M97 180 L103 180 L105 216 L100 224 L95 216 Z" fill="#7d1f33"/>'}
      <path d="M68 172 L96 232 M132 172 L104 232" stroke="#d2d2cc" stroke-width="3"/>
      <path d="M78 174 Q66 214 92 222 M122 174 Q134 214 108 222" fill="none" stroke="#2b2b2b" stroke-width="3"/><circle cx="100" cy="224" r="6" fill="#8a8a8a" stroke="#444" stroke-width="2"/>
      <g fill="rgba(220,235,255,.18)" stroke="#2a2a2a" stroke-width="2.4"><rect x="68" y="${eyeY - 10}" width="28" height="20" rx="7"/><rect x="104" y="${eyeY - 10}" width="28" height="20" rx="7"/></g>
      <path d="M96 ${eyeY - 2} Q100 ${eyeY - 5} 104 ${eyeY - 2} M68 ${eyeY - 4} L60 ${eyeY - 7} M132 ${eyeY - 4} L140 ${eyeY - 7}" fill="none" stroke="#2a2a2a" stroke-width="2.2"/>`);
  return `<svg class="face" viewBox="0 0 200 232" aria-hidden="true">${parts.join('')}</svg>`;
}

// The mouth follows the voice; the eyes blink on their own.
function animateFace() {
  cancelAnimationFrame(animateFace._r);
  const loop = () => {
    const m = document.getElementById('mouth');
    if (!m) return;
    const v = Voice.speaking ? Voice.level : 0;
    m.setAttribute('ry', (0.5 + v * 9).toFixed(1));
    m.setAttribute('rx', (9 - v * 2).toFixed(1));
    animateFace._r = requestAnimationFrame(loop);
  };
  loop();
}

// ---------- screens ----------

Views.cases = async (sub) => {
  const c = CaseSim.load();
  const books = await CaseSim.books(), pick = CaseSim.pickedBook(books);
  if (sub === 'run' && c && c.stage !== 'report') return caseRun(c);
  if (sub === 'report' && c) return caseReport(c);
  let hist = []; try { hist = JSON.parse(localStorage.getItem('caseHistory') || '[]'); } catch (e) {}
  return `<div class="page"><header class="page-head"><div><p class="eyebrow"><a class="link" href="#/practice">Practice</a></p><h1>Clinical case + viva</h1></div>
      <a class="btn ghost" href="#/drills">Examination drills</a></header>
    ${c && c.stage !== 'report' ? `<section class="card due"><div class="row between mid"><div><b>Case in progress</b><br><span class="muted small">${esc(c.case.patient.name)}, ${esc(String(c.case.patient.age))}</span></div><a class="btn primary" href="#/cases/run">Continue</a></div></section>` : ''}
    <form class="card mt" data-submit="caseStart">
      <p class="muted">A patient who talks. Take the history by voice, examine on the drawing, order tests, give your diagnosis and differentials, then face the viva. About 15 minutes.</p>
      <div class="grid2">
        <label>Subject<select name="subject">${Object.entries(SUBJECTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>Case<select name="kind"><option value="long">Long case</option><option value="short">Short case</option></select></label>
        <label>Patient speaks<select name="lang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === 'mix' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Difficulty<select name="difficulty"><option>usual exam case</option><option>straightforward</option><option>tricky</option></select></label>
      </div>
      <label>From the book<select name="book">${books.map(b => `<option value="${esc(b.id)}" ${pick === b.id ? 'selected' : ''}>${esc(b.short || b.name)}${(b.pages || 0) < 3 ? ' — text not on this device' : b.remote && !b.complete ? ' (text still coming from the laptop)' : ''}</option>`).join('')}<option value="none" ${pick === 'none' ? 'selected' : ''}>No book — any condition</option></select></label>
      ${books.length && TechBook.rank(books[0]) ? await TechBook.picker() : ''}
      <label>Condition (optional)<input name="topic" placeholder="Leave empty for a case the book covers — or e.g. nephrotic syndrome"></label>
      ${CaseSim._lastErr && !CaseSim._creating ? `<p class="form-err danger small">${esc(CaseSim._lastErr)}</p>` : ''}
      <button class="btn primary full lg mt" type="submit" ${CaseSim._creating ? 'disabled data-busy="1"' : ''}>${CaseSim._creating ? '<span class="spin"></span>The patient is being admitted…' : 'Meet the patient'}</button>
    </form>
    ${hist.length ? `<section class="card mt"><div class="card-head"><h3>Past cases</h3></div><div class="list">${hist.slice(0, 10).map(h => `<div class="row between pad"><span>${fmtDate(h.date)} · ${esc(SUBJECTS[h.subject] || '')} · ${esc(h.diagnosis || '')}</span><b>${h.score ?? '—'}/10</b></div>`).join('')}</div></section>` : ''}
  </div>`;
};

function caseRun(c) {
  const k = c.case, p = k.patient;
  // Five steps, about 15 minutes: the long case-sheet and the spoken presentation are folded into
  // one short Diagnosis step (the presentation is still there, optional, inside it).
  if (c.stage === 'sheet' || c.stage === 'present') c.stage = 'dx';
  const stages = [['history', 'History'], ['exam', 'Exam'], ['tests', 'Tests'], ['dx', 'Diagnosis'], ['viva', 'Viva']];
  const stageBar = `<nav class="tabs case-tabs">${stages.map(([s, l]) => `<button class="tab ${c.stage === s ? 'on' : ''}" data-act="caseStage" data-s="${s}">${l}</button>`).join('')}</nav>`;
  // In a child's case the mother (or father) is the one answering — so it is her face you talk to.
  const inf = p.informant && !/self/i.test(p.informant) ? p.informant : '';
  const speaker = inf ? { name: p.name, sex: /father|papa|pita/i.test(inf) ? 'male' : 'female', age: 32 } : p;
  const ex = CaseSim.examiner(c);
  // The viva is taken by the examiner — their face, not the patient's.
  const face = c.stage === 'viva'
    ? `<div class="case-face">${patientFace(ex, 'calm')}<div><b>${esc(ex.name)}</b><br><span class="muted small">Examiner · ${c.kind === 'short' ? 'short' : 'long'} case viva</span></div></div>`
    : `<div class="case-face">${patientFace(speaker, c.mood)}<div><b>${esc(p.name)}</b><br><span class="muted small">${esc(String(p.age))} · ${esc(p.sex)} · ${esc(p.occupation || '')}${p.informant && !/self/i.test(p.informant) ? ` · history from ${esc(p.informant)}` : ''}</span></div></div>`;
  const tools = `<div class="row between mid case-tools"><span class="case-clock" id="case-clock">${caseClock(c)}</span><button class="btn ghost sm" data-act="caseHint">Hint</button></div>
    ${c.lastHint && c.lastHint.stage === c.stage ? `<div class="hint-card">${esc(c.lastHint.text)}</div>` : ''}`;
  let body = '';
  if (c.stage === 'history') {
    const live = typeof LiveTalk !== 'undefined' && LiveTalk.on;
    body = `<div class="chat" id="case-chat">${c.chat.map(m => `<div class="msg ${m.who}">${esc(m.text)}</div>`).join('') || '<p class="muted small center">Greet the patient and start. Tap Talk live and just talk — or Speak one question at a time, or type.</p>'}</div>
      ${live ? `<div class="live-bar"><span class="live-dot"></span><span id="live-state" class="grow">Live — just talk. Talk over the patient to cut in.</span>
          <button class="btn sm" data-act="caseLiveMute">${LiveTalk.muted ? 'Unmute' : 'Mute'}</button><button class="btn sm danger-b" data-act="caseLiveEnd">End talk</button></div>`
        : `<button class="btn primary full lg live-go" data-act="caseLive">Talk live</button>`}
      <div class="chat-in">${live ? '' : '<button class="btn mic" data-act="caseTalk" aria-label="Speak">Speak</button>'}
        <form data-submit="caseAsk" class="row gap grow"><input name="q" placeholder="${live ? 'Or type — it goes down the live line' : 'Or type your question'}" autocomplete="off"><button class="btn">Ask</button></form></div>
      <div class="vq-meter"><i id="vq-lvl"></i></div>`;
  } else if (c.stage === 'exam') {
    // The examination steps come from the clinical book (Boloor): read them now if not yet done.
    setTimeout(() => TechBook.autoLearn().catch(() => {}), 2000);
    const done = new Map(c.exams.filter(e => e.kind === 'tech').map(e => [e.id, e]));
    const groups = {}; TECHNIQUES.forEach(t => (groups[t.group] ||= []).push(t));
    body = `<p class="muted small">Do it the way you would at the bedside. A finding only comes if the technique is right.</p>
      ${Object.entries(groups).map(([g, ts]) => `<div class="case-group"><p class="eyebrow">${esc(g)}</p><div class="chips">${ts.map(t => { const e = done.get(t.id); return `<button class="chip ${e ? (e.passed ? 'on' : 'warn') : ''}" data-act="caseTech" data-id="${t.id}">${esc(t.name)}</button>`; }).join('')}</div></div>`).join('')}
      <div class="case-group"><p class="eyebrow">Vitals</p><button class="chip" data-act="caseVitals">Take vitals</button></div>
      <form data-submit="caseExamOther" class="row gap mt"><input name="q" placeholder="Anything else — e.g. auscultate the mitral area with the bell, left lateral position" class="grow"><button class="btn">Examine</button></form>
      <div class="list mt">${c.exams.slice().reverse().map(e => `<div class="pad small"><b>${esc(e.kind === 'tech' ? TECH[e.id]?.name : e.what)}</b> — ${esc(e.finding || '')}${e.kind === 'tech' && !e.passed ? ' <span class="warn-t">(technique errors)</span>' : ''}</div>`).join('')}</div>
      <div id="station" class="station" hidden></div>`;
  } else if (c.stage === 'tests') {
    body = `<form data-submit="caseOrder" class="row gap"><input name="q" placeholder="Order a test — e.g. urine routine, serum albumin, chest X-ray" class="grow"><button class="btn primary">Order</button></form>
      <div class="list mt">${c.tests.map(t => `<div class="pad">${esc(t.result)}</div>`).join('') || '<p class="muted small pad">Nothing ordered yet. Order what you would justify to the examiner.</p>'}</div>`;
  } else if (c.stage === 'dx') {
    const d = c.dx ||= { summary: '', provisional: '', ddx: [{}, {}, {}] };
    const chk = c.dxCheck;
    body = `<p class="muted small">Two or three minutes. What is it, what else could it be, and what rules each one in or out?</p>
      <label>Provisional diagnosis<input data-input="caseDx" data-k="provisional" value="${esc(d.provisional || '')}" placeholder="e.g. Nephrotic syndrome, likely minimal change disease" autocomplete="off"></label>
      <label>One-line summary <span class="muted small">(optional)</span><input data-input="caseDx" data-k="summary" value="${esc(d.summary || '')}" placeholder="e.g. 6-year-old boy, 2 weeks of facial puffiness and frothy urine" autocomplete="off"></label>
      <p class="eyebrow mt">Differentials</p>
      <div class="ddx">${d.ddx.map((x, i) => `<div class="ddx-row">
        <input data-input="caseDdx" data-i="${i}" data-f="name" value="${esc(x.name || '')}" placeholder="Differential ${i + 1}" autocomplete="off">
        <input data-input="caseDdx" data-i="${i}" data-f="for" value="${esc(x.for || '')}" placeholder="For it — what fits" autocomplete="off">
        <input data-input="caseDdx" data-i="${i}" data-f="against" value="${esc(x.against || '')}" placeholder="Against it / how to rule out" autocomplete="off"></div>`).join('')}</div>
      ${d.ddx.length < 5 ? '<button class="btn ghost sm" data-act="caseDdxAdd">+ Another differential</button>' : ''}
      <button class="btn primary full mt" data-act="caseInterpret">${chk ? 'Check again' : 'Check my thinking'}</button>
      ${chk ? `<div class="card soft mt dx-check ${chk.correct ? 'ok' : 'bad'}">
        <p><b>${chk.correct ? 'Right track.' : 'Not quite.'}</b> ${esc(chk.verdict || '')}</p>
        <p class="small"><b>Diagnosis:</b> ${esc(chk.answer || c.case.diagnosis)}</p>
        ${chk.clues?.length ? `<p class="eyebrow mt">The clues</p><ul class="small">${chk.clues.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${chk.ddx?.length ? `<p class="eyebrow mt">Your differentials</p><ul class="small">${chk.ddx.map(x => `<li class="${x.ok ? 'ok-t' : 'warn-t'}"><b>${esc(x.name)}</b> — ${esc(x.comment || '')}</li>`).join('')}</ul>` : ''}
        ${chk.missed?.length ? `<p class="small"><b>Also think of:</b> ${esc(chk.missed.join(', '))}</p>` : ''}
        ${chk.tip ? `<p class="small muted">${esc(chk.tip)}</p>` : ''}</div>` : ''}
      <button class="btn full mt ${chk ? 'primary' : ''}" data-act="caseMark">Go to the viva</button>
      <details class="mt"><summary class="small muted">Present aloud (optional)</summary>
        <button class="btn full mt" data-act="casePresent">Start presenting</button><div class="vq-meter mt"><i id="vq-lvl"></i></div>
        ${c.presentation ? `<p class="small mt">${esc(c.presentation)}</p>` : ''}</details>`;
  } else if (c.stage === 'viva') {
    const asked = c.viva.length, q = c.vivaQs?.[asked];
    body = `${c.viva.map(v => `<div class="viva-item"><p><b>Examiner:</b> ${esc(v.q)}</p><p><b>You:</b> ${esc(v.answer || '—')}</p><p class="${v.verdict === 'good' ? 'ok-t' : v.verdict === 'partial' ? 'warn-t' : 'danger'}">${esc(v.say || '')}</p>${v.verdict !== 'good' ? `<p class="muted small">Better: ${esc(v.ideal || '')}</p>` : ''}</div>`).join('')}
      ${q ? `<div class="viva-item now"><p><b>Examiner:</b> ${esc(q)}</p></div>
        <div class="chat-in"><button class="btn primary mic" data-act="caseVivaTalk">Answer</button><form data-submit="caseVivaType" class="row gap grow"><input name="q" placeholder="Or type the answer"><button class="btn">Send</button></form></div>
        <div class="vq-meter"><i id="vq-lvl"></i></div>`
        : `<button class="btn primary full lg" data-act="caseFinish">See the full report</button>`}`;
  }
  setTimeout(() => { animateFace(); const ch = document.getElementById('case-chat'); if (ch) ch.scrollTop = ch.scrollHeight; }, 30);
  return `<div class="page case-page">
    <header class="page-head"><div><p class="eyebrow"><a class="link" href="#/cases">Clinical cases</a> · ${esc(SUBJECTS[c.subject])} · ${c.kind === 'short' ? 'short' : 'long'} case</p></div>
      <div class="row gap"><button class="btn ghost sm" data-act="voiceMode">${Voice.natural() ? 'Natural voice' : 'Phone voice'}</button><button class="btn ghost sm" data-act="caseQuit">End case</button></div></header>
    ${face}${stageBar}${tools}<section class="card mt case-body">${body}</section></div>`;
}

// Time on this case, against a 15-minute target.
function caseClock(c) {
  const s = Math.max(0, Math.round((Date.now() - (c.started || Date.now())) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} <span class="muted">/ 15:00</span>`;
}
setInterval(() => {
  const el = document.getElementById('case-clock');
  if (el && CaseSim.c && !document.hidden) el.innerHTML = caseClock(CaseSim.c);
}, 1000);

function caseReport(c) {
  const r = c.report || {}, k = c.case;
  const list = (title, arr, cls = '') => arr?.length ? `<p class="eyebrow mt">${title}</p><ul class="${cls}">${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const vg = c.viva.filter(v => v.verdict === 'good').length;
  return `<div class="page"><header class="page-head"><div><p class="eyebrow"><a class="link" href="#/cases">Clinical cases</a></p><h1>Report</h1></div><a class="btn primary" href="#/cases">New case</a></header>
    <section class="card amc-score ${(r.score || 0) >= 6 ? 'ok' : 'bad'}"><p class="eyebrow">Examiner's mark</p><div class="big-num">${r.score ?? '—'}<span class="muted"> / 10</span></div><p>${esc(r.verdict || '')}</p>
      <p class="small">Diagnosis: <b>${esc(k.diagnosis)}</b> · ${r.diagnosis?.correct ? 'you got it' : 'you missed it'}${r.diagnosis?.comment ? ' — ' + esc(r.diagnosis.comment) : ''} · Viva ${vg}/${c.viva.length}</p></section>
    <section class="card mt"><h3>History</h3>${list('Done well', r.history?.good)}${list('Not asked', r.history?.missed, 'bad-list')}</section>
    <section class="card mt"><h3>Examination</h3>${list('Technique errors', r.examination?.technique, 'bad-list')}${list('Not examined', r.examination?.missed, 'bad-list')}${list('Done well', r.examination?.good)}</section>
    ${c.dx?.provisional ? `<section class="card mt"><h3>Your diagnosis</h3><p class="small">${esc(c.dx.provisional)}${c.dxCheck?.verdict ? ' — ' + esc(c.dxCheck.verdict) : ''}</p>${list('Your differentials', (c.dx.ddx || []).filter(x => x?.name).map(x => x.name))}</section>` : ''}
    ${c.presentation ? `<section class="card mt"><h3>Presentation</h3>${list('Good', r.presentation?.good)}${list('Improve', r.presentation?.improve)}</section>` : ''}
    <section class="card mt"><h3>The case</h3><p class="small">${esc(k.diagnosis)} · differentials: ${esc((k.differentials || []).join(', '))}${c.book ? ` · from ${esc(c.book.name)} ${esc(k.source || '')}` : ''}</p>
      ${list('What the examiner expected you to ask', k.keyHistory)}
      <p class="eyebrow mt">Tests</p><p class="small">${esc(Object.entries(k.tests || {}).map(([a, b]) => `${a}: ${b}`).join(' · '))}</p></section>
  </div>`;
}

Object.assign(A, {
  async caseLive(el) {
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; el.disabled = true; el.innerHTML = '<span class="spin"></span>Connecting';
    const c = CaseSim.c, p = c.case.patient;
    const earlier = c.chat.slice(-30).map(m => `${m.who === 'you' ? 'Student' : 'You'}: ${m.text}`).join('\n');
    const system = `${CaseSim.persona(c)}
- You are speaking out loud at the bedside. Talk like a real person: natural, unhurried, never read lists. Do not say you are an AI.
- If the student greets you, greet them back and wait for their questions.${earlier ? `\nWHAT HAS BEEN SAID SO FAR (carry on from here, do not repeat yourself):\n${earlier}` : ''}`;
    try {
      await LiveTalk.start({
        system, voice: CaseSim.voiceFor(p),
        onYou: (t, done) => liveBubble('you', t, done),
        onThem: (t, done) => liveBubble('patient', t, done),
        onLevel: v => { const b = document.getElementById('vq-lvl'); if (b) b.style.width = Math.round(v * 100) + '%'; },
        onState: (s, why) => { if (s === 'ended' || s === 'error') { if (why) toast(why, 9000); if (location.hash.startsWith('#/cases/run')) App.render(true); } }
      });
      App.render(true);
    } catch (e) {
      toast(e.message || String(e), 9000);
      el.innerHTML = 'Talk live'; el.disabled = false; delete el.dataset.busy;
    }
  },
  caseLiveMute(el) { const m = LiveTalk.mute(); el.textContent = m ? 'Unmute' : 'Mute'; const st = document.getElementById('live-state'); if (st) st.textContent = m ? 'Muted — the patient cannot hear you.' : 'Live — just talk. Talk over the patient to cut in.'; },
  caseLiveEnd() { LiveTalk.stop(); App.render(true); },
  async caseStage(el) { CaseSim.c.stage = el.dataset.s; CaseSim.save(); LiveTalk.stop(); Voice.stop(); App.render(); },
  async caseTalk(el) {
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; el.disabled = true; el.innerHTML = '<span class="spin"></span>Listening';
    try {
      const q = await Voice.listen({ ...CaseSim.hearing(), onLevel: v => { const b = document.getElementById('vq-lvl'); if (b) b.style.width = Math.round(v * 100) + '%'; } });
      if (q) await caseAskPatient(q);
    } catch (e) { toast(e.message || String(e), 8000); }
    finally { el.innerHTML = 'Speak'; el.disabled = false; delete el.dataset.busy; }
  },
  caseTech(el) {
    const id = el.dataset.id, f = CaseSim.c.case.exam?.[TECH[id].finding];
    openStation(id, { quick: true, finding: f || 'Normal.', done: s => {
      CaseSim.c.exams.push({ kind: 'tech', id, passed: s.passed, techniqueOk: s.techniqueOk, misses: s.checks.filter(x => !x.ok).map(x => x.msg), finding: s.techniqueOk ? (f || 'Normal') : 'not elicited (technique)', at: Date.now() });
      CaseSim.save();
    } });
  },
  caseVitals() {
    const v = CaseSim.c.case.exam?.vitals || {};
    const f = `Pulse ${v.pulse || '—'}, BP ${v.bp || '—'}, RR ${v.rr || '—'}, temperature ${v.temp || '—'}, SpO₂ ${v.spo2 || '—'}`;
    CaseSim.c.exams.push({ kind: 'other', what: 'Vitals', finding: f, at: Date.now() }); CaseSim.save(); App.render(true);
  },
  async casePresent(el) {
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; el.disabled = true; el.innerHTML = '<span class="spin"></span>Listening — pause for 5 seconds to finish';
    try {
      const t = await Voice.listen({ maxMs: 300000, silenceMs: 5000, waitMs: 15000, prompt: 'A medical student presenting a clinical case: chief complaints, history of presenting illness, examination findings, provisional diagnosis.', onLevel: v => { const b = document.getElementById('vq-lvl'); if (b) b.style.width = Math.round(v * 100) + '%'; } });
      if (t) { CaseSim.c.presentation = t; CaseSim.save(); }
      App.render(true);
    } catch (e) { toast(e.message || String(e), 8000); el.disabled = false; delete el.dataset.busy; }
  },
  caseHint() { const c = CaseSim.c; c.lastHint = { stage: c.stage, text: CaseSim.hint() }; CaseSim.save(); App.render(true); },
  caseDdxAdd() { const d = CaseSim.c.dx; d.ddx.push({}); CaseSim.save(); App.render(true); },
  async caseInterpret(el) {
    const d = CaseSim.c.dx || {};
    if (!(d.provisional || '').trim()) { toast('Write your provisional diagnosis first.'); return; }
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; el.disabled = true; el.innerHTML = '<span class="spin"></span>Checking your thinking';
    try { await CaseSim.interpret(); App.render(true); }
    catch (e) { toast(e.message || String(e), 9000); el.disabled = false; delete el.dataset.busy; el.textContent = 'Check my thinking'; }
  },
  async caseMark(el) {
    if (el.dataset.busy) return;
    if (!(CaseSim.c.dx?.provisional || '').trim() && !confirm('No provisional diagnosis written. Go to the viva anyway?')) return;
    el.dataset.busy = '1'; el.disabled = true; el.innerHTML = '<span class="spin"></span>The examiner is reading your case';
    try {
      await CaseSim.examine();
      App.render();
      const q = CaseSim.c.vivaQs?.[0];
      if (q) Voice.say(q, { voice: CaseSim.examiner().voice, lang: 'en-IN' });
    } catch (e) { toast(e.message || String(e), 9000); el.disabled = false; delete el.dataset.busy; el.textContent = 'Go to the viva'; }
  },
  async caseVivaTalk(el) {
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; el.disabled = true; el.innerHTML = '<span class="spin"></span>Listening';
    try {
      const a = await Voice.listen({ maxMs: 90000, silenceMs: 2500, prompt: 'A medical student answering a viva question.', onLevel: v => { const b = document.getElementById('vq-lvl'); if (b) b.style.width = Math.round(v * 100) + '%'; } });
      await caseVivaAnswer(a);
    } catch (e) { toast(e.message || String(e), 8000); }
    finally { if (document.body.contains(el)) { el.innerHTML = 'Answer'; el.disabled = false; delete el.dataset.busy; } }
  },
  async caseFinish() { await CaseSim.close(); location.hash = '#/cases/report'; },
  caseQuit() {
    if (!confirm('End this case? You can see the report only if you have been through the examiner.')) return;
    Voice.stop();
    if (CaseSim.c?.report) { CaseSim.close().then(() => { location.hash = '#/cases/report'; }); }
    else { localStorage.removeItem('casesim'); CaseSim.c = null; location.hash = '#/cases'; }
  }
});

// Live talk: words appear as they are said; a finished turn goes into the case record.
function liveBubble(who, text, done) {
  const c = CaseSim.c; if (!c) return;
  const chat = document.getElementById('case-chat');
  const id = 'live-' + who;
  let el = document.getElementById(id);
  if (chat) {
    chat.querySelector('p.muted.center')?.remove();
    if (!el) { el = document.createElement('div'); el.className = 'msg ' + who; el.id = id; chat.appendChild(el); }
    el.textContent = text;
    chat.scrollTop = chat.scrollHeight;
  }
  if (done) {
    if (el) el.removeAttribute('id');
    if (text) { c.chat.push({ who, text, at: Date.now(), live: 1 }); CaseSim.save(); }
  }
}

async function caseAskPatient(q) {
  const chat = document.getElementById('case-chat');
  if (chat) { chat.insertAdjacentHTML('beforeend', `<div class="msg you">${esc(q)}</div><div class="msg patient typing">…</div>`); chat.scrollTop = chat.scrollHeight; }
  try {
    const a = await CaseSim.reply(q);
    App.render(true);
    setTimeout(() => { const ch = document.getElementById('case-chat'); if (ch) ch.scrollTop = ch.scrollHeight; }, 60);
    await CaseSim.speakPatient(a);
  } catch (e) { toast(e.message || String(e), 8000); App.render(true); }
}

async function caseVivaAnswer(a) {
  const c = CaseSim.c, q = c.vivaQs?.[c.viva.length];
  if (!q) return;
  const g = await CaseSim.gradeViva(q, a);
  App.render();
  const ex = CaseSim.examiner(c);
  await Voice.say(g?.say || '', { voice: ex.voice });
  const next = c.vivaQs?.[c.viva.length];
  if (next) await Voice.say(next, { voice: ex.voice });
}

Object.assign(F, {
  async caseStart(form) {
    const d = Object.fromEntries(new FormData(form));
    try { localStorage.setItem('caseBook', d.book || 'none'); } catch (e) {}
    const btn = form.querySelector('button[type=submit]');
    if (btn?.dataset.busy || CaseSim._creating) return;
    const cur = CaseSim.load();
    if (cur && cur.stage !== 'report' && !confirm(`${cur.case.patient.name}'s case is still open. Start a new patient and close that one?`)) return;
    CaseSim._creating = Date.now();
    const err = form.querySelector('.form-err') || form.insertAdjacentElement('beforeend', Object.assign(document.createElement('p'), { className: 'form-err danger small' }));
    err.textContent = ''; CaseSim._lastErr = '';
    const t0 = Date.now();
    let note = '';
    caseAI.say = m => { note = m; tick(); };
    const tick = () => { if (btn) btn.innerHTML = `<span class="spin"></span>${note ? esc(note) : 'The patient is being admitted…'} · ${Math.round((Date.now() - t0) / 1000)} s`; };
    if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
    tick(); const clock = setInterval(tick, 1000);
    try {
      // The full model writes the richest case, but on a busy day it can take minutes. After 90
      // seconds, hand the same job to the lighter model rather than keep you waiting.
      const limit = (pr, ms) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error('slow')), ms))]);
      try { await limit(CaseSim.create(d), 150000); }
      catch (e) {
        if (e.message !== 'slow') throw e;
        await limit(CaseSim.create({ ...d, quick: 1 }), 90000).catch(e2 => { throw e2.message === 'slow' ? new Error('Gemini is very slow right now — it did not answer within three minutes. Try again in a little while.') : e2; });
      }
      location.hash = '#/cases/run';
      setTimeout(() => { const cur = CaseSim.c; cur.chat.push({ who: 'patient', text: cur.case.opening, at: Date.now() }); CaseSim.save(); App.render(true); CaseSim.speakPatient(cur.case.opening); }, 400);
    } catch (e) {
      // Kept on screen, not a toast that disappears while you are looking away.
      err.textContent = CaseSim._lastErr = 'Could not admit the patient: ' + (e.message || String(e));
      if (btn) { btn.disabled = false; delete btn.dataset.busy; btn.textContent = 'Try again'; }
    } finally { clearInterval(clock); CaseSim._creating = 0; caseAI.say = null; }
  },
  async caseAsk(form) {
    const q = form.q.value.trim(); if (!q) return; form.q.value = '';
    if (LiveTalk.on) { liveBubble('you', q, true); LiveTalk.sendText(q); return; }
    await caseAskPatient(q);
  },
  async caseExamOther(form) {
    const q = form.q.value.trim(); if (!q) return;
    const b = form.querySelector('button'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try { await CaseSim.examOther(q); } catch (e) { toast(e.message || String(e), 8000); }
    App.render(true);
  },
  async caseOrder(form) {
    const q = form.q.value.trim(); if (!q) return;
    const b = form.querySelector('button'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try { await CaseSim.order(q); } catch (e) { toast(e.message || String(e), 8000); }
    App.render(true);
  },
  async caseVivaType(form) { const a = form.q.value.trim(); form.q.value = ''; const b = form.querySelector('button'); b.disabled = true; await caseVivaAnswer(a); }
});

Object.assign(I, {
  caseSheet(el) { CaseSim.c.sheet[el.dataset.h] = el.value; clearTimeout(I._cs); I._cs = setTimeout(() => CaseSim.save(), 400); },
  caseDx(el) { (CaseSim.c.dx ||= { ddx: [{}, {}, {}] })[el.dataset.k] = el.value; clearTimeout(I._cs); I._cs = setTimeout(() => CaseSim.save(), 400); },
  caseDdx(el) { const d = CaseSim.c.dx ||= { ddx: [{}, {}, {}] }; (d.ddx[+el.dataset.i] ||= {})[el.dataset.f] = el.value; clearTimeout(I._cs); I._cs = setTimeout(() => CaseSim.save(), 400); }
});

ROUTES.push([/^#\/cases(?:\/(\w+))?$/, m => Views.cases(m[1])]);
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/cases/run')) LiveTalk.stop(); if (!location.hash.startsWith('#/cases')) Voice.stop(); });
