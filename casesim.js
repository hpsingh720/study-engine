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
    return (own?.[c.subject] || own?.[k])?.length ? own[c.subject] || own[k] : CASE_FORMATS[k];
  },
  voiceFor(p) {
    const female = /^f/i.test(p?.sex || '') || p?.informant && /mother|mata|maa/i.test(p.informant);
    return female ? 'Kore' : 'Charon';
  },
  langCode(c) { return { hi: 'hi-IN', pa: 'pa-IN', en: 'en-IN', mix: 'en-IN' }[c.lang] || 'en-IN'; },

  async create({ subject, topic, lang, kind, difficulty }) {
    const findingKeys = TECHNIQUES.map(t => t.finding).filter(Boolean);
    const prompt = `Create a realistic ${kind === 'short' ? 'SHORT case' : 'LONG case'} for an Indian MBBS final-year clinical exam in ${SUBJECTS[subject]}${topic ? `, on or around: ${topic}` : ' — pick a condition commonly kept for MBBS finals'}. Difficulty: ${difficulty}.
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
- Everything internally consistent.`;
    const out = await AI.call({ prompt, system: SYSTEM_TUTOR, temperature: 0.8 });
    if (!out?.patient || !out?.facts) throw new Error('Could not make the case — try again.');
    this.c = { id: 'case-' + uid(), subject, topic, lang, kind, difficulty, started: Date.now(), stage: 'history', case: out, chat: [], exams: [], tests: [], sheet: {}, presentation: '', viva: [], report: null, mood: out.patient.mood || 'calm' };
    this.save();
    return this.c;
  },

  // ---- the patient ----
  async reply(question) {
    const c = this.c, k = c.case, p = k.patient;
    c.chat.push({ who: 'you', text: question, at: Date.now() });
    const langRule = { hi: 'Reply in Hindi, in Devanagari script, the way a patient speaks — simple everyday words.', pa: 'Reply in Punjabi, in Gurmukhi script, the way a patient from Punjab speaks.', en: 'Reply in simple Indian English.', mix: 'Reply in Hinglish written in Latin letters, the way patients mix Hindi and English.' }[c.lang] || 'Reply in simple Indian English.';
    const system = `You are ${p.name}, ${p.age}, ${p.sex}, ${p.occupation} from ${p.place}${p.informant && !/self/i.test(p.informant) ? ` — actually you are the ${p.informant} of the patient, answering for them` : ''}. A medical student is taking your history in a hospital ward. Personality: ${p.personality}.
WHAT YOU KNOW (your own experience, in your own words): ${JSON.stringify(k.facts)}
RULES — stay in character always:
- Answer ONLY what was asked. Never volunteer other symptoms; a student must ask.
- You do not know medical terms or your diagnosis. Never name it. Describe what you feel and notice.
- If asked something not listed, give a natural answer that fits and stays consistent (usually "no" for symptoms not in your story).
- Short: one to three sentences, like real speech. Show feeling where natural (worry, pain, embarrassment).
- If the student is rude or uses jargon, be confused like a real patient.
- ${langRule}
Return JSON: {"reply":"","mood":"calm|anxious|pain|tired|confused"}`;
    const convo = c.chat.slice(-24).map(m => `${m.who === 'you' ? 'Student' : 'You'}: ${m.text}`).join('\n');
    let out;
    try { out = await AI.call({ prompt: convo + '\nYou:', system, temperature: 0.7, model: AI.bulkModel }); }
    catch (e) { out = await AI.call({ prompt: convo + '\nYou:', system, temperature: 0.7 }); }
    const text = String(out?.reply || '').trim() || '…';
    c.mood = out?.mood || c.mood;
    c.chat.push({ who: 'patient', text, at: Date.now() });
    this.save();
    return text;
  },

  async speakPatient(text) {
    const c = this.c, p = c.case.patient;
    const style = { anxious: 'in a worried, anxious voice', pain: 'in a strained voice, in pain', tired: 'in a tired, slow voice', confused: 'sounding unsure' }[c.mood] || 'naturally';
    await Voice.say(text, { lang: this.langCode(c), voice: this.voiceFor(p), style });
  },

  // ---- examination outside the technique list ----
  async examOther(request) {
    const k = this.c.case;
    const out = await AI.call({ prompt: `Case findings: ${JSON.stringify(k.exam)}. Diagnosis: ${k.diagnosis}.
A student says: "${request}". Report ONLY what they would find doing exactly that, in one or two lines as an examiner would say it. If what they describe is vague ("examine the heart"), ask what exactly they do (inspect / palpate / percuss / auscultate, and where). Never state the diagnosis.
Return JSON: {"finding":""}`, temperature: 0.3, model: AI.bulkModel }).catch(() => AI.call({ prompt: `Findings: ${JSON.stringify(k.exam)}. Student: "${request}". One-line finding. JSON {"finding":""}` }));
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
      const out = await AI.call({ prompt: `Patient with ${k.diagnosis}. Known results: ${JSON.stringify(k.tests)}. The student orders: "${test}". Give a realistic result consistent with the case, one line with units. JSON {"result":""}`, temperature: 0.3, model: AI.bulkModel }).catch(() => ({ result: 'Result not available.' }));
      result = `${test}: ${out?.result || 'not available'}`;
    }
    this.c.tests.push({ test, result, at: Date.now() });
    this.save();
    return result;
  },

  // ---- the examiner ----
  async examine() {
    const c = this.c, k = c.case;
    const techLog = c.exams.filter(e => e.kind === 'tech').map(e => `${TECH[e.id]?.name}: ${e.passed ? 'done correctly' : 'MISTAKES — ' + e.misses.join(' | ')}`).join('\n') || 'none';
    const out = await AI.call({ system: SYSTEM_TUTOR, temperature: 0.3, prompt: `You are a strict but fair Indian MBBS final-exam examiner. Mark this ${c.kind} case.

THE CASE (hidden from the student): ${JSON.stringify({ diagnosis: k.diagnosis, differentials: k.differentials, keyHistory: k.keyHistory, exam: k.exam, tests: k.tests })}

WHAT THE STUDENT ASKED THE PATIENT:
${c.chat.filter(m => m.who === 'you').map(m => '- ' + m.text).join('\n') || '(nothing)'}

EXAMINATION TECHNIQUE (watched by you):
${techLog}
Other examination: ${c.exams.filter(e => e.kind === 'other').map(e => e.what).join('; ') || 'none'}
Tests ordered: ${c.tests.map(t => t.test).join(', ') || 'none'}

CASE SHEET WRITTEN:
${Object.entries(c.sheet).filter(([, v]) => v?.trim()).map(([h, v]) => `## ${h}\n${v}`).join('\n').slice(0, 12000) || '(not written)'}

PRESENTATION AS SPOKEN:
${c.presentation || '(not presented aloud)'}

Return JSON:
{"score":0,"verdict":"one line, as an examiner would say it",
"history":{"good":[""],"missed":["key questions not asked"]},
"examination":{"good":[""],"missed":["examinations not done"],"technique":["technique errors seen, said plainly"]},
"presentation":{"good":[""],"improve":[""]},
"diagnosis":{"correct":true,"comment":""},
"viva":["5 questions to ask now, starting from the student's own diagnosis and findings"]}
score is out of 10.` });
    c.report = out;
    c.vivaQs = (out?.viva || []).slice(0, 5);
    c.stage = 'viva';
    this.save();
    return out;
  },

  async gradeViva(q, answer) {
    const k = this.c.case;
    const model = (k.viva || []).map(v => `Q: ${v.q}\nA: ${v.a}`).join('\n');
    const out = await AI.call({ temperature: 0.3, model: AI.bulkModel, prompt: `Examiner's viva on ${k.diagnosis}. Reference answers:\n${model}\n\nQuestion: ${q}\nStudent's answer (spoken, transcribed): ${answer || '(no answer)'}\nReturn JSON: {"verdict":"good|partial|wrong","say":"what you say back, one short sentence, like an examiner","ideal":"the answer they should have given, 1-2 lines"}` })
      .catch(() => AI.call({ prompt: `Q: ${q}\nAnswer: ${answer}\nJSON {"verdict":"partial","say":"","ideal":""}` }));
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
  const female = /^f/i.test(p?.sex || ''), age = parseInt(p?.age) || 40, child = age < 13;
  const sikh = /\b(singh|kaur)\b/i.test(p?.name || '');
  const hair = age > 58 ? '#c9c9c9' : '#2a1d16';
  const skin = '#c99a74';
  const brow = { pain: 'M86 96 L112 102 M188 96 L162 102', anxious: 'M86 100 L112 94 M188 100 L162 94', tired: 'M86 100 L112 100 M188 100 L162 100', confused: 'M86 98 L112 92 M188 96 L162 100' }[mood] || 'M86 98 Q99 93 112 98 M188 98 Q175 93 162 98';
  return `<svg class="face" viewBox="0 0 280 300" aria-hidden="true">
    ${female ? `<path d="M50 150 Q40 40 140 34 Q240 40 230 150 L236 270 L44 270 Z" fill="${hair}"/>` : ''}
    <rect x="104" y="214" width="72" height="50" fill="${skin}"/>
    <path d="M30 300 Q40 250 140 246 Q240 250 250 300 Z" fill="${female ? '#7a3b5c' : '#3a5a7a'}"/>
    <ellipse cx="140" cy="140" rx="${child ? 76 : 70}" ry="${child ? 84 : 92}" fill="${skin}"/>
    ${sikh && !female ? `<path d="M64 120 Q60 30 140 28 Q220 30 216 120 Q180 84 140 86 Q100 84 64 120 Z" fill="#1e3a6e"/>` : !female ? `<path d="M70 110 Q72 46 140 44 Q208 46 210 110 Q176 74 140 76 Q104 74 70 110 Z" fill="${hair}"/>` : `<path d="M72 112 Q80 52 140 50 Q200 52 208 112 Q172 76 140 80 Q108 76 72 112 Z" fill="${hair}"/>`}
    ${sikh && !female && age > 18 ? `<path d="M80 176 Q90 268 140 272 Q190 268 200 176 Q180 214 140 216 Q100 214 80 176 Z" fill="${hair}"/>` : ''}
    <path class="brow" d="${brow}" stroke="#2a1d16" stroke-width="5" fill="none" stroke-linecap="round"/>
    <g class="eyes"><ellipse cx="100" cy="122" rx="11" ry="8" fill="#fff"/><ellipse cx="180" cy="122" rx="11" ry="8" fill="#fff"/>
      <circle cx="100" cy="123" r="5" fill="#2a1d16"/><circle cx="180" cy="123" r="5" fill="#2a1d16"/>
      <rect class="lid" x="86" y="112" width="28" height="0" fill="${skin}"/><rect class="lid" x="166" y="112" width="28" height="0" fill="${skin}"/></g>
    <path d="M140 132 Q134 160 140 168 Q146 170 150 166" stroke="#9b6f50" stroke-width="3" fill="none"/>
    <ellipse id="mouth" cx="140" cy="196" rx="18" ry="3" fill="#7a3434"/>
  </svg>`;
}

// The mouth follows the voice; the eyes blink on their own.
function animateFace() {
  cancelAnimationFrame(animateFace._r);
  const loop = () => {
    const m = document.getElementById('mouth');
    if (!m) return;
    const v = Voice.speaking ? Voice.level : 0;
    m.setAttribute('ry', (3 + v * 14).toFixed(1));
    m.setAttribute('rx', (18 - v * 4).toFixed(1));
    animateFace._r = requestAnimationFrame(loop);
  };
  loop();
}

// ---------- screens ----------

Views.cases = async (sub) => {
  const c = CaseSim.load();
  if (sub === 'run' && c && c.stage !== 'report') return caseRun(c);
  if (sub === 'report' && c) return caseReport(c);
  let hist = []; try { hist = JSON.parse(localStorage.getItem('caseHistory') || '[]'); } catch (e) {}
  return `<div class="page"><header class="page-head"><div><p class="eyebrow"><a class="link" href="#/practice">Practice</a></p><h1>Clinical case + viva</h1></div>
      <a class="btn ghost" href="#/drills">Examination drills</a></header>
    ${c && c.stage !== 'report' ? `<section class="card due"><div class="row between mid"><div><b>Case in progress</b><br><span class="muted small">${esc(c.case.patient.name)}, ${esc(String(c.case.patient.age))}</span></div><a class="btn primary" href="#/cases/run">Continue</a></div></section>` : ''}
    <form class="card mt" data-submit="caseStart">
      <p class="muted">A patient who talks. Take the history by voice, examine with your hands on the drawing, order tests, write the case sheet, present it, then face the viva.</p>
      <div class="grid2">
        <label>Subject<select name="subject">${Object.entries(SUBJECTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>Case<select name="kind"><option value="long">Long case</option><option value="short">Short case</option></select></label>
        <label>Patient speaks<select name="lang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === 'mix' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Difficulty<select name="difficulty"><option>usual exam case</option><option>straightforward</option><option>tricky</option></select></label>
      </div>
      <label>Condition (optional)<input name="topic" placeholder="Leave empty for a surprise — or e.g. nephrotic syndrome"></label>
      <button class="btn primary full lg mt" type="submit">Meet the patient</button>
    </form>
    ${hist.length ? `<section class="card mt"><div class="card-head"><h3>Past cases</h3></div><div class="list">${hist.slice(0, 10).map(h => `<div class="row between pad"><span>${fmtDate(h.date)} · ${esc(SUBJECTS[h.subject] || '')} · ${esc(h.diagnosis || '')}</span><b>${h.score ?? '—'}/10</b></div>`).join('')}</div></section>` : ''}
  </div>`;
};

function caseRun(c) {
  const k = c.case, p = k.patient;
  const stages = [['history', 'History'], ['exam', 'Examination'], ['tests', 'Tests'], ['sheet', 'Case sheet'], ['present', 'Present'], ['viva', 'Viva']];
  const stageBar = `<nav class="tabs case-tabs">${stages.map(([s, l]) => `<button class="tab ${c.stage === s ? 'on' : ''}" data-act="caseStage" data-s="${s}">${l}</button>`).join('')}</nav>`;
  // In a child's case the mother (or father) is the one answering — so it is her face you talk to.
  const inf = p.informant && !/self/i.test(p.informant) ? p.informant : '';
  const speaker = inf ? { name: p.name, sex: /father|papa|pita/i.test(inf) ? 'male' : 'female', age: 32 } : p;
  const face = `<div class="case-face">${patientFace(speaker, c.mood)}<div><b>${esc(p.name)}</b><br><span class="muted small">${esc(String(p.age))} · ${esc(p.sex)} · ${esc(p.occupation || '')}${p.informant && !/self/i.test(p.informant) ? ` · history from ${esc(p.informant)}` : ''}</span></div></div>`;
  let body = '';
  if (c.stage === 'history') {
    body = `<div class="chat" id="case-chat">${c.chat.map(m => `<div class="msg ${m.who}">${esc(m.text)}</div>`).join('') || '<p class="muted small center">Greet the patient and start. Tap the microphone and speak, or type.</p>'}</div>
      <div class="chat-in"><button class="btn primary mic" data-act="caseTalk" aria-label="Speak">Speak</button>
        <form data-submit="caseAsk" class="row gap grow"><input name="q" placeholder="Or type your question" autocomplete="off"><button class="btn">Ask</button></form></div>
      <div class="vq-meter"><i id="vq-lvl"></i></div>`;
  } else if (c.stage === 'exam') {
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
  } else if (c.stage === 'sheet') {
    body = `<p class="muted small">Write it as you would in the exam. Saved as you type.</p>
      ${CaseSim.format(c).map(h => `<label class="sheet-h">${esc(h)}<textarea rows="3" data-input="caseSheet" data-h="${esc(h)}">${esc(c.sheet[h] || '')}</textarea></label>`).join('')}`;
  } else if (c.stage === 'present') {
    body = `<p>Present the case to the examiner, out loud, as you would at the bedside. Up to five minutes; stop when you are done.</p>
      <button class="btn primary full lg" data-act="casePresent">Start presenting</button>
      <div class="vq-meter mt"><i id="vq-lvl"></i></div>
      ${c.presentation ? `<div class="card soft mt"><p class="eyebrow">What the examiner heard</p><p class="small">${esc(c.presentation)}</p></div>` : ''}
      <button class="btn full mt" data-act="caseMark">${c.presentation ? 'Hand over to the examiner' : 'Skip — use my written case sheet'}</button>`;
  } else if (c.stage === 'viva') {
    const asked = c.viva.length, q = c.vivaQs?.[asked];
    body = `${c.viva.map(v => `<div class="viva-item"><p><b>Examiner:</b> ${esc(v.q)}</p><p><b>You:</b> ${esc(v.answer || '—')}</p><p class="${v.verdict === 'good' ? 'ok-t' : v.verdict === 'partial' ? 'warn-t' : 'danger'}">${esc(v.say || '')}</p>${v.verdict !== 'good' ? `<p class="muted small">Better: ${esc(v.ideal || '')}</p>` : ''}</div>`).join('')}
      ${q ? `<div class="viva-item now"><p><b>Examiner:</b> ${esc(q)}</p></div>
        <div class="chat-in"><button class="btn primary mic" data-act="caseVivaTalk">Answer</button><form data-submit="caseVivaType" class="row gap grow"><input name="q" placeholder="Or type the answer"><button class="btn">Send</button></form></div>
        <div class="vq-meter"><i id="vq-lvl"></i></div>`
        : `<button class="btn primary full lg" data-act="caseFinish">See the full report</button>`}`;
  }
  setTimeout(animateFace, 50);
  return `<div class="page case-page">
    <header class="page-head"><div><p class="eyebrow"><a class="link" href="#/cases">Clinical cases</a> · ${esc(SUBJECTS[c.subject])} · ${c.kind === 'short' ? 'short' : 'long'} case</p></div>
      <button class="btn ghost sm" data-act="caseQuit">End case</button></header>
    ${face}${stageBar}<section class="card mt case-body">${body}</section></div>`;
}

function caseReport(c) {
  const r = c.report || {}, k = c.case;
  const list = (title, arr, cls = '') => arr?.length ? `<p class="eyebrow mt">${title}</p><ul class="${cls}">${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const vg = c.viva.filter(v => v.verdict === 'good').length;
  return `<div class="page"><header class="page-head"><div><p class="eyebrow"><a class="link" href="#/cases">Clinical cases</a></p><h1>Report</h1></div><a class="btn primary" href="#/cases">New case</a></header>
    <section class="card amc-score ${(r.score || 0) >= 6 ? 'ok' : 'bad'}"><p class="eyebrow">Examiner's mark</p><div class="big-num">${r.score ?? '—'}<span class="muted"> / 10</span></div><p>${esc(r.verdict || '')}</p>
      <p class="small">Diagnosis: <b>${esc(k.diagnosis)}</b> · ${r.diagnosis?.correct ? 'you got it' : 'you missed it'}${r.diagnosis?.comment ? ' — ' + esc(r.diagnosis.comment) : ''} · Viva ${vg}/${c.viva.length}</p></section>
    <section class="card mt"><h3>History</h3>${list('Done well', r.history?.good)}${list('Not asked', r.history?.missed, 'bad-list')}</section>
    <section class="card mt"><h3>Examination</h3>${list('Technique errors', r.examination?.technique, 'bad-list')}${list('Not examined', r.examination?.missed, 'bad-list')}${list('Done well', r.examination?.good)}</section>
    <section class="card mt"><h3>Presentation</h3>${list('Good', r.presentation?.good)}${list('Improve', r.presentation?.improve)}</section>
    <section class="card mt"><h3>The case</h3><p class="small">${esc(k.diagnosis)} · differentials: ${esc((k.differentials || []).join(', '))}</p>
      ${list('What the examiner expected you to ask', k.keyHistory)}
      <p class="eyebrow mt">Tests</p><p class="small">${esc(Object.entries(k.tests || {}).map(([a, b]) => `${a}: ${b}`).join(' · '))}</p></section>
  </div>`;
}

Object.assign(A, {
  async caseStage(el) { CaseSim.c.stage = el.dataset.s; CaseSim.save(); Voice.stop(); App.render(); },
  async caseTalk(el) {
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; el.disabled = true; el.innerHTML = '<span class="spin"></span>Listening';
    try {
      const q = await Voice.listen({ prompt: 'A doctor taking a history from a patient in a ward, in English, Hindi or Punjabi.', onLevel: v => { const b = document.getElementById('vq-lvl'); if (b) b.style.width = Math.round(v * 100) + '%'; } });
      if (q) await caseAskPatient(q);
    } catch (e) { toast(e.message || String(e), 8000); }
    finally { el.innerHTML = 'Speak'; el.disabled = false; delete el.dataset.busy; }
  },
  caseTech(el) {
    const id = el.dataset.id, f = CaseSim.c.case.exam?.[TECH[id].finding];
    openStation(id, { finding: f || 'Normal.', done: s => {
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
  async caseMark(el) {
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; el.disabled = true; el.innerHTML = '<span class="spin"></span>The examiner is reading your case';
    try {
      await CaseSim.examine();
      App.render();
      const q = CaseSim.c.vivaQs?.[0];
      if (q) Voice.say(q, { voice: 'Puck', lang: 'en-IN' });
    } catch (e) { toast(e.message || String(e), 9000); el.disabled = false; delete el.dataset.busy; el.textContent = 'Hand over to the examiner'; }
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

async function caseAskPatient(q) {
  const chat = document.getElementById('case-chat');
  if (chat) { chat.insertAdjacentHTML('beforeend', `<div class="msg you">${esc(q)}</div><div class="msg patient typing">…</div>`); chat.scrollTop = chat.scrollHeight; }
  try {
    const a = await CaseSim.reply(q);
    App.render(true);
    await CaseSim.speakPatient(a);
  } catch (e) { toast(e.message || String(e), 8000); App.render(true); }
}

async function caseVivaAnswer(a) {
  const c = CaseSim.c, q = c.vivaQs?.[c.viva.length];
  if (!q) return;
  const g = await CaseSim.gradeViva(q, a);
  App.render();
  await Voice.say(g?.say || '', { voice: 'Puck' });
  const next = c.vivaQs?.[c.viva.length];
  if (next) await Voice.say(next, { voice: 'Puck' });
}

Object.assign(F, {
  async caseStart(form) {
    const d = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type=submit]');
    if (btn?.dataset.busy) return;
    if (btn) { btn.dataset.busy = '1'; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>The patient is being admitted…'; }
    try {
      const c = await CaseSim.create(d);
      location.hash = '#/cases/run';
      setTimeout(() => { const cur = CaseSim.c; cur.chat.push({ who: 'patient', text: cur.case.opening, at: Date.now() }); CaseSim.save(); App.render(true); CaseSim.speakPatient(cur.case.opening); }, 400);
    } catch (e) { toast(e.message || String(e), 9000); if (btn) { btn.disabled = false; delete btn.dataset.busy; btn.textContent = 'Meet the patient'; } }
  },
  async caseAsk(form) { const q = form.q.value.trim(); if (!q) return; form.q.value = ''; await caseAskPatient(q); },
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
  caseSheet(el) { CaseSim.c.sheet[el.dataset.h] = el.value; clearTimeout(I._cs); I._cs = setTimeout(() => CaseSim.save(), 400); }
});

ROUTES.push([/^#\/cases(?:\/(\w+))?$/, m => Views.cases(m[1])]);
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/cases')) Voice.stop(); });
