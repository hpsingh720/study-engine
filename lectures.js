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
  // The full model, not turbo: turbo was distilled mostly on English and loses noticeably more of
  // Hindi and Punjabi, which is a large part of what a lecturer here actually says.
  WHISPER_MODEL: 'whisper-large-v3',

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

  async start({ topic = '', faculty = '', subject = '', auto = false } = {}) {
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
    if (!this.groqKey() && !AI.key) throw new Error('Add your Gemini or Groq key in Settings first — that is what turns speech into text.');

    const l = {
      id: 'lec-' + uid(),
      topic: topic.trim() || 'Untitled lecture',
      faculty, subject,
      started: Date.now(), ended: null,
      chunks: 0, transcript: '', seconds: 0, unclearSeconds: 0,
      state: 'recording', error: '',
      topicId: '', mcqIds: [], generated: 0,
      // The name was the roster's guess rather than something typed: check it again when the class
      // ends, against the middle of the recording rather than the moment Start was pressed.
      autoTopic: auto ? 1 : 0
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
    if (n) {
      // Recorder already gone (the class ended with the app closed): close the lecture now.
      let st = null; try { st = await n.getState(); } catch (e) {}
      if (st && !st.recording) { try { await this._chain; } catch (e) {} await this.finish(l.id); return l; }
      await n.stop();
    }
    else await this._browserStop();
    // Normally the recorder's final chunk closes the lecture. If that signal never comes, the
    // lecture would sit on "recording" for ever — so once everything already sent has been
    // transcribed, close it regardless.
    setTimeout(async () => {
      try {
        await this._chain;
        const x = await this.get(l.id);
        if (x && x.state === 'recording') await this.finish(l.id);
      } catch (e) {}
    }, 45000);
    return l;
  },

  // ---------- chunk handling ----------

  /** Called for every finished chunk, from either the native service or the browser fallback. */
  //
  // One chunk at a time, in the order they were recorded. Handled side by side, a short final chunk
  // could finish first and close the lecture while earlier ones were still being transcribed: the
  // questions were then written from part of the class, and the rest of the text arrived too late.
  onChunk(c) {
    const run = () => this._onChunk(c).catch(e => console.warn('chunk failed', e));
    this._chain = (this._chain || Promise.resolve()).then(run, run);
    return this._chain;
  },

  /**
   * The lecture a chunk was recorded in. The recorder names each file chunk_<start time>_<n>, so
   * the file says which recording it belongs to — the latest lecture started before it. Going by
   * "whichever lecture is open now" put the end of one class into the next whenever its last chunks
   * were still being processed when the next class was started.
   */
  async _ownerOf(path) {
    const m = /chunk_(\d{10,})_\d+\./.exec(path || '');
    if (!m) return null;
    const at = +m[1];
    // The file's time is when its recording began, so its lecture began then too. "The latest
    // lecture before it" is not enough: a recording started from the tile, with no lecture made for
    // it yet, was poured into the class before it — the 9–10 class vanished into the 8–9 one.
    const near = (await this.all()).filter(x => x.started && Math.abs(x.started - at) < 120000);
    near.sort((a, b) => Math.abs(a.started - at) - Math.abs(b.started - at));
    return near[0] || null;
  },

  async _onChunk({ path, blob, last, index, lecture }) {
    // The same piece can be offered twice (live event and the catch-up pass). Do it once.
    this._seen ||= new Set();
    if (path && this._seen.has(path)) return;
    const l = lecture || (path && await this._ownerOf(path)) || await this.current();

    // No lecture to attach this to — the tile recorded with no page open. Park it on disk for the
    // recovery pass instead of discarding it; audio thrown away here is a lecture lost for good.
    if (!l) {
      if (path) { await this._park({ path, index: index || 0, last: !!last }); this._recoverSoon(); }
      return 'parked';
    }

    let ok = false;
    const idx = index || ((await this.get(l.id))?.chunks || 0) + 1;
    try {
      if (path) {
        const n = this.native();
        const { data, mime } = await n.readChunk({ path });
        blob = this._b64ToBlob(data, mime);
      }
      if (blob && blob.size > 1024) {
        const { text, raw, dropped } = await this.transcribe(blob, l);
        const fresh = await this.get(l.id); // re-read: chunks arrive while other things write
        // Each part kept under its number, so a part transcribed late (after a failure) still lands
        // in its place in the class rather than at the end.
        fresh.parts ||= {};
        if (!Object.keys(fresh.parts).length && fresh.transcript) fresh.parts['0'] = fresh.transcript;
        if (text) fresh.parts[idx] = text;
        fresh.transcript = Object.keys(fresh.parts).map(Number).sort((a, b) => a - b).map(k => fresh.parts[k]).join(' ').trim();
        fresh.failedParts = (fresh.failedParts || []).filter(x => x !== idx);
        if (!fresh.failedParts.length) fresh.error = '';
        // Parts arriving after the questions were made: say so, and offer to make questions from them.
        if (fresh.state === 'done' && text) fresh.more = (fresh.more || 0) + 1;
        // Everything Whisper heard, unfiltered, kept alongside. If the filter ever turns out to be
        // too strict for a room, the class is still there to rebuild from.
        if (raw) fresh.rawTranscript = ((fresh.rawTranscript || '') + ' ' + raw).trim();
        fresh.chunks++;
        fresh.seconds += this.CHUNK_SECONDS;
        fresh.unclearSeconds = (fresh.unclearSeconds || 0) + (dropped || 0);
        // A class that had too little text before now has enough: make its questions.
        if (fresh.state === 'thin' && fresh.transcript.length >= 400) { fresh.state = 'transcribed'; fresh.error = ''; await this.save(fresh); await Queue.add('lectureMcqs', { lectureId: fresh.id }, 0.5); }
        else await this.save(fresh);
        this._paint();
      }
      ok = true;
    } catch (e) {
      console.warn('chunk failed', e);
      const fresh = await this.get(l.id);
      // One bad part must not lose the class: the recording stays on the phone and is tried again
      // later (Gemini busy, no internet, out of quota). It used to be deleted here — gone for good.
      fresh.failedParts = [...new Set([...(fresh.failedParts || []), idx])];
      fresh.error = `${fresh.failedParts.length} part${fresh.failedParts.length === 1 ? '' : 's'} not transcribed yet — will try again (${String(e.message || e).slice(0, 80)})`;
      await this.save(fresh);
      this._paint();
      if (path) { await this._park({ path, index: idx, last: false, tries: 1 }); this._retrySoon(); }
    } finally {
      // Deleted only once it has become text.
      if (path && ok) { this._seen.add(path); try { await this.native().deleteChunk({ path }); } catch (e) {} }
    }

    if (last && ['recording', undefined].includes((await this.get(l.id))?.state)) await this.finish(l.id);
    return ok ? 'ok' : 'failed';
  },

  // Failed parts are tried again in a few minutes, and whenever the app comes back to the front.
  _retrySoon() {
    if (this._rt) return;
    this._rt = setTimeout(() => { this._rt = null; this.catchUp().catch(console.warn); }, 5 * 60000);
  },

  /**
   * Speech to text. Gemini first: it listens to the Hindi and Punjabi stretches and writes them out
   * in English, where Whisper either guessed English that was never said or wrote Urdu letters.
   * Whisper (Groq) stays as the back-up, and for anyone who picks it in Settings.
   */
  async transcribe(blob, lecture) {
    const engine = localStorage.getItem('lectureEngine') || 'gemini';
    if (engine !== 'whisper' && AI.key) {
      try { return await this.transcribeGemini(blob, lecture); }
      catch (e) {
        console.warn('Gemini could not transcribe this part; using Whisper', e);
        if (!this.groqKey()) throw e;
      }
    }
    return this.transcribeWhisper(blob, lecture);
  },

  async transcribeGemini(blob, lecture) {
    const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
    // Android records Opus in an Ogg box; Gemini wants to be told it is Ogg audio.
    const mime = /ogg|opus/.test(blob.type) ? 'audio/ogg' : /mp4|m4a|aac/.test(blob.type) ? 'audio/aac' : (blob.type || 'audio/ogg').split(';')[0];
    const data = url.split(',')[1];
    const about = [lecture.topic, lecture.subject].filter(Boolean).join(', ');
    const tail = (lecture.transcript || '').slice(-400);
    const prompt = `This is about ${Math.round(this.CHUNK_SECONDS / 60)} minutes of a medical college lecture in India${about ? ` on ${about}` : ''}. The teacher speaks English mixed with Hindi and Punjabi.

Write down everything the teacher teaches, in English:
- English sentences as they were said.
- Hindi and Punjabi sentences translated into plain English, keeping the medical meaning exact.
- Medical terms, drug names, doses, eponyms, signs and abbreviations spelled correctly.
- Wherever the teacher stresses that something is important, will be asked, must be remembered or comes in the exam (in any language), put [IMPORTANT] in front of that sentence.
- Leave out chit-chat, attendance and noise. Do not add anything that was not said.
- If there is no teaching in it at all, reply with nothing.
${tail ? `
The transcript so far ended with: "${tail}"` : ''}

Reply with the transcript text only.`;
    const out = await AI.call({ prompt, images: [`data:${mime};base64,${data}`], json: false, temperature: 0.1 });
    let text = String(out || '').replace(/^```\w*\n?|```$/g, '').trim();
    if (/^(nothing|no teaching|\(no speech\)|\[no speech\]|empty)\.?$/i.test(text)) text = '';
    return { text, raw: text, dropped: 0, engine: 'gemini' };
  },

  /** Groq's Whisper endpoint. Free tier: 7,200 audio-seconds an hour, so a live lecture fits easily. */
  async transcribeWhisper(blob, lecture) {
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
    // The class's own topic and subject, not a fixed word list: the old list named eye structures
    // whatever was being taught, which pulled paediatrics and surgery towards ophthalmology words.
    const about = [lecture.topic, lecture.subject].filter(Boolean).join(', ');
    fd.append('prompt', `Medical college lecture in India${about ? ' on ' + about : ''}. The teacher mixes English with Hindi and Punjabi. Medical terms, drug names, eponyms, signs and abbreviations are spelled correctly, e.g. haemoglobin, ferritin, iron deficiency anaemia, pleural effusion, tetralogy of Fallot, TEF, VSD, ORS, IV fluids, mg/kg. ${tail}`.slice(0, 850));

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
      return this.transcribeWhisper(blob, lecture);
    }
    if (!res.ok) throw new Error('Transcription failed (' + res.status + '): ' + (await res.text()).slice(0, 200));
    const d = await res.json();
    return this.cleanSegments(d);
  },

  /**
   * Keep only what was really said — without throwing away a lecturer who is simply far away.
   *
   * The old filter dropped anything scoring below -0.8, on the belief that real speech sits between
   * -0.2 and -0.7. That holds for a phone at your mouth. A teacher across a hall, with echo, scores
   * -0.7 to -1.1 while being transcribed correctly, so most of every lecture was being discarded
   * and came back as "too little speech captured" with the microphone working fine.
   *
   * Now it follows Whisper's own rules. A segment is a failure only below -1.0; a repetition loop
   * (compression ratio over 2.4) is never real speech. It counts as silence only when Whisper thinks
   * so AND is unsure of the words — good confidence overrides the silence guess rather than the
   * other way round. The phrases Whisper invents on noise ("thanks for watching") always go. And if
   * all that would still remove most of a chunk, the chunk is kept whole: losing a real stretch of
   * the class costs more than a few odd words, which the question writer reads past anyway.
   *
   * Returns { text, raw, dropped } — raw is everything Whisper heard, kept for rebuilding.
   */
  cleanSegments(d) {
    const segs = d.segments;
    if (!Array.isArray(segs) || !segs.length) {
      const t = (d.text || '').trim();
      return { text: this._phantom(t) ? '' : t, raw: t, dropped: 0 };
    }

    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\u0900-\u0a7f ]/g, '').trim();
    const kept = [], all = [];
    let dropped = 0, total = 0, repeats = 0, lastText = '';

    for (const s of segs) {
      const secs = Math.max(0, (s.end || 0) - (s.start || 0));
      const t = (s.text || '').trim();
      if (!t) continue;
      total += secs;

      const same = norm(t) === lastText;
      repeats = same ? repeats + 1 : 0;
      lastText = norm(t);
      const loop = typeof s.compression_ratio === 'number' && s.compression_ratio > 2.4;
      if (repeats >= 2 || loop || this._phantom(t)) { dropped += secs; continue; }  // never real, kept nowhere
      all.push(t);

      const lp = typeof s.avg_logprob === 'number' ? s.avg_logprob : 0;
      const failed = lp < -1.0;
      const silent = typeof s.no_speech_prob === 'number' && s.no_speech_prob > 0.6 && lp < -1.0;
      if (failed || silent) { dropped += secs; continue; }
      kept.push(t);
    }

    const raw = all.join(' ').replace(/\s+/g, ' ').trim();
    if (total > 0 && dropped / total > 0.6) return { text: raw, raw, dropped: 0 };
    return { text: kept.join(' ').replace(/\s+/g, ' ').trim(), raw, dropped: Math.round(dropped) };
  },

  // What Whisper writes over noise or silence. None of it is ever said in a medical lecture.
  _phantom(t) {
    return /thank(s| you) (so much )?for watching|subscribe|like and share|my (youtube )?channel|see you (in the )?next (video|time)|^(thank you\.?|you\.?|bye\.?)$|amara\.org|subtitles by/i.test(String(t).trim());
  },

  // ---------- after the lecture ----------

  async finish(id) {
    const l = await this.get(id);
    if (!l || l.state === 'done') return;
    l.ended = Date.now();
    l.state = 'transcribed';
    // A name the roster guessed is checked against the middle of the recording. Started at 8:58
    // for the nine o'clock class, or left running into the next hour, the moment Start was pressed
    // names the wrong class; the middle of what was recorded does not.
    if (l.autoTopic && !l.topicId) {
      try {
        const mid = l.started + Math.max(0, (l.chunks || 0) * this.CHUNK_SECONDS * 1000) / 2;
        const cls = await this.classAt(mid);
        if (cls?.topic && cls.topic !== l.topic) {
          l.topic = cls.topic;
          l.faculty = cls.faculty || l.faculty;
          l.subject = cls.department || cls.subject || l.subject;
        }
      } catch (e) {}
    }
    await this.save(l);
    if ((await DB.meta('activeLecture')) === l.id) await DB.meta('activeLecture', null);
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
  /**
   * The moments a teacher says "this is important". Spoken in English, Hindi or Punjabi, in Latin or
   * native script — the transcript has all of them. Returns the surrounding stretch of each, merged
   * where they overlap, so the question writer can make several questions from each one.
   */
  emphasis(text) {
    const t = String(text || '');
    const cue = /\b(important|imp\b|exam|examination|mcqs?|viva|asked|ask(?:s|ing)? (?:this|it)|remember|note (?:this|it|down)|must know|high[- ]yield|favou?rite question|frequently|don'?t forget|never forget|very common question|zaroor[iy]?|jaroor[iy]?|yaad rakh\w*|dhyan rakh\w*|dhiyan\w*|puch(?:h)?(?:da|de|di|eya|te|ta|enge|nge)\w*|pooch\w*|aata hai|aunda|aaonda|paper vich|paper mein|exam vich|exam mein)\b|याद|ज़रूरी|जरूरी|महत्वपूर्ण|पूछ|परीक्षा|ਯਾਦ|ਜ਼ਰੂਰੀ|ਜਰੂਰੀ|ਪੁੱਛ|ਪੇਪਰ|ਇਮਤਿਹਾਨ/gi;
    const spans = [];
    let m;
    while ((m = cue.exec(t))) {
      const a = Math.max(0, m.index - 260), b = Math.min(t.length, m.index + 260);
      const last = spans[spans.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b); else spans.push([a, b]);
      if (spans.length >= 12) break;
    }
    return spans.map(([a, b]) => t.slice(a, b).replace(/\s+/g, ' ').trim());
  },

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

    // How many questions the class can carry: about one for every three minutes of usable speech.
    // An hour gives around twenty, before the extra ones for points the teacher flagged.
    const minutes = Math.max(1, Math.round((l.chunks || 0) * this.CHUNK_SECONDS / 60 - (l.unclearSeconds || 0) / 60));
    const flagged = this.emphasis(l.transcript);
    const base = Math.max(10, Math.min(30, Math.round(minutes / 2)));
    const target = Math.min(50, base + flagged.length * 3);

    const prompt = `A lecturer has just taught this class. Below is an automatic transcript of what was actually said. It contains speech-recognition errors, Hindi/Punjabi words, repetition and digressions — read through them.

LECTURE TOPIC: ${l.topic}${l.faculty ? ' (taught by ' + l.faculty + ')' : ''}

TRANSCRIPT:
${l.transcript.slice(0, 60000)}

${l.slideText?.length ? `WHAT WAS WRITTEN ON THE SLIDES — lists, classifications and criteria the lecturer put up and read off rather than dictated, so the transcript does not contain them. Treat these as taught material and write questions from them too:\n${l.slideText.join('\n---\n').slice(0, 12000)}\n` : ''}

${sheet ? `THE STUDENT'S EXISTING REVISION SHEET on this topic:\n${JSON.stringify({ management: sheet.sections?.management, comparison: sheet.comparison }).slice(0, 10000)}\n` : ''}
QUESTIONS ALREADY IN THE STUDENT'S BANK on this topic — do NOT write anything that tests the same point:
${existing || '(none yet)'}

${flagged.length ? `THE LECTURER FLAGGED THESE AS IMPORTANT (exam, MCQ, viva, "yaad rakhna", "zaroori" and the like). For EACH one, write 3–4 questions that test it from different angles — the fact itself, a clinical case that needs it, the commonest wrong belief about it:
${flagged.map((f, i) => `${i + 1}. …${f}…`).join('\n')}
` : ''}
Before writing, correct mis-heard medical words using the topic and the slides — the transcript is automatic, so "paldry hypolytic" is pulmonary hypoplasia and "TNV" may be TAPVC. Never quote a garbled word in a question.

Write questions that only this lecture makes possible. Specifically:
- Points the lecturer stressed, repeated, or called exam-important.
- Where the lecturer gave a local (Indian) figure, protocol or practice that differs from the textbook.
- Cases, numbers or rules of thumb the lecturer gave that are not in the sheet above.
- Anything the lecturer explicitly corrected or warned against.
Skip anything the transcript covers only in passing, and skip anything already in the bank list.

Write about ${target} MBBS-style questions (EXACTLY 4 options each)${flagged.length ? `, including 3–4 for every flagged point above` : ''}. Cover the whole class from start to end, not just the opening minutes. Go below ${target} only if the transcript genuinely has nothing more to test.

QUALITY RULES
- Clinical reasoning, not recall of a sentence: diagnosis, next step, investigation of choice, first-line treatment, complication, contraindication.
- Every wrong option must be something a real student could pick.
- GUIDELINES: the lecturer usually teaches Indian (or US) practice. Write such questions as Indian practice ("as per Indian guidelines", or no country at all). NEVER put "Australian", "AMC" or "RANZCOG" in a stem unless the answer follows the current Australian guideline — e.g. Australia screens with an HPV test every 5 years from 25 to 74, not a Pap smear every 3 years.
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

    // Every key checked before you see it (the lecture's own country's rule must not be sold as Australia's).
    try { await factCheck(kept); } catch (e) { console.warn('answer check later', e); }
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
    fresh.error = (fresh.failedParts || []).length ? fresh.error : '';
    fresh.more = 0;
    await this.save(fresh);
    this._paint();
    // Straight to the laptop and iPad — the phone may not be opened again for hours.
    try { if (Sync.on()) Sync.run(); } catch (e) {}
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
    await DB.put('media', { id: mediaId, data: await compressImage(dataUrl, 2200, 0.86), kind: 'lecture' });
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
    // Already made for this recording (by the catch-up pass): carry on with that one, never a second.
    const same = (await this.all()).find(x => x.started && Math.abs(x.started - started) < 120000);
    if (same) { if (same.state !== 'recording') { same.state = 'recording'; await this.save(same); } await DB.meta('activeLecture', same.id); return same; }
    const cls = await this.classAt(started);
    const topic = (st.label || '').trim() || cls?.topic || this._clockLabel(started);

    const l = {
      id: 'lec-' + uid(),
      topic,
      faculty: cls?.faculty || '', subject: cls?.subject || '',
      started, ended: null,
      chunks: 0, transcript: '', seconds: 0, unclearSeconds: 0,
      state: 'recording', error: '',
      topicId: '', mcqIds: [], generated: 0, fromTile: 1, autoTopic: 1
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
  async recoverSessions(liveNow) {
    const n = this.native();
    if (!n?.drainPending) return;

    // Persist before processing. drainPending empties the native queue, so a crash or a swipe-away
    // part way through would otherwise take the rest of the lecture with it.
    let drained = [];
    try { drained = (await n.drainPending())?.chunks || []; } catch (e) { drained = []; }
    for (const c of drained) if (c?.path) await this._park({ path: c.path, index: c.index || 0, last: !!c.last });

    // Every recorded piece still on the phone that the page never received — the list of finished
    // pieces lives in memory and is lost when Android closes the app; the files themselves are not.
    if (n.listChunks) {
      try {
        const files = (await n.listChunks())?.chunks || [];
        const st = await n.getState().catch(() => null);
        const liveStart = st?.recording ? st.startedAt : 0;
        const byStart = {};
        for (const f of files) {
          const m = /chunk_(\d{10,})_(\d+)\./.exec(f.path || '');
          if (!m || this._seen?.has(f.path) || this._inflight?.has(f.path)) continue;
          (byStart[m[1]] ||= []).push({ path: f.path, index: +m[2], size: f.size });
        }
        for (const [start, list] of Object.entries(byStart)) {
          const top = Math.max(...list.map(x => x.index));
          for (const c of list) {
            if (c.size < 1024) continue;
            await this._park({ path: c.path, index: c.index, last: c.index === top && Math.abs(+start - liveStart) > 120000 });
          }
        }
      } catch (e) { console.warn('could not list recordings on the phone', e); }
    }

    // A part that keeps failing waits a while before the next try.
    let tries = {}; try { tries = JSON.parse(localStorage.getItem('chunkTries') || '{}'); } catch (e) {}
    const now = Date.now();
    const queue = ((await DB.meta('pendingChunks')) || []).filter(c => !this._inflight?.has(c.path) && !(tries[c.path] && now - tries[c.path].at < Math.min(6, tries[c.path].n) * 10 * 60000));
    if (!queue.length) return;

    // Split the queue into recordings by the start time in each file's name (the same for every
    // piece of one recording), in order.
    const key = c => /chunk_(\d{10,})_/.exec(c.path || '')?.[1] || 'x';
    queue.sort((a, b) => key(a).localeCompare(key(b)) || (a.index || 0) - (b.index || 0));
    const sessions = [];
    for (const c of queue) {
      if (!sessions.length || key(sessions[sessions.length - 1][0]) !== key(c)) sessions.push([]);
      sessions[sessions.length - 1].push(c);
    }

    for (const chunks of sessions) {
      let l = null;
      // Only the pieces of the recording that is running now belong to it; older stray pieces get their own lecture.
      const began = this._startedFrom(chunks);
      const live = liveNow && (!began || Math.abs((liveNow.started || 0) - began) < 120000) ? liveNow : null;

      if (live) {
        l = live;                       // still recording: these chunks belong to it
      } else {
        const started = began || Date.now();
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
            topicId: '', mcqIds: [], generated: 0, fromTile: 1, autoTopic: 1
          };
          await this.save(l);
        }
        // Not made "the active lecture": a class being recorded right now must keep that place.
      }

      this._paint(); // show the lecture straight away; transcription takes a while

      let closed = false;
      for (const c of chunks) {
        const r = await this.onChunk({ path: c.path, index: c.index, last: !!c.last && !live, lecture: l });
        if (c.last && !live) closed = true;
        if (r === 'failed') { tries[c.path] = { n: (tries[c.path]?.n || 0) + 1, at: Date.now() }; try { localStorage.setItem('chunkTries', JSON.stringify(tries)); } catch (e) {} }
        else { await this._forget(c); delete tries[c.path]; }
      }
      try { localStorage.setItem('chunkTries', JSON.stringify(tries)); } catch (e) {}

      // The service never got to mark a final chunk — the app was killed, or the phone restarted.
      // Close it anyway rather than leave a lecture stuck on "recording" forever.
      if (!live && !closed && (await this.get(l.id))?.state === 'recording') await this.finish(l.id);
    }
  },

  // A chunk arrived with no lecture to go to: make the lecture for it now, while the app is open,
  // rather than leaving it on disk until the next time the app is started.
  _recoverSoon() {
    clearTimeout(this._rs);
    this._rs = setTimeout(() => this.catchUp().catch(console.warn), 2500);
  },
  async catchUp() {
    if (this._catching) return;
    this._catching = true;
    try {
      let live = null;
      try { live = await this.adoptNative(); } catch (e) { console.warn('could not adopt the running recording', e); }
      try { await this.recoverSessions(live); } catch (e) { console.warn('could not recover tile recordings', e); }
      this._paint();
    } finally { this._catching = false; }
  },

  /** Wire up the native events once, at boot. Survives page reloads mid-lecture. */
  async init() {
    const n = this.native();
    if (!n) return;
    // Parts still waiting to become text are tried again every 10 minutes and when the internet returns.
    setInterval(() => DB.meta('pendingChunks').then(q => { if (q?.length || n.listChunks) this.catchUp(); }).catch(() => {}), 10 * 60000);
    window.addEventListener('online', () => this.catchUp().catch(() => {}));

    // Listeners first. A chunk can finish while the rest of this is still running, and until this
    // is wired up every one of them goes into the native backlog instead of into the lecture.
    try {
      // Written down before it is worked on: if the app is closed half-way through a class, the
      // pieces not yet transcribed are picked up next time instead of being lost.
      n.addListener('chunk', async d => {
        const c = { path: d.path, index: d.index || 0, last: !!d.last };
        (this._inflight ||= new Set()).add(c.path);
        if (c.path) await this._park(c);
        const r = await this.onChunk(c);
        this._inflight.delete(c.path);
        if (c.path && r === 'ok') await this._forget(c);
      });
      // The tile started or stopped the recorder: make (or close) the lecture straight away.
      n.addListener('state', d => { if (d?.recording) this.catchUp().catch(console.warn); else this._paint(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.catchUp().catch(console.warn); });
      n.addListener('recorderError', async d => {
        const l = await this.current();
        if (l) { l.error = d.message; await this.save(l); this._paint(); }
      });
    } catch (e) { console.warn('could not listen for recorder events', e); }

    await this.catchUp();
  }
};
