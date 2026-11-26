/* Study Engine — live doubt tutor.
 * Tap "Ask live" while reading and just talk: a teacher answers out loud within about a second,
 * lips moving with the voice. It knows the topic open on screen, remembers every doubt you asked
 * before (they are saved under the topic and sync to your other devices), can look things up in
 * your own books, and can look at a photo of the page or figure in front of you.
 * Runs on the same live line as the talking patient (live.js), with your Gemini key. */

const Tutor = {
  on: false,
  topic: null,
  session: [],          // this conversation: [{q, a}]
  _q: '',
  _restarting: false,

  persona() {
    return localStorage.getItem('tutorVoice') === 'f'
      ? { name: 'Dr. Simran Kaur', sex: 'F', age: 44, role: 'examiner', voice: 'Kore' }
      : { name: 'Dr. Gurpreet Singh', sex: 'M', age: 50, role: 'examiner', voice: 'Charon' };
  },

  // The topic on screen, else the one you opened last.
  async currentTopic() {
    const m = location.hash.match(/^#\/topic\/([^/]+)/);
    const id = m ? decodeURIComponent(m[1]) : localStorage.getItem('lastTopic');
    return id ? (await DB.get('topics', id)) || null : null;
  },

  // Every doubt asked before: this topic's in full, and the latest ones from other topics.
  async memory(topic) {
    const notes = (await DB.all('notes')).filter(n => n.doubts?.length && !n.deleted);
    const here = topic ? (notes.find(n => n.id === topic.id)?.doubts || []) : [];
    const names = {};
    for (const t of await DB.live('topics')) names[t.id] = t.name;
    const elsewhere = notes.filter(n => !topic || n.id !== topic.id)
      .flatMap(n => n.doubts.map(d => ({ ...d, topic: names[n.id] || (n.id === '_tutor' ? 'general' : '') })))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 25).reverse();
    const line = d => `- Q: ${String(d.q).slice(0, 220)}\n  A: ${String(d.a).replace(/\s+/g, ' ').slice(0, 260)}`;
    return {
      here: here.slice(-30).map(line).join('\n'),
      elsewhere: elsewhere.map(d => line({ ...d, q: (d.topic ? `[${d.topic}] ` : '') + d.q })).join('\n')
    };
  },

  async system(topic) {
    const p = this.persona();
    let ctx = '';
    if (topic) {
      const sheet = await DB.get('sheets', topic.id);
      const s = sheet ? JSON.stringify({ sections: sheet.sections }).replace(/\s+/g, ' ').slice(0, 5000) : '';
      ctx = `He is reading: "${topic.name}"${topic.chapter ? ` (chapter: ${topic.chapter})` : ''}, subject ${sysName(topic.system)}.${s ? `\nHis revision sheet for it (for context only — do not read it out): ${s}` : ''}`;
    } else ctx = 'No particular topic is open.';
    const mem = await this.memory(topic);
    const now = this.session.map(x => `- Q: ${x.q.slice(0, 220)}\n  A: ${x.a.replace(/\s+/g, ' ').slice(0, 260)}`).join('\n');
    return `You are ${p.name}, a senior clinical teacher, talking live by voice with Harpreet, an Indian final-year MBBS student who is also preparing for the Australian AMC Part 1 exam. He is reading and stops to ask you doubts. Every second counts for him.

How to answer:
- Give the answer in your first sentence. No greeting, no "good question", no repeating his question back.
- Usually two to five short spoken sentences. Go longer only when he says "explain", "why", "more" or "in detail".
- This is speech: no bullet lists, no headings, no reading out symbols. Say numbers and units clearly.
- Be correct. MBBS answers follow the standard textbooks (Harrison, Davidson, Bailey & Love, Ghai, Williams, Park). When Australian practice (eTG, RACGP, Murtagh, NCSP) truly differs and it matters for the AMC, say so in one sentence — never invent a difference. If you are not sure of an exact number, say you are not sure rather than guessing.
- He may speak English, Hindi or Punjabi, or mix them. Reply in the same mix he used, keeping medical terms in English.
- If he cuts in, stop and answer the new thing.
- Remember everything he has asked, in this talk and before (listed below). When a new doubt connects to an earlier one, link them in a few words. Never re-explain something he already understood unless he asks.
- If he shows you a photo of a page or a figure, explain what is in it.
- You have a tool, search_my_books. Use it only when he asks what his book says, or needs an exact figure, table or classification from his book. Otherwise answer straight away from your own knowledge — do not make him wait.

${ctx}
${mem.here ? `\nDoubts he asked before on this topic (oldest first):\n${mem.here}` : ''}
${mem.elsewhere ? `\nHis recent doubts on other topics:\n${mem.elsewhere}` : ''}
${now ? `\nEarlier in this same talk:\n${now}` : ''}`;
  },

  extra() {
    const tools = typeof searchBooks === 'function' ? [{ functionDeclarations: [{
      name: 'search_my_books',
      description: "Search the student's own textbooks (the pages in his library) and return the best matching passages with book and page.",
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'What to look for, in textbook words' } }, required: ['query'] }
    }] }] : undefined;
    return {
      // No 10–15 minute cap on the conversation; old turns are compressed instead of dropped.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: LiveTalk.handle ? { handle: LiveTalk.handle } : {},
      ...(tools ? { tools } : {})
    };
  },

  async onTool(name, args) {
    if (name !== 'search_my_books') return 'unknown tool';
    this._state('Looking in your books…');
    const hits = await searchBooks(String(args.query || ''), 4).catch(() => []);
    this._state();
    if (!hits.length) return 'Nothing found in his books on this device. Answer from standard knowledge and say it is not from his book.';
    return hits.map(h => `${h.book} p.${h.p}: ${String(h.passage).replace(/\s+/g, ' ').slice(0, 700)}`).join('\n\n');
  },

  async start() {
    if (this.on) return;
    if (LiveTalk.on) return toast('The patient talk is still live — end it first.', 6000);
    if (!AI.key) return toast('The live tutor needs your Gemini key — add it in Settings.', 8000);
    this.on = true;
    this.session = []; this._q = '';
    LiveTalk.handle = null;
    this.topic = await this.currentTopic();
    this._panel();
    await this._connect();
  },

  async _connect() {
    this._state('Connecting…');
    const p = this.persona();
    try {
      await LiveTalk.start({
        system: await this.system(this.topic), voice: p.voice, extra: this.extra(),
        onYou: (t, done) => this._you(t, done),
        onThem: (t, done) => this._them(t, done),
        onLevel: v => { const b = document.getElementById('tp-lvl'); if (b) b.style.width = Math.round(v * 100) + '%'; },
        onTool: (n, a) => this.onTool(n, a),
        onState: (s, why, info) => this._onState(s, why, info)
      });
      this._state();
      this._animate();
    } catch (e) {
      this.on = false;
      this._state(e.message || String(e), true);
      this._buttons(false);
    }
  },

  _onState(s, why, info) {
    if (this._restarting) return;
    if (s === 'ended' && info?.limit && this.on) { this._state('Reconnecting — it remembers the talk…'); return this._reconnect(); }
    if (s === 'error' && this.on) {
      // A dropped line: one quiet retry, with the conversation carried over.
      if (!this._retried) { this._retried = true; this._state('Line dropped — reconnecting…'); return this._reconnect(); }
      this.on = false; this._state(why || 'The line dropped.', true); this._buttons(false); return;
    }
    if (s === 'ended') { this.on = false; this._buttons(false); }
  },

  async _reconnect() {
    this._restarting = true;
    try { LiveTalk.stop(); } catch (e) {}
    this._restarting = false;
    this.on = true;
    await sleep(300);
    await this._connect();
    setTimeout(() => { this._retried = false; }, 60000);
  },

  // Moved to another topic while talking: start again with that topic in mind (and everything
  // asked so far). Waits until the teacher has finished the sentence.
  async topicChanged() {
    if (!this.on) return;
    const t = await this.currentTopic();
    if (!t || t.id === this.topic?.id) return;
    this.topic = t;
    const el = document.getElementById('tp-topic'); if (el) el.textContent = 'Reading: ' + t.name;
    const go = async () => {
      if (!this.on) return;
      if (LiveTalk._srcs?.size || this._them_) return setTimeout(go, 800);
      this._restarting = true;
      try { LiveTalk.stop(); } catch (e) {}
      this._restarting = false;
      LiveTalk.handle = null;   // a fresh start, so it is told about the new topic
      this.on = true;
      await this._connect();
    };
    go();
  },

  stop() {
    this.on = false;
    this._restarting = true;
    try { LiveTalk.stop(); } catch (e) {}
    this._restarting = false;
    cancelAnimationFrame(this._raf);
    document.getElementById('tutor-panel')?.remove();
    this._fab();
  },

  // ---- the conversation ----
  _you(t, done) {
    this._line('you', t, done);
    if (done) this._q = (this._q ? this._q + ' ' : '') + t;
  },
  async _them(t, done) {
    this._them_ = !done;
    this._line('them', t, done);
    if (!done) return;
    const q = this._q.trim() || '(photo or follow-up)';
    this._q = '';
    if (!t.trim()) return;
    this.session.push({ q, a: t });
    try {
      const id = this.topic?.id || '_tutor';
      const n = await getNote(id);
      (n.doubts ||= []).push({ q, a: t, ts: Date.now(), live: 1 });
      await DB.put('notes', n);
    } catch (e) { console.warn('could not save the doubt', e); }
  },
  _line(who, t, done) {
    const log = document.getElementById('tp-log'); if (!log) return;
    let cur = log.querySelector(`.tp-${who}.open`);
    if (!cur) { cur = Object.assign(document.createElement('div'), { className: `tp-${who} open` }); log.appendChild(cur); }
    cur.textContent = t;
    if (done) cur.classList.remove('open');
    while (log.children.length > 40) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  },

  // ---- the panel ----
  _panel() {
    document.getElementById('tutor-panel')?.remove();
    const p = this.persona();
    const face = patientFace(p, 'calm').replace('id="mouth"', 'id="tp-mouth"');
    const el = document.createElement('div');
    el.id = 'tutor-panel';
    el.className = 'tutor-panel' + (localStorage.getItem('tutorBig') === '1' ? ' big' : '');
    el.innerHTML = `<div class="tp-head"><div class="tp-face" id="tp-facebox">${face}</div>
      <div class="tp-who"><b>${esc(p.name)}</b><small id="tp-state">Connecting…</small><small class="muted" id="tp-topic">${this.topic ? 'Reading: ' + esc(this.topic.name) : 'Ask anything'}</small><small><a class="link" href="javascript:void 0" data-act="tutorWho">Change teacher</a></small></div>
      <button class="btn ghost sm" data-act="tutorSize" aria-label="Bigger or smaller">⤢</button><button class="btn ghost sm" data-act="tutorEnd" aria-label="End">✕</button></div>
      <div class="tp-lvl"><i id="tp-lvl"></i></div>
      <div class="tp-log" id="tp-log"><p class="muted small">Just talk. Ask your doubt the moment you have it — talk over the teacher to cut in.</p></div>
      <div class="tp-btns" id="tp-btns">
        <button class="btn sm" data-act="tutorMute" id="tp-mute">Mute</button>
        <button class="btn sm" data-act="tutorHush">Stop talking</button>
        <label class="btn sm">Show page<input type="file" accept="image/*" capture="environment" hidden data-change="tutorPhoto"></label>
        <button class="btn sm" data-act="tutorType">Type</button>
      </div>
      <form class="tp-type" id="tp-type" data-submit="tutorSend" hidden><input name="q" placeholder="Type a doubt" autocomplete="off"><button class="btn primary sm">Send</button></form>`;
    document.body.appendChild(el);
    this._fab();
  },
  _buttons(live) {
    const b = document.getElementById('tp-btns'); if (!b) return;
    b.innerHTML = live === false
      ? `<button class="btn primary sm" data-act="tutorAgain">Talk again</button><button class="btn ghost sm" data-act="tutorEnd">Close</button>`
      : b.innerHTML;
  },
  _state(msg, bad) {
    const s = document.getElementById('tp-state'); if (!s) return;
    s.textContent = msg || (LiveTalk.muted ? 'Muted — it cannot hear you' : 'Live — just talk');
    s.classList.toggle('warn-t', !!bad);
  },
  _animate() {
    cancelAnimationFrame(this._raf);
    let sm = 0;
    const loop = () => {
      const m = document.getElementById('tp-mouth');
      if (!m) return;
      const v = LiveTalk.outLevel();
      sm = sm * 0.45 + v * 0.55;                 // quick to open, a touch softer to close
      m.setAttribute('ry', (0.6 + sm * 10).toFixed(2));
      m.setAttribute('rx', (9 - sm * 2.5).toFixed(2));
      const box = document.getElementById('tp-facebox');
      if (box) box.style.transform = `translateY(${(-sm * 1.6).toFixed(2)}px) rotate(${(Math.sin(performance.now() / 900) * sm * 1.5).toFixed(2)}deg)`;
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  },

  // The floating button: everywhere except where the line is already busy with a patient or quiz.
  _fab() {
    let f = document.getElementById('tutor-fab');
    if (!f) {
      f = Object.assign(document.createElement('button'), { id: 'tutor-fab', className: 'tutor-fab', innerHTML: '<span>🎙</span> Ask live' });
      f.dataset.act = 'tutorStart';
      f.title = 'Talk to a teacher about what you are reading';
      document.body.appendChild(f);
    }
    f.hidden = this.on || !!document.getElementById('tutor-panel') || /^#\/(cases|voice|amc\/run|drills|session)/.test(location.hash);
  }
};
window.Tutor = Tutor;

Object.assign(A, {
  async tutorStart() { await Tutor.start(); },
  async tutorAgain() { Tutor._panel(); Tutor.on = true; Tutor.session = Tutor.session || []; await Tutor._connect(); },
  tutorEnd() { Tutor.stop(); },
  async tutorWho() {
    localStorage.setItem('tutorVoice', localStorage.getItem('tutorVoice') === 'f' ? 'm' : 'f');
    const live = Tutor.on;
    Tutor._restarting = true; try { LiveTalk.stop(); } catch (e) {} Tutor._restarting = false;
    Tutor._panel();
    if (live) { LiveTalk.handle = null; Tutor.on = true; await Tutor._connect(); } else Tutor._buttons(false);
  },
  tutorHush() { LiveTalk.hush(); },
  tutorMute(el) { const m = LiveTalk.mute(); el.textContent = m ? 'Unmute' : 'Mute'; Tutor._state(); },
  tutorType() { const f = document.getElementById('tp-type'); if (f) { f.hidden = !f.hidden; if (!f.hidden) f.q.focus(); } },
  tutorSize() { const p = document.getElementById('tutor-panel'); if (!p) return; p.classList.toggle('big'); localStorage.setItem('tutorBig', p.classList.contains('big') ? '1' : '0'); }
});
Object.assign(F, {
  tutorSend(form) {
    const q = form.q.value.trim(); if (!q) return;
    if (!LiveTalk.on) return toast('Not connected — tap Talk again.', 5000);
    form.q.value = '';
    Tutor._you(q, true);
    LiveTalk.sendText(q);
  }
});
Object.assign(C, {
  async tutorPhoto(el) {
    const f = el.files?.[0]; el.value = '';
    if (!f || !LiveTalk.on) return;
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const b64 = c.toDataURL('image/jpeg', 0.8).split(',')[1];
      LiveTalk.sendImage(b64);
      Tutor._line('you', '📷 (photo of the page)', true);
      Tutor._q = 'About the photo of the page: ';
      Tutor._state('Got the photo — now ask about it');
      setTimeout(() => Tutor._state(), 4000);
    } catch (e) { toast('Could not read that photo.', 5000); }
  }
});

window.addEventListener('hashchange', () => { Tutor._fab(); Tutor.topicChanged(); });
document.addEventListener('DOMContentLoaded', () => Tutor._fab());
if (document.readyState !== 'loading') setTimeout(() => Tutor._fab(), 0);
