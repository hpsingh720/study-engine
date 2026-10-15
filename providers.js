// Extra free AI providers (OpenAI-compatible). They work in parallel with Gemini on the bulk jobs:
// importing question banks, image spotters and reading scanned pages.
const PROVIDER_PRESETS = {
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'meta-llama/llama-4-scout-17b-16e-instruct', rpm: 25, vision: true, signup: 'https://console.groq.com/keys', note: 'Free, no card. About 1,000 requests a day.' },
  mistral: { name: 'Mistral', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', rpm: 20, vision: true, signup: 'https://console.mistral.ai/api-keys', note: 'Free "Experiment" plan, no card (phone number needed). Large monthly allowance.' },
  meta: { name: 'Meta Llama API', base: 'https://api.llama.com/compat/v1', model: 'Llama-4-Maverick-17B-128E-Instruct-FP8', rpm: 9, vision: true, signup: 'https://llama.developer.meta.com/', note: 'Meta’s own Llama API (preview). About 10 requests a minute with a big size allowance, so whole pages fit.' },
  github: { name: 'GitHub Models', base: 'https://models.github.ai/inference', model: 'openai/gpt-4.1-mini', rpm: 10, vision: true, signup: 'https://github.com/settings/personal-access-tokens', note: 'Free with your GitHub account. Token needs the “Models” read permission.' },
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: '', rpm: 15, vision: false, signup: 'https://openrouter.ai/keys', note: 'Free “:free” models, about 50 requests a day. Text only here.' },
  cerebras: { name: 'Cerebras', base: 'https://api.cerebras.ai/v1', model: '', rpm: 25, vision: false, signup: 'https://cloud.cerebras.ai', note: 'Free, very fast. Text only.' }
};

const Providers = {
  list() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('providers') || '{}'); } catch (e) {}
    return Object.entries(PROVIDER_PRESETS).map(([id, p]) => ({ id, ...p, ...(saved[id] || {}) }));
  },
  active() { return this.list().filter(p => p.key && p.model && p.on !== false); },
  save(id, patch) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('providers') || '{}'); } catch (e) {}
    saved[id] = { ...(saved[id] || {}), ...patch };
    localStorage.setItem('providers', JSON.stringify(saved));
  },
  get(id) { return this.list().find(p => p.id === id); },

  async call(p, { prompt, images = [], system, json = true, temperature = 0.3, maxTokens = 8000 }) {
    const content = images.length
      ? [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))]
      : prompt;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content });
    const body = { model: p.model, messages, temperature, max_tokens: maxTokens };
    if (json) body.response_format = { type: 'json_object' };
    let res;
    try {
      res = await fetch(p.base.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key }, body: JSON.stringify(body)
      });
    } catch (e) { throw new QuotaError(`${p.name}: could not connect (offline, or this provider blocks browser apps)`, false, 60000); }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = d.error?.message || d.message || d.detail || ('HTTP ' + res.status);
      if (res.status === 429) {
        const ra = +res.headers.get('retry-after') || 30;
        throw new QuotaError(`${p.name}: ${msg}`, /day|daily|quota|tokens per/i.test(msg), ra * 1000 + 1000);
      }
      if (res.status >= 500) throw new QuotaError(`${p.name} busy (${res.status})`, false, 20000);
      // Some models reject JSON mode — retry once without it.
      if (json && /response_format|json/i.test(msg) && !body._noJson) return this.call(p, { prompt: prompt + '\n\nReply with JSON only.', images, system, json: false, temperature, maxTokens }).then(t => parseJSON(t));
      throw new Error(`${p.name}: ${msg}`);
    }
    const text = d.choices?.[0]?.message?.content || '';
    if (!text) throw new Error(`${p.name}: empty reply`);
    return json ? parseJSON(text) : text;
  },

  async models(p) {
    const r = await fetch(p.base.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + p.key } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error?.message || d.message || 'HTTP ' + r.status);
    const arr = Array.isArray(d) ? d : (d.data || []);
    return arr.map(m => m.id || m.name).filter(Boolean);
  }
};

// Bulk jobs call this: a provider when the job runs on a provider lane, otherwise Gemini's bulk model.
function bulkCall(ctx, opts) {
  return ctx?.provider ? Providers.call(ctx.provider, opts) : AI.call({ ...opts, model: AI.bulkModel });
}
