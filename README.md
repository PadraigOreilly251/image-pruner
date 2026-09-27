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

| `PI_PROVIDER` (substring) | keep | why |
|---|---|---|
| `vh114` | 3 | vLLM box launched with `--limit-mm-per-prompt {"image":4}` |
| *(none / other)* | 12 | default: ds4-server 16-cap minus headroom |

`PI_PROVIDER` is read per-process. If you switch provider mid-session the
stale value errs safe (over-prunes, never under). Set
`PI_IMAGE_PRUNE_LIMIT` explicitly to pin.

## Install

Drop `image-pruner.ts` into `~/.pi/agent/extensions/` (global) or
`.pi/extensions/` (project-local). Auto-discovered; `/reload` to pick up
changes in a running session.

## Tuning

```
PI_IMAGE_PRUNE_LIMIT=8   lower the keep-window (env always wins)
PI_IMAGE_PRUNE_LIMIT=0   disable pruning
```

Add new servers to the `PROVIDER_LIMITS` map in the file:
`keep = server cap - 1` headroom.

## Audit

One line per prune event: `~/.pi/agent/logs/image-pruner.log`

```
2026-09-26T20:33:35.284Z pruned 2 (had 14, kept 12); sources: read /tmp/wh_e.png; read /tmp/wh_wide.png
```

## Revert

Delete the file (or `/reload` after deleting).
