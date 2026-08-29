import { discardAttemptUsage, emptyUsage } from "@veyyon/catalog/models";
import * as logger from "@veyyon/utils/logger";
import * as AIError from "../error";
import type { Api, AssistantMessage, Model, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

export const THINKING_LOOP_ERROR_MARKER = "Thinking loop detected";

const VERBATIM_TAIL_WINDOW = 900;
const VERBATIM_MIN_REPEATED_CHARS = 180;
const VERBATIM_MAX_UNIT = 200;

const SEGMENT_CHAR_CAP = 700;
const SEGMENT_MIN_NORM_CHARS = 60;
const SEGMENT_WINDOW = 16;
const SEGMENT_SIMILARITY = 0.8;
const SEGMENT_MIN_COUNT = 8;
const SEGMENT_MIN_CLUSTER = 4;

const LEX_NOVELTY_WINDOW = 8;
const LEX_STALL_NOVELTY_FLOOR = 0.2;
const LEX_STALL_MIN_RUN = 8;

const CONCRETE_ANCHOR =
	/`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g;

const OPENAI_COMPAT_GUARDED_APIS: Partial<Record<Api, true>> = {
	"openai-completions": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

export function isGeminiThinkingModel(model: Model<Api>): boolean {
	if (OPENAI_COMPAT_GUARDED_APIS[model.api]) {
		const compat = model.compat as { enableGeminiThinkingLoopGuard?: boolean } | undefined;
		return compat?.enableGeminiThinkingLoopGuard === true;
	}
	return /gemini/i.test(`${model.provider}/${model.id}`);
}

export function isLoopGuardEnabled(options?: StreamOptions): boolean {
	return options?.loopGuard?.enabled !== false;
}

function describeVerbatimRepeat(unit: string, count: number): string {
	return `repeated "${unit.trim()}" ${count}× back-to-back`;
}

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
				// Same judgement the streamed detector applies: a whitespace-free run that
				// only continues a longer token is one long name cycling, not a sampler
				// runaway. Both paths have to agree, or a path echoed in a completed
				// message is a loop while the same bytes streamed are not.
				const continuesToken = !/\s/.test(unit) && runStart > 0 && !/\s/.test(text[runStart - 1] as string);
				if (
					count >= 4 &&
					count * len >= VERBATIM_MIN_REPEATED_CHARS &&
					VERBATIM_UNIT_CONTENT.test(unit) &&
					!continuesToken
				) {
					return describeVerbatimRepeat(unit, count);
				}
				agreement = 0;
			}
		}
	}
	return null;
}

export class ThinkingLoopDetector {
	#tail = "";
	#pending = "";
	#window: Set<string>[] = [];
	#count = 0;
	#wordWindow: Set<string>[] = [];
	#lexStallRun = 0;
	#anchorWindow: Set<string>[] = [];

	push(delta: string): string | null {
		if (!delta) return null;

		this.#tail += delta;
		if (this.#tail.length > VERBATIM_TAIL_WINDOW) this.#tail = this.#tail.slice(-VERBATIM_TAIL_WINDOW);
		const verbatim = detectVerbatimRepetition(this.#tail);
		if (verbatim) return describeVerbatimRepeat(verbatim[0], verbatim[1]);

		this.#pending += delta;
		while (true) {
			const boundary = /\n\s*\n/.exec(this.#pending);
			let raw: string;
			if (boundary) {
				raw = this.#pending.slice(0, boundary.index);
				this.#pending = this.#pending.slice(boundary.index + boundary[0].length);
			} else if (this.#pending.length > SEGMENT_CHAR_CAP) {
				raw = this.#pending.slice(0, SEGMENT_CHAR_CAP);
				this.#pending = this.#pending.slice(SEGMENT_CHAR_CAP);
			} else {
				return null;
			}
			for (let rest = raw; rest.length > 0; ) {
				const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
				rest = rest.slice(chunk.length);
				const hit = this.#consumeSegment(chunk);
				if (hit) return hit;
			}
		}
	}

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
		const segment = raw.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "").replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "");
		const normalized = normalizeSegment(segment);
		if (normalized.length < SEGMENT_MIN_NORM_CHARS) return null;

		const fingerprint = trigramShingles(normalized);
		let cluster = 1;
		for (const prev of this.#window) {
			if (jaccard(fingerprint, prev) >= SEGMENT_SIMILARITY) cluster++;
		}

		const words = new Set<string>(normalized.split(" ").filter(Boolean));
		const priorVocab = new Set<string>();
		for (const set of this.#wordWindow) for (const w of set) priorVocab.add(w);
		let unseen = 0;
		for (const w of words) if (!priorVocab.has(w)) unseen++;
		const novelty = priorVocab.size === 0 ? 1 : unseen / words.size;

		const anchors = new Set<string>();
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

export const GEMINI_HEADER_RUNAWAY_THRESHOLD = 24;

export function isReasoningSummaryHeader(line: string): boolean {
	return /^#{1,6}[ \t]+\S/.test(line) || /^\*{2,3}.+\*{2,3}$/.test(line);
}

export class GeminiHeaderRunDetector {
	#pending = "";
	#count = 0;
	#fired = false;

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

	get count(): number {
		return this.#count;
	}

	reset(): void {
		this.#pending = "";
		this.#count = 0;
		this.#fired = false;
	}
}

function guardThinkingLoopStream(
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
					// A stream that reached `done` stopped on its own, so a trailing repeat is
					// the end of an answer rather than a runaway. Raising here discards a turn
					// that already succeeded and hands the session a retry that resamples the
					// same prompt, trips the same detector, and fails again — the abort is
					// deterministic, so the retry ladder cannot recover it. Only a `length`
					// stop, where the model ran into the token cap still repeating, carries
					// the runaway signature this guard exists for.
					if (event.reason === "length") {
						if (thinkingArmed) {
							detail = thinkingDetector.flush();
						}
						if (textArmed) {
							detail = detail || textDetector.flush();
						}
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
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: `${THINKING_LOOP_ERROR_MARKER}: the model repeated near-identical content (${detail}). Treating as a stream stall and retrying.`,
		errorId: AIError.create(AIError.Flag.ThinkingLoop),
		timestamp: Date.now(),
	};
}

const VERBATIM_UNIT_CONTENT = /[\p{L}\p{Extended_Pictographic}]/u;

function detectVerbatimRepetition(text: string): [unit: string, count: number] | null {
	if (text.length < VERBATIM_MIN_REPEATED_CHARS) return null;
	const windowSize = Math.min(text.length, VERBATIM_TAIL_WINDOW);
	const searchSpace = text.slice(-windowSize);

	let contentAt = VERBATIM_MAX_UNIT + 1;
	const scan = Math.min(searchSpace.length, VERBATIM_MAX_UNIT);
	for (let back = 1; back <= scan; back++) {
		const at = searchSpace.length - back;
		const code = searchSpace.charCodeAt(at);
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
		if (count < 4 || len * count < VERBATIM_MIN_REPEATED_CHARS) continue;
		// A whitespace-free unit can be a slice of ONE long token — a path segment, an
		// identifier, a hash — that happens to cycle. A directory named
		// `probe_on_and_on_and_on…` repeats `_on_and` past the character threshold while
		// being a name that exists on disk, and echoing it back is not a sampler that lost
		// its footing. A runaway repeats ACROSS token boundaries, so a whitespace-free run
		// that only continues a longer token is data and is left alone. A run starting at a
		// token boundary still trips, which keeps a space-free script covered.
		if (!/\s/.test(unit) && pos > 0 && !/\s/.test(searchSpace[pos - 1] as string)) continue;
		return [unit, count];
	}
	return null;
}

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
