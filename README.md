# image-pruner

Pi extension that keeps long visual sessions alive on servers with a hard
per-prompt image cap.

## Problem

Pi sends its **full conversation history** on every LLM call, with images
stored inline (base64) in tool results / user messages. Some servers
hard-reject requests that carry too many image blocks:

- `ds4-server` (antirez): `if (count > 16) -> 400 "too many images; at most 16 are allowed"`
- vLLM: `--limit-mm-per-prompt {"image":4}` -> `400 "At most 4 image(s) may be provided in one prompt"`

The count is the **total** images across the whole request. So a long
visual workflow (e.g. 17+ document screenshots) bricks the session: every
subsequent call 400s forever — compaction can't run either (its
summarization call 400s too), and forking copies the images along.

## How it works

The `context` hook fires before every main-loop LLM call with a **deep
copy** of the outgoing messages. The handler:

1. Counts image blocks across the whole request (tool results + user
   messages).
2. If the total exceeds the limit, replaces the **oldest** images with
   one-line text placeholders that keep the source (file path / URL from
   the matching tool call) so the model can re-read the file if it needs
   the pixels again.
3. The session file is **never modified** — only the outgoing payload.
   History, fork, and resume keep the original images; pruning is
   recomputed per call.

Under the limit, the message list is returned unchanged, so the provider's
prefix cache stays warm.

Not a tool: hooks only, zero model-visible surface, negative token impact
(removes base64), no provider changes. Compaction's summarization call is
text-only (pi strips images when building the summary prompt) and is
already under any cap.

## Per-provider limits

Limit resolution order (per LLM call):

1. **`PI_IMAGE_PRUNE_LIMIT`** — explicit operator pin, always wins
   (`0` disables pruning).
2. **Live current model's provider** (`ctx.model.provider`), matched
   against the `PROVIDER_LIMITS` map by substring. No env needed;
   follows `/model` switches and mid-session model changes.
3. **Legacy `PI_PROVIDER` env** — fallback only, for processes where
   `ctx.model` is undefined.
4. **Default 12** — ds4-server 16-cap minus headroom.

| provider (substring) | keep | why |
|---|---|---|
| `vh114` | 3 | vLLM box launched with `--limit-mm-per-prompt {"image":4}` |
| *(none / other)* | 12 | default: ds4-server 16-cap minus headroom |

Why live resolution: a stale per-process `PI_PROVIDER` pin outlived a
server switch (2026-09-28 incident — pin said ds4/16, session was on
vh114/4, and every call after a compaction 400'd with `At most 4
image(s)`).

Add new servers to the `PROVIDER_LIMITS` map in the file:
`keep = server cap - 1` headroom.

## Install

Drop `image-pruner.ts` into `~/.pi/agent/extensions/` (global) or
`.pi/extensions/` (project-local). Auto-discovered; `/reload` to pick up
changes in a running session.

## Tuning

```
PI_IMAGE_PRUNE_LIMIT=8   lower the keep-window (pin always wins, logged via=pin)
PI_IMAGE_PRUNE_LIMIT=0   disable pruning
```

## Audit

One line per prune event: `~/.pi/agent/logs/image-pruner.log`

```
2026-09-28T18:49:00.613Z pruned 7 (had 10, kept 3) via=live provider=vh114; sources: read /tmp/x/p0.png; read /tmp/x/p1.png
```

`via` is the resolution path: `pin` (env), `live` (current model's
provider), `legacy-env` (fallback `PI_PROVIDER`), or `default`.

## Revert

Delete the file (or `/reload` after deleting).

## Changelog

- **1.1.0** (2026-09-28): per-provider limit resolved LIVE from the
  current model's provider (no `PI_PROVIDER` env needed); env pin and
  legacy env kept; audit lines carry `via=` + `provider=`. Driven by the
  2026-09-28 vh114 incident (stale `PI_PROVIDER=ds4` pin on a vLLM
  4-image-cap server → verbatim `At most 4 image(s)` 400s after
  compaction; reproduced live).
- **1.0.0** (2026-09-12): initial — per-provider pruning with
  `PI_PROVIDER`-driven limits, oldest-first placeholder swap, fail-open,
  audit log.
