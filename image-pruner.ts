/**
 * image-pruner.ts  (F3a)
 *
 * ds4-server (antirez) hard-rejects any chat completion request carrying
 * more than 16 image blocks: ds4_server.c `if (count > 16) -> 400 "too
 * many images; at most 16 are allowed"`. The count is the TOTAL images
 * across the whole request, and pi sends its full history on every LLM
 * call with images stored inline (base64) in tool results / user
 * messages. So a long visual workflow (17+ PNG reads) bricks the session:
 * every subsequent call 400s forever, compaction can't run (its
 * summarization call 400s too), and forking copies the images along.
 *
 * Fix: the `context` hook fires before every main-loop LLM call with a
 * DEEP COPY of the outgoing messages. This handler counts image blocks;
 * if the total exceeds the limit (default 12 = 16 hard cap minus 4
 * headroom), the OLDEST images are replaced with one-line text
 * placeholders that keep the source (file path / URL from the matching
 * tool call) so the model can re-read the file if it needs the pixels
 * again. The session file is never modified — only the outgoing payload —
 * so history, fork, and resume keep the original images; pruning is
 * recomputed per call. (Compaction's summarization call is text-only —
 * pi strips images when building the summary prompt — so it is already
 * under the cap and is not hooked.)
 *
 * Not a tool: hooks only, zero model-visible surface, negative token
 * impact (removes base64), no provider changes.
 *
 * Tuning:  PI_IMAGE_PRUNE_LIMIT=8   (lower the keep-window; 0 disables)
 *          unset + PI_PROVIDER=vh114 -> 3 (vLLM 4-image cap, per-provider map)
 * Revert:  delete this file (or /reload after deleting).
 * Audit:   ~/.pi/agent/logs/image-pruner.log  (one line per prune event)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_LIMIT = 12; // ds4 hard cap is 16; keep 4 of headroom.

// Per-provider hard caps (keep = cap - 1 headroom). Checked when no explicit
// PI_IMAGE_PRUNE_LIMIT is set. PI_PROVIDER is per-process: if the user switches
// provider mid-session the stale value errs safe (over-prunes) at worst; set
// PI_IMAGE_PRUNE_LIMIT explicitly to pin.
const PROVIDER_LIMITS: Record<string, number> = {
	vh114: 3, // vLLM box launched with --limit-mm-per-prompt {"image":4} (see run script)
};

function pruneLimit(): number {
	const raw = process.env.PI_IMAGE_PRUNE_LIMIT;
	if (raw !== undefined) {
		const n = Number.parseInt(raw, 10);
		if (Number.isFinite(n)) return n;
	}
	const prov = (process.env.PI_PROVIDER ?? "").toLowerCase();
	for (const [k, v] of Object.entries(PROVIDER_LIMITS)) {
		if (prov.includes(k)) return v;
	}
	return DEFAULT_LIMIT;
}

interface ContentBlock {
	type: string;
	[key: string]: unknown;
}
interface AnyMessage {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
}

function asBlocks(content: unknown): ContentBlock[] | null {
	if (!Array.isArray(content)) return null;
	const out: ContentBlock[] = [];
	for (const b of content) {
		if (b && typeof b === "object" && typeof (b as ContentBlock).type === "string") {
			out.push(b as ContentBlock);
		}
	}
	return out;
}

function isImageBlock(b: ContentBlock): boolean {
	return b.type === "image";
}

/** Extract a human-readable source (file path / URL) from tool-call arguments. */
function sourceFromArgs(args: unknown): string | undefined {
	let obj: unknown = args;
	if (typeof obj === "string") {
		try {
			obj = JSON.parse(obj);
		} catch {
			return undefined;
		}
	}
	if (typeof obj !== "object" || obj === null) return undefined;
	const o = obj as Record<string, unknown>;
	for (const key of ["path", "url", "file", "filename", "filePath", "target"]) {
		const v = o[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function appendAudit(line: string): void {
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
		const dir = path.join(agentDir, "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "image-pruner.log"), line + "\n");
	} catch {
		/* audit log must never break the session */
	}
}

export default function imagePruner(pi: ExtensionAPI) {
	pi.on("context", async (event) => {
		try {
			const limit = pruneLimit();
			if (limit <= 0) return; // disabled

			const messages = event.messages as AnyMessage[];

			// 1) Map tool-call id -> { toolName, source } from all assistant messages.
			const callInfo = new Map<string, { name: string; source?: string }>();
			for (const m of messages) {
				if (m.role !== "assistant") continue;
				const blocks = asBlocks(m.content);
				if (!blocks) continue;
				for (const b of blocks) {
					if (b.type !== "toolCall") continue;
					const id = b.id;
					const name = typeof b.name === "string" ? b.name : "tool";
					if (typeof id === "string" && id) {
						callInfo.set(id, { name, source: sourceFromArgs(b.arguments) });
					}
				}
			}

			// 2) Collect every image block in message order (oldest first).
			const images: {
				msg: AnyMessage;
				idx: number;
				label: string;
				mimeType: string;
			}[] = [];
			for (const m of messages) {
				if (typeof m.content !== "object" || m.content === null || !Array.isArray(m.content)) continue;
				const raw = m.content as unknown[];
				if (m.role === "toolResult") {
					const info = (m.toolCallId && callInfo.get(m.toolCallId)) || undefined;
					const name = (m.toolName as string) || info?.name || "tool";
					const source = info?.source;
					const label = source ? `${name} ${source}` : `tool result of ${name}`;
					raw.forEach((b, idx) => {
						const blk = b as ContentBlock;
						if (blk && typeof blk === "object" && isImageBlock(blk)) {
							images.push({
								msg: m,
								idx,
								label,
								mimeType: typeof blk.mimeType === "string" ? blk.mimeType : "image",
							});
						}
					});
				} else if (m.role === "user") {
					raw.forEach((b, idx) => {
						const blk = b as ContentBlock;
						if (blk && typeof blk === "object" && isImageBlock(blk)) {
							images.push({
								msg: m,
								idx,
								label: "user-provided",
								mimeType: typeof blk.mimeType === "string" ? blk.mimeType : "image",
							});
						}
					});
				}
			}

			if (images.length <= limit) return; // nothing to prune

			// 3) Replace the OLDEST (images.length - limit) images with placeholders.
			const toPrune = images.length - limit;
			const pruned = images.slice(0, toPrune);
			for (const img of pruned) {
				const hint = img.label === "user-provided"
					? "original not recoverable"
					: img.label.startsWith("read ") || img.label.includes("http")
						? "re-read the source to see it again"
						: "re-run the tool if needed";
				// Replace in the ORIGINAL content array of the (cloned) message:
				// asBlocks() returns a fresh wrapper array; mutating it would be lost.
				const original = img.msg.content as ContentBlock[];
				original[img.idx] = {
					type: "text",
					text: `[image pruned (over provider image cap; keeping newest ${limit}): ${img.label} (${img.mimeType}) - ${hint}]`,
				};
			}

			appendAudit(
				`${new Date().toISOString()} pruned ${toPrune} (had ${images.length}, kept ${limit}); ` +
					`sources: ${pruned.map((p) => p.label).slice(0, 8).join("; ")}`,
			);
			// Mutations were made on the (deep-copied) messages in-place AND returned
			// explicitly, per the context-hook contract.
			return { messages: event.messages };
		} catch {
			/* fail-open: any internal error leaves the payload untouched */
		}
	});
}
