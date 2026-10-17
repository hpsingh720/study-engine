// Offline AI search: a small sentence-meaning model runs inside the browser (no internet after the first download).
// It turns text into "meaning vectors", so a search finds the right passage even when the book uses different words.
const Semantic = {
  pipe: null, loading: null, failed: '',
  MODEL: 'Xenova/all-MiniLM-L6-v2',
  async load(onStatus) {
    if (this.pipe) return this.pipe;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      onStatus?.('Getting the offline AI ready (one-time download, about 25 MB)…');
      const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2');
      T.env.allowLocalModels = false; T.env.useBrowserCache = true; // the model is kept in the browser for offline use
      this.pipe = await T.pipeline('feature-extraction', this.MODEL, { dtype: 'q8' });
      this.failed = '';
      return this.pipe;
    })().catch(e => { this.failed = e.message || String(e); this.loading = null; throw e; });
    return this.loading;
  },
  async embed(texts) {
    const p = await this.load();
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
