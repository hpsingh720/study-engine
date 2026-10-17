// Extra free AI providers (OpenAI-compatible). They work in parallel with Gemini on the bulk jobs:
// importing question banks, image spotters and reading scanned pages.
const PROVIDER_PRESETS = {
  gemini2: { name: 'Gemini — 2nd key (e.g. a friend\'s)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', rpm: 8, vision: true, big: true, signup: 'https://aistudio.google.com/apikey', note: 'A second Gemini key from another Google account (with its owner\'s OK). It writes topic sheets and MCQs alongside your own key. Click Test and it picks the newest Flash model.' },
  gemini3: { name: 'Gemini — 3rd key (another friend\'s)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', rpm: 8, vision: true, big: true, signup: 'https://aistudio.google.com/apikey', note: 'A second Gemini key from another Google account (with its owner\'s OK). It writes topic sheets and MCQs alongside your own key. Click Test and it picks the newest Flash model.' },
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'meta-llama/llama-4-scout-17b-16e-instruct', rpm: 25, vision: true, signup: 'https://console.groq.com/keys', note: 'Free, no card. About 1,000 requests a day.' },
  mistral: { name: 'Mistral', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', rpm: 20, vision: true, signup: 'https://console.mistral.ai/api-keys', note: 'Free "Experiment" plan, no card (phone number needed). Large monthly allowance.' },
  nvidia: { name: 'NVIDIA (build.nvidia.com)', base: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.2-90b-vision-instruct', rpm: 30, vision: true, signup: 'https://build.nvidia.com/settings/api-keys', note: 'Free, no card. Needs the relay (below). Sign up with email, then "Get API Key". About 40 requests a minute on free credits.' },
  siliconflow: { name: 'SiliconFlow', base: 'https://api.siliconflow.com/v1', model: '', rpm: 20, vision: true, signup: 'https://cloud.siliconflow.com/account/ak', note: 'Free models, no card. Click Test and it finds a free model by itself. If the key does not work, try the China site: change the address to https://api.siliconflow.cn/v1.' },
  zhipu: { name: 'Z.ai / Zhipu GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash', rpm: 5, vision: true, signup: 'https://open.bigmodel.cn/usercenter/apikeys', note: 'GLM "Flash" models are free forever. Only one request at a time, so keep this low.' },
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: '', rpm: 15, vision: false, signup: 'https://openrouter.ai/keys', note: 'Free “:free” models, about 50 requests a day. Text only here.' },
  custom: { name: 'Any other (OpenAI-compatible)', base: '', model: '', rpm: 10, vision: false, custom: true, signup: 'https://github.com/cheahjs/free-llm-api-resources', note: 'Any service that says “OpenAI-compatible”: paste its address (ends in /v1), key and model.' },
  cerebras: { name: 'Cerebras (paid now — skip)', base: 'https://api.cerebras.ai/v1', model: '', rpm: 25, vision: false, signup: 'https://cloud.cerebras.ai', note: 'Asks for payment. Skip.' },
  meta: { name: 'Meta Llama API (paid — skip)', base: 'https://api.llama.com/compat/v1', model: 'Llama-4-Maverick-17B-128E-Instruct-FP8', rpm: 9, vision: true, signup: 'https://llama.developer.meta.com/', note: 'Asks for billing. Skip.' },
  github: { name: 'GitHub Models (needs relay)', base: 'https://models.github.ai/inference', model: 'openai/gpt-4.1-mini', rpm: 10, vision: true, signup: 'https://github.com/settings/personal-access-tokens', note: 'Free with your GitHub account. Blocks browser apps, so it needs the relay (below). Token needs the “Models” read permission.' }
};

const Providers = {
  relay() { return (localStorage.getItem('relay') || '').trim().replace(/\/$/, ''); },
  // Address to call: straight to the service, or through the user's Cloudflare relay for services that block browser apps.
  url(p, path) {
    const target = p.base.replace(/\/$/, '') + path;
    return p.viaRelay && this.relay() ? this.relay() + '/?u=' + encodeURIComponent(target) : target;
  },
  async send(p, path, init) {
    const direct = p.base.replace(/\/$/, '') + path;
    const relayed = this.relay() ? this.relay() + '/?u=' + encodeURIComponent(direct) : null;
    const first = p.viaRelay && relayed ? relayed : direct, second = first === direct ? relayed : direct;
    try { return await fetch(first, init); }
    catch (e) {
      if (!second) throw e;
      // Remember whichever way works (a short network blip shouldn't lock a service onto the relay for ever).
      const r = await fetch(second, init);
      const via = second === relayed; if (!!p.viaRelay !== via) { this.save(p.id, { viaRelay: via }); p.viaRelay = via; }
      return r;
    }
  },
  list() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('providers') || '{}'); } catch (e) {}
    return Object.entries(PROVIDER_PRESETS).map(([id, p]) => ({ id, ...p, ...(saved[id] || {}) }));
  },
  active() { return this.list().filter(p => p.key && p.model && p.base && p.on !== false); },
  save(id, patch) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('providers') || '{}'); } catch (e) {}
    saved[id] = { ...(saved[id] || {}), ...patch };
    localStorage.setItem('providers', JSON.stringify(saved));
  },
  get(id) { return this.list().find(p => p.id === id); },

  async call(p, { prompt, images = [], system, json = true, temperature = 0.3, maxTokens = 8000, _retried = false }) {
    const content = images.length
      ? [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))]
      : prompt;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content });
    const body = { model: p.model, messages };
    if (!p.noTemp) body.temperature = temperature;
    if (p.newTokens) body.max_completion_tokens = maxTokens; else body.max_tokens = maxTokens;
    if (_retried) body._retried = true;
    if (json) body.response_format = { type: 'json_object' };
    let res;
    try {
      res = await this.send(p, '/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key }, body: JSON.stringify({ ...body, _retried: undefined })
      });
    } catch (e) { throw new QuotaError(`${p.name}: could not connect — ${this.relay() ? 'even through your relay (check the relay address)' : 'this service blocks browser apps. Set up the free relay (below) and Test again'}`, false, 60000); }
    const raw = await res.text().catch(() => '');
    let d = {}; try { d = JSON.parse(raw); } catch (e) {}
    if (res.ok && !d.choices) throw new Error(`${p.name}: unexpected reply — "${raw.replace(/\s+/g, ' ').slice(0, 120)}"${p.viaRelay ? ' (through your relay — click Test relay)' : ''}`);
    if (!res.ok) {
      const msg = d.error?.message || d.message || d.detail || ('HTTP ' + res.status);
      if (res.status === 429) {
        const ra = +res.headers.get('retry-after') || 30;
        throw new QuotaError(`${p.name}: ${msg}`, /day|daily|quota|tokens per/i.test(msg), ra * 1000 + 1000);
      }
      if (res.status >= 500) throw new QuotaError(`${p.name} busy (${res.status})`, false, 20000);
      // Newer "thinking" models want max_completion_tokens and no temperature — remember that and retry.
      if (/max_completion_tokens/i.test(msg) && !p.newTokens) { this.save(p.id, { newTokens: true }); return this.call({ ...p, newTokens: true }, { prompt, images, system, json, temperature, maxTokens, _retried }); }
      if (/temperature/i.test(msg) && !p.noTemp) { this.save(p.id, { noTemp: true }); return this.call({ ...p, noTemp: true }, { prompt, images, system, json, temperature, maxTokens, _retried }); }
      // Some models reject JSON mode — retry once without it.
      if (json && /response_format|json/i.test(msg) && !body._noJson) return this.call(p, { prompt: prompt + '\n\nReply with JSON only.', images, system, json: false, temperature, maxTokens }).then(t => parseJSON(t));
      throw new Error(`${p.name}: ${msg}`);
    }
    const text = (d.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!text) {
      // "Thinking" models (gpt-5, o-series…) can use up the whole allowance before answering — retry once with more room.
      if (!body._retried && maxTokens < 16000) return this.call(p, { prompt, images, system, json, temperature, maxTokens: Math.max(4000, maxTokens * 8), _retried: true });
      throw new Error(`${p.name}: empty reply from ${p.model} (finish: ${d.choices?.[0]?.finish_reason || 'unknown'}) — try another model, e.g. openai/gpt-4.1-mini`);
    }
    return json ? parseJSON(text) : text;
  },

  async models(p) {
    if (/models\.github\.ai/.test(p.base)) {
      const r = await this.send({ ...p, base: 'https://models.github.ai' }, '/catalog/models', { headers: { Authorization: 'Bearer ' + p.key } });
      const d = await r.json().catch(() => []);
      return (Array.isArray(d) ? d : []).map(m => m.id).filter(Boolean);
    }
    const r = await this.send(p, '/models', { headers: { Authorization: 'Bearer ' + p.key } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error?.message || d.message || 'HTTP ' + r.status);
    const arr = Array.isArray(d) ? d : (d.data || []);
    return arr.map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
  }
};

// Bulk jobs call this: a provider when the job runs on a provider lane, otherwise Gemini's bulk model.
function bulkCall(ctx, opts) {
  return ctx?.provider ? Providers.call(ctx.provider, opts) : AI.call({ ...opts, model: AI.bulkModel });
}
