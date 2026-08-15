/**
 * Shared model registry and upstream provider adapter.
 *
 * Roster is deliberately narrow: GPT OSS and Qwen only. Llama 3.3 70B Versatile
 * is decommissioned on GroqCloud as of 2026-08-16, and the Mistral / Zephyr /
 * Phi entries the app used to carry were never part of the supported set.
 *
 * Two upstreams speak the same OpenAI-compatible dialect:
 *   GROQ_API_KEY -> api.groq.com          (preferred when present)
 *   HF_TOKEN     -> router.huggingface.co (fallback)
 */

export const LANES = {
  L1: {
    id: 'L1',
    name: 'Swift',
    blurb: 'Short answers, rewrites, lookups, conversation.',
    groq: 'openai/gpt-oss-20b',
    hf: 'openai/gpt-oss-20b',
    label: 'gpt-oss-20b',
    params: '20B',
    context: 131072,
    // USD per million tokens, approximate — upstream pricing moves.
    price: { in: 0.10, out: 0.50 },
    maxTokens: 2048,
    temperature: 0.7,
  },
  L2: {
    id: 'L2',
    name: 'Broad',
    blurb: 'Drafting, translation, long context, everyday work.',
    groq: 'qwen/qwen3.6-27b',
    hf: 'Qwen/Qwen3.6-27B',
    label: 'qwen3.6-27b',
    params: '27B',
    context: 131072,
    price: { in: 0.32, out: 3.20 },
    maxTokens: 4096,
    temperature: 0.7,
  },
  L3: {
    id: 'L3',
    name: 'Deep',
    blurb: 'Multi-step reasoning, math, architecture, code review.',
    groq: 'openai/gpt-oss-120b',
    hf: 'openai/gpt-oss-120b',
    label: 'gpt-oss-120b',
    params: '120B',
    context: 131072,
    price: { in: 0.15, out: 0.75 },
    maxTokens: 8192,
    temperature: 0.6,
  },
};

export const LANE_IDS = Object.keys(LANES);

/** The arbiter runs on the cheapest, fastest lane so routing stays near-free. */
export const ARBITER_LANE = 'L1';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';

/**
 * Resolve which upstream to talk to. Groq wins when both keys exist.
 * @returns {{name: 'groq'|'hf', url: string, token: string}}
 */
export function resolveUpstream() {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) return { name: 'groq', url: GROQ_URL, token: groqKey };

  const hfToken = process.env.HF_TOKEN;
  if (hfToken) return { name: 'hf', url: HF_URL, token: hfToken };

  return null;
}

/** Map a lane id to the model string this upstream expects. */
export function modelForLane(laneId, upstreamName) {
  const lane = LANES[laneId] || LANES.L2;
  return upstreamName === 'groq' ? lane.groq : lane.hf;
}

/** Coerce anything the client sends into a known lane id. */
export function normalizeLane(value) {
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase();
  if (LANES[upper]) return upper;
  // Tolerate raw model ids so older clients and bookmarks keep working.
  const match = LANE_IDS.find(
    (id) => LANES[id].groq === value.toLowerCase() || LANES[id].hf === value,
  );
  return match || null;
}

/** Strip anything that is not a usable chat turn. */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.content === 'string' && m.content.length > 0)
    .filter((m) => ['system', 'user', 'assistant'].includes(m.role))
    .map((m) => ({ role: m.role, content: m.content.slice(0, 60000) }));
}

/**
 * POST to the upstream chat completions endpoint.
 * Returns the raw fetch Response so callers can stream or buffer.
 */
export async function callUpstream(upstream, body, signal) {
  return fetch(upstream.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${upstream.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}

/** Turn an upstream failure into a message worth showing a person. */
export async function describeUpstreamError(response) {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || parsed?.error || text;
    } catch {
      detail = text;
    }
  } catch {
    detail = '';
  }
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  detail = detail.slice(0, 300);

  switch (response.status) {
    case 401:
    case 403:
      return 'The upstream rejected the API key. Check GROQ_API_KEY or HF_TOKEN in your deployment settings.';
    case 404:
      return `That model is not available on this upstream. ${detail}`;
    case 413:
      return 'The conversation is longer than this model accepts. Start a new thread or trim earlier turns.';
    case 429:
      return 'Rate limit reached upstream. Wait a few seconds and send again.';
    case 503:
      return 'The model is still warming up. Send again in about 30 seconds.';
    default:
      return `Upstream error ${response.status}. ${detail}`;
  }
}

/** Standard CORS + preflight handling. Returns true when the request is done. */
export function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}
