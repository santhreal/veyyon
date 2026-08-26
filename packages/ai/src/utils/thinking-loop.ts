/**
 * Output-loop guard detecting verbatim repetition, near-duplicate segments, and lexical stalls in thinking streams.
 */
import { discardAttemptUsage, emptyUsage } from "@veyyon/catalog/models";
import * as logger from "@veyyon/utils/logger";
import * as AIError from "../error";
import type { Api, AssistantMessage, Model, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

/** Stable lead phrase of the guard's error message; exported for tests. The
 *  message also carries "stream stall" so the session + transport retry
 *  classifiers treat it as a transient (retryable) stop without bespoke rules. */
export const THINKING_LOOP_ERROR_MARKER = "Thinking loop detected";

/**
 * Rolling char tail window inspected for verbatim back-to-back repetition.
 */
const VERBATIM_TAIL_WINDOW = 900;
/** Minimum total repeated chars before a verbatim run counts as a loop. */
const VERBATIM_MIN_REPEATED_CHARS = 180;
/**
 * Longest unit length probed for verbatim repeats.
 */
const VERBATIM_MAX_UNIT = 200;
/** Char cap for an unterminated segment; forces a flush so a wall-of-text loop
 *  (no blank lines / headings) still segments. */
const SEGMENT_CHAR_CAP = 700;
/** Normalized-length floor below which a segment is ignored (too short to be a
 *  meaningful paragraph; bare headings must not trip detection). */
const SEGMENT_MIN_NORM_CHARS = 60;
/** How many recent substantial segments are kept for similarity comparison. */
const SEGMENT_WINDOW = 16;
/** Word-trigram Jaccard at/above which two segments count as near-duplicates. */
const SEGMENT_SIMILARITY = 0.8;
/** Substantial segments required before detection may fire (warm-up). */
const SEGMENT_MIN_COUNT = 8;
/** Near-duplicate cluster size (current + matches) that trips the loop. */
const SEGMENT_MIN_CLUSTER = 4;

/** Recent segments whose pooled unigram vocabulary is the novelty baseline for
 *  progress-lexicon stall detection. */
const LEX_NOVELTY_WINDOW = 8;
/** Novelty (fraction of a segment's content words unseen across the recent
 *  window) at/below which a segment counts as recycling earlier wording.
 *  Calibrated against 536k real non-Gemini reasoning blocks: at 0.2 the longest
 *  low-information run any legitimate block reached was 7. */
const LEX_STALL_NOVELTY_FLOOR = 0.2;
/** Consecutive low-information segments that trip a progress-lexicon stall. Set
 *  to 8 (one above the worst legitimate run observed in the 536k-block corpus) so
 *  the heuristic stays clear of focused reasoning that briefly recycles wording;
 *  the real reasoning-summarizer loop sustains far longer runs (10+). */
const LEX_STALL_MIN_RUN = 8;

/**
 * Matches concrete references (code spans, paths, identifiers) that reset lexical stall tracking.
 */
const CONCRETE_ANCHOR =
	/`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g;

const OPENAI_COMPAT_GUARDED_APIS: Partial<Record<Api, true>> = {
	"openai-completions": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

/**
 * Returns true when `model` is a Gemini model whose thinking stream surfaces reasoning headers.
 */
export function isGeminiThinkingModel(model: Model<Api>): boolean {
	if (OPENAI_COMPAT_GUARDED_APIS[model.api]) {
		const compat = model.compat as { enableGeminiThinkingLoopGuard?: boolean } | undefined;
		return compat?.enableGeminiThinkingLoopGuard === true;
	}
	return /gemini/i.test(`${model.provider}/${model.id}`);
}

/**
 * Returns true when a stream should be watched for degenerate output loops.
 */
export function isLoopGuardEnabled(options?: StreamOptions): boolean {
	return options?.loopGuard?.enabled !== false;
}

/** How the guard names a verbatim repeat. One owner, so the streamed path and the completed-text
 *  path cannot describe the same shape in two different ways. */
function describeVerbatimRepeat(unit: string, count: number): string {
	return `repeated "${unit.trim()}" ${count}× back-to-back`;
}

/**
 * Checks whether completed text contains a degenerate verbatim sampler repeat.
 */
export function detectDegenerateRepetition(text: string): string | null {
	if (text.length < VERBATIM_MIN_REPEATED_CHARS) return null;
	for (let len = 2; len <= VERBATIM_MAX_UNIT && text.length >= len * 4; len++) {
		let runStart = 0;
		let agreement = 0;
		for (let i = 0; i + len <= text.length; i++) {
			if (i + len < text.length && text.charCodeAt(i) === text.charCodeAt(i + len)) {
				if (agreement === 0) runStart = i;
				agreement++;
				continue;
			}
			if (agreement > 0) {
				const count = Math.floor((agreement + len) / len);
				const unit = text.slice(runStart, runStart + len);
				if (count >= 4 && count * len >= VERBATIM_MIN_REPEATED_CHARS && VERBATIM_UNIT_CONTENT.test(unit)) {
					return describeVerbatimRepeat(unit, count);
				}
				agreement = 0;
			}
		}
	}
	return null;
}

/**
 * Stateful detector fed the streamed thinking deltas. `push` returns a
 * human-readable reason the first time a loop shape is recognized; the caller
 * is responsible for stopping after the first hit.
 */
export class ThinkingLoopDetector {
	/** Rolling char tail for verbatim repeat detection. */
	#tail = "";
	/** Pending thinking text not yet split into completed segments. */
	#pending = "";
	/** Fingerprints of the most recent substantial segments (≤ SEGMENT_WINDOW). */
	#window: Set<string>[] = [];
	/** Count of substantial segments seen so far (warm-up gate). */
	#count = 0;
	/** Unigram word sets of the most recent segments (≤ LEX_NOVELTY_WINDOW); the
	 *  novelty baseline for progress-lexicon stall detection. */
	#wordWindow: Set<string>[] = [];
	/** Consecutive low-information (low-novelty, anchor-free) segments seen. */
	#lexStallRun = 0;
	/** Concrete anchors seen per recent segment (≤ LEX_NOVELTY_WINDOW). A stall is
	 *  only broken by a *new* reference, so filler repeating one fixed
	 *  path/identifier every paragraph is still caught. */
	#anchorWindow: Set<string>[] = [];

	push(delta: string): string | null {
		if (!delta) return null;

		// 1. Verbatim back-to-back repetition over the rolling tail.
		this.#tail += delta;
		if (this.#tail.length > VERBATIM_TAIL_WINDOW) this.#tail = this.#tail.slice(-VERBATIM_TAIL_WINDOW);
		const verbatim = detectVerbatimRepetition(this.#tail);
		if (verbatim) return describeVerbatimRepeat(verbatim[0], verbatim[1]);

		// 2. Near-duplicate paragraph loop. Append, then drain completed segments.
		this.#pending += delta;
		while (true) {
			const boundary = /\n\s*\n/.exec(this.#pending);
			let raw: string;
			if (boundary) {
				raw = this.#pending.slice(0, boundary.index);
				this.#pending = this.#pending.slice(boundary.index + boundary[0].length);
			} else if (this.#pending.length > SEGMENT_CHAR_CAP) {
				// No boundary yet but the segment is runaway-long: force a flush.
				raw = this.#pending.slice(0, SEGMENT_CHAR_CAP);
				this.#pending = this.#pending.slice(SEGMENT_CHAR_CAP);
			} else {
				return null;
			}
			// An over-long segment is chunked so each piece stays comparable.
			for (let rest = raw; rest.length > 0; ) {
				const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
				rest = rest.slice(chunk.length);
				const hit = this.#consumeSegment(chunk);
				if (hit) return hit;
			}
		}
	}

	/** Process the buffered trailing paragraph (one with no blank-line / heading
	 *  terminator). Called when the thinking block ends so the final segment —
	 *  which may be the one that completes a duplicate cluster — is not dropped. */
	flush(): string | null {
		if (!this.#pending) return null;
		let rest = this.#pending;
		this.#pending = "";
		while (rest.length > 0) {
			const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
			rest = rest.slice(chunk.length);
			const hit = this.#consumeSegment(chunk);
			if (hit) return hit;
		}
		return null;
	}

	#consumeSegment(raw: string): string | null {
		// Reasoning-summarizer titles ("**Maintaining Momentum**", "## Heading")
		// are per-thought formatting, not chain-of-thought; their ever-changing
		// wording would otherwise mask a loop by inflating novelty. Strip them
		// before analysis (a title-only segment then falls below the length gate).
		const segment = raw.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "").replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "");
		const normalized = normalizeSegment(segment);
		if (normalized.length < SEGMENT_MIN_NORM_CHARS) return null;

		// (a) Near-duplicate trigram cluster: the same paragraph reused with
		// cosmetic wording drift (high word-trigram overlap).
		const fingerprint = trigramShingles(normalized);
		let cluster = 1;
		for (const prev of this.#window) {
			if (jaccard(fingerprint, prev) >= SEGMENT_SIMILARITY) cluster++;
		}

		// (b) Progress-lexicon stall: paragraphs that recycle the recent
		// vocabulary (low novelty) and add no *new* concrete reference — reworded
		// filler that burns budget without advancing. The trigram check above
		// already claims high-overlap near-duplicates; this catches the
		// low-overlap, reshuffled-wording shape it misses. Requiring a NEW anchor
		// (not merely any anchor) still catches filler that name-drops one fixed
		// path/identifier every paragraph, while sparing genuine per-target work
		// that names a fresh file/symbol each time.
		const words = new Set<string>(normalized.split(" ").filter(Boolean));
		const priorVocab = new Set<string>();
		for (const set of this.#wordWindow) for (const w of set) priorVocab.add(w);
		let unseen = 0;
		for (const w of words) if (!priorVocab.has(w)) unseen++;
		const novelty = priorVocab.size === 0 ? 1 : unseen / words.size;

		const anchors = new Set<string>();
		// Canonicalize so the same reference written as `Foo`, Foo, or FOO is one
		// anchor and cannot masquerade as "new" to keep a fixed-reference stall alive.
		for (const match of segment.matchAll(CONCRETE_ANCHOR)) anchors.add(match[0].replace(/`/g, "").toLowerCase());
		let newAnchor = false;
		for (const anchor of anchors) {
			if (this.#anchorWindow.every(seen => !seen.has(anchor))) {
				newAnchor = true;
				break;
			}
		}

		if (novelty <= LEX_STALL_NOVELTY_FLOOR && !newAnchor) {
			this.#lexStallRun++;
		} else {
			this.#lexStallRun = 0;
		}

		this.#window.push(fingerprint);
		if (this.#window.length > SEGMENT_WINDOW) this.#window.shift();
		this.#wordWindow.push(words);
		if (this.#wordWindow.length > LEX_NOVELTY_WINDOW) this.#wordWindow.shift();
		this.#anchorWindow.push(anchors);
		if (this.#anchorWindow.length > LEX_NOVELTY_WINDOW) this.#anchorWindow.shift();
		this.#count++;

		if (this.#count >= SEGMENT_MIN_COUNT) {
			if (cluster >= SEGMENT_MIN_CLUSTER) {
				return `${cluster} near-identical segments within the last ${SEGMENT_WINDOW}`;
			}
			if (this.#lexStallRun >= LEX_STALL_MIN_RUN) {
				return `${this.#lexStallRun} low-information segments recycling recent wording`;
			}
		}
		return null;
	}
}

/**
 * Threshold of consecutive thought-summary headers in a stream before interrupting with a reminder.
 */
export const GEMINI_HEADER_RUNAWAY_THRESHOLD = 24;

/**
 * Returns true if a line matches a Gemini reasoning-summary title (markdown header or bold line).
 */
export function isReasoningSummaryHeader(line: string): boolean {
	return /^#{1,6}[ \t]+\S/.test(line) || /^\*{2,3}.+\*{2,3}$/.test(line);
}

/**
 * Counts consecutive Gemini reasoning-summary headers across a streamed thinking block.
 */
export class GeminiHeaderRunDetector {
	/** Thinking text not yet split into completed lines. */
	#pending = "";
	/** Summary-title lines seen in the current run. */
	#count = 0;
	/** Latches after the first threshold hit so each run fires at most once. */
	#fired = false;

	/** Feed a thinking delta. Returns true the first time the run hits the threshold. */
	push(delta: string): boolean {
		if (this.#fired || !delta) return false;
		this.#pending += delta;
		let nl = this.#pending.indexOf("\n");
		while (nl !== -1) {
			const line = this.#pending.slice(0, nl).trim();
			this.#pending = this.#pending.slice(nl + 1);
			if (line !== "" && isReasoningSummaryHeader(line) && ++this.#count >= GEMINI_HEADER_RUNAWAY_THRESHOLD) {
				this.#fired = true;
				return true;
			}
			nl = this.#pending.indexOf("\n");
		}
		return false;
	}

	/** Number of summary titles counted in the current run (for the reminder/log). */
	get count(): number {
		return this.#count;
	}

	/** Re-arm for a fresh reasoning block: clears the buffer, count, and latch. */
	reset(): void {
		this.#pending = "";
		this.#count = 0;
		this.#fired = false;
	}
}

/**
 * Wrap a provider stream with the loop guard. `controller` is the guard's own
 * abort handle: aborting it (after wiring it into the provider's signal via
 * {@link withGeminiThinkingLoopGuard}) tears down the upstream once a loop
 * trips.
 */
export function guardThinkingLoopStream(
	inner: AssistantMessageEventStream,
	model: Model<Api>,
	controller: AbortController,
	options?: StreamOptions,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const thinkingDetector = new ThinkingLoopDetector();
	const textDetector = new ThinkingLoopDetector();
	const checkAssistantContent = options?.loopGuard?.checkAssistantContent !== false;

	void (async () => {
		let thinkingArmed = true;
		let textArmed = checkAssistantContent;
		// Last streamed view of the attempt, kept for its usage: a loop that gets
		// aborted still billed every token it sampled, and the stall message this
		// guard raises replaces the attempt entirely.
		let partial: AssistantMessage | undefined;
		try {
			for await (const event of inner) {
				if ("partial" in event) partial = event.partial;
				let detail: string | null = null;
				if (thinkingArmed && event.type === "thinking_delta") {
					detail = thinkingDetector.push(event.delta);
				} else if (thinkingArmed && event.type === "thinking_end") {
					detail = thinkingDetector.flush();
					thinkingArmed = false;
				} else if (event.type === "text_start" || event.type === "text_delta") {
					thinkingArmed = false;
					if (textArmed && event.type === "text_delta") {
						detail = textDetector.push(event.delta);
					}
				} else if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
					thinkingArmed = false;
					textArmed = false;
				} else if (event.type === "done") {
					if (thinkingArmed) {
						detail = thinkingDetector.flush();
					}
					if (textArmed) {
						detail = detail || textDetector.flush();
					}
				}
				if (detail) {
					logger.warn("Thinking loop detected; aborting stream for retry.", {
						model: model.id,
						provider: model.provider,
						detail,
					});
					controller.abort(
						AIError.attach(new Error(THINKING_LOOP_ERROR_MARKER), AIError.create(AIError.Flag.ThinkingLoop)),
					);
					const stall = buildThinkingLoopError(model, detail);
					if (partial) discardAttemptUsage(model, partial.usage, stall.usage);
					outer.push({
						type: "error",
						reason: "error",
						error: stall,
					});
					return;
				}
				outer.push(event);
				if (outer.done) return;
			}
			if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (err) {
					outer.fail(err);
				}
			}
		} catch (err) {
			if (!outer.done) outer.fail(err);
		}
	})();

	return outer;
}

/**
 * Applies the loop guard around a provider stream dispatch, injecting an abort controller for early termination.
 */
export function withGeminiThinkingLoopGuard<
	O extends { signal?: AbortSignal; loopGuard?: { enabled?: boolean; checkAssistantContent?: boolean } },
>(
	model: Model<Api>,
	options: O | undefined,
	dispatch: (options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (process.env.VEYYON_NO_THINKING_LOOP_GUARD === "1" || !isLoopGuardEnabled(options)) {
		return dispatch(options);
	}
	const controller = new AbortController();
	const caller = options?.signal;
	const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
	const merged = { ...(options ?? {}), signal } as O;
	return guardThinkingLoopStream(dispatch(merged), model, controller, options);
}

function buildThinkingLoopError(model: Model<Api>, detail: string): AssistantMessage {
	return {
		role: "assistant",
		// Empty content is load-bearing: loop-guard output is replay garbage, even
		// when it arrived as assistant text instead of native thinking. Keeping it
		// would persist the failed attempt before AgentSession retries.
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "error",
		// "stream stall" makes the transport/session retry classifiers treat this
		// as a transient (retryable) failure with no bespoke rule.
		errorMessage: `${THINKING_LOOP_ERROR_MARKER}: the model repeated near-identical content (${detail}). Treating as a stream stall and retrying.`,
		errorId: AIError.create(AIError.Flag.ThinkingLoop),
		timestamp: Date.now(),
	};
}

/** A letter or pictographic emoji: a unit without one is a run of digits, whitespace or punctuation,
 *  which is legitimate in tabular / hex / numeric output. Not stateful, so `test` is safe here. */
const VERBATIM_UNIT_CONTENT = /[\p{L}\p{Extended_Pictographic}]/u;

/**
 * Detects a unit repeated back-to-back at the stream tail.
 */
function detectVerbatimRepetition(text: string): [unit: string, count: number] | null {
	if (text.length < VERBATIM_MIN_REPEATED_CHARS) return null;
	const windowSize = Math.min(text.length, VERBATIM_TAIL_WINDOW);
	const searchSpace = text.slice(-windowSize);

	// Distance from the end to the nearest letter/emoji, capped at the longest unit probed. Any unit
	// shorter than this is punctuation, digits or whitespace and is skipped without a regex call.
	let contentAt = VERBATIM_MAX_UNIT + 1;
	const scan = Math.min(searchSpace.length, VERBATIM_MAX_UNIT);
	for (let back = 1; back <= scan; back++) {
		const at = searchSpace.length - back;
		const code = searchSpace.charCodeAt(at);
		// An emoji is two code units and a lone surrogate carries no Unicode property, so a low
		// surrogate is tested together with the high half in front of it, and a unit has to reach one
		// char further back to hold the whole pair.
		const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff && at > 0;
		const char = isLowSurrogate ? searchSpace.slice(at - 1, at + 1) : (searchSpace[at] as string);
		if (VERBATIM_UNIT_CONTENT.test(char)) {
			contentAt = isLowSurrogate ? back + 1 : back;
			break;
		}
	}
	if (contentAt > VERBATIM_MAX_UNIT) return null;

	for (let len = Math.max(2, contentAt); len <= VERBATIM_MAX_UNIT; len++) {
		if (searchSpace.length < len * 4) break;
		const unit = searchSpace.slice(-len);

		let count = 0;
		let pos = searchSpace.length;
		while (pos >= len) {
			if (searchSpace.slice(pos - len, pos) === unit) {
				count++;
				pos -= len;
			} else {
				break;
			}
		}
		if (count >= 4 && len * count >= VERBATIM_MIN_REPEATED_CHARS) return [unit, count];
	}
	return null;
}

/** Lowercase and tokenize prose plus code/path payloads, dropping pure numbers. */
function normalizeSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/`([^`]*)`/g, " $1 ")
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter(token => /[a-z]/.test(token))
		.join(" ")
		.trim();
}

/** Word-trigram shingle set of a normalized segment. */
function trigramShingles(normalized: string): Set<string> {
	const words = normalized.split(" ").filter(Boolean);
	if (words.length < 3) return new Set(words.length > 0 ? [words.join(" ")] : []);
	const shingles = new Set<string>();
	for (let i = 0; i + 3 <= words.length; i++) {
		shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	}
	return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size < b.size ? [a, b] : [b, a];
	let intersection = 0;
	for (const x of small) {
		if (large.has(x)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
