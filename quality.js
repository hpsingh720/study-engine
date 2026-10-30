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
/**
 * Wrap ONE occurrence of a phrase, counting only text that is actually on the page.
 *
 * A plain split/join marked every occurrence — highlighting "PR" lit up every PR in the topic —
 * and happily rewrote the inside of tags, so selecting a word like "class" or "mark" corrupted the
 * markup. This walks the html in tag and text runs, counts occurrences in the text runs alone, and
 * wraps the nth. If that occurrence cannot be found (the selection crossed a tag boundary) it
 * falls back to the first, which is better than marking all of them.
 */
function markNth(html, needle, nth, cls, idx) {
  if (!needle || needle.length < 2) return html;
  const open = `<mark class="${cls}" data-hl="${idx}">`;
  const parts = String(html).split(/(<[^>]*>)/);
  const wrap = want => {
    let seen = 0, hit = false;
    const out = parts.map(s => {
      if (hit || s.startsWith('<')) return s;
      let res = '', pos = 0;
      for (;;) {
        const at = s.indexOf(needle, pos);
        if (at === -1) { res += s.slice(pos); break; }
        if (seen === want) {
          res += s.slice(pos, at) + open + needle + '</mark>' + s.slice(at + needle.length);
          hit = true; seen++; break;
        }
        seen++; res += s.slice(pos, at + needle.length); pos = at + needle.length;
      }
      return res;
    }).join('');
    return hit ? out : null;
  };
  return wrap(nth >= 0 ? nth : 0) ?? wrap(0) ?? html;
}

function keyColour(h, user = []) {
  let out = h.replace(/(^|[\s(>])(?:'|&#39;|‘)([^'’&<]{3,40})(?:'|&#39;|’)(?=[\s.,;:)<&]|$)/g, '$1<mark class="kw">$2</mark>')
    .replace(/\b([A-Z][A-Z0-9]{2,6}s?)\b(?![^<]*>)/g, (w) => /^(THE|AND|FOR|WITH|NOT|ALL|ANY|USE)$/.test(w) ? w : `<b class="acr">${w}</b>`);
  user.forEach((u, i) => {
    const e = esc(u.t);
    if (e.length < 3) return;
    out = markNth(out, e, Number.isInteger(u.n) ? u.n : 0, u.k === 'ul' ? 'uul' : 'uhl', i);
  });
  return out;
}

// Wrap the user's highlights inside a question stem (exam tool, lasts for this test only).
function applyMarks(html, list = []) {
  list.forEach((t, i) => {
    const e = esc(typeof t === 'string' ? t : t.t);
    const n = typeof t === 'string' ? 0 : (Number.isInteger(t.n) ? t.n : 0);
    if (e.length > 1) html = markNth(html, e, n, 'uhl', i);
  });
  return html;
}

// Book references must suit the patient: no children's textbooks for adults.
function refsForPatient(m, refs = []) {
  const age = +((String(m.stem).match(/(\d{1,2})[- ](?:year|yr)[- ]old/i) || [])[1] || 0);
  return refs.filter(r => !(age >= 16 && /nelson|ghai|paediatric|pediatric/i.test(r.book || '')));
}

// ---------- Mind maps (made only when asked) ----------
async function bookFigures(t) {
  const books = (await searchableBooks()).filter(b => ['ref', 'amc', 'mbbs'].includes(b.role));
  if (!books.length) return [];
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
      let book = await DB.get('books', f.bookId), file = book && await DB.get('files', book.id);
      // On the iPad/phone: use a reading copy of the same PDF if you added one, otherwise ask the laptop for the page picture.
      if (!file && f.size) { book = (await DB.all('books')).find(b => b.size === f.size) || null; file = book && await DB.get('files', book.id); }
      if (!file) { f.img = PageRelay.pid(f.bookId, f.p); if (Sync.on() && !(await DB.get('media', f.img))) PageRelay.askPage(f.bookId, f.p, f.book).catch(() => {}); continue; }
      if (!(await DB.get('media', id))) { const c = await renderPage(book, f.p, 1500); await DB.put('media', { id, data: c.toDataURL('image/jpeg', 0.72), kind: 'figure', caption: f.cap }); }
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
{"center":"${t.name}","branches":[{"title":"Definition","items":["...",{"h":"Sub-heading","items":["..."]}]}],"flows":[{"title":"Management of …","steps":["…","If … → …"]}]}

THIS REPLACES READING THE CHAPTER. Someone meeting the topic for the first time must be able to learn
it from this alone and sit an exam on it. Completeness matters far more than brevity — a fact left
out is a fact they will not know.

- Cover the WHOLE topic, start to finish. Every cause, every classification with all of its grades or
  stages and what defines each, every clinical sign, every named test and what a positive one means,
  every investigation with its values and cut-offs, every treatment with drug, dose and route, every
  complication, every eponym. If the textbook devotes a paragraph to it, it belongs here.
- Use as many branches as the topic needs — twelve is fine. Beyond the usual Definition, Anatomy,
  Types / Classification, Causes, Pathophysiology, Clinical features, Examination findings,
  Differential diagnosis, Investigations, Management (medical / surgical), Complications,
  Prognosis — add whatever this topic actually has.
- Put as many items in a branch as the facts require; never trim a list to make it look tidy. Group a
  long branch with {"h":"Sub-heading","items":[...]} so it stays readable — classifications,
  conservative vs surgical, by age, by severity.
- Items are compressed notes, not sentences: "**Trendelenburg** test +ve → SFJ incompetence",
  "Grade **III**: ulcer, healed or active". Keep every number, dose, cut-off and criterion. Wrap the
  one or two words that carry the fact in **double asterisks**.
- Where the textbook has a mnemonic or a classic triad, include it.
- flows: 1–3 COMPLETE step-by-step algorithms (management and/or diagnostic pathway, as in the
  textbook's flowchart) — include every step and decision, up to 14 steps each; each step max 14
  words; use "If X → Y" for decisions. Do not cut management short.
- Australian practice (Murtagh/eTG) where it differs, marked "(AU)". Do not drop the Indian answer.`;
  const mm = await AI.call({ prompt, json: true });
  if (!mm || !Array.isArray(mm.branches)) throw new Error('The AI reply wasn’t a mind map — try again.');
  mm.figs = await bookFigures(t).catch(() => []);
  mm.figsDone = (await searchableBooks()).some(b => b.role !== 'reader');   // no books on this device → the laptop adds the figures later
  mm.at = Date.now();
  const s = sheet || { id: t.id, sections: {} };
  s.mindmap = mm; s.updated = Date.now(); await DB.put('sheets', s);
  return mm;
}
function mindmapHTML(t, mm, imgs = {}) {
  const inl = x => keyColour(texify(esc(String(x))).replace(/\*\*(.+?)\*\*/g, '<b class="key">$1</b>'));
  // An item is either a note or a sub-heading with its own notes under it, so a long branch —
  // a classification, or conservative versus surgical — keeps the shape the book gave it.
  const items = list => (list || []).map(x => (x && typeof x === 'object' && Array.isArray(x.items))
    ? `<li class="mm-sub"><b>${esc(x.h || '')}</b><ul>${items(x.items)}</ul></li>`
    : `<li>${inl(x)}</li>`).join('');
  const br = (mm.branches || []).map((b, i) => `<section class="mm-b c${i % 8}"><h4>${esc(b.title)}</h4><ul>${items(b.items)}</ul></section>`);
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
    document.addEventListener('mouseup', check); document.addEventListener('keyup', check);
    // Phones: dragging the selection handles fires no touch events — follow the selection itself, and wait until it settles.
    let t = 0; document.addEventListener('selectionchange', () => { clearTimeout(t); t = setTimeout(() => this.check(), 450); });
    this.touch = matchMedia('(pointer: coarse)').matches; if (this.touch) b.classList.add('touch');
    b.addEventListener('touchstart', e => { const k = e.target.closest('[data-sel]')?.dataset.sel; if (k) { e.preventDefault(); this.act(k); } }, { passive: false });
    document.addEventListener('scroll', () => { if (!this.el.hidden) this.place(); }, true);
  },
  check() {
    const sel = window.getSelection(), t = sel && sel.toString().trim();
    if (!t || t.length < 2 || t.length > 800 || !sel.rangeCount) { this.el.hidden = true; return; }
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    // The India/Australia comparison and the tables copied out of the books are read just as closely
    // as the prose, so they are highlightable too.
    const host = node && node.closest('.read, .q-stem, .expl, .bookquote, .mm, .cmp, .master, .opt-t, .doubt, .dtable, .mdt, .callout');
    if (!host || host.closest('#selbar')) { this.el.hidden = true; return; }
    this.text = t; this.ctx = host.textContent.replace(/\s+/g, ' ').slice(0, 900); this.inQ = !!host.closest('.q-stem, .opt-t');
    // Which occurrence of this phrase was picked, counted in the host's own text — so marking one
    // "PR" marks that one and not every PR on the page.
    this.nth = 0;
    try {
      const pre = document.createRange();
      pre.selectNodeContents(host);
      pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
      this.nth = pre.toString().split(t).length - 1;
    } catch (e) { this.nth = 0; }
    this.el.querySelector('[data-sel="ul"]').hidden = this.inQ;
    this.el.hidden = false; this.place();
  },
  place() {
    if (this.touch) return;   // phones/iPad: the bar sits at the bottom, clear of the phone's own Copy/Select-all menu
    const sel = window.getSelection(); if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const w = this.el.offsetWidth || 220;
    this.el.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    this.el.style.top = (r.top > 60 ? r.top - 48 : r.bottom + 8) + 'px';
  },
  async act(k) {
    const live = window.getSelection()?.toString().trim(); if (live && live.length >= 2) this.text = live;
    const t = this.text; this.el.hidden = true; window.getSelection().removeAllRanges();
    if (k === 'ask') return askSelection(t, this.ctx);
    if (k === 'g') return window.open('https://www.google.com/search?q=' + encodeURIComponent(t), '_blank', 'noopener');
    const nth = this.nth || 0;
    if (this.inQ && Practice.s) { const s = Practice.s, id = s.qs[s.idx]; ((s.hl ||= {})[id] ||= []).push({ t, n: nth }); Practice.save(); return App.render(true); }
    const tid = (location.hash.match(/#\/topic\/([^/]+)/) || [])[1];
    if (!tid) return toast('Open a topic to keep highlights.');
    const note = await getNote(tid); (note.hl ||= []).push({ t, k, n: nth }); await DB.put('notes', note); App.render(true);
  },

  /**
   * Tap a highlight to take it off again.
   *
   * Wired here rather than through data-act, because a mark sits inside the text and a click on it
   * should not also count as a click on whatever contains it.
   */
  initRemove() {
    document.addEventListener('click', async e => {
      const m = e.target.closest('mark[data-hl]');
      if (!m) return;
      e.preventDefault(); e.stopPropagation();
      const i = +m.dataset.hl;

      if (Practice.s && m.closest('.q-stem, .opt-t')) {
        const s = Practice.s, id = s.qs[s.idx], list = (s.hl ||= {})[id] || [];
        if (i >= 0 && i < list.length) { list.splice(i, 1); Practice.save(); App.render(true); }
        return;
      }
      const tid = (location.hash.match(/#\/topic\/([^/]+)/) || [])[1];
      if (!tid) return;
      const note = await getNote(tid);
      if (!Array.isArray(note.hl) || i < 0 || i >= note.hl.length) return;
      note.hl.splice(i, 1);
      await DB.put('notes', note);
      toast('Highlight removed');
      App.render(true);
    }, true);
  }
};
async function askSelection(text, ctx, history = []) {
  const box = document.getElementById('asksel-out');
  // Light and draggable: an answer can take a while, and the sheet behind it is what is being read
  // in the meantime — so the page stays scrollable, selectable and highlightable while it thinks.
  if (!box) openModal(`<form data-submit="askSelMore"><p class="eyebrow">Ask AI · drag the bar to move me</p><h3>“${esc(text.slice(0, 120))}”</h3><div id="asksel-out" class="read"></div>
    <div class="row gap mt"><input name="q" placeholder="Ask a follow-up…" style="flex:1;min-width:0" autocomplete="off"><button class="btn primary">Ask</button></div>
    <div class="row end mt"><button type="button" class="btn" data-act="closeModal">Close</button></div></form>`, { drag: true, light: true });
  const out = document.getElementById('asksel-out');
  window._askSel = { text, ctx, history };
  const q = history.length ? history[history.length - 1].q : null;
  out.insertAdjacentHTML('beforeend', `<div class="asksel-a"><p class="muted"><span class="spin"></span>Thinking…</p></div>`);
  const slot = out.lastElementChild;
  try {
    const prev = history.slice(0, -1).map(h => `Q: ${h.q}\nA: ${h.a}`).join('\n');
    const prompt = q ? `Earlier we discussed "${text}" (context: ${ctx}).\n${prev}\nStudent's follow-up: ${q}\nAnswer ONLY in short bullet points (max 120 words), **bold** key terms; an arrow chain (A → B → C) if it helps.`
      : `A medical student (Indian MBBS, preparing for the Australian AMC exam) selected this text while studying: "${text}"\nSurrounding text: ${ctx}\n
Explain it ONLY in short bullet points (max 12 words each, max 200 words total) — never paragraphs:
**What it is** – 1–2 points in plain words.
**How it works** – the mechanism as an arrow chain (A → B → C).
**Key facts** – 3–6 points (numbers, criteria, components as a list).
**Exam angle** – 1–2 points on what AMC/MBBS asks (Australian practice if different).
**Test yourself** – 2 short questions; answers in brackets at the end.
Use **bold** for key terms.`;
    const a = await fastAI({ prompt, json: false }); // the fast model: answers in a few seconds
    slot.innerHTML = (q ? `<p class="muted small">You asked: ${esc(q)}</p>` : '') + md(a);
    if (q) history[history.length - 1].a = a;
  } catch (e) { slot.innerHTML = `<p class="warn-t">${esc(e.message)}${/key/i.test(e.message) ? ' — add your Gemini key in Settings on this device too.' : ''}</p>`; }
}
