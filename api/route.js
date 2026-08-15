/**
 * The router. Decides which lane answers a turn, based on how hard the turn is.
 *
 * Two stages:
 *   1. Signal scoring   — deterministic, instant, always runs. Produces a prior.
 *   2. Arbiter model    — gpt-oss-20b reads the turn and the prior, and returns
 *                         a lane with a one-line rationale. It may override.
 *
 * If the arbiter is slow, unreachable, or returns something unparseable, the
 * prior stands. Routing never blocks an answer.
 */

import {
  LANES,
  ARBITER_LANE,
  resolveUpstream,
  modelForLane,
  callUpstream,
  handleCors,
} from './_provider.js';

const ARBITER_TIMEOUT_MS = 4000;

/* ---------------------------------------------------------------- signals */

const REASONING_TERMS = [
  'prove', 'proof', 'derive', 'analyz', 'analys', 'compare', 'contrast',
  'differ', 'versus', ' vs ', 'pros and cons',
  'trade-off', 'tradeoff', 'evaluate', 'critique', 'architect', 'design',
  'optimi', 'strategy', 'why does', 'why is', 'explain', 'step by step',
  'reason', 'algorithm', 'complexity', 'theorem', 'integral', 'derivative',
  'probability', 'benchmark', 'root cause', 'diagnose', 'debug', 'trace',
  'plan for', 'model the', 'concurren', 'deadlock', 'race condition',
];

const CODE_TERMS = [
  'function ', 'const ', 'class ', 'import ', 'def ', 'async ', 'return ',
  'refactor', 'stack trace', 'traceback', 'compile', 'segfault', 'null pointer',
  'typescript', 'javascript', 'python', 'rust', 'golang', 'sql query', 'regex',
  'docker', 'kubernetes', 'terraform', 'api endpoint', 'unit test', 'race condition',
  'worker pool', 'mutex', 'null reference',
];

/* Turns that ask for a written artifact carry length, not difficulty. */
const OUTPUT_TERMS = [
  'draft', 'write ', 'compose', 'blog', 'essay', 'email', 'notes', 'outline',
  'documentation', 'report', 'proposal', 'summar', 'script for', 'copy for',
];

const CODE_PATTERNS = [
  /```/,
  /\b\w+\.(js|ts|tsx|jsx|py|rs|go|java|rb|c|cpp|h|sh|sql|yml|yaml|json|css|html)\b/i,
  /\b(npm|pip|cargo|git|curl|kubectl)\s+\w+/i,
  /[{};]\s*$/m,
];

const BREADTH_PATTERNS = [
  /\b(and also|additionally|as well as|then|after that|finally)\b/gi,
  /^\s*(\d+[.)]|[-*])\s+/gm,
];

const PRESSURE_TERMS = [
  "that's wrong", 'thats wrong', 'incorrect', 'not what i asked', 'try again',
  'you missed', 'more detail', 'go deeper', 'still broken', 'doesn’t work',
  "doesn't work", 'nope', 'wrong answer', 'be more thorough', 'you forgot',
];

const SIMPLE_PATTERNS = [
  /^(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|nice|got it)\b/i,
  /^(what|who|when|where)\s+(is|are|was|were)\b/i,
  /^(translate|summari[sz]e|rewrite|shorten|fix the grammar)\b/i,
];

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const countMatches = (text, re) => (text.match(re) || []).length;
const countHits = (text, terms) => terms.reduce((acc, t) => (text.includes(t) ? acc + 1 : acc), 0);

/**
 * Keyword evidence with diminishing returns: one strong hit already means a
 * lot, and the fifth adds little. A flat per-hit score makes real prompts
 * (which rarely trip more than two or three terms) score near zero.
 */
const evidence = (hits, decay) => (hits ? 100 * (1 - decay ** hits) : 0);

/**
 * Score a turn on four axes, then fold them into one complexity number.
 * Every axis is 0-100 so the UI can render them as comparable meters.
 */
export function scoreSignals(prompt, history) {
  const raw = prompt || '';
  const text = raw.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  let reasoning = evidence(countHits(text, REASONING_TERMS), 0.55);
  if (/[∑∫√≈≤≥π]|\b\d+\s*[\^*/]\s*\d+/.test(raw)) reasoning += 20;
  if (countMatches(text, /\?/g) > 1) reasoning += 10;

  const codeHits =
    countHits(text, CODE_TERMS) + CODE_PATTERNS.filter((re) => re.test(raw)).length;
  const code = evidence(codeHits, 0.5);

  // Length is one reading of breadth; asking for a written artifact is another.
  const lengthScore = Math.min(70, (words / 50) * 70);
  const listScore = BREADTH_PATTERNS.reduce(
    (acc, re) => acc + Math.min(25, countMatches(text, re) * 9),
    0,
  );
  const outputScore = evidence(countHits(text, OUTPUT_TERMS), 0.6);
  const breadth = Math.max(lengthScore + listScore, outputScore);

  const historyChars = (history || []).reduce((acc, m) => acc + (m.content?.length || 0), 0);
  const context = Math.min(100, (historyChars / 12000) * 100);

  const pressure = evidence(countHits(text, PRESSURE_TERMS), 0.4);

  const signals = {
    reasoning: clamp(reasoning),
    code: clamp(code),
    breadth: clamp(breadth),
    context: clamp(context),
  };

  let complexity =
    signals.reasoning * 0.34 +
    signals.code * 0.30 +
    signals.breadth * 0.26 +
    signals.context * 0.10;

  complexity += signals.reasoning && signals.code ? 6 : 0; // both firing compounds
  complexity += clamp(pressure) * 0.25; // dissatisfaction escalates the next turn

  // "Summarise this" is trivial; "summarise this and list the open questions"
  // is two asks wearing the same opener, so a coordinator disqualifies it.
  const isSimple =
    words <= 12 &&
    !/\band\b/.test(text) &&
    SIMPLE_PATTERNS.some((re) => re.test(raw.trim()));
  if (isSimple) complexity *= 0.4;

  return { signals, complexity: clamp(complexity), pressure: clamp(pressure), words };
}

/**
 * L2 is the default lane, not L1. A turn has to earn its way down to the fast
 * lane by being demonstrably trivial, or up to the deep lane by being
 * demonstrably hard. Climbing from zero would leave everything in L1.
 */
export function laneFromScore({ signals, complexity, words }) {
  if (complexity >= 55) return 'L3';
  if (signals.code >= 55 && signals.reasoning >= 35) return 'L3';
  // Maths and proofs carry no code signal at all, so reasoning alone qualifies.
  if (signals.reasoning >= 78) return 'L3';
  if (complexity <= 8 && words <= 14 && signals.code < 25) return 'L1';
  return 'L2';
}

function heuristicReason({ signals, complexity }, lane) {
  const ranked = Object.entries(signals).sort((a, b) => b[1] - a[1]);
  const [topName, topValue] = ranked[0];
  if (lane === 'L1') return 'Short, self-contained ask';
  if (topValue < 25) return `Moderate load, complexity ${complexity}`;
  const phrases = {
    reasoning: 'Multi-step reasoning required',
    code: 'Code and tooling in scope',
    breadth: 'Several asks in one turn',
    context: 'Long thread to carry forward',
  };
  return phrases[topName];
}

/* ---------------------------------------------------------------- arbiter */

const ARBITER_SYSTEM = `You route one chat turn to one of three models. Answer with JSON only.

L1 gpt-oss-20b  — greetings, lookups, rewrites, translation, short factual answers.
L2 qwen3.6-27b  — drafting, summarising long text, explanation, everyday multi-part work.
L3 gpt-oss-120b — multi-step reasoning, math, debugging, architecture, code review, anything where a wrong answer is expensive.

Pick the cheapest lane that will produce a genuinely good answer. Do not pick L3 for tone or length alone.

Reply with exactly: {"lane":"L1"|"L2"|"L3","complexity":<0-100>,"why":"<at most 9 words>"}`;

function parseArbiter(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!LANES[parsed.lane]) return null;
    return {
      lane: parsed.lane,
      complexity: clamp(Number(parsed.complexity) || 0),
      why: String(parsed.why || '').slice(0, 80),
    };
  } catch {
    return null;
  }
}

async function askArbiter(upstream, prompt, prior) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARBITER_TIMEOUT_MS);

  try {
    const response = await callUpstream(
      upstream,
      {
        model: modelForLane(ARBITER_LANE, upstream.name),
        messages: [
          { role: 'system', content: ARBITER_SYSTEM },
          {
            role: 'user',
            content: `Signal prior: ${JSON.stringify(prior.signals)} (complexity ${prior.complexity}).\n\nTurn:\n"""${prompt.slice(0, 3000)}"""`,
          },
        ],
        max_tokens: 120,
        temperature: 0,
        response_format: { type: 'json_object' },
      },
      controller.signal,
    );

    if (!response.ok) return null;
    const data = await response.json();
    return parseArbiter(data.choices?.[0]?.message?.content);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- handler */

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const upstream = resolveUpstream();
  if (!upstream) {
    return res
      .status(500)
      .json({ error: 'No upstream configured. Set GROQ_API_KEY or HF_TOKEN.' });
  }

  const started = Date.now();
  const { prompt = '', history = [], useArbiter = true } = req.body || {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  const prior = scoreSignals(prompt, history);
  let lane = laneFromScore(prior);
  let complexity = prior.complexity;
  let why = heuristicReason(prior, lane);
  let decidedBy = 'signals';

  if (useArbiter) {
    const verdict = await askArbiter(upstream, prompt, prior);
    if (verdict) {
      lane = verdict.lane;
      // Blend so the meter reflects both readings rather than lurching.
      complexity = clamp((verdict.complexity + prior.complexity) / 2);
      why = verdict.why || why;
      decidedBy = 'arbiter';
    }
  }

  // A turn that pushes back on the last answer never routes below L2.
  if (prior.pressure >= 30 && lane === 'L1') {
    lane = 'L2';
    why = 'Follow-up on an unsatisfying answer';
    decidedBy = decidedBy === 'arbiter' ? 'arbiter+rule' : 'rule';
  }

  return res.status(200).json({
    lane,
    complexity,
    why,
    decidedBy,
    signals: prior.signals,
    latencyMs: Date.now() - started,
    upstream: upstream.name,
    model: LANES[lane].label,
  });
}
