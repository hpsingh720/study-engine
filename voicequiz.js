// Hands-free questions: the app reads each question and its options aloud, you answer by voice,
// it says whether you were right and the one fact to remember. For walking, travelling, or any time
// your hands and eyes are busy. Answers count exactly like typed ones — stats, revision, mistakes.

const VoiceQuiz = {
  run: null,

  // What you said → which option, or a command. Whisper writes "B.", "option B", "bee", "doosra"…
  parse(text, m) {
    const s = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9ऀ-੿ ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
    if (/ (repeat|again|say again|once more|dobara|dubara|phir se|fir se|ਦੁਬਾਰਾ|दोबारा) /.test(s)) return { cmd: 'repeat' };
    if (/ (skip|next|pass|chhodo|chodo|agla|ਅਗਲਾ|अगला) /.test(s)) return { cmd: 'skip' };
    if (/ (stop|pause|band karo|ruk|ruko|bas|enough|ਬੰਦ|बंद|रुको) /.test(s)) return { cmd: 'stop' };
    const words = s.trim().split(' ');
    const letter = { a: 0, ay: 0, eh: 0, b: 1, bee: 1, be: 1, bi: 1, c: 2, see: 2, sea: 2, si: 2, she: 2, d: 3, dee: 3, de: 3, di: 3, e: 4, 'ए': 0, 'बी': 1, 'सी': 2, 'डी': 3, 'ਏ': 0, 'ਬੀ': 1, 'ਸੀ': 2, 'ਡੀ': 3 };
    const ord = { first: 0, one: 0, '1': 0, ek: 0, pehla: 0, pahla: 0, pehli: 0, second: 1, two: 1, '2': 1, do: 1, doosra: 1, dusra: 1, doosri: 1, third: 2, three: 2, '3': 2, teen: 2, teesra: 2, tisra: 2, fourth: 3, four: 3, '4': 3, char: 3, chaar: 3, chautha: 3, chotha: 3,
      'पहला': 0, 'पहली': 0, 'एक': 0, 'दूसरा': 1, 'दूसरी': 1, 'दो': 1, 'तीसरा': 2, 'तीसरी': 2, 'तीन': 2, 'चौथा': 3, 'चौथी': 3, 'चार': 3,
      'ਪਹਿਲਾ': 0, 'ਪਹਿਲੀ': 0, 'ਇੱਕ': 0, 'ਦੂਜਾ': 1, 'ਦੂਜੀ': 1, 'ਦੋ': 1, 'ਤੀਜਾ': 2, 'ਤੀਜੀ': 2, 'ਤਿੰਨ': 2, 'ਚੌਥਾ': 3, 'ਚੌਥੀ': 3, 'ਚਾਰ': 3 };
    // "option B", "answer is C", "it's D" — or a short reply that is just the letter.
    const lead = s.match(/ (?:option|answer|answer is|its|it s|letter|choice) ([a-d]|bee|see|sea|dee) /);
    if (lead) return { choice: letter[lead[1]] };
    if (words.length <= 3) for (const w of words) if (w in letter) return { choice: letter[w] };
    for (const w of words) if (w in ord && (words.length <= 4 || /option|answer/.test(s))) return { choice: ord[w] };
    // Said the answer itself rather than its letter.
    const toks = x => new Set(String(x).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length > 2));
    const said = toks(text);
    let best = -1, bestScore = 0;
    (m?.options || []).forEach((o, i) => {
      const ot = toks(o); if (!ot.size) return;
      let hit = 0; ot.forEach(w => { if (said.has(w)) hit++; });
      const sc = hit / ot.size;
      if (sc > bestScore) { bestScore = sc; best = i; }
    });
    if (best >= 0 && bestScore >= 0.6) return { choice: best };
    return {};
  },

  async questions({ topicIds, systems, source = 'all', count = 15 }) {
    // Picture questions cannot be read aloud.
    const ids = await Practice.pool({ topicIds, systems, source, count: count * 2, weightMistakes: source === 'all' });
    const out = [];
    for (const id of ids) { const m = await DB.get('mcqs', id); if (m && m.type !== 'IMG' && !m.image && !m.img && (m.options || []).length >= 2 && !isMulti(m)) out.push(m); if (out.length >= count) break; }
    return out;
  },

  // "Quiz me on nephrotic syndrome" → the topic or subject meant.
  async find(text) {
    const q = String(text || '').toLowerCase().replace(/\b(quiz|ask|test|me|on|about|questions?|some|please|from|hey|jarvis|karo|puchho|poocho)\b/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!q) return null;
    if (/mistake|wrong|galat/.test(q)) return { source: 'mistakes', title: 'Your mistakes' };
    if (/revision|due|revise/.test(q)) return { source: 'due', title: 'Due for revision' };
    const sys = SEED.systems.find(s => s.name.toLowerCase().split(/[ &]+/).some(w => w.length > 3 && q.includes(w)) || q.includes(s.code.toLowerCase()));
    const topics = await DB.live('topics');
    const words = q.split(' ').filter(w => w.length > 2);
    let best = null, bestScore = 0;
    for (const t of topics) {
      const n = t.name.toLowerCase();
      const hit = words.filter(w => n.includes(w)).length;
      const sc = hit / Math.max(words.length, n.split(/\s+/).length);
      if (hit && sc > bestScore) { bestScore = sc; best = t; }
    }
    if (best && bestScore >= 0.34) return { topicIds: [best.id], title: best.name };
    if (sys) return { systems: [sys.code], title: sys.name };
    return null;
  },

  async start(sel) {
    const qs = await this.questions({ ...sel, count: +sel.count || 15 });
    if (!qs.length) { toast('No questions to read for that yet — generate some first.'); return; }
    this.run = { id: 'voice-' + uid(), title: sel.title || 'Voice quiz', qs, i: 0, right: 0, done: 0, state: 'ready', said: '', paused: false };
    try { this._lock = await navigator.wakeLock?.request('screen'); } catch (e) {}
    location.hash = '#/voice/run';
    setTimeout(() => this.loop(), 300);
  },

  stopRun() {
    if (!this.run) return;
    this.run.stopped = true;
    Voice.stop();
    try { this._lock?.release(); } catch (e) {}
  },

  paint() {
    const el = document.getElementById('vq-live');
    if (!el || !this.run) return;
    const r = this.run, m = r.qs[r.i];
    el.innerHTML = m ? `
      <p class="eyebrow">${esc(r.title)} · ${r.i + 1} of ${r.qs.length} · ${r.right}/${r.done} right</p>
      <h2 class="vq-stem">${esc(Voice.plain(m.stem))}</h2>
      <ol class="vq-opts" type="A">${m.options.map((o, k) => `<li class="${r.reveal != null ? (correctSet(m).includes(k) ? 'ok' : r.reveal === k ? 'bad' : '') : ''}">${esc(Voice.plain(o))}</li>`).join('')}</ol>
      <p class="vq-state">${{ speaking: 'Reading…', listening: 'Listening — say A, B, C or D', thinking: 'Got it…', feedback: '', ready: '' }[r.state] || ''}${r.said ? ` <span class="muted">“${esc(r.said)}”</span>` : ''}</p>
      <div class="vq-meter"><i id="vq-lvl"></i></div>` : `<h2>Done</h2><p>${r.right} of ${r.done} right.</p><a class="btn primary" href="#/voice">Another round</a>`;
  },

  async ask(m) {
    const opts = m.options.map((o, k) => `Option ${'ABCDE'[k]}: ${o}.`).join(' ');
    await Voice.say(`${m.stem}. ${opts}`);
  },

  async loop() {
    const r = this.run;
    while (r && !r.stopped && r.i < r.qs.length) {
      const m = r.qs[r.i];
      r.reveal = null; r.said = ''; r.state = 'speaking'; this.paint();
      await this.ask(m);
      let choice = null, tries = 0;
      while (!r.stopped && choice == null && tries < 3) {
        r.state = 'listening'; this.paint();
        let heard = '';
        try { heard = await Voice.listen({ prompt: 'Answer A, B, C or D. Repeat. Skip. Stop.', onLevel: v => { const b = document.getElementById('vq-lvl'); if (b) b.style.width = Math.round(v * 100) + '%'; } }); }
        catch (e) { toast(e.message || String(e), 8000); this.stopRun(); return; }
        if (r.stopped) return;
        r.said = heard; r.state = 'thinking'; this.paint();
        const p = this.parse(heard, m);
        if (p.cmd === 'stop') { await Voice.say('Stopping. Well done.'); this.stopRun(); r.i = r.qs.length; this.paint(); return; }
        if (p.cmd === 'skip') { choice = -1; break; }
        if (p.cmd === 'repeat') { r.state = 'speaking'; this.paint(); await this.ask(m); continue; }
        if (p.choice != null) { choice = p.choice; break; }
        tries++;
        if (tries < 3) await Voice.say(heard ? 'Sorry, which option? A, B, C or D.' : 'I did not catch that. A, B, C or D?');
      }
      if (r.stopped) return;
      if (choice != null && choice >= 0) {
        const ok = isRight(m, choice);
        r.done++; if (ok) r.right++;
        r.reveal = choice; r.state = 'feedback'; this.paint();
        await DB.put('attempts', { id: uid(), mcqId: m.id, topicId: m.topicId, system: m.system, type: m.type, choice, correct: ok ? 1 : 0, ts: Date.now(), session: r.id, voice: 1 });
        const k = correctSet(m)[0];
        const why = m.master || String(m.explanation || '').split('\n').find(l => l.trim() && !/^answer/i.test(l.trim())) || '';
        await Voice.say(ok ? `Correct. ${why}` : `Not quite. The answer is ${'ABCDE'[k] || ''}: ${m.options[k]}. ${why}`);
      }
      r.i++;
    }
    if (r && !r.stopped) { this.paint(); await Voice.say(`That's the round. ${r.right} out of ${r.done} right.`); this.stopRun(); }
  }
};
window.VoiceQuiz = VoiceQuiz;

Views.voice = async (sub) => {
  if (sub === 'run' && VoiceQuiz.run) {
    return `<div class="page vq-page"><header class="page-head"><div><p class="eyebrow"><a class="link" href="#/practice">Practice</a></p><h1>Voice quiz</h1></div></header>
      <section class="card vq-card" id="vq-live"></section>
      <div class="row gap mt"><button class="btn danger full" data-act="vqStop">Stop</button></div></div>`;
  }
  const topics = (await DB.live('topics')).filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 40);
  return `<div class="page"><header class="page-head"><div><p class="eyebrow"><a class="link" href="#/practice">Practice</a></p><h1>Voice quiz</h1></div></header>
    <section class="card">
      <div class="row between mid"><p class="muted">Questions read aloud; answer by saying A, B, C or D. Say “repeat”, “skip” or “stop” any time.</p>
        <button class="btn ghost sm" data-act="voiceMode">${Voice.natural() ? 'Natural voice' : 'Phone voice'}</button></div>
      <button class="btn primary full lg mt" data-act="vqSay">Say what to quiz you on</button>
      <p class="muted small center mt" id="vq-hint">e.g. “Quiz me on nephrotic syndrome” · “my mistakes” · “cardiology”</p>
    </section>
    <section class="card mt"><div class="card-head"><h3>Or pick</h3></div>
      <div class="menu">
        <button class="btn full" data-act="vqGo" data-source="due">Due for revision</button>
        <button class="btn full" data-act="vqGo" data-source="mistakes">My mistakes</button>
        ${topics.map(t => `<button class="btn full ghost" data-act="vqGo" data-topic="${esc(t.id)}">${esc(t.name)}</button>`).join('')}
      </div>
      <label class="mt">Questions per round<select id="vq-count"><option>10</option><option selected>15</option><option>25</option><option>40</option></select></label>
    </section></div>`;
};

Object.assign(A, {
  // Natural (Gemini) sounds human but takes a moment to arrive; the phone's own voice is instant.
  voiceMode(el) {
    const nat = !Voice.natural();
    localStorage.setItem('voiceNatural', nat ? '1' : '0');
    Voice._gemOff = false;
    el.textContent = nat ? 'Natural voice' : 'Phone voice';
    toast(nat ? 'Natural voice — sounds human, a second or two to start.' : 'Phone voice — starts instantly. Needs the latest Android app; on the laptop it uses the browser voice.', 6000);
  },
  async vqSay(el) {
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; el.disabled = true;
    const orig = el.innerHTML; el.innerHTML = '<span class="spin"></span>Listening…';
    try {
      const said = await Voice.listen({ prompt: 'Quiz me on nephrotic syndrome. My mistakes. Cardiology.' });
      const hint = document.getElementById('vq-hint');
      if (!said) { if (hint) hint.textContent = 'Nothing heard — try again.'; return; }
      const sel = await VoiceQuiz.find(said);
      if (!sel) { if (hint) hint.textContent = `Heard “${said}” but could not match a topic.`; return; }
      await VoiceQuiz.start({ ...sel, count: $('#vq-count')?.value });
    } catch (e) { toast(e.message || String(e), 8000); }
    finally { el.innerHTML = orig; el.disabled = false; delete el.dataset.busy; }
  },
  async vqGo(el) {
    const count = $('#vq-count')?.value;
    if (el.dataset.topic) { const t = await DB.get('topics', el.dataset.topic); return VoiceQuiz.start({ topicIds: [el.dataset.topic], title: t?.name, count }); }
    VoiceQuiz.start({ source: el.dataset.source, title: el.textContent.trim(), count });
  },
  vqStop() { VoiceQuiz.stopRun(); location.hash = '#/voice'; }
});

ROUTES.push([/^#\/voice(?:\/(\w+))?$/, m => Views.voice(m[1])]);

// Leaving the page ends the round, so it never keeps talking in the background.
window.addEventListener('hashchange', () => { if (VoiceQuiz.run && !VoiceQuiz.run.stopped && !location.hash.startsWith('#/voice/run')) VoiceQuiz.stopRun(); });
