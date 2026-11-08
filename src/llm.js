// AI provider layer. Leash works with any of these (first key found wins):
//   GEMINI_API_KEY     Google Gemini (free tier, no card needed)  ← recommended
//   GROQ_API_KEY       Groq (free tier, open models)
//   ANTHROPIC_API_KEY  Anthropic Claude (paid)
// Gemini and Groq are called through their OpenAI-compatible endpoints with plain fetch.
import Anthropic from '@anthropic-ai/sdk';

const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    key: process.env.GEMINI_API_KEY,
    baseUrl: process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: process.env.AI_MODEL || 'gemini-flash-latest',
  },
  groq: {
    label: 'Groq',
    key: process.env.GROQ_API_KEY,
    baseUrl: 'https://api.groq.com/openai/v1',
    model: process.env.AI_MODEL || 'llama-3.3-70b-versatile',
  },
  claude: {
    label: 'Claude',
    key: process.env.ANTHROPIC_API_KEY,
    model: process.env.AI_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  },
};

const chosen = process.env.AI_PROVIDER || ['gemini', 'groq', 'claude'].find((p) => PROVIDERS[p].key);
export const provider = chosen && PROVIDERS[chosen]?.key ? { id: chosen, ...PROVIDERS[chosen] } : null;
export const aiLive = Boolean(provider);
export const aiLabel = provider ? `${provider.label} (${provider.model})` : 'offline';

const anthropic = provider?.id === 'claude' ? new Anthropic({ apiKey: provider.key }) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQUEST_TIMEOUT_MS = 60000;

// Model preference for Gemini. If a model is retired or has no free quota for this key,
// Leash asks the API which models exist and falls back automatically.
const GEMINI_PREFERRED = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
];
let currentModel = provider?.model;
const triedModels = new Set();

async function nextGeminiModel() {
  triedModels.add(currentModel);
  let available = [];
  try {
    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${provider.key}` },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    available = (json.data || []).map((m) => String(m.id).replace(/^models\//, ''));
  } catch (err) {
    console.error('Could not list Gemini models:', err.message);
  }
  const flash = available.filter((m) => /flash/.test(m) && !/(image|tts|audio|live|embed|thinking-exp)/.test(m));
  const candidates = [...GEMINI_PREFERRED.filter((m) => !available.length || available.includes(m)), ...flash];
  const next = candidates.find((m) => !triedModels.has(m));
  if (!next) return null;
  console.log(`Gemini: switching model ${currentModel} -> ${next}`);
  currentModel = next;
  return next;
}

export const currentModelName = () => currentModel;

/** OpenAI-compatible chat completion: times out, retries brief rate limits, falls back to another model. */
async function openaiChat(body) {
  let rateLimitRetries = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    let res;
    try {
      res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: currentModel, ...body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`${provider.label} request failed (${currentModel}):`, err.message);
      if (provider.id === 'gemini' && (await nextGeminiModel())) continue;
      throw new Error(`${provider.label} did not respond in time. Try again, or use the Scripted demo agent.`);
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    console.error(`${provider.label} ${res.status} (${currentModel}): ${text.slice(0, 500)}`);

    const noFreeQuota = res.status === 429 && /limit:\s*0|per day|PerDay|RESOURCE_EXHAUSTED.*free/i.test(text);
    const modelGone = res.status === 404 || (res.status === 400 && /model/i.test(text) && /not (found|supported|available)/i.test(text));
    if (provider.id === 'gemini' && (modelGone || noFreeQuota) && (await nextGeminiModel())) continue;

    if ((res.status === 429 || res.status === 503) && rateLimitRetries < 3) {
      rateLimitRetries++;
      const wait = Number(res.headers.get('retry-after')) * 1000 || 10000 * rateLimitRetries;
      await sleep(Math.min(wait, 20000));
      continue;
    }
    throw new Error(`${provider.label} error ${res.status} (${currentModel}): ${text.slice(0, 300)}`);
  }
  throw new Error(`${provider.label}: no working model found for this key. Use the Scripted demo agent for now.`);
}

/** Keep only the JSON-schema keywords every provider accepts. */
export function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const k of ['type', 'description', 'enum', 'required']) if (schema[k] !== undefined) out[k] = schema[k];
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, cleanSchema(v)]));
  }
  if (schema.items) out.items = cleanSchema(schema.items);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

/** Single prompt in, text out (used by the risk reviewer). */
export async function complete(prompt, maxTokens = 400) {
  if (anthropic) {
    const msg = await anthropic.messages.create({
      model: provider.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content.map((c) => c.text || '').join('');
  }
  const json = await openaiChat({ messages: [{ role: 'user', content: prompt }], temperature: 0 });
  return json.choices?.[0]?.message?.content || '';
}

/**
 * Tool-using agent loop.
 * tools: [{ name, description, parameters }]
 * runTool(name, args) -> string;  onText(text) for agent narration.
 */
export async function runAgentLoop({ system, user, tools, runTool, onText, maxSteps = 15 }) {
  if (anthropic) {
    const messages = [{ role: 'user', content: user }];
    const anthTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: cleanSchema(t.parameters) }));
    for (let step = 0; step < maxSteps; step++) {
      const res = await anthropic.messages.create({ model: provider.model, max_tokens: 2000, system, tools: anthTools, messages });
      messages.push({ role: 'assistant', content: res.content });
      for (const b of res.content) if (b.type === 'text' && b.text.trim()) onText(b.text.trim());
      const calls = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !calls.length) return;
      const results = [];
      for (const c of calls) results.push({ type: 'tool_result', tool_use_id: c.id, content: await runTool(c.name, c.input) });
      messages.push({ role: 'user', content: results });
    }
    return;
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const oaTools = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: cleanSchema(t.parameters) },
  }));
  for (let step = 0; step < maxSteps; step++) {
    const json = await openaiChat({ messages, tools: oaTools, tool_choice: 'auto', temperature: 0.2 });
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error(`${provider.label} returned no message`);
    messages.push(msg);
    if (msg.content && String(msg.content).trim()) onText(String(msg.content).trim());
    const calls = msg.tool_calls || [];
    if (!calls.length) return;
    for (const c of calls) {
      let args = {};
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {}
      messages.push({ role: 'tool', tool_call_id: c.id, content: await runTool(c.function.name, args) });
    }
  }
}
