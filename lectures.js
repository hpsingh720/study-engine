// College lectures: record in class, transcribe while it runs, turn it into questions afterwards.
//
// Recording happens in the Android shell's foreground service (screen can be off, app can be
// backgrounded). In a plain browser it falls back to MediaRecorder, which only survives while the
// tab is open — fine for testing on a laptop, not for a real lecture.
//
// Audio arrives in ~2 minute chunks so transcription runs alongside the lecture rather than as a
// 60-minute wait at the end. Each chunk is transcribed, appended to the lecture record, and the
// audio is deleted straight away — a term of lectures would otherwise fill the phone.

const Lectures = {
  CHUNK_SECONDS: 120,
  WHISPER_MODEL: 'whisper-large-v3-turbo',

  native() { return window.Capacitor?.Plugins?.LectureRecorder || null; },

  // ---------- storage ----------

  async all() { return (await DB.live('lectures')).sort((a, b) => b.started - a.started); },
  async get(id) { return DB.get('lectures', id); },
  async save(l) { return DB.put('lectures', l); },

  async current() {
    const id = await DB.meta('activeLecture');
    return id ? this.get(id) : null;
  },

  // ---------- recording ----------

  async start({ topic = '', faculty = '', subject = '' } = {}) {
    if (await this.current()) throw new Error('A lecture is already recording.');
    if (!this.groqKey()) throw new Error('Add your Groq key in Settings first — that is what turns speech into text.');

    const l = {
      id: 'lec-' + uid(),
      topic: topic.trim() || 'Untitled lecture',
      faculty, subject,
      started: Date.now(), ended: null,
      chunks: 0, transcript: '', seconds: 0, unclearSeconds: 0,
      state: 'recording', error: '',
      topicId: '', mcqIds: [], generated: 0
    };
    await this.save(l);
    await DB.meta('activeLecture', l.id);

    const n = this.native();
    if (n) {
      await n.start({ chunkSeconds: this.CHUNK_SECONDS, label: l.topic });
    } else {
      await this._browserStart(l.id);
    }
    return l;
  },

  async stop() {
    const l = await this.current();
    if (!l) return null;
    const n = this.native();
    if (n) await n.stop();
    else await this._browserStop();
    return l;
  },

  // ---------- chunk handling ----------

  /** Called for every finished chunk, from either the native service or the browser fallback. */
  async onChunk({ path, blob, last }) {
    const l = await this.current();
    if (!l) return;

    try {
      if (path) {
        const n = this.native();
        const { data, mime } = await n.readChunk({ path });
        blob = this._b64ToBlob(data, mime);
      }
      if (blob && blob.size > 1024) {
        const { text, dropped } = await this.transcribe(blob, l);
        const fresh = await this.get(l.id); // re-read: chunks arrive while other things write
        if (text) fresh.transcript = (fresh.transcript + ' ' + text).trim();
        fresh.chunks++;
        fresh.seconds += this.CHUNK_SECONDS;
        fresh.unclearSeconds = (fresh.unclearSeconds || 0) + (dropped || 0);
        await this.save(fresh);
        this._paint();
      }
    } catch (e) {
      console.warn('chunk failed', e);
      const fresh = await this.get(l.id);
      // One bad chunk must not kill the lecture — note it and keep going.
      fresh.error = e.message || String(e);
      await this.save(fresh);
      this._paint();
    } finally {
      if (path) { try { await this.native().deleteChunk({ path }); } catch (e) {} }
    }

    if (last) await this.finish(l.id);
  },

  /** Groq's Whisper endpoint. Free tier: 7,200 audio-seconds an hour, so a live lecture fits easily. */
  async transcribe(blob, lecture) {
    const p = Providers.get('groq');
    if (!p?.key) throw new Error('No Groq key');

    const fd = new FormData();
    fd.append('file', blob, 'chunk' + (blob.type.includes('ogg') ? '.ogg' : '.m4a'));
    fd.append('model', this.WHISPER_MODEL);
    // verbose_json gives a confidence score per segment. That matters more than it sounds: on
    // Hindi/Punjabi stretches Whisper does not fail, it invents fluent English ("I also have a
    // question about my YouTube channel" in the middle of an ophthalmology lecture). The scores
    // separate the two cleanly — real speech scores around -0.2 to -0.7, invented around -1.0.
    fd.append('response_format', 'verbose_json');
    fd.append('temperature', '0');
    // Medical vocabulary and the tail of the previous chunk both steer the model: Whisper leans on
    // this prompt for spellings it would otherwise guess ("DKA", "Addison", Punjabi-English mixing).
    const tail = (lecture.transcript || '').slice(-350);
    fd.append('prompt', `Medical lecture for MBBS students in India, mixing English with Hindi and Punjabi. Spell anatomical and drug names correctly: aqueous humour, ciliary body, pars plicata, trabecular meshwork, ultrafiltration, anterior chamber, trachoma, xerophthalmia. ${tail}`.slice(0, 850));

    const lang = localStorage.getItem('lectureLang') || '';
    if (lang) fd.append('language', lang);

    const res = await Providers.send(p, '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + p.key },
      body: fd
    });

    if (res.status === 429) {
      const wait = +(res.headers.get('retry-after') || 30);
      await sleep(Math.min(wait, 120) * 1000);
      return this.transcribe(blob, lecture);
    }
    if (!res.ok) throw new Error('Transcription failed (' + res.status + '): ' + (await res.text()).slice(0, 200));
    const d = await res.json();
    return this.cleanSegments(d);
  },

  /**
   * Keep only what was really said.
   *
   * Three things get dropped: low-confidence segments (invented English over Hindi/Punjabi),
   * segments Whisper itself thinks are silence, and repetition loops ("absorb them absorb them"),
   * which are a known failure mode on unclear audio.
   *
   * Returns { text, dropped } so the lecture can report how much was unusable rather than
   * quietly pretending the transcript is complete.
   */
  cleanSegments(d) {
    const segs = d.segments;
    if (!Array.isArray(segs) || !segs.length) return { text: (d.text || '').trim(), dropped: 0 };

    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const kept = [];
    let dropped = 0, repeats = 0, lastText = '';

    for (const s of segs) {
      const secs = Math.max(0, (s.end || 0) - (s.start || 0));
      const t = (s.text || '').trim();

      // -0.8 sits in the gap seen on real lectures: genuine speech lands around -0.2 to -0.7,
      // hallucinated runs around -1.0 and worse.
      const unsure = typeof s.avg_logprob === 'number' && s.avg_logprob < -0.8;
      const silent = typeof s.no_speech_prob === 'number' && s.no_speech_prob > 0.6;

      const same = norm(t) && norm(t) === lastText;
      repeats = same ? repeats + 1 : 0;
      lastText = norm(t);

      if (!t || unsure || silent || repeats >= 2) { dropped += secs; continue; }
      kept.push(t);
    }

    return { text: kept.join(' ').replace(/\s+/g, ' ').trim(), dropped: Math.round(dropped) };
  },

  // ---------- after the lecture ----------

  async finish(id) {
    const l = await this.get(id);
    if (!l || l.state === 'done') return;
    l.ended = Date.now();
    l.state = 'transcribed';
    await this.save(l);
    await DB.meta('activeLecture', null);
    this._paint();

    if ((l.transcript || '').length < 400) {
      l.state = 'thin';
      l.error = 'Too little speech was captured to make questions from.';
      await this.save(l);
      this._paint();
      return;
    }
    await Queue.add('lectureMcqs', { lectureId: l.id }, 0.5);
  },

  /**
   * Turn a transcript into questions.
   *
   * Fed three things on purpose: the transcript, the existing topic sheet, and the questions already
   * in the bank. Without the last two the model happily rewrites questions you already have.
   */
  async generate(id) {
    const l = await this.get(id);
    if (!l) return;
    l.state = 'writing'; await this.save(l); this._paint();

    const topic = l.topicId ? await DB.get('topics', l.topicId) : await matchTopic(l.topic + ' ' + l.transcript.slice(0, 2000));
    if (topic && !l.topicId) { l.topicId = topic.id; await this.save(l); }

    const sheet = topic ? await DB.get('sheets', topic.id) : null;
    const existing = topic
      ? (await DB.byIndex('mcqs', 'topicId', topic.id)).filter(m => !m.deleted).slice(-60).map(m => '- ' + m.stem.slice(0, 120)).join('\n')
      : '';

    const prompt = `A lecturer has just taught this class. Below is an automatic transcript of what was actually said. It contains speech-recognition errors, Hindi/Punjabi words, repetition and digressions — read through them.

LECTURE TOPIC: ${l.topic}${l.faculty ? ' (taught by ' + l.faculty + ')' : ''}

TRANSCRIPT:
${l.transcript.slice(0, 60000)}

${sheet ? `THE STUDENT'S EXISTING REVISION SHEET on this topic:\n${JSON.stringify({ management: sheet.sections?.management, comparison: sheet.comparison }).slice(0, 10000)}\n` : ''}
QUESTIONS ALREADY IN THE STUDENT'S BANK on this topic — do NOT write anything that tests the same point:
${existing || '(none yet)'}

Write questions that only this lecture makes possible. Specifically:
- Points the lecturer stressed, repeated, or called exam-important.
- Where the lecturer gave a local (Indian) figure, protocol or practice that differs from the textbook.
- Cases, numbers or rules of thumb the lecturer gave that are not in the sheet above.
- Anything the lecturer explicitly corrected or warned against.
Skip anything the transcript covers only in passing, and skip anything already in the bank list.

Write 6–12 MBBS-style questions (EXACTLY 4 options each). Fewer, sharper questions are better than filling a quota — if the lecture only supports 4 good questions, write 4.

QUALITY RULES
- Clinical reasoning, not recall of a sentence: diagnosis, next step, investigation of choice, first-line treatment, complication, contraindication.
- Every wrong option must be something a real student could pick.
- No "all of the above" / "none of the above". One defensible answer. Spread the correct letter around.
- "explanation": first line "Answer: <option text>", then 1–3 lines why, then one short line per wrong option.
- "master": one line — the exact fact needed to never miss this.
- "fromLecture": one short quote or paraphrase of what the lecturer said that this question came from.

Return JSON: {"mcqs":[{"stem":"","options":["","","",""],"answer":0,"explanation":"","difficulty":"medium","master":"","fromLecture":""}]}`;

    let out;
    try {
      out = await AI.call({ prompt, system: typeof SYSTEM_TUTOR !== 'undefined' ? SYSTEM_TUTOR : undefined, temperature: 0.5, maxTokens: 12000 });
    } catch (e) {
      l.state = 'transcribed'; l.error = e.message || String(e); await this.save(l); this._paint();
      throw e;
    }

    let list = (out.mcqs || [])
      .map(m => cleanMcq({ ...m, type: 'MBBS' }, topic, { src: 'lecture: ' + l.topic, system: topic?.system || '' }))
      .filter(Boolean);

    list.forEach((q, i) => {
      q.lectureId = l.id;
      q.keyedBy = 'lecture';
      const src = out.mcqs[i];
      if (src?.fromLecture) q.fromLecture = asText(src.fromLecture);
    });

    const { kept, duplicates } = await this.dedupe(list, topic);

    if (kept.length) await DB.putMany('mcqs', kept);

    // A duplicate still means the lecturer covered it — surface the question you already own
    // rather than silently dropping the overlap.
    for (const m of duplicates) {
      const seen = Array.isArray(m.lectures) ? m.lectures : [];
      if (!seen.includes(l.id)) { m.lectures = [...seen, l.id]; await DB.put('mcqs', m); }
    }

    const fresh = await this.get(l.id);
    fresh.mcqIds = kept.map(q => q.id);
    fresh.reinforced = duplicates.map(m => m.id);
    fresh.generated = kept.length;
    fresh.state = 'done';
    fresh.error = '';
    await this.save(fresh);
    this._paint();
    return fresh;
  },

  /**
   * Drop questions that repeat ones already in the bank.
   *
   * Compared by meaning, using the offline model already shipped for book search — wording-based
   * matching misses "most appropriate next step" vs "what would you do first" entirely.
   * Falls back to word overlap if the model cannot load (no network on first run).
   */
  async dedupe(list, topic) {
    if (!list.length) return { kept: [], duplicates: [] };

    const pool = topic
      ? (await DB.byIndex('mcqs', 'topicId', topic.id)).filter(m => !m.deleted && !m.flagged)
      : [];
    if (!pool.length) return { kept: list, duplicates: [] };

    const text = m => (m.stem + ' ' + (m.options || []).join(' ')).replace(/\s+/g, ' ').slice(0, 500);

    let vecsNew, vecsOld;
    try {
      vecsNew = await Semantic.embed(list.map(text));
      vecsOld = await Semantic.embed(pool.map(text));
    } catch (e) {
      return this._dedupeWords(list, pool);
    }

    const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
    const kept = [], duplicates = [];

    for (let i = 0; i < list.length; i++) {
      let best = 0, bestM = null;
      for (let j = 0; j < pool.length; j++) {
        const s = dot(vecsNew[i], vecsOld[j]);
        if (s > best) { best = s; bestM = pool[j]; }
      }
      // 0.90 on normalised MiniLM vectors is "same question, different words"; below that the
      // questions genuinely test different things even when they share a topic.
      if (best >= 0.90 && bestM) duplicates.push(bestM);
      else kept.push(list[i]);
    }
    return { kept, duplicates };
  },

  _dedupeWords(list, pool) {
    const words = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
    const jac = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, a.size + b.size - n); };
    const kept = [], duplicates = [];
    const poolW = pool.map(m => [m, words(m.stem)]);
    for (const q of list) {
      const w = words(q.stem);
      const hit = poolW.find(([, pw]) => jac(w, pw) >= 0.6);
      if (hit) duplicates.push(hit[0]); else kept.push(q);
    }
    return { kept, duplicates };
  },

  async remove(id) {
    const l = await this.get(id);
    if (!l) return;
    for (const qid of l.mcqIds || []) {
      const m = await DB.get('mcqs', qid);
      if (m) { m.deleted = 1; await DB.put('mcqs', m); }
    }
    l.deleted = 1;
    await this.save(l);
    if (await DB.meta('activeLecture') === id) await DB.meta('activeLecture', null);
  },

  // ---------- browser fallback (laptop testing only) ----------

  async _browserStart(lectureId) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true }
    });
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined);
    this._rec = rec; this._stream = stream;

    rec.ondataavailable = e => { if (e.data && e.data.size > 1024) this.onChunk({ blob: e.data, last: false }); };
    rec.onstop = () => {
      try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      this.finish(lectureId);
    };
    rec.start(this.CHUNK_SECONDS * 1000); // emit a blob every chunk
  },

  async _browserStop() {
    try { this._rec?.stop(); } catch (e) {}
    this._rec = null; this._stream = null;
  },

  // ---------- plumbing ----------

  groqKey() { return Providers.get('groq')?.key || ''; },

  _b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: mime || 'audio/ogg' });
  },

  _paint() { if (location.hash.startsWith('#/lectures')) App.render(true); },

  /**
   * Adopt a recording the Quick Settings tile started.
   *
   * The tile can start the microphone with no page loaded, so on opening the app there may be a
   * live recording with no lecture record behind it. Without this the app would show an idle
   * Start button while the service was already running, and the audio would go nowhere.
   */
  async adoptNative() {
    const n = this.native();
    if (!n?.getState) return;
    let st;
    try { st = await n.getState(); } catch (e) { return; }
    if (!st?.recording) return;
    if (await this.current()) return; // already ours

    const topic = (st.label || '').trim() || 'Lecture';
    const match = (await Timetable.todays()).find(c => c.topic === topic);

    const l = {
      id: 'lec-' + uid(),
      topic,
      faculty: match?.faculty || '', subject: match?.subject || '',
      started: st.startedAt || Date.now(), ended: null,
      chunks: 0, transcript: '', seconds: 0, unclearSeconds: 0,
      state: 'recording', error: '',
      topicId: '', mcqIds: [], generated: 0, fromTile: 1
    };
    await this.save(l);
    await DB.meta('activeLecture', l.id);
  },

  /** Wire up the native events once, at boot. Survives page reloads mid-lecture. */
  async init() {
    const n = this.native();
    if (!n) return;
    await this.adoptNative();
    n.addListener('chunk', d => this.onChunk({ path: d.path, last: d.last }));
    n.addListener('recorderError', async d => {
      const l = await this.current();
      if (l) { l.error = d.message; await this.save(l); this._paint(); }
    });
    // Anything that finished while the page was away (reload, app swiped off the recents list).
    try {
      const { chunks } = await n.drainPending();
      for (const c of chunks || []) await this.onChunk({ path: c.path, last: c.last });
    } catch (e) {}
  }
};
