/* Study Engine — live talk.
 * A real back-and-forth with the patient, like talking to Gemini Live: one open line to Google's
 * live voice model, which hears your voice directly (Punjabi, Hindi or English) and answers in its
 * own voice within about a second. You can talk over it, and it stops to listen. No typing, no
 * waiting for your words to be written out and sent.
 * Uses the Gemini key from Settings. */

const LiveTalk = {
  // Newest first. The one that worked last time is tried first next time.
  MODELS: ['gemini-3.1-flash-live-preview', 'gemini-2.5-flash-native-audio-preview-12-2025'],
  on: false,
  muted: false,

  url() { return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(AI.key)}`; },

  // Two ways of writing the opening message are in use; whichever Google accepts is remembered.
  _setups(model, system, voice) {
    const speech = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
    const common = {
      model: 'models/' + model,
      systemInstruction: { parts: [{ text: system }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    };
    // Answer after 0.6 s of quiet — quick, but not so quick it cuts in while you think.
    const vad = { automaticActivityDetection: { silenceDurationMs: 600, prefixPaddingMs: 200 } };
    const out = [];
    if (/^gemini-3/.test(model)) out.push({ name: 'fast', setup: { ...common, realtimeInputConfig: vad, generationConfig: { responseModalities: ['AUDIO'], speechConfig: speech, thinkingConfig: { thinkingLevel: 'MINIMAL' } } } });
    out.push({ name: 'standard', setup: { ...common, realtimeInputConfig: vad, generationConfig: { responseModalities: ['AUDIO'], speechConfig: speech } } });
    out.push({ name: 'flat', setup: { ...common, responseModalities: ['AUDIO'], speechConfig: speech } });
    return out;
  },

  /**
   * Start talking. Callbacks:
   *  onYou(text, done)      — your words as they are heard
   *  onThem(text, done)     — the patient's words as they are spoken
   *  onState(state, detail) — 'connecting' | 'live' | 'ended' | 'error'
   *  onLevel(0..1)          — your microphone level
   */
  async start({ system, voice = 'Charon', onYou, onThem, onState, onLevel } = {}) {
    if (this.on) return;
    if (!AI.key) throw new Error('Live talk needs your Gemini key — add it in Settings.');
    if (!window.WebSocket) throw new Error('This browser cannot hold a live line open.');
    this.cb = { onYou, onThem, onState, onLevel };
    this.on = true; this.muted = false;
    this._you = ''; this._them = ''; this._ended = false;
    onState?.('connecting');
    try {
      const n = Voice.native();
      if (n?.ensureMic) { const r = await n.ensureMic().catch(() => ({ granted: false })); if (r && r.granted === false) throw new Error('Microphone permission is needed.'); }
      if (Voice.speaking) Voice.stop();
      // Microphone first: if it cannot open, there is no point connecting.
      this.stream = await Voice._mic();
      await this._connect(system, voice);
      if (!this.on) return this._cleanup();
      this._capture();
      onState?.('live');
    } catch (e) {
      this._cleanup();
      this.on = false;
      throw e;
    }
  },

  async _connect(system, voice) {
    const saved = localStorage.getItem('liveModel'), savedSetup = localStorage.getItem('liveSetup');
    const models = saved && this.MODELS.includes(saved) ? [saved, ...this.MODELS.filter(m => m !== saved)] : this.MODELS;
    let last;
    for (const model of models) {
      let setups = this._setups(model, system, voice);
      if (model === saved && savedSetup) setups = [...setups.filter(s => s.name === savedSetup), ...setups.filter(s => s.name !== savedSetup)];
      for (const s of setups) {
        try {
          await this._open(s.setup);
          localStorage.setItem('liveModel', model); localStorage.setItem('liveSetup', s.name);
          return;
        } catch (e) {
          last = e;
          if (!this.on) throw e;
          if (e.fatal) throw e;
          // A refused model (not found, used up) — no point trying another way of asking for it.
          if (e.model) break;
        }
      }
    }
    throw this._explain(last);
  },

  _explain(e) {
    const m = String(e?.message || e || '');
    if (/quota|exhaust|exceeded|429|rate/i.test(m)) return new Error("Google's free allowance for live talk is used up for now. Use Speak instead, or try again later.");
    if (/key|permission|unauth|403/i.test(m)) return new Error('Google refused the Gemini key for live talk. Check the key in Settings.');
    return new Error('Live talk could not connect (' + (m || 'no answer') + '). Use Speak instead.');
  },

  _open(setup) {
    return new Promise((resolve, reject) => {
      let ready = false;
      const ws = new WebSocket(this.url());
      this.ws = ws;
      const timer = setTimeout(() => { if (!ready) { try { ws.close(); } catch (e) {} reject(new Error('no answer from Google')); } }, 12000);
      ws.onopen = () => ws.send(JSON.stringify({ setup }));
      ws.onmessage = async (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await (ev.data.text ? ev.data.text() : new Response(ev.data).text())); } catch (e) { return; }
        if (msg.setupComplete && !ready) { ready = true; clearTimeout(timer); resolve(); return; }
        if (ready) this._onMessage(msg);
      };
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!ready) {
          const reason = ev.reason || 'closed (' + ev.code + ')';
          const e = new Error(reason);
          e.fatal = /api key|API_KEY|unauth/i.test(reason);
          e.model = /not found|not supported|quota|exhaust|exceeded/i.test(reason);
          reject(e);
          return;
        }
        if (this.ws === ws) this._closed(ev);
      };
    });
  },

  _onMessage(msg) {
    const sc = msg.serverContent;
    if (msg.goAway) this._goingAway = true;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      this._you += sc.inputTranscription.text;
      this.cb.onYou?.(this._you.trim(), false);
    }
    if (sc.interrupted) {
      // You started talking: the patient stops at once, like a person would.
      this._flushAudio();
      if (this._them) { this.cb.onThem?.(this._them.trim() + ' …', true); this._them = ''; }
    }
    const parts = sc.modelTurn?.parts || [];
    for (const p of parts) {
      const d = p.inlineData || p.inline_data;
      if (d?.data && /audio/.test(d.mimeType || d.mime_type || 'audio')) {
        this._doneYou();
        this._play(d.data, d.mimeType || d.mime_type);
      }
    }
    if (sc.outputTranscription?.text) {
      this._doneYou();
      this._them += sc.outputTranscription.text;
      this.cb.onThem?.(this._them.trim(), false);
    }
    if (sc.turnComplete) {
      this._doneYou();
      if (this._them.trim()) this.cb.onThem?.(this._them.trim(), true);
      this._them = '';
    }
  },

  _doneYou() {
    if (!this._you.trim()) return;
    this.cb.onYou?.(this._you.trim(), true);
    this._you = '';
  },

  // ---- your voice: 16 kHz, 16-bit, sent every ~0.1 s ----
  _capture() {
    const ctx = Voice.ctx();
    this._src = ctx.createMediaStreamSource(this.stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;   // needed for the processor to run; makes no sound
    this._src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    this._proc = proc; this._mute = mute;
    const ratio = ctx.sampleRate / 16000;
    let pending = [], pendingLen = 0, quietSent = false;
    proc.onaudioprocess = (e) => {
      if (!this.on || !this.ws || this.ws.readyState !== 1) return;
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      this.cb.onLevel?.(this.muted ? 0 : Math.min(1, Math.sqrt(sum / input.length) * 5));
      if (this.muted) {
        if (!quietSent) { quietSent = true; this._send({ realtimeInput: { audioStreamEnd: true } }); }
        return;
      }
      quietSent = false;
      const n = Math.floor(input.length / ratio), out = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        // Average the samples that fold into each 16 kHz sample.
        const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
        let s = 0; for (let j = a; j < b; j++) s += input[j];
        const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      pending.push(out); pendingLen += n;
      if (pendingLen >= 1600) {
        const all = new Int16Array(pendingLen); let o = 0;
        for (const c of pending) { all.set(c, o); o += c.length; }
        pending = []; pendingLen = 0;
        this._send({ realtimeInput: { audio: { data: this._b64(new Uint8Array(all.buffer)), mimeType: 'audio/pcm;rate=16000' } } });
      }
    };
  },

  _b64(u) { let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); },
  _send(obj) { try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); } catch (e) {} },

  // Typed words go down the same open line.
  sendText(text) {
    if (!this.on || !text) return false;
    this._send({ realtimeInput: { text } });
    return true;
  },

  mute(on) { this.muted = on ?? !this.muted; return this.muted; },

  // ---- the patient's voice: 24 kHz pieces played back to back ----
  _play(b64, mime) {
    const ctx = Voice.ctx();
    const rate = +((mime || '').match(/rate=(\d+)/)?.[1] || 24000);
    const bin = atob(b64), n = bin.length >> 1;
    if (!n) return;
    const buf = ctx.createBuffer(1, n, rate), ch = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 0x8000) v -= 0x10000; ch[i] = v / 0x8000; sum += ch[i] * ch[i]; }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this._next || 0);
    src.start(at);
    this._next = at + buf.duration;
    (this._srcs ||= new Set()).add(src);
    // The face's mouth follows the voice.
    const lvl = Math.min(1, Math.sqrt(sum / n) * 4);
    setTimeout(() => { if (this._srcs?.has(src)) { Voice.speaking = true; Voice.level = lvl; Voice._stopBtn(true); } }, Math.max(0, (at - ctx.currentTime) * 1000));
    src.onended = () => { this._srcs?.delete(src); if (!this._srcs?.size) { Voice.speaking = false; Voice.level = 0; Voice._stopBtn(false); } };
  },

  _flushAudio() {
    for (const s of this._srcs || []) { try { s.onended = null; s.stop(); } catch (e) {} }
    this._srcs = new Set(); this._next = 0;
    Voice.speaking = false; Voice.level = 0; Voice._stopBtn?.(false);
  },

  // Stop the patient talking without ending the call.
  hush() { this._flushAudio(); },

  _closed(ev) {
    const wasOn = this.on;
    this._cleanup();
    this.on = false;
    if (!wasOn) return;
    const why = ev?.reason || '';
    const limit = this._goingAway || /time|duration|limit|deadline/i.test(why) || ev?.code === 1000;
    this.cb.onState?.(limit ? 'ended' : 'error', limit ? 'The live line closes after about 10 minutes. Tap Talk live to carry on — the patient remembers what was said.' : this._explain(why || 'line dropped').message);
  },

  stop() {
    if (!this.on && !this.ws) return;
    this.on = false;
    const ws = this.ws;
    this._cleanup();
    try { ws?.close(1000); } catch (e) {}
    this.cb?.onState?.('ended');
  },

  _cleanup() {
    this._flushAudio();
    try { this._proc && (this._proc.onaudioprocess = null); this._proc?.disconnect(); this._src?.disconnect(); this._mute?.disconnect(); } catch (e) {}
    this._proc = this._src = this._mute = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    if (this.ws) { const ws = this.ws; this.ws = null; ws.onclose = null; ws.onmessage = null; if (ws.readyState <= 1) try { ws.close(1000); } catch (e) {} }
    this._goingAway = false;
    this.cb?.onLevel?.(0);
  }
};
window.LiveTalk = LiveTalk;
