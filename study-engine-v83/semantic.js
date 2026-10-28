// Offline AI search: a small sentence-meaning model runs inside the browser (no internet after the first download).
// It turns text into "meaning vectors", so a search finds the right passage even when the book uses different words.
const _semBase = (document.currentScript && document.currentScript.src || location.href).replace(/[^/]*$/, '');
const Semantic = {
  pipe: null, loading: null, failed: '', worker: null, _id: 0, _wait: {},
  MODEL: 'Xenova/all-MiniLM-L6-v2',
  async load(onStatus) {
    if (this.pipe) return this.pipe;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      onStatus?.('Getting the offline AI ready (one-time download, about 25 MB)…');
      // Preferred: run it in a background worker so taps and scrolling never freeze.
      try {
        const w = new Worker(_semBase + 'embed-worker.js', { type: 'module' });
        w.onmessage = e => { const r = this._wait[e.data.id]; if (!r) return; delete this._wait[e.data.id]; e.data.ok ? r[0](e.data.vecs) : r[1](new Error(e.data.error)); };
        w.onerror = e => { Object.values(this._wait).forEach(r => r[1](new Error(e.message || 'worker failed'))); this._wait = {}; };
        this.worker = w;
        await this._ask(null);
        this.pipe = { worker: true }; this.failed = '';
        return this.pipe;
      } catch (e) { try { this.worker?.terminate(); } catch (x) {} this.worker = null; }
      const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2');
      T.env.allowLocalModels = false; T.env.useBrowserCache = true; // the model is kept in the browser for offline use
      this.pipe = await T.pipeline('feature-extraction', this.MODEL, { dtype: 'q8' });
      this.failed = '';
      return this.pipe;
    })().catch(e => { this.failed = e.message || String(e); this.loading = null; throw e; });
    return this.loading;
  },
  _ask(texts) { const id = ++this._id; return new Promise((ok, no) => { this._wait[id] = [ok, no]; this.worker.postMessage({ id, texts }); }); },
  async embed(texts) {
    const p = await this.load();
    if (this.worker) return this._ask(texts);
    const out = await p(texts, { pooling: 'mean', normalize: true });
    return out.tolist();
  },
  quant(v) { const a = new Int8Array(v.length); for (let i = 0; i < v.length; i++) a[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127))); return a; },
  // Split a page into ~500-character pieces (overlapping) so each vector is about one idea.
  chunks(text) {
    const t = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n'), out = [];
    for (let i = 0; i < t.length; i += 400) { const piece = t.slice(i, i + 520).trim(); if (piece.length > 60) out.push({ off: i, text: piece }); if (i + 520 >= t.length) break; }
    return out;
  }
};
