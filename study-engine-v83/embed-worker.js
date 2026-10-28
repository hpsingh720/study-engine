// Runs the offline AI search model in the background, so the app stays smooth while it works.
let pipe = null;
async function load() {
  if (pipe) return pipe;
  const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2');
  T.env.allowLocalModels = false; T.env.useBrowserCache = true;
  try { T.env.backends.onnx.wasm.numThreads = 1; } catch (e) {} // one core only: keeps the laptop cool
  pipe = await T.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
  return pipe;
}
onmessage = async e => {
  const { id, texts } = e.data;
  try {
    const p = await load();
    if (!texts) return postMessage({ id, ok: true });
    const out = await p(texts, { pooling: 'mean', normalize: true });
    postMessage({ id, ok: true, vecs: out.tolist() });
  } catch (err) { postMessage({ id, ok: false, error: err.message || String(err) }); }
};
