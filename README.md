# Nova — Model Router

A chat app that picks the model for you. Every turn is scored for difficulty and
routed to the cheapest model that can answer it well.

## Lanes

Three models, GPT OSS and Qwen only:

| Lane | Model | Handles | USD / 1M tokens |
| --- | --- | --- | --- |
| **L1 Swift** | `gpt-oss-20b` | Lookups, rewrites, translation, short answers | 0.10 in · 0.50 out |
| **L2 Broad** | `qwen3.6-27b` | Drafting, explanation, long context, everyday work | 0.32 in · 3.20 out |
| **L3 Deep** | `gpt-oss-120b` | Multi-step reasoning, math, debugging, code review | 0.15 in · 0.75 out |

Prices are approximate and move with the upstream provider.

`llama-3.3-70b-versatile` was decommissioned on GroqCloud on 2026-08-16 and is
not in the roster. Neither are the Mistral, Zephyr and Phi entries the app used
to list.

## How routing works

Each turn goes through `/api/route` before it is answered:

1. **Signal scoring** — deterministic and instant. Four axes, each 0–100:
   `reasoning`, `code`, `breadth`, `context`. Keyword evidence uses diminishing
   returns, so one strong hit already counts and the fifth adds little.
2. **Arbiter** — `gpt-oss-20b` reads the turn plus the scores and returns a lane
   with a one-line rationale, in JSON, capped at 120 tokens. It can override the
   signal reading.

L2 is the default. A turn has to earn its way *down* to L1 by being
demonstrably trivial, or *up* to L3 by being demonstrably hard.

If the arbiter is slow (4s budget), unreachable, or returns something
unparseable, the signal score stands. If `/api/route` itself fails, the browser
falls back to its own copy of the scorer. Routing never blocks an answer.

Two rules sit on top of the model's judgement:

- A turn that pushes back on the previous answer ("that's wrong", "go deeper")
  never routes below L2.
- **Escalate to L3** on any answer re-runs the turn on `gpt-oss-120b`.

Every answer is stamped with the lane, the complexity reading, the rationale,
and what it cost. Pin a lane with the `AUTO · L1 · L2 · L3` switch to bypass
routing entirely.

## Features

Threads with search, pinning, rename, and Markdown / JSON export · streaming
with stop · retry and escalate · edit and resend · automatic thread naming ·
system prompt with presets · temperature and response limit · command palette
(`Ctrl K`) · light and dark · keyboard shortcuts · full mobile layout.

Threads are stored in `localStorage` only — nothing is persisted server-side.

## Deployment

Set **one** of these environment variables in your Vercel project. Groq wins
when both are present.

| Variable | Upstream |
| --- | --- |
| `GROQ_API_KEY` | `api.groq.com` |
| `HF_TOKEN` | `router.huggingface.co` |

Then import the repo at [vercel.com](https://vercel.com) and deploy. The key
never reaches the browser; `/api/chat` and `/api/route` proxy every call.

## Local development

```
npx vercel dev
```

Needs the same environment variable in a `.env` file. There is no build step.

## Stack

Vanilla HTML/CSS/JS, no framework · Vercel serverless functions · marked +
highlight.js from CDN (the app degrades to a built-in renderer if either fails
to load).
