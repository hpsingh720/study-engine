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
    // A lecture left open from earlier would otherwise swallow this one: every chunk of the new
    // class goes to whichever lecture is "current", so this morning's class ends up inside
    // yesterday's. Close it first unless the microphone is genuinely still running.
    const open = await this.current();
    if (open) {
      let live = false;
      try { live = !!(await this.native()?.getState())?.recording; } catch (e) {}
      if (live) throw new Error('A lecture is already recording.');
      await this.finish(open.id);
    }
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
  async onChunk({ path, blob, last, index, lecture }) {
    const l = lecture || await this.current();

    // No lecture to attach this to — the tile recorded with no page open. Park it on disk for the
    // recovery pass instead of discarding it; audio thrown away here is a lecture lost for good.
    if (!l) {
      if (path) await this._park({ path, index: index || 0, last: !!last });
      return;
    }

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

    let topic = l.topicId ? await DB.get('topics', l.topicId) : await matchTopic(l.topic + ' ' + l.transcript.slice(0, 2000));

    // Keyword matching cannot resolve what a lecturer actually writes on the roster — "TEF", "BOH",
    // "AGN". Without a topic the questions are saved with no home: they never show up in the
    // topic's practice or in a system test, so the lecture looks as though it produced nothing.
    if (!topic && typeof Focus !== 'undefined') {
      try {
        // Add subject/department to context so the classifier gets a strong hint about what system this is
        const contextHint = `Department/Subject: ${l.subject || 'not specified'}\nFaculty: ${l.faculty || 'not specified'}\n`;
        const { topic: made } = await Focus.study(`${l.topic}${l.subject ? ' (' + l.subject + ')' : ''}`, { amc: 0, mbbs: 0, context: contextHint + (l.transcript || '') });
        topic = made;
      } catch (e) { console.warn('could not place the lecture', e); }
    }
    if (topic && !l.topicId) { l.topicId = topic.id; await this.save(l); }

    const sheet = topic ? await DB.get('sheets', topic.id) : null;
    const existing = topic
      ? (await DB.byIndex('mcqs', 'topicId', topic.id)).filter(m => !m.deleted).slice(-60).map(m => '- ' + m.stem.slice(0, 120)).join('\n')
      : '';

    const prompt = `A lecturer has just taught this class. Below is an automatic transcript of what was actually said. It contains speech-recognition errors, Hindi/Punjabi words, repetition and digressions — read through them.

LECTURE TOPIC: ${l.topic}${l.faculty ? ' (taught by ' + l.faculty + ')' : ''}

TRANSCRIPT:
${l.transcript.slice(0, 60000)}

${l.slideText?.length ? `WHAT WAS WRITTEN ON THE SLIDES — lists, classifications and criteria the lecturer put up and read off rather than dictated, so the transcript does not contain them. Treat these as taught material and write questions from them too:\n${l.slideText.join('\n---\n').slice(0, 12000)}\n` : ''}

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

  // ---------- slides photographed during the class ----------

  /**
   * Keep a photo of what was on the screen.
   *
   * Half of what a lecturer shows is a diagram — a chest film, a pedigree, an embryology drawing —
   * and none of it reaches the transcript. A picture taken at the time is attached to the lecture
   * and becomes a question of its own afterwards.
   */
  async addSlide(id, file) {
    const l = await this.get(id);
    if (!l) throw new Error('That lecture is gone');
    const mediaId = 'img-' + uid();
    await DB.put('media', { id: mediaId, data: await compressImage(file, 1400, 0.82), kind: 'lecture' });
    (l.slides ||= []).push({ id: mediaId, at: Date.now() });
    await this.save(l);
    this._paint();
    return mediaId;
  },

  /**
   * The same, for a photo already taken in the app's own camera.
   *
   * Comes in as a JPEG data URL that has been framed and trimmed, so it is stored a little larger
   * than a straight file upload — a trimmed X-ray has already thrown away the room around it, and
   * what is left is all detail worth keeping.
   */
  async addSlideData(id, dataUrl) {
    const l = await this.get(id);
    if (!l) throw new Error('That lecture is gone');
    const mediaId = 'img-' + uid();
    await DB.put('media', { id: mediaId, data: await compressImage(dataUrl, 1600, 0.86), kind: 'lecture' });
    (l.slides ||= []).push({ id: mediaId, at: Date.now() });
    await this.save(l);
    this._paint();
    return mediaId;
  },

  async removeSlide(id, mediaId) {
    const l = await this.get(id);
    if (!l) return;
    l.slides = (l.slides || []).filter(s => s.id !== mediaId);
    await this.save(l);
    try { await DB.del('media', mediaId); } catch (e) {}
    this._paint();
  },

  /**
   * Turn the photographed slides into questions.
   *
   * Sent with the transcript around them, so a question can ask what the lecturer was explaining
   * while that diagram was on screen rather than describing the picture in the abstract.
   */
  async slideMcqs(id) {
    const l = await this.get(id);
    if (!l?.slides?.length) return 0;

    const topic = l.topicId ? await DB.get('topics', l.topicId) : null;
    const done = new Set((l.slideMcqIds || []).map(String));
    const todo = [];
    for (const s of l.slides) {
      if (s.used) continue;
      const m = await DB.get('media', s.id);
      if (m?.data) todo.push({ ...s, data: m.data });
    }
    if (!todo.length) return 0;

    const made = [];
    for (const s of todo) {
      let out;
      try {
        out = await AI.call({
          images: [s.data],
          system: typeof SYSTEM_TUTOR !== 'undefined' ? SYSTEM_TUTOR : undefined,
          temperature: 0.4, maxTokens: 4000,
          prompt: `This is a photograph of a slide from a lecture on "${l.topic}" to Indian MBBS students.

Lecture transcript, for context on what was being taught around it:
${(l.transcript || '').slice(0, 6000) || '(no transcript)'}

Two jobs.

1. "text": copy out everything written on the slide, as written — headings, every bullet, every
   number, every item of a list. A slide that lists the complications of a condition is worth as
   much as any diagram, and the transcript will not contain that list because it was read off the
   screen rather than spoken. Return "" only if there is genuinely no text.

2. "mcqs": 1-4 MBBS-style questions from this slide.
   - If it shows something visual — a diagram, an X-ray or scan, a pedigree, a specimen, a graph —
     write questions that need the picture, built around what is visible ("the finding arrowed",
     "this pattern"), and set "needsImage": true on them.
   - If it is text — a list, a classification, criteria, doses, a table — write ordinary questions
     from what it says, and set "needsImage": false. Do not skip a text slide: its content is
     exactly what the lecturer wanted remembered.
   - Only a title slide, a photo of the room, or a slide with nothing examinable returns no
     questions. Say so with "mcqs": [].

EXACTLY 4 options each, one defensible answer, plausible distractors.
"explanation": first line "Answer: <option text>", then why, then one short line per wrong option.
"master": one line — the fact needed to never miss it.

Return JSON: {"text":"","mcqs":[{"stem":"","options":["","","",""],"answer":0,"explanation":"","difficulty":"medium","master":"","needsImage":false}]}`
        });
      } catch (e) { console.warn('slide failed', e); continue; }

      // A question that needs the picture carries it; one written off a list of complications is an
      // ordinary question and should not drag an image into practice with it.
      const list = (out?.mcqs || [])
        .map(m => {
          const visual = m.needsImage !== false;
          return cleanMcq({ ...m, type: visual ? 'IMG' : 'MBBS' }, topic, {
            type: visual ? 'IMG' : 'MBBS',
            img: visual ? s.id : null,
            src: 'lecture slide: ' + l.topic,
            system: topic?.system || ''
          });
        })
        .filter(Boolean);
      for (const q of list) { q.lectureId = l.id; q.keyedBy = 'lecture'; }
      if (list.length) { await DB.putMany('mcqs', list); made.push(...list); }

      const fresh = await this.get(l.id);
      const sl = (fresh.slides || []).find(x => x.id === s.id);
      if (sl) { sl.used = 1; sl.made = list.length; }

      // Keep what was written on the slide with the lecture: it is content the transcript never
      // had, because it was read off the screen rather than said aloud.
      const text = String(out?.text || '').trim();
      if (text) {
        if (sl) sl.text = text.slice(0, 4000);
        fresh.slideText = [...new Set([...(fresh.slideText || []), text.slice(0, 4000)])].slice(0, 40);
      }
      fresh.slideMcqIds = [...new Set([...(fresh.slideMcqIds || []), ...list.map(q => q.id)])];
      await this.save(fresh);
      this._paint();
      await sleep(800);
    }
    return made.length;
  },

  // ---------- notes for the practical exam ----------

  /**
   * Read every photograph once, and keep the reading.
   *
   * A practical class is forty X-rays in ninety minutes, and the transcript of it is useless on its
   * own: "and here you can see the classic appearance" means nothing in June. So each photograph is
   * read on its own — what it is, what is visible, how to recognise it in the five seconds a spotter
   * station allows, and what the examiner asks there — and that reading is stored on the slide.
   * Stored rather than recomputed, because this is the slow part and the class should survive a
   * dropped connection halfway through.
   */
  async readSlides(id, onProgress) {
    const l = await this.get(id);
    if (!l?.slides?.length) return 0;

    const todo = [];
    for (const [i, s] of l.slides.entries()) {
      if (s.read) continue;
      const m = await DB.get('media', s.id);
      if (m?.data) todo.push({ i, id: s.id, data: m.data });
    }
    if (!todo.length) return 0;

    let done = 0;
    for (const s of todo) {
      onProgress?.(done + 1, todo.length);
      let out;
      try {
        out = await AI.call({
          images: [s.data], json: true, temperature: 0.2,
          system: typeof SYSTEM_TUTOR !== 'undefined' ? SYSTEM_TUTOR : undefined,
          prompt: `A photograph taken by an Indian final-year MBBS student during a practical class on "${l.topic}"${l.subject ? ` (${l.subject})` : ''}.

Read it the way an examiner at the station would expect it read.

"kind": one of "imaging" (radiograph, CT, MRI, ultrasound, ECG), "instrument", "specimen",
  "clinical" (a patient, or a sign), "slide" (projected or written text), "chart", "other".

For imaging, instruments, specimens and clinical photographs:
  "label"     — what it is, in the examiner's words ("AP chest radiograph of an infant")
  "findings"  — what is actually visible, most important first. Only what you can see.
  "diagnosis" — the single most likely diagnosis, or "" if the picture does not support one
  "clues"     — how to recognise this in five seconds: the one or two things that give it away
  "viva"      — the 2 to 4 questions an Indian examiner asks at this station, each with a short answer
  "text"      — ""

For a slide of text, a table or a blackboard:
  "text" — copy out everything written, as written: headings, every bullet, every number, every
    dose. This is the part the transcript never has, because it was read off the screen.
  and leave "findings", "clues" and "viva" empty or very short.

Be straight about doubt. If the film could be either of two things, write that in "diagnosis"
("either X or Y, distinguished by …") instead of picking one. A wrong label learnt from this
becomes a wrong answer at the station, which is worse than an honest maybe.

If the photograph is blurred, is of the room, or has nothing examinable on it, return
"kind":"other" and "label":"not usable".

Return JSON: {"kind":"","label":"","findings":[""],"diagnosis":"","clues":[""],"viva":[{"q":"","a":""}],"text":""}`
        });
      } catch (e) { console.warn('read slide failed', e); continue; }
      if (!out) continue;

      const fresh = await this.get(id);
      const sl = (fresh.slides || []).find(x => x.id === s.id);
      if (sl) {
        sl.read = {
          kind: String(out.kind || 'other'),
          label: String(out.label || '').slice(0, 200),
          findings: (out.findings || []).map(String).slice(0, 10),
          diagnosis: String(out.diagnosis || '').slice(0, 300),
          clues: (out.clues || []).map(String).slice(0, 6),
          viva: (out.viva || []).filter(v => v?.q).map(v => ({ q: String(v.q), a: String(v.a || '') })).slice(0, 5)
        };
        const text = String(out.text || '').trim();
        if (text) {
          sl.text = text.slice(0, 4000);
          fresh.slideText = [...new Set([...(fresh.slideText || []), text.slice(0, 4000)])].slice(0, 60);
        }
      }
      await this.save(fresh);
      done++;
      await sleep(600);
    }
    return done;
  },

  /**
   * Compose the class into notes.
   *
   * Written from the readings rather than the pictures, so the whole class fits in one request
   * however many photographs there were. The pictures come back at display time, pinned next to
   * what was read off them.
   */
  async makeNotes(id, onProgress) {
    const l0 = await this.get(id);
    if (!l0) throw new Error('That lecture is gone');

    await this.readSlides(id, (n, t) => onProgress?.(`Reading photo ${n} of ${t}…`));

    const l = await this.get(id);
    const slides = l.slides || [];
    const readings = slides.map((s, i) => {
      const r = s.read;
      if (!r || r.label === 'not usable') return null;
      return `PHOTO ${i}  [${r.kind}]  ${r.label}
${r.findings?.length ? `  visible: ${r.findings.join('; ')}\n` : ''}${r.diagnosis ? `  diagnosis: ${r.diagnosis}\n` : ''}${r.clues?.length ? `  recognise by: ${r.clues.join('; ')}\n` : ''}${r.viva?.length ? `  asked here: ${r.viva.map(v => v.q + ' — ' + v.a).join(' | ')}\n` : ''}${s.text ? `  written on it: ${s.text.slice(0, 1200)}\n` : ''}`;
    }).filter(Boolean);

    if (!readings.length && !(l.transcript || '').trim()) {
      throw new Error('Nothing to make notes from yet — record the class or add some photos first.');
    }

    onProgress?.('Writing the notes…');

    const out = await AI.call({
      json: true, temperature: 0.35,
      system: typeof SYSTEM_TUTOR !== 'undefined' ? SYSTEM_TUTOR : undefined,
      prompt: `Make revision notes from one class, for the Indian final-year MBBS student who sat in it.

Class: "${l.topic}"${l.subject ? ` · ${l.subject}` : ''}${l.faculty ? ` · taught by ${l.faculty}` : ''}
Date: ${new Date(l.started || Date.now()).toDateString()}

These notes are what he reads the night before the practical exam, months later, when he remembers
nothing of the room. They have to stand in for having been there. Two rules follow from that:
everything taught goes in, and nothing that was not taught gets invented. Where the class was thin
on something it clearly assumed, you may add it, but keep such additions to what any examiner would
expect a final-year to know, and put them in their own section headed as background.

${l.transcript ? `WHAT WAS SAID (transcript, imperfect — the Hindi and Punjabi stretches are missing):
${l.transcript.slice(0, 30000)}
` : '(the class was not recorded — work from the photographs)\n'}
${readings.length ? `WHAT THE PHOTOGRAPHS SHOW — each was read one by one. The numbers are the photo's
position, and you must reuse them in "spotters" so each entry is shown beside its own picture:
${readings.join('\n').slice(0, 30000)}
` : ''}
Return JSON, and fill every part that the class supports:

{
  "title": "what this class was about, four words or so",
  "subtitle": "one line on what it covered",
  "approach": { "h": "e.g. Reading a paediatric chest film", "steps": ["the ordered drill to run at the station, as taught"] },
  "sections": [{
    "h": "heading",
    "colour": "blue | green | amber | rose | violet",
    "points": ["the actual content — full enough to learn from, not headings pretending to be notes"],
    "mnemonic": "only if the lecturer gave one, or one is genuinely standard. Otherwise \\"\\".",
    "table": { "head": ["col", "col"], "rows": [["", ""]] }
  }],
  "spotters": [{
    "i": 0,
    "label": "what the examiner calls it",
    "diagnosis": "",
    "clues": ["what gives it away at a glance"],
    "viva": [{ "q": "", "a": "" }]
  }],
  "viva": [{ "q": "questions on the class as a whole", "a": "" }],
  "traps": ["the mistakes that lose marks here — wrong answers students actually give"],
  "mustKnow": ["the handful of lines that must be known cold"]
}

On the parts:
- "sections": as many as the class needs. Use a table where the content is a comparison or a set of
  values; use points otherwise. Give consecutive sections different colours.
- "spotters": one per usable photograph, in photo order, carrying its "i" through unchanged. This is
  the part he revises from, so the clues must be the ones that actually separate this film from the
  film it gets confused with.
- "traps": only real ones, from how the lecturer corrected the class or from what is commonly
  confused. An empty list is better than a made-up one.
- Leave "table" out of a section that does not need one. Leave any list empty rather than padding it.
- Indian practice and Indian names throughout, since this is an Indian exam.`
    });

    if (!out?.title && !out?.sections?.length) throw new Error('The notes came back empty — try again in a minute.');

    const notes = {
      title: String(out.title || l.topic || 'Class notes').slice(0, 120),
      subtitle: String(out.subtitle || '').slice(0, 300),
      approach: out.approach?.steps?.length
        ? { h: String(out.approach.h || 'How to approach it'), steps: out.approach.steps.map(String).slice(0, 14) } : null,
      sections: (out.sections || []).filter(s => s?.h).map(s => ({
        h: String(s.h).slice(0, 160),
        colour: ['blue', 'green', 'amber', 'rose', 'violet'].includes(s.colour) ? s.colour : 'blue',
        points: (s.points || []).map(String).slice(0, 40),
        mnemonic: String(s.mnemonic || '').slice(0, 300),
        table: s.table?.rows?.length ? { head: (s.table.head || []).map(String), rows: s.table.rows.map(r => (r || []).map(String)) } : null
      })).slice(0, 30),
      spotters: (out.spotters || []).filter(s => s && Number.isInteger(+s.i)).map(s => ({
        i: +s.i,
        label: String(s.label || '').slice(0, 200),
        diagnosis: String(s.diagnosis || '').slice(0, 300),
        clues: (s.clues || []).map(String).slice(0, 8),
        viva: (s.viva || []).filter(v => v?.q).map(v => ({ q: String(v.q), a: String(v.a || '') })).slice(0, 6)
      })).slice(0, 60),
      viva: (out.viva || []).filter(v => v?.q).map(v => ({ q: String(v.q), a: String(v.a || '') })).slice(0, 25),
      traps: (out.traps || []).map(String).slice(0, 15),
      mustKnow: (out.mustKnow || []).map(String).slice(0, 15),
      made: Date.now()
    };

    const fresh = await this.get(id);
    fresh.notes = notes;
    await this.save(fresh);
    this._paint();
    return notes;
  },

  /**
   * The notes, on paper.
   *
   * Handwriting and colour are not decoration here: the point is that it reads like the notes he
   * would have made himself, which is the thing people actually revise from, rather than another
   * screen of grey prose. Photographs are pinned in beside their own reading.
   */
  notesHTML(notes, slideData = {}, lecture = null) {
    if (!notes) return '';
    const n = notes;
    const li = a => (a || []).map(x => `<li>${esc(x)}</li>`).join('');

    const table = t => !t?.rows?.length ? '' : `<table class="hn-table">
      ${t.head?.length ? `<thead><tr>${t.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : ''}
      <tbody>${t.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

    const spot = n.spotters.map((s, k) => {
      const img = slideData[s.i];
      return `<figure class="hn-spot" style="--tilt:${(k % 3 - 1) * 0.5}deg">
        ${img ? `<img src="${img}" alt="" data-act="zoomImg">` : '<div class="hn-nopic">photo gone</div>'}
        <figcaption>
          <b>${esc(s.label || 'Spotter ' + (k + 1))}</b>
          ${s.diagnosis ? `<p class="hn-dx">${esc(s.diagnosis)}</p>` : ''}
          ${s.clues?.length ? `<p class="hn-lab">gives it away</p><ul>${li(s.clues)}</ul>` : ''}
          ${s.viva?.length ? `<p class="hn-lab">asked here</p>${s.viva.map(v =>
            `<p class="hn-q">${esc(v.q)}</p><p class="hn-a">${esc(v.a)}</p>`).join('')}` : ''}
        </figcaption></figure>`;
    }).join('');

    return `<div class="hnotes">
      <header class="hn-top">
        ${lecture ? `<p class="hn-lec">${esc(lecture.topic || 'Untitled')}${lecture.faculty ? ' · ' + esc(lecture.faculty) : ''}${lecture.subject ? ' · ' + esc(lecture.subject) : ''}<br><small>${new Date(lecture.started || 0).toDateString()}</small></p>` : ''}
        <h2>${esc(n.title)}</h2>
        ${n.subtitle ? `<p>${esc(n.subtitle)}</p>` : ''}
      </header>

      ${n.approach ? `<section class="hn-card c-violet hn-drill">
        <h3>${esc(n.approach.h)}</h3>
        <ol>${li(n.approach.steps)}</ol></section>` : ''}

      ${n.mustKnow?.length ? `<section class="hn-must">
        <h3>Know these cold</h3>
        <ul>${n.mustKnow.map(x => `<li><mark>${esc(x)}</mark></li>`).join('')}</ul></section>` : ''}

      ${n.sections.map(s => `<section class="hn-card c-${s.colour}">
        <h3>${esc(s.h)}</h3>
        ${s.points?.length ? `<ul>${li(s.points)}</ul>` : ''}
        ${table(s.table)}
        ${s.mnemonic ? `<p class="hn-mn">${esc(s.mnemonic)}</p>` : ''}
      </section>`).join('')}

      ${spot ? `<h3 class="hn-h">The photos, one by one</h3><div class="hn-spots">${spot}</div>` : ''}

      ${n.traps?.length ? `<section class="hn-card c-rose">
        <h3>Where marks go</h3><ul>${li(n.traps)}</ul></section>` : ''}

      ${n.viva?.length ? `<section class="hn-viva"><h3>Viva</h3>
        ${n.viva.map(v => `<p class="hn-q">${esc(v.q)}</p><p class="hn-a">${esc(v.a)}</p>`).join('')}</section>` : ''}

      <p class="hn-foot">Made ${fmtDate(n.made)} from the class itself.</p>
    </div>`;
  },

  // ---------- recordings started with no page open ----------

  /**
   * The class that was being taught at a given moment.
   *
   * Recovery cannot ask the tile what it called the recording — once the service has stopped, the
   * label is gone. The roster plus the timestamp baked into the chunk filename give a better
   * answer anyway, and it is the same answer the tile would have given.
   */
  async classAt(ms) {
    try {
      const d = new Date(ms);
      const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      // The merged day view, so a class whose topic was never published still names the recording
      // after the group that teaches it.
      const day = await Timetable.dayView(Timetable.iso(d));
      const hit = day.find(c => c.start <= hhmm && c.end >= hhmm)
          || day.slice().sort((a, b) => b.start.localeCompare(a.start)).find(c => c.start <= hhmm);
      if (!hit) return null;
      return { ...hit, topic: hit.topic || hit.label || hit.group || hit.subject || '' };
    } catch (e) { return null; }
  },

  _clockLabel(ms) {
    const d = new Date(ms);
    const h = d.getHours(), h12 = h % 12 === 0 ? 12 : h % 12;
    return 'Lecture ' + h12 + (h >= 12 ? 'pm' : 'am') + ' · ' + d.toLocaleDateString();
  },

  /** The service names each chunk chunk_<millis>_<n>, so the file itself says when it was recorded. */
  _startedFrom(chunks) {
    for (const c of chunks) {
      const m = /chunk_(\d{10,})_(\d+)\./.exec(c.path || '');
      if (m) return +m[1];
    }
    return 0;
  },

  async _park(c) {
    const q = (await DB.meta('pendingChunks')) || [];
    if (q.some(x => x.path && x.path === c.path)) return;
    q.push(c);
    await DB.meta('pendingChunks', q);
  },

  async _forget(c) {
    const q = (await DB.meta('pendingChunks')) || [];
    await DB.meta('pendingChunks', q.filter(x => !(x.path === c.path && x.index === c.index)));
  },

  /**
   * Adopt a recording the Quick Settings tile started and is still running.
   *
   * The tile can start the microphone with no page loaded, so on opening the app there may be a
   * live recording with no lecture record behind it. Without this the app would show an idle
   * Start button while the service was already running, and the audio would go nowhere.
   */
  async adoptNative() {
    const n = this.native();
    if (!n?.getState) return null;
    let st;
    try { st = await n.getState(); } catch (e) { return null; }
    if (!st?.recording) return null;

    const started = st.startedAt || Date.now();

    const existing = await this.current();
    if (existing) {
      // The same recording we already know about — carry on with it.
      if (!started || Math.abs((existing.started || 0) - started) < 120000) return existing;
      // A different one: the tile started a new class while an older lecture was still open.
      // Close the old one so this morning's class does not land inside last night's.
      await this.finish(existing.id);
    }
    const cls = await this.classAt(started);
    const topic = (st.label || '').trim() || cls?.topic || this._clockLabel(started);

    const l = {
      id: 'lec-' + uid(),
      topic,
      faculty: cls?.faculty || '', subject: cls?.subject || '',
      started, ended: null,
      chunks: 0, transcript: '', seconds: 0, unclearSeconds: 0,
      state: 'recording', error: '',
      topicId: '', mcqIds: [], generated: 0, fromTile: 1
    };
    await this.save(l);
    await DB.meta('activeLecture', l.id);
    return l;
  },

  /**
   * Rebuild lectures that were recorded and finished with no page open.
   *
   * This is the ordinary way the tile gets used: tap to start, sit through the class, tap to stop,
   * open the app afterwards. By then the service has exited, so there is nothing to "adopt" — the
   * audio is sitting in the service's queue with no lecture behind it. Everything needed to
   * reconstruct it is in the chunks themselves: the numbering restarts at 1 for each recording, and
   * the filename carries the start time.
   */
  async recoverSessions(live) {
    const n = this.native();
    if (!n?.drainPending) return;

    // Persist before processing. drainPending empties the native queue, so a crash or a swipe-away
    // part way through would otherwise take the rest of the lecture with it.
    let drained = [];
    try { drained = (await n.drainPending())?.chunks || []; } catch (e) { drained = []; }
    for (const c of drained) if (c?.path) await this._park({ path: c.path, index: c.index || 0, last: !!c.last });

    const queue = (await DB.meta('pendingChunks')) || [];
    if (!queue.length) return;

    // Split the queue into recordings. The service numbers chunks from 1 each time it starts.
    const sessions = [];
    for (const c of queue) {
      if (!sessions.length || c.index === 1) sessions.push([]);
      sessions[sessions.length - 1].push(c);
    }

    for (const chunks of sessions) {
      let l = null;

      if (live) {
        l = live;                       // still recording: these chunks belong to it
      } else {
        const started = this._startedFrom(chunks) || Date.now();
        // Don't build a second lecture for a recording an earlier pass already recovered.
        l = (await this.all()).find(x => Math.abs(x.started - started) < 90000) || null;
        if (!l) {
          const cls = await this.classAt(started);
          l = {
            id: 'lec-' + uid(),
            topic: cls?.topic || this._clockLabel(started),
            faculty: cls?.faculty || '', subject: cls?.subject || '',
            started, ended: null,
            chunks: 0, transcript: '', seconds: 0, unclearSeconds: 0,
            state: 'recording', error: '',
            topicId: '', mcqIds: [], generated: 0, fromTile: 1
          };
          await this.save(l);
        }
        await DB.meta('activeLecture', l.id);
      }

      this._paint(); // show the lecture straight away; transcription takes a while

      let closed = false;
      for (const c of chunks) {
        await this.onChunk({ path: c.path, index: c.index, last: !!c.last && !live, lecture: l });
        if (c.last && !live) closed = true;
        await this._forget(c);
      }

      // The service never got to mark a final chunk — the app was killed, or the phone restarted.
      // Close it anyway rather than leave a lecture stuck on "recording" forever.
      if (!live && !closed) await this.finish(l.id);
    }
  },

  /** Wire up the native events once, at boot. Survives page reloads mid-lecture. */
  async init() {
    const n = this.native();
    if (!n) return;

    // Listeners first. A chunk can finish while the rest of this is still running, and until this
    // is wired up every one of them goes into the native backlog instead of into the lecture.
    try {
      n.addListener('chunk', d => this.onChunk({ path: d.path, index: d.index, last: d.last }));
      n.addListener('recorderError', async d => {
        const l = await this.current();
        if (l) { l.error = d.message; await this.save(l); this._paint(); }
      });
    } catch (e) { console.warn('could not listen for recorder events', e); }

    // Each step on its own: a failure in one must not stop the others.
    let live = null;
    try { live = await this.adoptNative(); } catch (e) { console.warn('could not adopt the running recording', e); }
    try { await this.recoverSessions(live); } catch (e) { console.warn('could not recover tile recordings', e); }
  }
};
