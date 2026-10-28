// Study Engine relay — paste this whole file into a Cloudflare Worker and Deploy.
// It passes the app's AI requests to services that block browser apps (NVIDIA, GitHub Models…),
// and reaches Gemini on networks that block it.
const ALLOW = ['generativelanguage.googleapis.com', 'integrate.api.nvidia.com', 'models.github.ai', 'api.siliconflow.com', 'api.siliconflow.cn', 'open.bigmodel.cn', 'api.z.ai',
  'api.cerebras.ai', 'api.groq.com', 'api.mistral.ai', 'openrouter.ai', 'api.sambanova.ai', 'api.together.xyz', 'api.hyperbolic.xyz', 'api.chutes.ai', 'llm.chutes.ai', 'api.ocr.space'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': '*' };
export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    let target;
    try { target = new URL(new URL(req.url).searchParams.get('u')); } catch (e) { return new Response('Relay is working.', { headers: CORS }); }
    if (target.protocol !== 'https:' || !ALLOW.some(h => target.hostname === h || target.hostname.endsWith('.' + h)))
      return new Response(JSON.stringify({ error: { message: 'Relay: this address is not on the allowed list' } }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } });
    const headers = new Headers();
    for (const k of ['authorization', 'content-type', 'accept']) { const v = req.headers.get(k); if (v) headers.set(k, v); }
    const r = await fetch(target, { method: req.method, headers, body: req.method === 'POST' ? await req.arrayBuffer() : undefined });
    const out = new Response(r.body, r);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  }
};
