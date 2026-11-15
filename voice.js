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
        contents: [{ role: 'user', parts: [{ text: style ? `Say this ${style}: ${text}` : text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
      };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(AI.key)}`;
      try {
        const res = await AI.gfetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error?.message || 'voice ' + res.status);
        const part = (d.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
        const inl = part?.inlineData || part?.inline_data;
        if (!inl?.data) throw new Error('no audio in reply');
        localStorage.setItem('tts_model', model);
        if (this._cancel) return;
        await this._playPcm(inl.data, +((inl.mimeType || inl.mime_type || '').match(/rate=(\d+)/) || [])[1] || 24000);
        return;
      } catch (e) { last = e; }
    }
    // Not on this key (or out of today's allowance): use the other voices for the rest of the session.
    this._gemOff = true;
    throw last || new Error('no natural voice');
  },

  async _playPcm(b64, rate) {
    const bin = atob(b64), n = bin.length >> 1, ctx = this.ctx();
    const buf = ctx.createBuffer(1, n, rate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; ch[i] = v / 32768; }
    const src = ctx.createBufferSource(), an = ctx.createAnalyser();
    an.fftSize = 512; src.buffer = buf; src.connect(an); an.connect(ctx.destination);
    this._src = src;
    const data = new Float32Array(an.fftSize);
    let alive = true;
    const meter = () => { if (!alive) return; an.getFloatTimeDomainData(data); let s = 0; for (const x of data) s += x * x; this.level = Math.min(1, Math.sqrt(s / data.length) * 6); requestAnimationFrame(meter); };
    await new Promise(res => { src.onended = res; src.start(); meter(); });
    alive = false; this.level = 0; this._src = null;
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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
