/**
 * Context-reducing surgical compaction ("shake").
 *
 * `shake` drops heavy content out of the live context mechanically: whole
 * tool-call results and large fenced/XML blocks are replaced with short
 * placeholders. This module is the pure layer — region detection and in-place
 * mutation only. Artifact offload, persistence, and provider-session teardown
 * are orchestrated by the caller (`AgentSession.shake`).
 *
 * Layering mirrors `pruning.ts`: no I/O here.
 */

import type { TextContent, ToolResultMessage } from "@veyyon/ai";
import { countTokens } from "../tokenizer";
import type { AgentMessage, AgentToolCall } from "../types";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "./entries";
import { getToolResultMessage, resolveCompactionBoundaryIndex } from "./entries";
import { estimateTokens } from "./token-estimate";
import {
	collectToolCallsById,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";

export interface ShakeConfig {
	/** Keep the most recent context tokens (across all entries) intact. */
	protectTokens: number;
	/** Only shake when total estimated savings meets this threshold. */
	minSavings: number;
	/** Tool-result protection matchers. String entries protect every result from that tool; predicates may inspect the paired tool call. */
	protectedTools: ProtectedToolMatcher[];
	/** Minimum token size for a fenced/XML block to be eligible. */
	fenceMinTokens: number;
	/**
	 * Compaction boundary (`firstKeptEntryId` of the latest compaction). Entries
	 * before it are summarized away and never sent, so they are skipped — shaking
	 * them only churns persisted history. Undefined = no compaction (whole branch
	 * is sent). Note: shake still elides the warm cached prefix at/after the
	 * boundary — that is its job as a compaction-class reducer.
	 */
	keepBoundaryId?: string;
}

/** Auto-shake config: protects the live tail, conservative thresholds. */
export const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 16_000,
	minSavings: 4_000,
	protectedTools: ["skill", isSkillReadToolResult],
	fenceMinTokens: 400,
};

/** Manual `/shake`: aggressive — drops every eligible region across history. */
export const AGGRESSIVE_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 0,
	minSavings: 0,
	protectedTools: ["skill", isSkillReadToolResult],
	fenceMinTokens: 400,
};

/** Rough token cost of a placeholder line; used only for the savings gate. */
const PLACEHOLDER_TOKEN_ESTIMATE = 16;

/** A located eligible region. */
export interface ToolResultShakeRegion {
	kind: "toolResult";
	entry: SessionMessageEntry;
	tokens: number;
	originalText: string;
	/** Human label for the offload doc (tool name). */
	label: string;
}

/**
 * Where one editable text lives inside a message, and the only place that
 * knowledge is written down.
 *
 * A role does not have to carry its text in `content`. A bash or python cell
 * carries it in `output`, a branch or compaction summary in `summary`, and a
 * `@file` mention in `files[i].content` — up to 50KB per mention. A reducer
 * that reads only `content` therefore cannot touch five of the eleven roles a
 * session can hold, and a session wedged by one of them has no automatic way
 * out. Adding a role that stores text somewhere new means adding a member here
 * and an arm in `getTextSlot`, and nowhere else.
 */
export type ShakeTextAddress =
	| { field: "content"; blockIndex: number }
	| { field: "output" }
	| { field: "summary" }
	| { field: "fileContent"; fileIndex: number };

/** Address the `content` field itself, which is a string rather than a block array. */
export const CONTENT_STRING: ShakeTextAddress = { field: "content", blockIndex: -1 };

export interface BlockShakeRegion {
	kind: "block";
	entry: SessionMessageEntry | CustomMessageEntry;
	/** Which text inside the message this region cuts into. */
	address: ShakeTextAddress;
	/** Character offsets into the target text (start inclusive, end exclusive). */
	start: number;
	end: number;
	tokens: number;
	originalText: string;
	/** Human label for the offload doc (role / customType). */
	label: string;
	/**
	 * Set when the region is the oversized middle of one text rather than a
	 * whole block, so the head and tail around it survive the rewrite. Only
	 * {@link collectOversizedTextRegions} produces one, and the only thing that
	 * reads it is the caller's placeholder wording: a reader of the rewritten
	 * history needs to know the text continues past the marker.
	 */
	truncation?: true;
}

export type ShakeRegion = ToolResultShakeRegion | BlockShakeRegion;

/**
 * A content block that holds editable text. The walks below read blocks out of
 * `unknown[]`, because a role's content array is reached by field name rather
 * than through its declared type, so the shape is checked rather than asserted.
 */
function isTextBlock(value: unknown): value is TextContent {
	return (
		value !== null &&
		typeof value === "object" &&
		"type" in value &&
		value.type === "text" &&
		"text" in value &&
		typeof value.text === "string"
	);
}

// Mirror prompt.ts top-level XML detection. Lowercase tag names only —
// conservative by design (uppercase / mixed-case tags are ignored).
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;
const CLOSING_XML = /^<\/([a-z_-]+)>$/;

function toolResultText(message: ToolResultMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/** Estimate the token contribution of an entry for the protect-recent window. */
function entryTokens(entry: SessionEntry): number {
	if (entry.type === "message") {
		return estimateTokens(entry.message);
	}
	if (entry.type === "custom_message") {
		const content = entry.content;
		if (typeof content === "string") return content.length === 0 ? 0 : countTokens(content);
		const fragments = content.filter((block): block is TextContent => block.type === "text").map(block => block.text);
		return fragments.length === 0 ? 0 : countTokens(fragments);
	}
	return 0;
}

/**
 * Locate fenced code blocks and top-level XML element spans inside `text`.
 * Returns character ranges `[start, end)` covering the full block (including the
 * opening and closing fence/tag lines, excluding the trailing newline).
 *
 * Conservative: unterminated fences/tags yield no range, and XML detection is
 * suppressed inside fences. Mirrors the toggling logic in
 * `@veyyon/utils` `format()` so behavior stays aligned with prompt rendering.
 */
function scanTextForBlockRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	let inFence = false;
	let fenceStart = -1;
	const tagStack: string[] = [];
	let xmlStart = -1;

	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== "\n") continue;
		const line = text.slice(lineStart, i);
		const lineEnd = i; // offset of the newline (or end of text); excludes the "\n"
		const trimmedStart = line.trimStart();

		const isFenceLine = trimmedStart.startsWith("```") || trimmedStart.startsWith("~~~");
		if (isFenceLine) {
			if (!inFence) {
				inFence = true;
				fenceStart = lineStart;
			} else {
				inFence = false;
				ranges.push({ start: fenceStart, end: lineEnd });
				fenceStart = -1;
			}
			lineStart = i + 1;
			continue;
		}

		if (!inFence) {
			const isOpeningXml = line.length === trimmedStart.length && OPENING_XML.test(trimmedStart);
			if (isOpeningXml) {
				const match = OPENING_XML.exec(trimmedStart);
				if (match) {
					if (tagStack.length === 0) xmlStart = lineStart;
					tagStack.push(match[1]);
				}
			} else {
				const closingMatch = CLOSING_XML.exec(trimmedStart);
				if (closingMatch && tagStack.length > 0 && tagStack[tagStack.length - 1] === closingMatch[1]) {
					tagStack.pop();
					if (tagStack.length === 0 && xmlStart >= 0) {
						ranges.push({ start: xmlStart, end: lineEnd });
						xmlStart = -1;
					}
				}
			}
		}

		lineStart = i + 1;
	}

	return mergeRanges(ranges);
}

/**
 * Sort ascending by start and drop any range that overlaps an already-kept
 * range. Because fence/XML spans are always properly nested (XML detection is
 * suppressed inside fences), overlap means containment — keeping the
 * earlier-starting range keeps the outermost span.
 */
function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	if (ranges.length <= 1) return ranges;
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const kept: Array<{ start: number; end: number }> = [];
	let lastEnd = -1;
	for (const range of sorted) {
		if (range.start < lastEnd) continue;
		kept.push(range);
		lastEnd = range.end;
	}
	return kept;
}

function pushBlockRegions(
	entry: SessionMessageEntry | CustomMessageEntry,
	address: ShakeTextAddress,
	text: string,
	config: ShakeConfig,
	label: string,
	out: ShakeRegion[],
): void {
	for (const range of scanTextForBlockRanges(text)) {
		const slice = text.slice(range.start, range.end);
		if (slice.length === 0) continue;
		const tokens = countTokens(slice);
		if (tokens < config.fenceMinTokens) continue;
		out.push({
			kind: "block",
			entry,
			address,
			start: range.start,
			end: range.end,
			tokens,
			originalText: slice,
			label,
		});
	}
}

function collectBlockRegions(
	entry: SessionMessageEntry | CustomMessageEntry,
	config: ShakeConfig,
	out: ShakeRegion[],
): void {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant") {
			for (let bi = 0; bi < message.content.length; bi++) {
				const block = message.content[bi];
				if (block.type === "text")
					pushBlockRegions(entry, { field: "content", blockIndex: bi }, block.text, config, "assistant", out);
			}
			return;
		}
		if (message.role === "user" || message.role === "developer") {
			scanContentBlocks(entry, message.content, config, message.role, out);
		}
		return;
	}
	// custom_message
	scanContentBlocks(entry, entry.content, config, entry.customType, out);
}

function scanContentBlocks(
	entry: SessionMessageEntry | CustomMessageEntry,
	content: string | Array<{ type: string; text?: string }>,
	config: ShakeConfig,
	label: string,
	out: ShakeRegion[],
): void {
	if (typeof content === "string") {
		pushBlockRegions(entry, CONTENT_STRING, content, config, label, out);
		return;
	}
	for (let bi = 0; bi < content.length; bi++) {
		const block = content[bi];
		if (block.type === "text" && typeof block.text === "string") {
			pushBlockRegions(entry, { field: "content", blockIndex: bi }, block.text, config, label, out);
		}
	}
}

/**
 * Pure detection: locate every eligible shake region on a branch.
 *
 * Walks the protect-recent window (most recent `protectTokens` of context is
 * kept intact), collects whole tool-result messages (honoring `protectedTools`
 * and skipping already-pruned results) and large fenced/XML blocks inside
 * user/developer/assistant/custom messages. Tool results flagged contextually
 * useless by their tool bypass the protect window — there is nothing recent
 * worth keeping in them. Returns regions in document order.
 *
 * `toolCall` blocks are never touched (tool-call/result pairing is preserved)
 * and regions never span a message boundary. When the combined estimated
 * savings is below `minSavings`, returns `[]` (no-op).
 */
export function collectShakeRegions(entries: SessionEntry[], config: ShakeConfig): ShakeRegion[] {
	const n = entries.length;
	if (n === 0) return [];

	// Tokens of all entries strictly more recent than index i.
	const accumulatedAfter = new Array<number>(n);
	let acc = 0;
	for (let i = n - 1; i >= 0; i--) {
		accumulatedAfter[i] = acc;
		acc += entryTokens(entries[i]);
	}

	const toolCallsById = collectToolCallsById(entries);

	// Entries before the compaction boundary are summarized away and never sent —
	// shaking them only churns persisted history (no prompt/cache effect).
	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);

	const regions: ShakeRegion[] = [];
	for (let i = 0; i < n; i++) {
		const entry = entries[i];
		if (i < boundaryIndex) continue;
		const toolResult = getToolResultMessage(entry);
		// Useless-flagged results carry no information once consumed; they are
		// eligible even inside the protect-recent window.
		const uselessResult = toolResult !== undefined && toolResult.useless === true && toolResult.isError !== true;
		if (!uselessResult && accumulatedAfter[i] < config.protectTokens) continue;
		if (toolResult) {
			if (toolResult.prunedAt !== undefined) continue;
			if (isProtectedToolResult(toolResult, toolCallsById.get(toolResult.toolCallId), config.protectedTools))
				continue;
			const text = toolResultText(toolResult);
			if (text.length === 0) continue;
			regions.push({
				kind: "toolResult",
				entry: entry as SessionMessageEntry,
				tokens: estimateTokens(toolResult as AgentMessage),
				originalText: text,
				label: toolResult.toolName,
			});
			continue;
		}

		if (entry.type === "message" || entry.type === "custom_message") {
			collectBlockRegions(entry as SessionMessageEntry | CustomMessageEntry, config, regions);
		}
	}

	let savings = 0;
	for (const region of regions) savings += Math.max(0, region.tokens - PLACEHOLDER_TOKEN_ESTIMATE);
	if (savings < config.minSavings) return [];

	return regions;
}

/**
 * Stable signature of a tool-result for redundancy matching: tool name, the
 * paired call's arguments (key-sorted so argument order never splits a match),
 * and the verbatim output text. Two results with the same signature carry the
 * same information — re-reading an unchanged file or re-running the same command
 * produces byte-identical output, and only the newest copy needs to stay live.
 */
function redundancySignature(toolName: string, call: AgentToolCall | undefined, outputText: string): string {
	const args = call?.arguments;
	const argsKey = args === undefined ? "" : JSON.stringify(args, Object.keys(args).sort());
	return `${toolName}\x00${argsKey}\x00${outputText}`;
}

/**
 * Locate earlier tool-result messages whose (tool, arguments, output) is
 * byte-identical to a LATER tool-result on the same branch.
 *
 * Re-reading an unchanged file or re-running the same command leaves several
 * identical results in context; every copy but the newest is pure redundancy.
 * This returns the earlier copies as tool-result regions (the newest copy of
 * each signature is always kept), in document order. The caller offloads their
 * text through the same artifact path as {@link collectShakeRegions}, so the
 * bytes stay recoverable even if the surviving copy is later elided too.
 *
 * Unlike {@link collectShakeRegions} this ignores the protect-recent window and
 * the savings gate: a duplicate carries no unique recent information, so it is
 * eligible however recent it is, and dedup is meant to run proactively rather
 * than only under context pressure. Protected tools, error results, empty
 * results, and already-pruned results are never deduped — an identical error may
 * still be worth re-reading in place, and protection/prune state is
 * authoritative. `keepBoundaryId` still applies: entries summarized away by a
 * prior compaction are never sent, so shaking them only churns history.
 */
export function collectRedundantToolResultRegions(entries: SessionEntry[], config: ShakeConfig): ShakeRegion[] {
	const n = entries.length;
	if (n === 0) return [];

	const toolCallsById = collectToolCallsById(entries);

	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);

	interface Candidate {
		index: number;
		entry: SessionMessageEntry;
		message: ToolResultMessage;
		signature: string;
		text: string;
	}
	const candidates: Candidate[] = [];
	// signature -> index of the newest (survivor) candidate.
	const latestBySignature = new Map<string, number>();

	for (let i = boundaryIndex; i < n; i++) {
		const toolResult = getToolResultMessage(entries[i]);
		if (!toolResult) continue;
		if (toolResult.prunedAt !== undefined) continue;
		if (toolResult.isError === true) continue;
		if (isProtectedToolResult(toolResult, toolCallsById.get(toolResult.toolCallId), config.protectedTools)) continue;
		const text = toolResultText(toolResult);
		if (text.length === 0) continue;
		const signature = redundancySignature(toolResult.toolName, toolCallsById.get(toolResult.toolCallId), text);
		candidates.push({ index: i, entry: entries[i] as SessionMessageEntry, message: toolResult, signature, text });
		latestBySignature.set(signature, i);
	}

	const regions: ShakeRegion[] = [];
	for (const candidate of candidates) {
		// The newest copy of each signature survives; every earlier copy is elided.
		if (latestBySignature.get(candidate.signature) === candidate.index) continue;
		regions.push({
			kind: "toolResult",
			entry: candidate.entry,
			tokens: estimateTokens(candidate.message as AgentMessage),
			originalText: candidate.text,
			label: candidate.message.toolName,
		});
	}
	return regions;
}

export interface TruncationConfig {
	/**
	 * Tokens that must leave the context. The collector stops as soon as the
	 * regions it has cover this, so a pass removes what the caller is over by
	 * and not the whole of the largest text it can find.
	 */
	excessTokens: number;
	/**
	 * Tokens preserved at the start and at the end of every truncated text. A
	 * tool result states what it read in its first lines and what it concluded
	 * in its last, and both stay readable; only the bulk between them goes.
	 */
	keepEdgeTokens: number;
	/** Texts below this are left alone: the middle would not pay for its marker. */
	minTextTokens: number;
	/** Tool-result protection matchers, as in {@link ShakeConfig}. */
	protectedTools: ProtectedToolMatcher[];
	/** Compaction boundary, as in {@link ShakeConfig}. */
	keepBoundaryId?: string;
}

interface TruncationCandidate {
	entry: SessionMessageEntry | CustomMessageEntry;
	address: ShakeTextAddress;
	text: string;
	tokens: number;
	label: string;
}

function pushTruncationCandidate(
	entry: SessionMessageEntry | CustomMessageEntry,
	address: ShakeTextAddress,
	text: unknown,
	label: string,
	minTextTokens: number,
	out: TruncationCandidate[],
): void {
	if (typeof text !== "string" || text.length === 0) return;
	const tokens = countTokens(text);
	if (tokens < minTextTokens) return;
	out.push({ entry, address, text, tokens, label });
}

/**
 * Every text a message holds that can be cut into, whatever field it lives in.
 *
 * The walk is driven by which fields are PRESENT rather than by role, because
 * the roles are contributed through declaration merging (`CustomAgentMessages`)
 * and a switch here would go stale the moment a host adds one. `content`,
 * `output`, `summary` and `files[i].content` are the four places the shapes in
 * this workspace store model-visible text; a fifth means a new
 * {@link ShakeTextAddress} member, which forces `getTextSlot` to grow the
 * matching arm.
 */
function collectTruncationCandidates(
	entry: SessionMessageEntry | CustomMessageEntry,
	minTextTokens: number,
	out: TruncationCandidate[],
): void {
	// Fields by name, not a switch over roles: see ShakeTextAddress.
	const message = (entry.type === "message" ? entry.message : entry) as unknown as Record<string, unknown>;
	const label =
		typeof message.toolName === "string"
			? message.toolName
			: typeof message.customType === "string"
				? message.customType
				: String(message.role ?? entry.type);

	const content = message.content;
	if (typeof content === "string") {
		pushTruncationCandidate(entry, CONTENT_STRING, content, label, minTextTokens, out);
	} else if (Array.isArray(content)) {
		for (let bi = 0; bi < content.length; bi++) {
			const block: unknown = content[bi];
			if (isTextBlock(block)) {
				pushTruncationCandidate(entry, { field: "content", blockIndex: bi }, block.text, label, minTextTokens, out);
			}
		}
	}

	pushTruncationCandidate(entry, { field: "output" }, message.output, label, minTextTokens, out);
	pushTruncationCandidate(entry, { field: "summary" }, message.summary, label, minTextTokens, out);

	const files = message.files;
	if (Array.isArray(files)) {
		for (let fi = 0; fi < files.length; fi++) {
			const file: unknown = files[fi];
			if (file !== null && typeof file === "object" && "content" in file) {
				pushTruncationCandidate(
					entry,
					{ field: "fileContent", fileIndex: fi },
					file.content,
					label,
					minTextTokens,
					out,
				);
			}
		}
	}
}

/**
 * Pure detection: locate the oversized middles that have to go for the context
 * to shrink by `excessTokens`.
 *
 * This is the reducer of last resort, and the only one whose eligibility does
 * not depend on the SHAPE of what is too large. {@link collectShakeRegions}
 * finds a whole tool result or a fenced/XML block, which covers the common
 * case and misses the one that wedges a session: a single message carrying
 * megabytes of prose with no fence in it, or a tool result already elided once
 * whose remaining text is still over the band. Nothing recognizes those, so
 * every tier reports "nothing eligible" and maintenance parks a session that
 * cannot send another request.
 *
 * So a candidate here is any text at all — a tool-result text block, an
 * assistant/user/developer block, a custom message — at or after the
 * compaction boundary and not protected by tool. Candidates are cut largest
 * first, `keepEdgeTokens` of head and tail preserved, and the walk stops at the
 * first candidate that covers the excess. The region is the middle, so the
 * caller's ordinary splice keeps the edges without a second apply path, and the
 * removed bytes reach the caller's recovery artifact like any other region.
 *
 * ON THE PROMPT CACHE. Pruning orders its victims by how much of the cache a
 * mutation forces the provider to re-write (`computeMessageSuffixTokens`),
 * because it runs on a session that could have sent its request anyway, so a
 * rewrite it did not need is pure cost. This tier is ordered by size alone, and
 * that is deliberate: it runs only after every other tier failed on a session
 * that CANNOT send at all, so the comparison is not "cheap prune vs expensive
 * prune" but "one cache rewrite vs no request". Cutting the largest text covers
 * the excess in the fewest regions, and the reported case — the newest turn is
 * the oversized one — is also the cheapest position to cut.
 *
 * Returns `[]` when no text is large enough to cut, which is the honest
 * dead end: the context is many small messages and only a summarizer or the
 * operator can reduce it.
 */
export function collectOversizedTextRegions(entries: SessionEntry[], config: TruncationConfig): ShakeRegion[] {
	if (config.excessTokens <= 0 || entries.length === 0) return [];

	const toolCallsById = collectToolCallsById(entries);
	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);

	const candidates: TruncationCandidate[] = [];
	for (let i = boundaryIndex; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message" && entry.type !== "custom_message") continue;
		const toolResult = getToolResultMessage(entry);
		if (toolResult) {
			// A protected tool's output is protected here too: the whole point of the
			// matcher is that the model must keep seeing those bytes.
			if (isProtectedToolResult(toolResult, toolCallsById.get(toolResult.toolCallId), config.protectedTools)) {
				continue;
			}
		}
		collectTruncationCandidates(entry as SessionMessageEntry | CustomMessageEntry, config.minTextTokens, candidates);
	}

	candidates.sort((a, b) => b.tokens - a.tokens);

	const regions: ShakeRegion[] = [];
	let freed = 0;
	for (const candidate of candidates) {
		if (freed >= config.excessTokens) break;
		// Tokens do not map to character offsets, and the splice needs offsets.
		// The text's own average is the only ratio that describes THIS text, and
		// the edges it produces are then measured exactly below, so an unusual
		// encoding costs a slightly wider or narrower edge and never an
		// unbounded one.
		const charsPerToken = candidate.text.length / candidate.tokens;
		const edgeChars = Math.max(1, Math.floor(config.keepEdgeTokens * charsPerToken));
		const start = Math.min(edgeChars, candidate.text.length);
		const end = Math.max(start, candidate.text.length - edgeChars);
		const middle = candidate.text.slice(start, end);
		if (middle.length === 0) continue;
		const middleTokens = countTokens(middle);
		if (middleTokens <= 0) continue;
		regions.push({
			kind: "block",
			entry: candidate.entry,
			address: candidate.address,
			start,
			end,
			tokens: middleTokens,
			originalText: middle,
			label: candidate.label,
			truncation: true,
		});
		freed += middleTokens;
	}

	return regions;
}

interface TextSlot {
	read(): string;
	write(value: string): void;
}

function stringFieldSlot(owner: Record<string, unknown>, field: string): TextSlot | undefined {
	if (typeof owner[field] !== "string") return undefined;
	return {
		read: () => owner[field] as string,
		write: value => {
			owner[field] = value;
		},
	};
}

function textBlockSlot(content: unknown, blockIndex: number): TextSlot | undefined {
	if (!Array.isArray(content)) return undefined;
	const block: unknown = content[blockIndex];
	if (!isTextBlock(block)) return undefined;
	return {
		read: () => block.text,
		write: value => {
			block.text = value;
		},
	};
}

/**
 * Resolve a {@link ShakeTextAddress} to a readable and writable text on the
 * live message. `undefined` when the message does not hold what the address
 * names, which is how a region built against a since-rewritten branch fails
 * safe instead of writing into the wrong field.
 */
function getTextSlot(entry: SessionMessageEntry | CustomMessageEntry, address: ShakeTextAddress): TextSlot | undefined {
	const owner = (entry.type === "message" ? entry.message : entry) as unknown as Record<string, unknown>;
	switch (address.field) {
		case "content":
			return address.blockIndex === -1
				? stringFieldSlot(owner, "content")
				: textBlockSlot(owner.content, address.blockIndex);
		case "output":
			return stringFieldSlot(owner, "output");
		case "summary":
			return stringFieldSlot(owner, "summary");
		case "fileContent": {
			const files = owner.files;
			if (!Array.isArray(files)) return undefined;
			const file = files[address.fileIndex] as Record<string, unknown> | undefined;
			return file ? stringFieldSlot(file, "content") : undefined;
		}
	}
}

/**
 * Pure mutation: replace a single region's content in place.
 *
 * Tool-result: replaces the message text with the placeholder and stamps
 * `prunedAt`, keeping every non-text block. A shake reclaims text tokens;
 * dropping an image with them would blind the model to a screenshot or a
 * diagram it still needs, and that block is not what the text budget is spent
 * on. Filtering on `!== "text"` rather than on the image kind keeps a block
 * kind added to the content union later from silently regressing this.
 * Block: splices `replacement` over `[start, end)` of the
 * target text block. When several block regions share one text block they MUST
 * be applied highest-start-first so earlier offsets stay valid — use
 * {@link applyShakeRegions}, which orders them correctly.
 */
export function applyShakeRegion(region: ShakeRegion, replacement: string): void {
	if (region.kind === "toolResult") {
		const message = region.entry.message as ToolResultMessage;
		const preserved = message.content.filter(block => block.type !== "text");
		message.content = [{ type: "text", text: replacement }, ...preserved];
		message.prunedAt = Date.now();
		return;
	}
	const slot = getTextSlot(region.entry, region.address);
	if (!slot) return;
	const text = slot.read();
	slot.write(text.slice(0, region.start) + replacement + text.slice(region.end));
}

/**
 * Apply many regions at once. Block regions are applied highest-start-first so
 * that splicing one region never shifts the offsets of another in the same text
 * block; tool-result regions are independent.
 */
export function applyShakeRegions(items: Array<{ region: ShakeRegion; replacement: string }>): void {
	const ordered = [...items].sort((a, b) => {
		const aStart = a.region.kind === "block" ? a.region.start : -1;
		const bStart = b.region.kind === "block" ? b.region.start : -1;
		return bStart - aStart;
	});
	for (const { region, replacement } of ordered) applyShakeRegion(region, replacement);
}
