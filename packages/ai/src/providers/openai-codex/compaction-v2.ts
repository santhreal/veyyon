/**
 * Codex remote compaction v2: the wire the ChatGPT Codex backend serves.
 *
 * `packages/ai/src/providers/openai-compaction.ts` posts it for every
 * `openai-codex-responses` model and reads the stream through
 * {@link collectCodexCompactionV2Stream}, and
 * `@veyyon/agent-core/compaction/remote-compaction` declares the matching
 * `responses_compaction_v2` metadata. The route and the declaration are one
 * decision and move together.
 *
 * READ THIS BEFORE REWIRING ANYTHING HERE. The two candidate wires have traded
 * places more than once, so each move is a live measurement rather than a
 * reading of the OpenAI compaction guide, which documents the official host
 * only. On 2026-08-29 a live call found `POST {base}/codex/responses/compact`,
 * `{base}/codex/compact` and `{base}/responses/compact` all answering 404,
 * while the ordinary responses route answered a compaction-marked request with
 * an ordinary turn; a later session on the same account got a 404 from the
 * streaming route instead, and this module was retired in favour of the
 * compact route. That was wrong, and it shipped: with the compact route live,
 * every codex compaction answered 404 and fell back to a paid local pass.
 * Re-measured on 2026-09-01 against a ChatGPT account on `gpt-5.6-sol`:
 * `{base}/codex/responses/compact` answered `404 Not Found`, and the same span
 * posted here answered `200` with exactly one `compaction` item carrying a
 * 1740-character `encrypted_content` (usage in=639, out=116).
 *
 * The mechanism this module implements is an input item. Appending
 * `{ type: "compaction_trigger" }` to an otherwise-normal streaming Responses
 * request makes the backend emit exactly one `compaction` output item carrying
 * `encrypted_content`, and nothing else. codex-rs does this in
 * `core/src/compact_remote_v2.rs`; this module mirrors it.
 *
 * Two consequences shape the code below:
 *
 * - The request streams. A body without `stream: true` was rejected with 400
 *   `{"detail":"Stream must be set to true"}`.
 * - The window is assembled here, not returned by the host. `response.completed`
 *   carries an empty `output`; the compaction item arrives on
 *   `response.output_item.done`. The replacement history is the retained real
 *   user messages of the span followed by that item, which is what the caller
 *   stores and replays.
 */

import { clampLow, logger } from "@veyyon/utils";
import { readSseJson } from "@veyyon/utils/stream";
import { isRecord } from "@veyyon/utils/type-guards";

/** The input item that turns a normal responses request into a compaction. */
export const CODEX_COMPACTION_TRIGGER_ITEM: Readonly<Record<string, string>> = { type: "compaction_trigger" };

/** Retained-message budget codex-rs applies to the replacement history. */
export const CODEX_COMPACTION_V2_RETAINED_TOKEN_BUDGET = 64_000;

/**
 * Image cost estimate for the retained budget. OpenAI meters an image by detail
 * and dimensions; the common high-detail 1024px path is charged so a retained
 * image history cannot be unbounded.
 */
const IMAGE_TOKEN_ESTIMATE = 765;

/**
 * User messages the session injects around the real ones. They are rebuilt on
 * every turn, so retaining them across a compaction duplicates them.
 *
 * Exported so a test can sweep every member rather than restate the list: a
 * prefix added here without working is then a red test, not a silent leak of a
 * synthesized turn into the retained window.
 */
export const CONTEXTUAL_USER_PREFIXES = [
	"<environment_context>",
	"<user_instructions>",
	"<additional_context>",
	"<skills",
	"<token_budget>",
	"<model_switch>",
];

/** Token usage reported by the terminal event of a v2 compaction stream. */
export interface CodexCompactionV2Usage {
	inputTokens?: number;
	outputTokens?: number;
}

/** What the v2 stream yielded: the one compaction item, and the usage beside it. */
export interface CodexCompactionV2StreamResult {
	compactionItem: Record<string, unknown>;
	usage?: CodexCompactionV2Usage;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" ? value : undefined;
}

/** One event of the compaction stream, read structurally rather than by wire union. */
interface CodexCompactionV2Event {
	type?: string;
	item?: unknown;
	response?: unknown;
	error?: unknown;
}

function readUsage(response: unknown): CodexCompactionV2Usage | undefined {
	if (!isRecord(response)) return undefined;
	const usage = response.usage;
	if (!isRecord(usage)) return undefined;
	const input = usage.input_tokens;
	const output = usage.output_tokens;
	const inputTokens = typeof input === "number" && Number.isFinite(input) ? input : undefined;
	const outputTokens = typeof output === "number" && Number.isFinite(output) ? output : undefined;
	if (inputTokens === undefined && outputTokens === undefined) return undefined;
	return { inputTokens, outputTokens };
}

function describeFailure(event: CodexCompactionV2Event, type: string, sanitize: (text: string) => string): string {
	const fromResponse = isRecord(event.response) && isRecord(event.response.error) ? event.response.error : undefined;
	const error = isRecord(event.error) ? event.error : fromResponse;
	const message = error ? stringField(error, "message") : undefined;
	const code = error ? (stringField(error, "code") ?? stringField(error, "type")) : undefined;
	return `Codex compaction stream ${type}${code ? ` (${sanitize(code)})` : ""}${message ? `: ${sanitize(message)}` : ""}`;
}

/**
 * Read a v2 compaction stream down to its single compaction item.
 *
 * Exactly one is required, and it must carry its blob. Zero means the backend
 * ran the span as a turn — the trigger item did not take — and more than one
 * means the window would be ambiguous. A `compaction` item with no
 * `encrypted_content` is the third shape: it looks compacted to the transport
 * and is rejected later as an unusable window, which re-expands the whole span
 * on the next turn. All three are failures the caller turns into a local pass
 * rather than storing a history that does not compact.
 */
export async function collectCodexCompactionV2Stream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
	sanitize: (text: string) => string,
): Promise<CodexCompactionV2StreamResult> {
	const compactionItems: Array<Record<string, unknown>> = [];
	let malformedCompactionItems = 0;
	let outputItemCount = 0;
	let sawCompleted = false;
	let usage: CodexCompactionV2Usage | undefined;

	for await (const event of readSseJson<CodexCompactionV2Event>(body, signal)) {
		if (!isRecord(event)) continue;
		const type = typeof event.type === "string" ? event.type : undefined;
		if (type === "response.output_item.done") {
			outputItemCount++;
			if (isRecord(event.item) && event.item.type === "compaction") {
				// The blob IS the compacted history. An item without one carries no
				// window, so counting it as the compaction item stores an entry that
				// every later turn discards.
				if (typeof event.item.encrypted_content === "string") compactionItems.push(event.item);
				else malformedCompactionItems++;
			}
			continue;
		}
		if (type === "response.completed") {
			sawCompleted = true;
			usage = readUsage(event.response);
			continue;
		}
		if (type === "response.failed" || type === "response.incomplete" || type === "error") {
			throw new Error(
				`${describeFailure(event, type, sanitize)}. The history was NOT compacted; the caller falls back to local compaction.`,
			);
		}
	}

	if (!sawCompleted) {
		throw new Error(
			"Codex compaction stream closed before response.completed. The history was NOT compacted; the caller falls back to local compaction.",
		);
	}
	if (malformedCompactionItems > 0 && compactionItems.length === 0) {
		throw new Error(
			`Codex compaction returned ${malformedCompactionItems} compaction items with no encrypted_content. The history was NOT compacted; the caller falls back to local compaction.`,
		);
	}
	const compactionItem = compactionItems[0];
	if (compactionItems.length !== 1 || !compactionItem) {
		throw new Error(
			`Codex compaction returned ${compactionItems.length} compaction items among ${outputItemCount} output items, expected exactly one. The history was NOT compacted; the caller falls back to local compaction.`,
		);
	}
	logger.debug("Codex compaction stream produced its window", { outputItemCount, ...usage });
	return { compactionItem, usage };
}

function approxTokenCount(text: string): number {
	return Math.ceil(text.length / 4);
}

function contentParts(item: Record<string, unknown>): unknown[] {
	return Array.isArray(item.content) ? item.content : [];
}

/**
 * A real user turn: a user message the session did not synthesize around it.
 *
 * `type` is optional on a Responses input message and `buildResponsesInput`
 * omits it for user items, so requiring `type === "message"` here retained
 * nothing and every window came back as the bare compaction item.
 */
function isRetainedUserMessage(item: unknown): item is Record<string, unknown> {
	if (!isRecord(item) || stringField(item, "role") !== "user") return false;
	if (item.type !== undefined && item.type !== "message") return false;
	return !contentParts(item).some(part => {
		if (!isRecord(part) || part.type !== "input_text") return false;
		const text = stringField(part, "text")?.trimStart().toLowerCase();
		return text !== undefined && CONTEXTUAL_USER_PREFIXES.some(prefix => text.startsWith(prefix));
	});
}

function messageTokenCount(item: Record<string, unknown>): number {
	let tokens = 0;
	for (const part of contentParts(item)) {
		if (!isRecord(part)) continue;
		if (part.type === "input_image") {
			tokens += IMAGE_TOKEN_ESTIMATE;
			continue;
		}
		if (part.type === "input_text" || part.type === "output_text") {
			tokens += approxTokenCount(stringField(part, "text") ?? "");
		}
	}
	return tokens;
}

function truncateText(text: string, maxTokens: number): string {
	if (maxTokens <= 0) return "";
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	const omittedTokens = Math.max(1, approxTokenCount(text) - maxTokens);
	const marker = `…${omittedTokens} tokens truncated…`;
	if (maxChars <= marker.length + 2) return text.slice(0, maxChars);
	const sideChars = Math.max(1, Math.floor((maxChars - marker.length) / 2));
	return `${text.slice(0, sideChars)}${marker}${text.slice(-sideChars)}`;
}

function truncateMessage(item: Record<string, unknown>, maxTokens: number): Record<string, unknown> | undefined {
	let remaining = maxTokens;
	const kept: unknown[] = [];
	for (const part of contentParts(item)) {
		if (!isRecord(part)) continue;
		if (part.type === "input_image") {
			if (remaining < IMAGE_TOKEN_ESTIMATE) continue;
			kept.push(part);
			remaining -= IMAGE_TOKEN_ESTIMATE;
			continue;
		}
		if (part.type !== "input_text" && part.type !== "output_text") continue;
		if (remaining === 0) continue;
		const text = stringField(part, "text") ?? "";
		const tokens = approxTokenCount(text);
		if (tokens <= remaining) {
			kept.push(part);
			remaining -= tokens;
			continue;
		}
		const truncated = truncateText(text, remaining);
		remaining = 0;
		if (truncated.length > 0) kept.push({ ...part, text: truncated });
	}
	return kept.length > 0 ? { ...item, content: kept } : undefined;
}

/**
 * The canonical next window: the span's real user messages, newest first until
 * the budget runs out, followed by the compaction item that stands for
 * everything else. The host returns no window of its own under v2, so this is
 * the artifact the caller stores and replays.
 */
export function buildCodexCompactionV2Window(
	input: readonly unknown[],
	compactionItem: Record<string, unknown>,
	budgetTokens = CODEX_COMPACTION_V2_RETAINED_TOKEN_BUDGET,
): Array<Record<string, unknown>> {
	const retained = input.filter(isRetainedUserMessage);
	let remaining = clampLow(Math.floor(budgetTokens), 1, CODEX_COMPACTION_V2_RETAINED_TOKEN_BUDGET);
	const window: Array<Record<string, unknown>> = [];
	for (let index = retained.length - 1; index >= 0 && remaining > 0; index--) {
		const item = retained[index];
		if (!item) continue;
		const tokens = Math.max(messageTokenCount(item), 1);
		if (tokens <= remaining) {
			window.push(item);
			remaining -= tokens;
			continue;
		}
		const truncated = truncateMessage(item, remaining);
		remaining = 0;
		if (truncated) window.push(truncated);
	}
	window.reverse();
	window.push(compactionItem);
	return window;
}
