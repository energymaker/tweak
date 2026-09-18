// Talks to the model. Ollama on this computer by default, or any
// OpenAI-compatible server (LM Studio, OpenRouter) if TWEAK_API_BASE is set.

const OLLAMA = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'http://');
// A Hugging Face token is all you need for the bigger models: it sets the
// address for you. TWEAK_API_BASE still works for LM Studio, OpenRouter, etc.
const HF_TOKEN = () => process.env.TWEAK_HF_TOKEN || '';
const API_BASE = () => (process.env.TWEAK_API_BASE || (HF_TOKEN() ? 'https://router.huggingface.co/v1' : '')).replace(/\/+$/, '');
const API_KEY = () => process.env.TWEAK_API_KEY || HF_TOKEN();

export async function listModels() {
  const out = { ollama: { reachable: false, models: [], error: '' }, api: { configured: !!API_BASE(), reachable: false, models: [], error: '' } };
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    out.ollama.reachable = true;
    out.ollama.models = (d.models || []).map(m => m.name);
  } catch (e) {
    out.ollama.error = e.name === 'TimeoutError' ? 'No answer from Ollama' : 'Ollama is not running at ' + OLLAMA;
  }
  if (API_BASE()) {
    try {
      const headers = API_KEY() ? { Authorization: 'Bearer ' + API_KEY() } : {};
      const r = await fetch(API_BASE() + '/models', { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      out.api.reachable = true;
      out.api.models = (d.data || []).map(m => m.id);
    } catch (e) {
      out.api.error = e.message && /40[13]/.test(e.message) ? 'The token was rejected' : 'Could not reach the model service';
    }
  }
  return out;
}

export function parseJSON(text) {
  if (text == null || String(text).trim() === '') throw new Error('The model returned nothing');
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  const err = new Error('The model did not reply with valid JSON');
  err.raw = t.slice(0, 2000);
  throw err;
}

// model is "ollama:<name>" or "api:<name>"
const MODEL_TIMEOUT = Number(process.env.TWEAK_MODEL_TIMEOUT || 300) * 1000;

// Never wait forever on a model. A stalled request used to hang the whole run.
function withTimeout(signal) {
  const t = AbortSignal.timeout(MODEL_TIMEOUT);
  if (!signal) return t;
  return AbortSignal.any ? AbortSignal.any([signal, t]) : signal;
}

export async function ask(model, prompt, schema, signal, maxOutput) {
  signal = withTimeout(signal);
  const [provider, ...rest] = String(model).split(':');
  const name = rest.join(':');
  if (provider === 'ollama') {
    const body = { model: name, messages: [{ role: 'user', content: prompt }], stream: false, format: schema || 'json', options: { temperature: 0.2, num_ctx: Number(process.env.TWEAK_NUM_CTX || 8192), num_predict: maxOutput || Number(process.env.TWEAK_MAX_OUTPUT || 1400) } };
    // Thinking models answer faster and more reliably in JSON with thinking off.
    const tryThinkOff = /qwen3|deepseek-r1|gpt-oss/i.test(name);
    let r = await fetch(OLLAMA + '/api/chat', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tryThinkOff ? { ...body, think: false } : body) });
    if (!r.ok && tryThinkOff && r.status === 400) {
      r = await fetch(OLLAMA + '/api/chat', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    if (!r.ok) throw new Error('Ollama error ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const d = await r.json();
    return { json: parseJSON(d.message && d.message.content), tokens: { prompt: d.prompt_eval_count ?? null, output: d.eval_count ?? null } };
  }
  if (provider === 'api') {
    if (!API_BASE()) throw new Error('No Hugging Face token saved yet. Add one in Settings.');
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY()) headers.Authorization = 'Bearer ' + API_KEY();
    const r = await fetch(API_BASE() + '/chat/completions', { method: 'POST', signal, headers, body: JSON.stringify({ model: name, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }) });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      const plain = r.status === 402 || /credit|quota|billing/i.test(body)
        ? `${name} is out of credit on your account. Add a little at huggingface.co, under Settings then Billing, or carry on with the models on your computer.`
        : r.status === 401 || r.status === 403 ? 'Your Hugging Face token was rejected. Check it in Settings.'
        : r.status === 404 ? `${name} is not available to your account. Pick a different one in Settings.`
        : r.status === 429 ? `${name} is busy right now. Wait a minute and try again.`
        : `The bigger model refused (error ${r.status}).`;
      const err = new Error(plain);
      err.code = 'model_unavailable';
      err.status = r.status;
      throw err;
    }
    const d = await r.json();
    const msg = d.choices && d.choices[0] && d.choices[0].message;
    return { json: parseJSON(msg && msg.content), tokens: { prompt: d.usage?.prompt_tokens ?? null, output: d.usage?.completion_tokens ?? null } };
  }
  throw new Error('Unknown model "' + model + '"');
}
