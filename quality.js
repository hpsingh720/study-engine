// Question tags (AMEDEX / PYQ / AI / MBBS), broken-question detection, small text fixes, mind maps and the select-to-ask bar.
function qBank(m) {
  const s = String(m.src || '');
  if (!s || s === 'ai' || s === 'merged' || m.gen) return 'AI';
  if (/uworld|\buw\b|usmle|step ?2/i.test(s)) return 'UWORLD';
  if (/annotated|handbook|recall|pyq|past ?paper/i.test(s)) return 'PYQ';
  if (m.spot || (m.type === 'IMG' && /prac|spotter|osce|atlas|bailey|love|davidson|harrison|clinical|image/i.test(s))) return 'SPOT';
  if (m.type === 'MBBS') return 'MBBS';
  return 'AMEDEX';
}
const BANK_LABEL = { AMEDEX: 'AMEDEX', PYQ: 'PYQ', AI: 'AI-written', MBBS: 'MBBS bank', SPOT: 'Image spotter', UWORLD: 'UWorld' };
function bankTag(m) { const k = qBank(m); return `<span class="btag b-${k}">${BANK_LABEL[k]}</span>`; }

// Options that still carry the book's own letters ("B Sodium valproate") would clash with the app's letters.
function cleanOpt(o, all) {
  const lab = /^\s*\(?[A-Ea-e]\s*[).:\]]?\s+(?=\S)/;
  return all.every(x => lab.test(x)) ? String(o).replace(lab, '') : String(o);
}

// Why a question can't be used as it is (shown hidden from practice until it's repaired).
const FIG_RE = /\b(figure|fig\.|photograph|photo|picture|image|illustrated|accompanying|shown below|shown above|is shown|are shown|table below|following table|graph|ecg below)\b/i;
function qBroken(m) {
  const stem = String(m.stem || '').trim(), opts = (m.options || []).map(String);
  if (opts.length < 2) return 'missing options';
  if (stem.length < 25 && !m.img) return 'question text missing';
  if (/^[O0]?[A-E][\s.)]/.test(stem) && !/\?/.test(stem) && stem.length < 60) return 'question text missing';
  const junk = t => /[A-Za-z]\(\)|\(\)[A-Za-z]|[{}|$\\]|[^\x00-\x7F°±≤≥µ×–—‘’“”…·•→↑↓′″αβγδμ]{2,}/.test(t);
  if (opts.filter(junk).length >= 2 || (opts.join('').length < opts.length * 3 && opts.length >= 4)) return 'garbled options';
  const bad = (stem.match(/[^A-Za-z0-9\s.,;:()'"%/+\-–?°±≤≥µ×’‘“”]/g) || []).length;
  if (bad > Math.max(6, stem.length * 0.06)) return 'garbled question';
  if (!m.img && FIG_RE.test(stem)) return 'picture missing';
  return '';
}

// "Severe anaemia" written in capitals for emphasis → normal case, underlined (acronyms like WHO, ECG stay).
const EMPH = new Set('most best least except not never always only first initial next likely unlikely appropriate inappropriate correct incorrect true false recommend recommended important immediate immediately definitive commonest common useful contraindicated indicated initially earliest single main major principal characteristic diagnostic preferred'.split(' '));
function unshout(h) { return h.replace(/\b([A-Z]{3,})\b/g, (w, x) => EMPH.has(x.toLowerCase()) ? `<u>${x.toLowerCase()}</u>` : w); }

// AI text sometimes comes with maths codes ("$\rightarrow$", "\text{ mmol/L}", "10^9") — show them as real symbols.
function texify(h) {
  const G = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', mu: 'µ', kappa: 'κ', lambda: 'λ' };
  return h.replace(/\$([^$\n]{1,160})\$/g, (m, g) => /\\|\^|_|\{/.test(g) ? g : m)
    .replace(/\\(?:text|mathrm|textbf|mathbf|operatorname|textit)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:rightarrow|to|longrightarrow|Rightarrow|implies)\b/g, '→').replace(/\\(?:leftarrow|Leftarrow)\b/g, '←')
    .replace(/\\uparrow\b/g, '↑').replace(/\\downarrow\b/g, '↓').replace(/\\(?:geq?|ge)\b/g, '≥').replace(/\\(?:leq?|le)\b/g, '≤')
    .replace(/\\times\b/g, '×').replace(/\\pm\b/g, '±').replace(/\\approx\b/g, '≈').replace(/\\sim\b/g, '~').replace(/\\%/g, '%')
    .replace(/\\(alpha|beta|gamma|delta|mu|kappa|lambda)\b/g, (m, g) => G[g]).replace(/\\[,; ]/g, ' ')
    .replace(/\^\{([^{}]{1,14})\}/g, '<sup>$1</sup>').replace(/_\{([^{}]{1,14})\}/g, '<sub>$1</sub>')
    .replace(/([A-Za-z0-9)])\^([0-9+\-−]{1,3})/g, '$1<sup>$2</sup>')
    .replace(/\b(\d{2})\+([0-6])(?=\s*(?:weeks?|wks?|days?|\/40|w\b))/gi, '$1<sup>+$2</sup>');
}

// Colour the words that matter in notes: acronyms (SIADH, HPOA), 'quoted' terms, and the user's own highlights.
function keyColour(h, user = []) {
  let out = h.replace(/(^|[\s(>])(?:'|&#39;|‘)([^'’&<]{3,40})(?:'|&#39;|’)(?=[\s.,;:)<&]|$)/g, '$1<mark class="kw">$2</mark>')
    .replace(/\b([A-Z][A-Z0-9]{2,6}s?)\b(?![^<]*>)/g, (w) => /^(THE|AND|FOR|WITH|NOT|ALL|ANY|USE)$/.test(w) ? w : `<b class="acr">${w}</b>`);
  for (const u of user) { const e = esc(u.t); if (e.length < 3) continue; out = out.split(e).join(`<mark class="${u.k === 'ul' ? 'uul' : 'uhl'}">${e}</mark>`); }
  return out;
}

// Wrap the user's highlights inside a question stem (exam tool, lasts for this test only).
function applyMarks(html, list = []) { for (const t of list) { const e = esc(t); if (e.length > 1) html = html.split(e).join(`<mark class="uhl">${e}</mark>`); } return html; }

// Book references must suit the patient: no children's textbooks for adults.
function refsForPatient(m, refs = []) {
  const age = +((String(m.stem).match(/(\d{1,2})[- ](?:year|yr)[- ]old/i) || [])[1] || 0);
  return refs.filter(r => !(age >= 16 && /nelson|ghai|paediatric|pediatric/i.test(r.book || '')));
}

// ---------- Mind maps (made only when asked) ----------
async function bookFigures(t) {
  if (!(await DB.count('books'))) return [];
  const books = (await DB.all('books')).filter(b => ['ref', 'amc', 'mbbs'].includes(b.role));
  const stop = /^(and|the|with|of|in|for|acute|chronic|disease|disorders?|syndrome)$/i;
  const words = [...new Set(`${t.name} ${(t.kw || []).join(' ')}`.toLowerCase().match(/[a-z]{3,}/g) || [])].filter(w => !stop.test(w));
  const abbr = (t.name.match(/\b[A-Z]{2,6}\b/g) || []).map(x => x.toLowerCase());
  const phrases = [t.name.replace(/\(.*?\)/g, ''), ...(t.kw || [])].map(x => x.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()).filter(x => x.split(' ').length >= 2);
  const out = [];
  for (const b of books) {
    await DB.each('pages', 'bookId', b.id, pg => {
      const re = /(?:fig(?:ure|\.)?|box)\s*\d+[.\d]*\s+([^\n]{8,170})/gi; let m;
      while ((m = re.exec(pg.text))) {
        const cap = m[1].toLowerCase();
        let sc = words.filter(w => cap.includes(w)).length * 2 + abbr.filter(w => new RegExp('\\b' + w + '\\b').test(cap)).length * 2 + phrases.filter(ph => cap.includes(ph)).length * 5;
        if (sc < 4) continue;
        if (/treatment|management|algorithm|approach|summary|classification|criteria|pathway|flow/i.test(cap)) sc += 3;
        out.push({ s: sc, book: b.short || b.name, bookId: b.id, size: b.size, p: pg.p, cap: m[0].replace(/\s+/g, ' ').trim().slice(0, 160) });
      }
    });
  }
  out.sort((a, b) => b.s - a.s);
  const seen = new Set(), figs = out.filter(f => { const k = f.bookId + ':' + f.p; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
  // Keep a picture of each page, so the phone shows the real textbook figure too.
  for (const f of figs.slice(0, 3)) {
    try {
      const id = `fig-${f.bookId}-${f.p}`;
      if (!(await DB.get('media', id))) { const book = await DB.get('books', f.bookId); const c = await renderPage(book, f.p, 1500); await DB.put('media', { id, data: c.toDataURL('image/jpeg', 0.72), kind: 'figure', caption: f.cap }); }
      f.img = id;
    } catch (e) { console.warn('figure', e); }
  }
  return figs;
}
async function makeMindmap(t) {
  const sheet = await DB.get('sheets', t.id);
  const notes = sheet ? Object.entries(sheet.sections || {}).map(([k, v]) => `## ${SECTIONS[k] || k}\n${['ref', 'mbbs', 'amc'].map(c => asText(v?.[c])).join('\n')}`).join('\n').slice(0, 15000) : '';
  const prompt = `Make a colourful revision MIND MAP for the topic "${t.name}" for a medical student (Indian MBBS + Australian AMC).
${notes ? 'Use these notes from their textbooks:\n' + notes : 'Use standard textbook knowledge (Davidson, Harrison, Bailey & Love, Murtagh).'}

Return JSON only:
{"center":"${t.name}","branches":[{"title":"Definition","items":["..."]}],"flows":[{"title":"Management of …","steps":["…","If … → …"]}]}
Rules:
- branches in this order when relevant: Definition, Causes / Risk factors, Pathophysiology, Clinical features, Investigations, Management, Complications, Prognosis / key numbers.
- 3–7 items per branch, each max 12 words, no full sentences. Wrap the 1–2 most important words of each item in **double asterisks**.
- flows: 1–3 COMPLETE step-by-step algorithms (management and/or diagnostic pathway, as in the textbook's flowchart) — include every step and decision, up to 14 steps each; each step max 14 words; use "If X → Y" for decisions. Do not cut management short.
- Exam-relevant facts only. Australian practice (Murtagh/eTG) where it differs, marked "(AU)".`;
  const mm = await AI.call({ prompt, json: true });
  if (!mm || !Array.isArray(mm.branches)) throw new Error('The AI reply wasn’t a mind map — try again.');
  mm.figs = await bookFigures(t).catch(() => []);
  mm.figsDone = !!(await DB.count('books'));   // no books on this device → the laptop adds the figures later
  mm.at = Date.now();
  const s = sheet || { id: t.id, sections: {} };
  s.mindmap = mm; s.updated = Date.now(); await DB.put('sheets', s);
  return mm;
}
function mindmapHTML(t, mm, imgs = {}) {
  const inl = x => keyColour(texify(esc(String(x))).replace(/\*\*(.+?)\*\*/g, '<b class="key">$1</b>'));
  const br = (mm.branches || []).map((b, i) => `<section class="mm-b c${i % 8}"><h4>${esc(b.title)}</h4><ul>${(b.items || []).map(x => `<li>${inl(x)}</li>`).join('')}</ul></section>`);
  const half = Math.ceil(br.length / 2);
  const flows = (mm.flows || []).map((f, i) => `<section class="mm-flow c${(i + 3) % 8}"><h4>${esc(f.title)}</h4><div class="flow">${(f.steps || []).map(s => `<div class="fstep">${inl(s)}</div>`).join('<div class="farrow">↓</div>')}</div></section>`).join('');
  const figs = (mm.figs || []).length ? `<section class="card mt"><h4>The textbook's own figures &amp; flowcharts</h4>${mm.figs.filter(f => imgs[f.img]).map(f => `<figure class="mm-fig"><img src="${imgs[f.img]}" data-act="zoomImg" alt="${esc(f.cap || '')}" loading="lazy"><figcaption>${esc(f.book)} p.${f.p} — ${esc(f.cap || '')}</figcaption></figure>`).join('')}${mm.figs.filter(f => !imgs[f.img]).map(f => `<p><button class="linkbtn" data-act="openRef" data-book="${f.bookId}" data-size="${f.size || ''}" data-p="${f.p}">${esc(f.book)} p.${f.p}</button> <span class="muted small">${esc(f.cap || '')}</span></p>`).join('')}</section>` : '';
  return `<div class="mm"><div class="mm-side">${br.slice(0, half).join('')}</div><div class="mm-core"><div class="mm-center">${esc(mm.center || t.name)}</div></div><div class="mm-side">${br.slice(half).join('')}</div></div>
    ${flows ? `<div class="mm-flows">${flows}</div>` : ''}${figs}`;
}

// ---------- Select any text → Ask AI / highlight / underline ----------
const SelBar = {
  el: null, text: '', ctx: '',
  init() {
    const b = document.createElement('div'); b.id = 'selbar'; b.hidden = true;
    b.innerHTML = '<button data-sel="ask">Ask AI</button><button data-sel="g">Google</button><button data-sel="hl">Highlight</button><button data-sel="ul">Underline</button>';
    document.body.appendChild(b); this.el = b;
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', e => { const k = e.target.dataset.sel; if (k) this.act(k); });
    const check = () => setTimeout(() => this.check(), 10);
    document.addEventListener('mouseup', check); document.addEventListener('touchend', check); document.addEventListener('keyup', check);
    document.addEventListener('scroll', () => { if (!this.el.hidden) this.place(); }, true);
  },
  check() {
    const sel = window.getSelection(), t = sel && sel.toString().trim();
    if (!t || t.length < 2 || t.length > 500 || !sel.rangeCount) { this.el.hidden = true; return; }
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const host = node && node.closest('.read, .q-stem, .expl, .bookquote, .mm, .cmp, .master, .opt-t, .doubt');
    if (!host || host.closest('#selbar')) { this.el.hidden = true; return; }
    this.text = t; this.ctx = host.textContent.replace(/\s+/g, ' ').slice(0, 900); this.inQ = !!host.closest('.q-stem, .opt-t');
    this.el.querySelector('[data-sel="ul"]').hidden = this.inQ;
    this.el.hidden = false; this.place();
  },
  place() {
    const sel = window.getSelection(); if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const w = this.el.offsetWidth || 220;
    this.el.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    this.el.style.top = (r.top > 60 ? r.top - 48 : r.bottom + 8) + 'px';
  },
  async act(k) {
    const t = this.text; this.el.hidden = true; window.getSelection().removeAllRanges();
    if (k === 'ask') return askSelection(t, this.ctx);
    if (k === 'g') return window.open('https://www.google.com/search?q=' + encodeURIComponent(t), '_blank', 'noopener');
    if (this.inQ && Practice.s) { const s = Practice.s, id = s.qs[s.idx]; ((s.hl ||= {})[id] ||= []).push(t); Practice.save(); return App.render(true); }
    const tid = (location.hash.match(/#\/topic\/([^/]+)/) || [])[1];
    if (!tid) return toast('Open a topic to keep highlights.');
    const n = await getNote(tid); (n.hl ||= []).push({ t, k }); await DB.put('notes', n); App.render(true);
  }
};
async function askSelection(text, ctx, history = []) {
  const box = document.getElementById('asksel-out');
  if (!box) openModal(`<form data-submit="askSelMore"><p class="eyebrow">Ask AI</p><h3>“${esc(text.slice(0, 120))}”</h3><div id="asksel-out" class="read"></div>
    <div class="row gap mt"><input name="q" placeholder="Ask a follow-up…" style="flex:1;min-width:0" autocomplete="off"><button class="btn primary">Ask</button></div>
    <div class="row end mt"><button type="button" class="btn" data-act="closeModal">Close</button></div></form>`);
  const out = document.getElementById('asksel-out');
  window._askSel = { text, ctx, history };
  const q = history.length ? history[history.length - 1].q : null;
  out.insertAdjacentHTML('beforeend', `<div class="asksel-a"><p class="muted"><span class="spin"></span>Thinking…</p></div>`);
  const slot = out.lastElementChild;
  try {
    const prev = history.slice(0, -1).map(h => `Q: ${h.q}\nA: ${h.a}`).join('\n');
    const prompt = q ? `Earlier we discussed "${text}" (context: ${ctx}).\n${prev}\nStudent's follow-up: ${q}\nAnswer ONLY in short bullet points (max 120 words), **bold** key terms; an arrow chain (A → B → C) if it helps; add a Hindi/Punjabi mnemonic (in English letters) if useful.`
      : `A medical student (Indian MBBS, preparing for the Australian AMC exam) selected this text while studying: "${text}"\nSurrounding text: ${ctx}\n
Explain it ONLY in short bullet points (max 12 words each, max 200 words total) — never paragraphs:
**What it is** – 1–2 points in plain words.
**How it works** – the mechanism as an arrow chain (A → B → C).
**Key facts** – 3–6 points (numbers, criteria, components as a list).
**Remember it** – one mnemonic in English, and one fun mnemonic in Hindi or Punjabi written in English letters.
**Exam angle** – 1–2 points on what AMC/MBBS asks (Australian practice if different).
**Test yourself** – 2 short questions; answers in brackets at the end.
Use **bold** for key terms.`;
    const a = await fastAI({ prompt, json: false }); // the fast model: answers in a few seconds
    slot.innerHTML = (q ? `<p class="muted small">You asked: ${esc(q)}</p>` : '') + md(a);
    if (q) history[history.length - 1].a = a;
  } catch (e) { slot.innerHTML = `<p class="warn-t">${esc(e.message)}${/key/i.test(e.message) ? ' — add your Gemini key in Settings on this device too.' : ''}</p>`; }
}
