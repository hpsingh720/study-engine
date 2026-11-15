// Speaking and listening, for the voice quiz and the clinical case simulator.
//
// Speaking: Gemini's own voices first — natural, with Hindi and Punjabi, and able to sound anxious
// or in pain, which matters when it is a patient talking. If that is not available, the phone's
// built-in voice (through the Android app), then the browser's. The Android app's web view has no
// speech of its own, which is why the phone voice goes through the app.
//
// Listening: the microphone is recorded in short turns and sent to Groq's Whisper, the same as the
// lectures. It works the same on the phone, the iPad and the laptop, and copes with Hinglish.
// A turn ends by itself when you stop talking.

const Voice = {
  _ctx: null, level: 0, speaking: false, listening: false, _cancel: false, _src: null,
  TTS_MODELS: ['gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview'],

  ctx() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
    return this._ctx;
  },
  native() { return typeof Lectures !== 'undefined' ? Lectures.native() : null; },
  natural() { return localStorage.getItem('voiceNatural') !== '0'; },

  /** Stop whatever is being said or heard. */
  stop() {
    this._cancel = true;
    try { this._src?.stop(); } catch (e) {}
    for (const x of this._srcs || []) { try { x.stop(); } catch (e) {} }
    this._srcs = []; this._metering = false;
    try { window.speechSynthesis?.cancel(); } catch (e) {}
    try { this.native()?.stopSpeaking?.(); } catch (e) {}
    this.speaking = false;
  },

  // Markdown, arrows and symbols read badly aloud.
  plain(t) {
    return String(t || '').replace(/\*\*|__|`|#+\s/g, '').replace(/→|->/g, ' leads to ').replace(/↑/g, ' raised ').replace(/↓/g, ' low ')
      .replace(/\[[^\]]*p\.\s*\d+\]/g, '').replace(/\s+/g, ' ').trim();
  },

  /**
   * Say something. Resolves when it has finished being said.
   * opts: lang ('en-IN', 'hi-IN', 'pa-IN'), voice (a Gemini voice name), style ("anxious, in pain").
   */
  async say(text, { lang = 'en-IN', voice = 'Kore', style = '' } = {}) {
    text = this.plain(text);
    if (!text) return;
    this._cancel = false;
    this.speaking = true;
    try {
      if (this.natural() && AI.key && !this._gemOff) {
        try { await this._gemini(text, voice, style); return; } catch (e) { if (this._cancel) return; console.warn('natural voice unavailable', e); }
      }
      const n = this.native();
      if (n?.speak) { try { await n.speak({ text, lang, rate: 1.0 }); return; } catch (e) { console.warn('phone voice failed', e); } }
      if (window.speechSynthesis) { await this._browser(text, lang); return; }
    } finally { this.speaking = false; this.level = 0; }
  },

  async _gemini(text, voice, style) {
    const tried = localStorage.getItem('tts_model');
    const models = tried ? [tried, ...this.TTS_MODELS.filter(m => m !== tried)] : this.TTS_MODELS;
    let last;
    for (const model of models) {
      const body = {
        contents: [{ role: 'user', parts: [{ text: `Speak at a normal conversational pace${style ? ', ' + style : ''}: ${text}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
      };
      const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
      const key = encodeURIComponent(AI.key);
      try {
        // Streamed: the first words play while the rest is still being made, instead of waiting
        // two seconds or more for the whole sentence.
        if (!this._noStream) {
          try {
            if (await this._stream(`${base}:streamGenerateContent?alt=sse&key=${key}`, body)) { localStorage.setItem('tts_model', model); return; }
            this._noStream = true;
          } catch (e) { if (this._cancel) return; this._noStream = true; }
        }
        const res = await AI.gfetch(`${base}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error?.message || 'voice ' + res.status);
        const part = (d.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
        const inl = part?.inlineData || part?.inline_data;
        if (!inl?.data) throw new Error('no audio in reply');
        localStorage.setItem('tts_model', model);
        if (this._cancel) return;
        const pcm = this._pcm(inl.data, inl.mimeType || inl.mime_type);
        await this._play([pcm]);
        return;
      } catch (e) { last = e; }
    }
    // Not on this key (or out of today's allowance): use the other voices for the rest of the session.
    this._gemOff = true;
    throw last || new Error('no natural voice');
  },

  /**
   * Audio bytes → samples at their true rate. Older voices send bare 16-bit PCM with the rate in
   * the type ("rate=24000"); newer ones send a WAV file with the rate written in its header. Reading
   * WAV as bare PCM at an assumed rate is what made the voice slow and deep.
   */
  _pcm(b64, mime = '') {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer);
    let rate = +(String(mime).match(/rate=(\d+)/) || [])[1] || 24000, off = 0, len = bytes.length, ch = 1;
    if (bytes.length > 44 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF') {
      ch = dv.getUint16(22, true) || 1;
      rate = dv.getUint32(24, true) || rate;
      let p = 12;
      while (p + 8 <= bytes.length) {
        const id = String.fromCharCode(...bytes.slice(p, p + 4)), size = dv.getUint32(p + 4, true);
        if (id === 'data') { off = p + 8; len = Math.min(size, bytes.length - off); break; }
        p += 8 + size + (size & 1);
      }
    }
    const n = Math.floor(len / 2 / ch), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(off + i * 2 * ch, true) / 32768;
    return { samples: out, rate };
  },

  async _stream(url, body) {
    const res = await AI.gfetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) throw new Error('no stream');
    const reader = res.body.getReader(), dec = new TextDecoder();
    const ctx = this.ctx(), an = ctx.createAnalyser();
    an.fftSize = 512; an.connect(ctx.destination);
    let buf = '', at = 0, got = 0, lastEnd = Promise.resolve();
    this._srcs = [];
    this._meter(an);
    for (;;) {
      let value, done;
      // Cut off part-way: keep what already played rather than saying the sentence twice.
      try { ({ value, done } = await reader.read()); } catch (e) { if (got) break; throw e; }
      if (done || this._cancel) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch (e) { continue; }
        for (const part of d.candidates?.[0]?.content?.parts || []) {
          const inl = part.inlineData || part.inline_data;
          if (!inl?.data) continue;
          const { samples, rate } = this._pcm(inl.data, inl.mimeType || inl.mime_type);
          if (!samples.length) continue;
          const b = ctx.createBuffer(1, samples.length, rate);
          b.getChannelData(0).set(samples);
          const src = ctx.createBufferSource();
          src.buffer = b; src.connect(an);
          at = Math.max(at, ctx.currentTime + 0.05);
          src.start(at); at += b.duration; got++;
          this._srcs.push(src);
          lastEnd = new Promise(r => { src.onended = r; });
        }
      }
    }
    if (!got) return false;
    await lastEnd;
    this._metering = false; this.level = 0;
    return true;
  },

  _meter(an) {
    const data = new Float32Array(an.fftSize);
    this._metering = true;
    const tick = () => { if (!this._metering) return; an.getFloatTimeDomainData(data); let s = 0; for (const x of data) s += x * x; this.level = Math.min(1, Math.sqrt(s / data.length) * 6); requestAnimationFrame(tick); };
    tick();
  },

  async _play(chunks) {
    const ctx = this.ctx(), an = ctx.createAnalyser();
    an.fftSize = 512; an.connect(ctx.destination);
    this._meter(an);
    for (const { samples, rate } of chunks) {
      if (this._cancel || !samples.length) continue;
      const b = ctx.createBuffer(1, samples.length, rate);
      b.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = b; src.connect(an);
      this._src = src;
      await new Promise(r => { src.onended = r; src.start(); });
    }
    this._metering = false; this.level = 0; this._src = null;
  },

  _browser(text, lang) {
    return new Promise(res => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const v = speechSynthesis.getVoices().find(x => x.lang === lang) || speechSynthesis.getVoices().find(x => x.lang?.startsWith(lang.slice(0, 2)));
      if (v) u.voice = v;
      // No sound levels from the browser voice, so the face moves on a gentle rhythm instead.
      const t = setInterval(() => { this.level = 0.25 + Math.random() * 0.5; }, 110);
      u.onend = u.onerror = () => { clearInterval(t); this.level = 0; res(); };
      speechSynthesis.speak(u);
    });
  },

  /**
   * Listen for one turn and return what was said, as text ('' if nothing was said).
   * Ends after `silenceMs` of quiet once speech has started, or `maxMs` in all.
   */
  async listen({ maxMs = 25000, silenceMs = 1500, waitMs = 9000, prompt = '', language = '', onLevel } = {}) {
    if (!(typeof Lectures !== 'undefined' && Lectures.groqKey())) throw new Error('Add your Groq key in Settings — it is what turns your voice into text.');
    const n = this.native();
    if (n?.ensureMic) { const r = await n.ensureMic().catch(() => ({ granted: false })); if (r && r.granted === false) throw new Error('Microphone permission is needed.'); }
    const stream = await this._mic();
    this._cancel = false;
    this.listening = true;
    const ctx = this.ctx(), an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const parts = [];
    rec.ondataavailable = e => { if (e.data?.size) parts.push(e.data); };
    rec.start(250);

    const spoke = await new Promise(res => {
      const buf = new Float32Array(an.fftSize), t0 = Date.now();
      let floor = 0.008, heard = false, lastLoud = 0, samples = 0;
      const tick = () => {
        if (this._cancel) return res(false);
        an.getFloatTimeDomainData(buf);
        let s = 0; for (const x of buf) s += x * x;
        const rms = Math.sqrt(s / buf.length), now = Date.now();
        if (now - t0 < 350) { floor = Math.max(floor, rms * 1.2); samples++; } // the room's own noise, first
        const loud = rms > Math.max(0.018, floor * 2.6);
        onLevel?.(Math.min(1, rms * 8));
        if (loud) { heard = true; lastLoud = now; }
        if ((heard && now - lastLoud > silenceMs) || now - t0 > maxMs || (!heard && now - t0 > waitMs)) return res(heard);
        setTimeout(tick, 60);
      };
      tick();
    });

    const blob = await new Promise(res => { rec.onstop = () => res(new Blob(parts, { type: rec.mimeType || 'audio/webm' })); try { rec.stop(); } catch (e) { res(null); } });
    stream.getTracks().forEach(t => t.stop());
    this.listening = false;
    onLevel?.(0);
    if (!spoke || !blob || blob.size < 2000 || this._cancel) return '';
    return this.transcribe(blob, { prompt, language });
  },

  /**
   * The microphone. "Could not start audio source" means something else already has it — most often
   * a lecture recording still running, since the recorder holds the microphone the whole class.
   * Some phones also refuse the cleaned-up voice settings, so it tries once more with plain ones.
   */
  async _mic() {
    try {
      const st = await this.native()?.getState?.();
      if (st?.recording) throw new Error('A lecture is being recorded, and that recording is using the microphone. Stop it (Lectures page or the swipe-down tile), then try again.');
    } catch (e) { if (/lecture is being recorded/.test(e.message)) throw e; }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw new Error('Microphone permission is off for Study Engine. Allow it: phone Settings → Apps → Study Engine → Permissions → Microphone (on a laptop, the lock icon in the address bar).');
      await sleep(500);
      try { return await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (e2) {
        if (e2?.name === 'NotReadableError' || /could not start/i.test(e2?.message || '')) throw new Error('The microphone is busy — another app is using it (a lecture recording, a call, WhatsApp voice, Google Assistant). Close that, then tap Speak again.');
        if (e2?.name === 'NotFoundError') throw new Error('No microphone found on this device.');
        throw new Error('Could not open the microphone: ' + (e2?.message || e2));
      }
    }
  },

  async transcribe(blob, { prompt = '', language = '' } = {}) {
    const p = Providers.get('groq');
    const fd = new FormData();
    const ext = /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
    fd.append('file', blob, 'turn.' + ext);
    fd.append('model', 'whisper-large-v3');
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    if (prompt) fd.append('prompt', prompt.slice(0, 600));
    if (language) fd.append('language', language);
    const res = await Providers.send(p, '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + p.key }, body: fd });
    if (res.status === 429) { await sleep(3000); return this.transcribe(blob, { prompt, language }); }
    if (!res.ok) throw new Error('Could not hear that (' + res.status + ')');
    const d = await res.json();
    const t = (d.text || '').trim();
    return Lectures._phantom?.(t) ? '' : t;
  }
};
window.Voice = Voice;
