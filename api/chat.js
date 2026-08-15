/**
 * Chat completion proxy. Talks to Groq when GROQ_API_KEY is set, otherwise to
 * the Hugging Face router. The upstream key never reaches the browser.
 *
 * Accepts a lane id (L1 / L2 / L3) rather than a raw model string, so the
 * server stays the single source of truth for which models are in the roster.
 *
 * Intents:
 *   chat  (default) — stream or buffer an assistant turn
 *   title           — one short thread title, always on the cheapest lane
 */

import {
  LANES,
  resolveUpstream,
  modelForLane,
  normalizeLane,
  sanitizeMessages,
  callUpstream,
  describeUpstreamError,
  handleCors,
} from './_provider.js';

const TITLE_SYSTEM =
  'Write a title for this conversation: 2 to 5 words, sentence case, no quotes, no trailing period. Reply with the title only.';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const upstream = resolveUpstream();
  if (!upstream) {
    return res.status(500).json({
      error:
        'No upstream configured. Add GROQ_API_KEY (recommended) or HF_TOKEN to your environment variables.',
    });
  }

  try {
    const {
      messages,
      lane: rawLane,
      model,
      intent = 'chat',
      parameters = {},
      stream = false,
    } = req.body || {};

    const history = sanitizeMessages(messages);
    if (!history.length) {
      return res.status(400).json({ error: 'Missing or invalid messages array' });
    }

    if (intent === 'title') {
      return await handleTitle(res, upstream, history);
    }

    const laneId = normalizeLane(rawLane) || normalizeLane(model) || 'L2';
    const lane = LANES[laneId];

    const payload = {
      model: modelForLane(laneId, upstream.name),
      messages: history,
      max_tokens: clampNumber(
        parameters.max_tokens ?? parameters.max_new_tokens,
        256,
        lane.maxTokens,
        lane.maxTokens,
      ),
      temperature: clampNumber(parameters.temperature, 0, 2, lane.temperature),
      top_p: clampNumber(parameters.top_p, 0.1, 1, 0.95),
      stream,
    };

    // Groq reports token usage in a trailing stream chunk when asked to.
    if (stream && upstream.name === 'groq') {
      payload.stream_options = { include_usage: true };
    }

    const response = await callUpstream(upstream, payload);

    if (!response.ok) {
      const message = await describeUpstreamError(response);
      return res.status(response.status).json({ error: message, lane: laneId });
    }

    res.setHeader('X-Nova-Lane', laneId);
    res.setHeader('X-Nova-Model', lane.label);
    res.setHeader('X-Nova-Upstream', upstream.name);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
          if (typeof res.flush === 'function') res.flush();
        }
      } catch (streamErr) {
        // The client hung up, or the upstream cut the connection mid-answer.
        res.write(
          `data: ${JSON.stringify({ error: streamErr.message || 'Stream interrupted' })}\n\n`,
        );
      }
      return res.end();
    }

    const data = await response.json();
    return res.status(200).json({
      choices: data.choices,
      usage: data.usage || null,
      lane: laneId,
      model: lane.label,
      upstream: upstream.name,
      generated_text: data.choices?.[0]?.message?.content || '',
    });
  } catch (err) {
    console.error('Chat proxy error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'The request failed before it reached the model.' });
  }
}

async function handleTitle(res, upstream, history) {
  const seed = history.filter((m) => m.role !== 'system').slice(0, 2);
  const response = await callUpstream(upstream, {
    model: modelForLane('L1', upstream.name),
    messages: [
      { role: 'system', content: TITLE_SYSTEM },
      { role: 'user', content: seed.map((m) => `${m.role}: ${m.content}`).join('\n\n').slice(0, 2000) },
    ],
    max_tokens: 24,
    temperature: 0.3,
    stream: false,
  });

  if (!response.ok) {
    return res.status(200).json({ title: null });
  }

  const data = await response.json();
  const title = (data.choices?.[0]?.message?.content || '')
    .replace(/^["'\s]+|["'\s.]+$/g, '')
    .slice(0, 48);

  return res.status(200).json({ title: title || null });
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
