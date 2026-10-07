/**
 * Output-loop guard.
 *
 * Gemini models (notably `gemini-3.5-flash` via OpenRouter) occasionally fall
 * into a degenerate reasoning loop: they re-emit the same paragraph intent over
 * and over with cosmetic wording drift ("Confirming Safety", "Verifying
 * Completion", …), burning the entire output budget without ever calling a tool
 * or answering. The runaway is *not* byte-identical, so a cheap verbatim
 * tail-repeat check alone misses it.
 *
 * This guard watches the streamed `thinking` deltas and, on a match, terminates
 * the stream with a synthetic `error` {@link AssistantMessage} that carries
 * **no observable content**. An empty-content `stopReason: "error"` message tagged
 * with `AIError.Flag.ThinkingLoop` lets result consumers and `AgentSession` discard
 * the runaway and re-sample instead of committing garbage transcript.
 *
 * Three failure shapes are detected:
 * 1. **Verbatim tail repetition** — a short unit repeated back-to-back (e.g.
 *    "🌊 🌊 🌊 …"). Caught from the stream's last 900 chars.
 * 2. **Near-duplicate segments** — paragraphs that normalize to the same
 *    word-trigram fingerprint. Caught with a Jaccard window over recent
 *    paragraphs. Thresholds were calibrated on a real loop transcript plus
 *    13.5k non-loop thinking blocks (zero false positives; hardest negative
 *    scored 3 against the trigger of 4).
 * 3. **Progress-lexicon stall** — paragraphs that keep reshuffling the same
 *    motivational filler ("just doing it, pushing ahead, maintaining momentum")
 *    into fresh word order, so trigrams never match, yet introduce no new
 *    vocabulary and name nothing concrete. Caught by a run of low-novelty,
 *    anchor-free segments; a segment naming a path/identifier resets the run, so
 *    genuine but vocabulary-repetitive work (per-file templates) is spared.
 *
 * Every model's stream is guarded, up to its first tool call. Native
 * thinking is checked first; assistant text can also be checked for providers
 * that surface reasoning as visible prose. On a hit the failed turn is emitted as
 * an empty retryable stream-stall error; result-awaiting callers (`complete`,
 * `completeSimple`) re-sample it a few times and then let a stubborn loop cook
 * through one unguarded pass. Disable detection with `VEYYON_NO_THINKING_LOOP_GUARD=1`.
 */
import { discardAttemptUsage, emptyUsage } from "@veyyon/catalog/models";
import * as logger from "@veyyon/utils/logger";
import * as AIError from "../error";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

/** Stable lead phrase of the guard's error message; exported for tests. The
 *  message also carries "stream stall" so the session + transport retry
 *  classifiers treat it as a transient (retryable) stop without bespoke rules. */
export const THINKING_LOOP_ERROR_MARKER = "Thinking loop detected";

/**
 * Rolling tail (chars) inspected for verbatim back-to-back repetition.
 *
 * Wide enough to hold four repeats of the longest unit probed, and then some: the detector requires
 * four, so a window that cannot fit four of a length it claims to probe makes that length dead code.
 * At 250 it held three repeats of an 80-char sentence, which is exactly the shape a real session
 * streamed fifty times with nothing stopping it.
 */
const VERBATIM_TAIL_WINDOW = 900;
/** Minimum total repeated chars before a verbatim run counts as a loop. */
const VERBATIM_MIN_REPEATED_CHARS = 180;
/**
 * Longest unit length probed for a verbatim repeat.
 *
 * A sentence is the unit a degenerate sampler repeats, and a sentence is longer than the 60 chars
 * this used to allow, so the cheap detector was blind to the commonest runaway shape and the only
 * fallback was the segment path, which cannot fire until eight substantial segments (up to 5600
 * chars, about seventy repeats) have gone past. Raised to two full lines; past that a repeat still
 * reaches the segment path.
 */
const VERBATIM_MAX_UNIT = 200;

/** Char cap for an unterminated segment; forces a flush so a wall-of-text loop
 *  (no blank lines / headings) still segments. */
const SEGMENT_CHAR_CAP = 700;
/** A blank line, which ends a segment. Global so a search resumes at `lastIndex`; every use sets
 *  `lastIndex` first. */
const SEGMENT_BOUNDARY = /\n\s*\n/g;
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

/** A concrete reference the model is actually reasoning about: a code span, a
 *  file extension / dotted member, a multi-segment path, or a snake/camel/Pascal
 *  identifier. A segment that introduces a NEW one resets the lexical-stall run —
 *  this spares genuine per-target work (per-file templates, focused single-symbol
 *  debugging) while still catching reworded filler that names nothing new ("just
 *  doing it, pushing ahead") or fixates on one unchanging reference. Excludes bare
 *  digits, abbreviations, and decimals (e.g. "Step 2", "i.e.", "1.2") so numbered
 *  or punctuated filler is not self-anchoring. Global flag: collected with
 *  matchAll, so never used with the stateful test(). */
const CONCRETE_ANCHOR =
	/`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g;

const OPENAI_COMPAT_GUARDED_APIS: Partial<Record<Api, true>> = {
	"openai-completions": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

/**
 * True when `model` is a Gemini model whose native thinking stream surfaces the
 * "thought summary" titles this module's header guard counts.
 *
 * OpenAI-compat transports can serve Gemini under an arbitrary provider/id, so they
 * carry the explicit `compat.enableGeminiThinkingLoopGuard` flag; direct Gemini
 * transports carry a clearly shaped id/provider, so a string match is sufficient.
 */
export function isGeminiThinkingModel(model: Model<Api>): boolean {
	if (OPENAI_COMPAT_GUARDED_APIS[model.api]) {
		const compat = model.compat as { enableGeminiThinkingLoopGuard?: boolean } | undefined;
		return compat?.enableGeminiThinkingLoopGuard === true;
	}
	return /gemini/i.test(`${model.provider}/${model.id}`);
}

/**
 * True when a stream should be watched for a degenerate output loop.
 *
 * Every model is, unless the caller turns the guard off. The guard used to be
 * armed only for Gemini and DeepSeek, on the theory that those were the models
 * observed looping — which meant a Claude or GPT stream could repeat one word
 * five hundred times and nothing was even looking. The detectors below are
 * model-agnostic (verbatim repetition, near-duplicate paragraphs, recycled
 * vocabulary) and were calibrated to zero false positives against 536k real
 * reasoning blocks from every provider, and a false hit costs a re-sample
 * rather than a lost turn, so the narrow scope bought nothing and hid loops.
 *
 * The Gemini-specific *header-run* detector is separate and still keyed on
 * {@link isGeminiThinkingModel}; only the general loop guard is universal.
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
 * Reason `text` is a degenerate sampler run, or null.
 *
 * Same predicate {@link ThinkingLoopDetector} applies while streaming — a unit repeated at least
 * four times with nothing between the repeats, {@link VERBATIM_MIN_REPEATED_CHARS} chars of it, and
 * a letter or emoji somewhere in the unit — asked of a text that is already complete.
 *
 * It needs its own scan rather than a call into the streamed detector, because that one is anchored
 * to the END of what it has seen: the unit is the last `len` chars, which is exactly right for a
 * stream that aborts on the first hit and never right for a run buried mid-text behind a tidy
 * closing paragraph. Re-asking the tail question at every offset would be quadratic (900-char window
 * × 200 candidate lengths × every position), so the run is found directly: for each unit length,
 * find the positions where `text[i]` equals `text[i + len]` and measure how far that agreement
 * holds. An unbroken agreement of `n` chars means the text is periodic with period `len` across
 * `n + len` chars, which is `(n + len) / len` back-to-back repeats. The shortest length that clears
 * the floors wins, so the reported unit is the repeat itself and not a multiple of it.
 *
 * A run clears the floors only when its agreement reaches `floor` positions, so every such run
 * covers one of the positions probed `floor` apart. Only those positions are compared until one
 * agrees, and the run around it is measured then: clean text costs about one comparison per char
 * across all 199 lengths instead of one per char per length.
 *
 * Only this verbatim path applies. The segment-similarity and lexical-stall heuristics are
 * calibrated against reasoning streams, where restating a paragraph is itself the defect; a summary
 * restates by construction, so those two would reject good summaries.
 */
export function detectDegenerateRepetition(text: string): string | null {
	if (text.length < VERBATIM_MIN_REPEATED_CHARS) return null;
	for (let len = 2; len <= VERBATIM_MAX_UNIT && text.length >= len * 4; len++) {
		const hit = degenerateRunOfUnit(text, len);
		if (hit) return hit;
	}
	return null;
}

/** The first run in `text` of a `len`-char unit repeated back-to-back that clears the floors, described, or null. */
function degenerateRunOfUnit(text: string, len: number): string | null {
	const length = text.length;
	// Four repeats need `3 * len` agreeing positions, and the char floor `MIN - len` of them.
	const floor = Math.max(3 * len, VERBATIM_MIN_REPEATED_CHARS - len);
	// Every run starting before `from` has been judged, and `from - 1` is not part of a run.
	let from = 0;
	for (let probe = floor - 1; probe + len < length; probe = from + floor - 1) {
		if (text.charCodeAt(probe) !== text.charCodeAt(probe + len)) {
			from = probe + 1;
			continue;
		}
		const runStart = periodicRunStart(text, probe, len, from);
		const runEnd = periodicRunEnd(text, probe, len);
		from = runEnd + 1;
		const count = Math.floor((runEnd - runStart + len) / len);
		if (count < 4 || count * len < VERBATIM_MIN_REPEATED_CHARS) continue;
		const unit = text.slice(runStart, runStart + len);
		const before = runStart > 0 ? text.charCodeAt(runStart - 1) : -1;
		if (VERBATIM_UNIT_CONTENT.test(unit) && !continuesToken(unit, before)) return describeVerbatimRepeat(unit, count);
	}
	return null;
}

/** Where the agreement of `text` with itself `len` chars on, which holds at `probe`, begins; no earlier than `floor`. */
function periodicRunStart(text: string, probe: number, len: number, floor: number): number {
	let start = probe;
	while (start > floor && text.charCodeAt(start - 1) === text.charCodeAt(start - 1 + len)) start--;
	return start;
}

/** Where the agreement of `text` with itself `len` chars on, which holds at `probe`, ends (exclusive). */
function periodicRunEnd(text: string, probe: number, len: number): number {
	let end = probe + 1;
	while (end + len < text.length && text.charCodeAt(end) === text.charCodeAt(end + len)) end++;
	return end;
}

/**
 * Whether a run of `unit` only continues a longer token, given the code unit `before` the run, or -1
 * when the run starts the text. A whitespace-free unit can be a slice of ONE long token — a path
 * segment, an identifier, a hash — that happens to cycle. A directory named
 * `probe_on_and_on_and_on…` repeats `_on_and` past the character threshold while being a name that
 * exists on disk, and echoing it back is not a sampler that lost its footing. A runaway repeats
 * ACROSS token boundaries, so a whitespace-free run that only continues a longer token is data and
 * is left alone. A run starting at a token boundary still trips, which keeps a space-free script
 * covered. The streamed and the completed-text scans both ask this, so bytes that are a loop when
 * streamed are a loop when echoed in a completed message.
 */
function continuesToken(unit: string, before: number): boolean {
	return before >= 0 && !/\s/.test(unit) && !/\s/.test(String.fromCharCode(before));
}

/**
 * Stateful detector fed the streamed thinking deltas. `push` returns a
 * human-readable reason the first time a loop shape is recognized; the caller
 * is responsible for stopping after the first hit.
 */
export class ThinkingLoopDetector {
	/** The stream's last code units, at least {@link VERBATIM_TAIL_WINDOW} of them once that many
	 *  arrived, for verbatim repeat detection. A delta is appended in place and the window is moved to
	 *  the front once the buffer fills, so a delta costs its own length rather than a copy of the
	 *  window. */
	#tail = new Uint16Array(VERBATIM_TAIL_WINDOW * 2);
	#tailLength = 0;
	/** Pending thinking text not yet split into completed segments. */
	#pending = "";
	/** Where in {@link #pending} a segment boundary can still begin: the start of its trailing
	 *  whitespace run. A boundary is whitespace from end to end, so one beginning earlier would sit
	 *  wholly in text already searched, and only the run and what arrives after it is searched again. */
	#boundaryFrom = 0;
	/** Fingerprints of the most recent substantial segments (≤ SEGMENT_WINDOW). */
	#window: Set<string>[] = [];
	/** Count of substantial segments seen so far (warm-up gate). */
	#count = 0;
	/** Unigram word sets of the most recent segments (≤ LEX_NOVELTY_WINDOW); the
	 *  novelty baseline for progress-lexicon stall detection. */
	#wordWindow: Set<string>[] = [];
	/** How many sets in {@link #wordWindow} hold each word: the window's pooled vocabulary, kept as
	 *  segments enter and leave rather than re-pooled for every segment. */
	#vocabulary = new Map<string, number>();
	/** Consecutive low-information (low-novelty, anchor-free) segments seen. */
	#lexStallRun = 0;
	/** Concrete anchors seen per recent segment (≤ LEX_NOVELTY_WINDOW). A stall is
	 *  only broken by a *new* reference, so filler repeating one fixed
	 *  path/identifier every paragraph is still caught. Only a low-novelty segment
	 *  compares anchors, so an entry holds its segment's text until one does and
	 *  the anchor set replaces it then. */
	#anchorWindow: (Set<string> | string)[] = [];

	push(delta: string): string | null {
		if (!delta) return null;

		// 1. Verbatim back-to-back repetition over the rolling tail.
		const verbatim = detectVerbatimRepetition(this.#tail, this.#extendTail(delta));
		if (verbatim) return describeVerbatimRepeat(verbatim[0], verbatim[1]);

		// 2. Near-duplicate paragraph loop. Append, then drain completed segments.
		this.#pending += delta;
		for (let raw = this.#takeSegment(); raw !== undefined; raw = this.#takeSegment()) {
			const hit = this.#consumeChunks(raw);
			if (hit) return hit;
		}
		return null;
	}

	/**
	 * Removes the next completed segment from {@link #pending}: the text before a blank line, or the
	 * first {@link SEGMENT_CHAR_CAP} chars of a runaway-long segment with no boundary yet. Returns
	 * undefined when neither is there, after moving {@link #boundaryFrom} to where the next search
	 * starts.
	 */
	#takeSegment(): string | undefined {
		const pending = this.#pending;
		SEGMENT_BOUNDARY.lastIndex = this.#boundaryFrom;
		const boundary = SEGMENT_BOUNDARY.exec(pending);
		let raw: string;
		if (boundary) {
			raw = pending.slice(0, boundary.index);
			this.#pending = pending.slice(SEGMENT_BOUNDARY.lastIndex);
		} else if (pending.length > SEGMENT_CHAR_CAP) {
			raw = pending.slice(0, SEGMENT_CHAR_CAP);
			this.#pending = pending.slice(SEGMENT_CHAR_CAP);
		} else {
			// The char before `#boundaryFrom` is not whitespace, so the trailing run starts there at
			// the earliest.
			this.#boundaryFrom = trailingWhitespaceStart(pending, this.#boundaryFrom);
			return undefined;
		}
		// What remains was cut from the front, so it is searched from its start.
		this.#boundaryFrom = 0;
		return raw;
	}

	/** Consumes `raw` in pieces of at most {@link SEGMENT_CHAR_CAP} chars, so an over-long segment
	 *  stays comparable, and returns the first hit. */
	#consumeChunks(raw: string): string | null {
		for (let at = 0; at < raw.length; at += SEGMENT_CHAR_CAP) {
			const hit = this.#consumeSegment(raw.slice(at, at + SEGMENT_CHAR_CAP));
			if (hit) return hit;
		}
		return null;
	}

	/** Appends `delta` to {@link #tail}, moving the last {@link VERBATIM_TAIL_WINDOW} code units to the
	 *  front first when it would not fit, and returns the tail's new length. */
	#extendTail(delta: string): number {
		const tail = this.#tail;
		let length = this.#tailLength;
		let from = 0;
		if (delta.length >= VERBATIM_TAIL_WINDOW) {
			from = delta.length - VERBATIM_TAIL_WINDOW;
			length = 0;
		} else if (length + delta.length > tail.length) {
			tail.copyWithin(0, length - VERBATIM_TAIL_WINDOW, length);
			length = VERBATIM_TAIL_WINDOW;
		}
		for (let i = from; i < delta.length; i++) tail[length++] = delta.charCodeAt(i);
		this.#tailLength = length;
		return length;
	}

	/** Process the buffered trailing paragraph (one with no blank-line / heading
	 *  terminator). Called when the thinking block ends so the final segment —
	 *  which may be the one that completes a duplicate cluster — is not dropped. */
	flush(): string | null {
		if (!this.#pending) return null;
		const rest = this.#pending;
		this.#pending = "";
		this.#boundaryFrom = 0;
		return this.#consumeChunks(rest);
	}

	#consumeSegment(raw: string): string | null {
		// Reasoning-summarizer titles ("**Maintaining Momentum**", "## Heading")
		// are per-thought formatting, not chain-of-thought; their ever-changing
		// wording would otherwise mask a loop by inflating novelty. Strip them
		// before analysis (a title-only segment then falls below the length gate).
		const segment = raw.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "").replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "");
		const tokens = segmentTokens(segment);
		if (joinedLength(tokens) < SEGMENT_MIN_NORM_CHARS) return null;

		// (a) Near-duplicate trigram cluster: the same paragraph reused with
		// cosmetic wording drift (high word-trigram overlap).
		const fingerprint = trigramShingles(tokens);
		let cluster = 1;
		for (const prev of this.#window) {
			if (nearDuplicate(fingerprint, prev)) cluster++;
		}

		const words = new Set<string>(tokens);
		const anchorsHeld = this.#scoreLexicalStall(segment, words);
		this.#remember(fingerprint, words, anchorsHeld);

		if (this.#count < SEGMENT_MIN_COUNT) return null;
		if (cluster >= SEGMENT_MIN_CLUSTER) {
			return `${cluster} near-identical segments within the last ${SEGMENT_WINDOW}`;
		}
		if (this.#lexStallRun >= LEX_STALL_MIN_RUN) {
			return `${this.#lexStallRun} low-information segments recycling recent wording`;
		}
		return null;
	}

	/**
	 * (b) Progress-lexicon stall: paragraphs that recycle the recent
	 * vocabulary (low novelty) and add no *new* concrete reference — reworded
	 * filler that burns budget without advancing. The trigram check
	 * already claims high-overlap near-duplicates; this catches the
	 * low-overlap, reshuffled-wording shape it misses. Requiring a NEW anchor
	 * (not merely any anchor) still catches filler that name-drops one fixed
	 * path/identifier every paragraph, while sparing genuine per-target work
	 * that names a fresh file/symbol each time.
	 *
	 * Advances or resets {@link #lexStallRun} and returns what the anchor window holds for this
	 * segment: its anchors when they were matched, or the segment itself to extract them from later.
	 */
	#scoreLexicalStall(segment: string, words: Set<string>): Set<string> | string {
		const vocabulary = this.#vocabulary;
		let unseen = 0;
		for (const w of words) if (!vocabulary.has(w)) unseen++;
		const novelty = vocabulary.size === 0 ? 1 : unseen / words.size;
		// A segment that adds enough new words resets the run whatever it names, so its anchors are
		// matched only when it falls under the novelty floor.
		if (novelty > LEX_STALL_NOVELTY_FLOOR) {
			this.#lexStallRun = 0;
			return segment;
		}
		const anchors = concreteAnchors(segment);
		if (this.#namesNewAnchor(anchors)) this.#lexStallRun = 0;
		else this.#lexStallRun++;
		return anchors;
	}

	/** Slides the segment's fingerprint, words and anchors into their bounded windows. */
	#remember(fingerprint: Set<string>, words: Set<string>, anchorsHeld: Set<string> | string): void {
		this.#window.push(fingerprint);
		if (this.#window.length > SEGMENT_WINDOW) this.#window.shift();
		const vocabulary = this.#vocabulary;
		this.#wordWindow.push(words);
		for (const w of words) vocabulary.set(w, (vocabulary.get(w) ?? 0) + 1);
		if (this.#wordWindow.length > LEX_NOVELTY_WINDOW) {
			for (const w of this.#wordWindow.shift() as Set<string>) {
				const held = (vocabulary.get(w) as number) - 1;
				if (held === 0) vocabulary.delete(w);
				else vocabulary.set(w, held);
			}
		}
		this.#anchorWindow.push(anchorsHeld);
		if (this.#anchorWindow.length > LEX_NOVELTY_WINDOW) this.#anchorWindow.shift();
		this.#count++;
	}

	/** Whether `anchors` holds a reference no segment in the anchor window named. */
	#namesNewAnchor(anchors: Set<string>): boolean {
		const window = this.#anchorWindow;
		for (const anchor of anchors) {
			let seen = false;
			for (let i = 0; i < window.length && !seen; i++) {
				let held = window[i] as Set<string> | string;
				if (typeof held === "string") {
					held = concreteAnchors(held);
					window[i] = held;
				}
				seen = held.has(anchor);
			}
			if (!seen) return true;
		}
		return false;
	}
}

/**
 * Consecutive Gemini thought-summary headers in one uninterrupted reasoning
 * stream that trips the tool-call reminder. Gemini occasionally narrates a long
 * chain of titled summaries ("Examining Result Handling", "Refining Result
 * Rendering", …) without ever calling a tool, burning the whole budget on
 * planning. This is the over-planning shape {@link ThinkingLoopDetector} misses —
 * those titles are stripped before its similarity analysis precisely because their
 * wording keeps changing, so a genuinely-distinct planning runaway never trips it.
 *
 * Set well above legitimate hard-problem depth: a capable model can emit ~10
 * distinct, progressing hypotheses in a single reasoning block before acting (and
 * a false trip is costly — the interrupt discards the whole reasoning turn). A
 * real narration runaway burns dozens-to-hundreds of titles, so this still trips
 * fast on the actual pathology.
 */
export const GEMINI_HEADER_RUNAWAY_THRESHOLD = 24;

/**
 * True when a single trimmed line is a Gemini reasoning-summary title: a markdown
 * ATX heading (`## …`) or a whole-line bold / bold-italic run (`**Title**`,
 * `***Title***`). Inline emphasis inside prose never matches — the bold run must
 * span the entire line. Mirrors the title shapes {@link ThinkingLoopDetector}
 * strips before similarity analysis.
 */
export function isReasoningSummaryHeader(line: string): boolean {
	return /^#{1,6}[ \t]+\S/.test(line) || /^\*{2,3}.+\*{2,3}$/.test(line);
}

/**
 * Counts consecutive Gemini reasoning-summary headers across a streamed thinking
 * block. {@link push} returns true exactly once — when the running header count
 * first reaches {@link GEMINI_HEADER_RUNAWAY_THRESHOLD} — and the caller then
 * interrupts the stream and reminds the model to issue a tool call. Paragraph
 * lines between titles do NOT reset the run (Gemini emits header + paragraph per
 * thought, so the run IS the number of summaries); leaving the reasoning channel
 * does, via {@link reset} on a new thinking block / prose / tool call.
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
	const detectors = new StreamLoopDetectors(options?.loopGuard?.checkAssistantContent !== false);
	void pumpGuardedStream(inner, outer, detectors, model, controller);
	return outer;
}

/**
 * The thinking and assistant-text detectors of one guarded stream. Thinking is watched until
 * the first text or tool-call event, assistant text until the first tool-call event.
 */
class StreamLoopDetectors {
	#thinking = new ThinkingLoopDetector();
	#text = new ThinkingLoopDetector();
	#thinkingArmed = true;
	#textArmed: boolean;

	constructor(checkAssistantContent: boolean) {
		this.#textArmed = checkAssistantContent;
	}

	/** The loop `event` completes, or null. */
	inspect(event: AssistantMessageEvent): string | null {
		switch (event.type) {
			case "thinking_delta":
				return this.#thinkingArmed ? this.#thinking.push(event.delta) : null;
			case "thinking_end":
				if (!this.#thinkingArmed) return null;
				this.#thinkingArmed = false;
				return this.#thinking.flush();
			case "text_start":
				this.#thinkingArmed = false;
				return null;
			case "text_delta":
				this.#thinkingArmed = false;
				return this.#textArmed ? this.#text.push(event.delta) : null;
			case "toolcall_start":
			case "toolcall_delta":
				this.#thinkingArmed = false;
				this.#textArmed = false;
				return null;
			case "done":
				// A stream that reached `done` stopped on its own, so a trailing repeat is
				// the end of an answer rather than a runaway. Raising here discards a turn
				// that already succeeded and hands the session a retry that resamples the
				// same prompt, trips the same detector, and fails again — the abort is
				// deterministic, so the retry ladder cannot recover it. Only a `length`
				// stop, where the model ran into the token cap still repeating, carries
				// the runaway signature this guard exists for.
				return event.reason === "length" ? this.#flushArmed() : null;
			default:
				return null;
		}
	}

	#flushArmed(): string | null {
		// Text is pushed only after thinking disarms, and nothing re-arms it, so at most one
		// detector holds anything to flush.
		if (this.#thinkingArmed) return this.#thinking.flush();
		return this.#textArmed ? this.#text.flush() : null;
	}
}

/** Forwards `inner` to `outer` until the stream ends or a detector reports a loop. */
async function pumpGuardedStream(
	inner: AssistantMessageEventStream,
	outer: AssistantMessageEventStream,
	detectors: StreamLoopDetectors,
	model: Model<Api>,
	controller: AbortController,
): Promise<void> {
	// Last streamed view of the attempt, kept for its usage: a loop that gets
	// aborted still billed every token it sampled, and the stall message this
	// guard raises replaces the attempt entirely.
	let partial: AssistantMessage | undefined;
	try {
		for await (const event of inner) {
			if ("partial" in event) partial = event.partial;
			const detail = detectors.inspect(event);
			if (detail) {
				raiseThinkingLoop(outer, model, controller, detail, partial);
				return;
			}
			// The event that ends `outer` also ended `inner`, so the loop ends after it.
			outer.push(event);
		}
		if (outer.done) return;
		try {
			outer.end(await inner.result());
		} catch (err) {
			outer.fail(err);
		}
	} catch (err) {
		if (!outer.done) outer.fail(err);
	}
}

/** Aborts the upstream and ends `outer` with the retryable stall, which carries the usage the attempt billed. */
function raiseThinkingLoop(
	outer: AssistantMessageEventStream,
	model: Model<Api>,
	controller: AbortController,
	detail: string,
	partial: AssistantMessage | undefined,
): void {
	logger.warn("Thinking loop detected; aborting stream for retry.", {
		model: model.id,
		provider: model.provider,
		detail,
	});
	controller.abort(AIError.attach(new Error(THINKING_LOOP_ERROR_MARKER), AIError.create(AIError.Flag.ThinkingLoop)));
	const stall = buildThinkingLoopError(model, detail);
	if (partial) discardAttemptUsage(model, partial.usage, stall.usage);
	outer.push({ type: "error", reason: "error", error: stall });
}

/**
 * Apply the loop guard around a provider dispatch. For non-guarded models
 * (or when disabled) this is a transparent pass-through. For guarded models it injects a
 * guard abort signal into the provider call so a detected loop tears down the
 * upstream, then wraps the returned stream. The guard only raises the retryable
 * stall; bounding the re-samples and the final cook pass lives in the
 * result-awaiting caller.
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
 * Detect a unit repeated back-to-back at the tail (verbatim loop). Only a unit carrying a letter or
 * pictographic emoji counts.
 *
 * The ladder probes unit lengths in ascending order, and two things keep it cheap at a 200-char cap.
 * The character test is answered once for the whole window by measuring how far the nearest letter
 * sits from the end (a unit of length `len` carries content exactly when it reaches that far back),
 * rather than re-scanning each candidate. And a unit of length `len` can only repeat when the char
 * `len` back from the end equals the last char, so the ladder jumps between occurrences of the last
 * char instead of comparing at every length.
 */
function detectVerbatimRepetition(tail: Uint16Array, end: number): [unit: string, count: number] | null {
	// Every index below is into `tail`; the search space is the last `VERBATIM_TAIL_WINDOW` code units
	// before `end`, read in place. A delta is pushed many times a second, so no candidate unit becomes
	// a string until it repeats: the comparison walks code units, and a mismatch on the first ends a
	// length.
	const start = end - Math.min(end, VERBATIM_TAIL_WINDOW);
	const searchLength = end - start;
	if (searchLength < VERBATIM_MIN_REPEATED_CHARS) return null;

	const contentAt = contentDistance(tail, start, end);
	if (contentAt > VERBATIM_MAX_UNIT) return null;

	const minLen = Math.max(2, contentAt);
	const maxLen = Math.min(VERBATIM_MAX_UNIT, Math.floor(searchLength / 4));
	const last = tail[end - 1];
	// `at` is the code unit `len` back from the end, and only an `at` holding the last one starts a
	// comparison. `at` stays above `start` because `len` is at most a quarter of the window.
	for (let at = end - 1 - minLen; at >= end - 1 - maxLen; at--) {
		if (tail[at] !== last) continue;
		const len = end - 1 - at;
		const unitAt = end - len;
		// The last `len` chars are one repeat; the run is every equal block before them.
		const runAt = repeatRunStart(tail, start, unitAt, len);
		const count = (unitAt - runAt) / len + 1;
		if (count < 4 || len * count < VERBATIM_MIN_REPEATED_CHARS) continue;
		const unit = String.fromCharCode(...tail.subarray(unitAt, end));
		if (continuesToken(unit, runAt > start ? (tail[runAt - 1] as number) : -1)) continue;
		return [unit, count];
	}
	return null;
}

/**
 * Distance from `end` back to the nearest letter or pictographic emoji in `tail[start, end)`, or
 * {@link VERBATIM_MAX_UNIT} + 1 when none sits within the longest unit probed. Any unit shorter than
 * this is punctuation, digits or whitespace and is never probed.
 */
function contentDistance(tail: Uint16Array, start: number, end: number): number {
	const scan = Math.min(end - start, VERBATIM_MAX_UNIT);
	for (let back = 1; back <= scan; back++) {
		const at = end - back;
		const code = tail[at] as number;
		// An ASCII char carries content exactly when it is a letter: no ASCII char is a pictograph.
		if (code < 0x80) {
			if (((code | 0x20) - 0x61) >>> 0 < 26) return back;
			continue;
		}
		// An emoji is two code units and a lone surrogate carries no Unicode property, so a low
		// surrogate is tested together with the high half in front of it, and a unit has to reach one
		// char further back to hold the whole pair.
		const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff && at > start;
		const char = isLowSurrogate ? String.fromCharCode(tail[at - 1] as number, code) : String.fromCharCode(code);
		if (VERBATIM_UNIT_CONTENT.test(char)) return isLowSurrogate ? back + 1 : back;
	}
	return VERBATIM_MAX_UNIT + 1;
}

/** Where the run of `len`-unit blocks equal to the one at `unitAt` begins, no earlier than `start`. */
function repeatRunStart(tail: Uint16Array, start: number, unitAt: number, len: number): number {
	let pos = unitAt;
	while (pos - len >= start && sameUnits(tail, pos - len, unitAt, len)) pos -= len;
	return pos;
}

/** Whether `tail` holds the same `length` code units at `a` and at `b`. */
function sameUnits(tail: Uint16Array, a: number, b: number, length: number): boolean {
	for (let i = 0; i < length; i++) {
		if (tail[a + i] !== tail[b + i]) return false;
	}
	return true;
}

/** Where the run of whitespace ending `text` begins, searching back no further than `floor`. */
function trailingWhitespaceStart(text: string, floor: number): number {
	let from = text.length;
	while (from > floor) {
		const code = text.charCodeAt(from - 1);
		const space = code < 0x80 ? code === 0x20 || (code >= 0x09 && code <= 0x0d) : /\s/.test(text[from - 1] as string);
		if (!space) break;
		from--;
	}
	return from;
}

/** Lowercased word tokens of prose plus code/path payloads, dropping pure numbers. */
function segmentTokens(segment: string): string[] {
	return segment
		.toLowerCase()
		.replace(/`([^`]*)`/g, " $1 ")
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter(token => /[a-z]/.test(token));
}

/** Length of `tokens` joined by single spaces. */
function joinedLength(tokens: readonly string[]): number {
	let length = tokens.length > 0 ? tokens.length - 1 : 0;
	for (const token of tokens) length += token.length;
	return length;
}

/** Word-trigram shingle set of a segment's tokens. */
function trigramShingles(words: readonly string[]): Set<string> {
	if (words.length < 3) return new Set(words.length > 0 ? [words.join(" ")] : []);
	const shingles = new Set<string>();
	for (let i = 0; i + 3 <= words.length; i++) {
		shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	}
	return shingles;
}

/**
 * Whether the Jaccard similarity of `a` and `b` reaches {@link SEGMENT_SIMILARITY}. The similarity
 * only rises with the intersection, so the walk stops at the first miss after which even an
 * intersection holding every unchecked shingle stays below it; two unrelated segments stop within
 * the first few shingles.
 */
function nearDuplicate(a: Set<string>, b: Set<string>): boolean {
	if (a.size === 0 || b.size === 0) return false;
	const small = a.size < b.size ? a : b;
	const large = small === a ? b : a;
	const total = a.size + b.size;
	let intersection = 0;
	let unchecked = small.size;
	for (const x of small) {
		unchecked--;
		if (large.has(x)) {
			intersection++;
		} else {
			const best = intersection + unchecked;
			if (best / (total - best) < SEGMENT_SIMILARITY) return false;
		}
	}
	return intersection / (total - intersection) >= SEGMENT_SIMILARITY;
}

/** Concrete anchors in a segment, canonicalized so the same reference written as `Foo`, Foo, or FOO
 *  is one anchor and cannot masquerade as "new" to keep a fixed-reference stall alive. */
function concreteAnchors(segment: string): Set<string> {
	const anchors = new Set<string>();
	for (const match of segment.matchAll(CONCRETE_ANCHOR)) anchors.add(match[0].replace(/`/g, "").toLowerCase());
	return anchors;
}
