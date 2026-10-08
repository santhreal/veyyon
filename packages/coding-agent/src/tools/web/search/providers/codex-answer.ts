/**
 * One Codex web search's answer, sources, model, request id and token usage, folded from the
 * Responses SSE events the search streams back.
 */
import type { SearchSource } from "../types";
import { SearchProviderError } from "../types";

interface CodexAnnotation {
	type: string;
	url?: string;
	title?: string;
}

interface CodexContentPart {
	type: string;
	text?: string;
	annotations?: CodexAnnotation[];
}

interface CodexOutputItem {
	type: string;
	content?: CodexContentPart[];
	summary?: Array<{ type: string; text: string }>;
}

interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface CodexResponse {
	id?: string;
	model?: string;
	usage?: CodexUsage;
}

/** The Responses stream events a search reads. An event of any other type is skipped. */
export type CodexSearchEvent =
	| { type: "response.output_text.delta"; delta?: unknown }
	| { type: "response.output_item.done"; item?: CodexOutputItem }
	| { type: "response.completed" | "response.done"; response?: CodexResponse }
	| { type: "error"; code?: string; message?: string }
	| { type: "response.failed"; response?: { error?: { message?: string } } };

/** Token usage of one search. `inputTokens` excludes cached input tokens. */
export interface CodexSearchUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

export interface CodexSearchAnswer {
	answer: string;
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: CodexSearchUsage;
}

/**
 * Known Codex "image placeholder" answers — short prose the assistant emits in
 * place of a real answer when it produced a screenshot instead of text. These
 * carry no information, so callers treat them as non-answers and advance the
 * chain to a provider that returns text. Extend by adding the normalized
 * literal below; no regex tuning required.
 */
const IMAGE_PLACEHOLDER_ANSWERS: ReadonlySet<string> = new Set([
	"see attached image",
	"attached image",
	"see the attached image",
	"see image",
	"see image above",
	"image above",
	"see image below",
	"image below",
]);

function isImagePlaceholderAnswer(text: string): boolean {
	// Strip surrounding brackets/quotes and trailing punctuation, lowercase,
	// then match against the known-placeholder set.
	const normalized = text
		.trim()
		.replace(/^[[("'`*_]+/, "")
		.replace(/[\])"'`*_.!?]+$/, "")
		.trim()
		.toLowerCase();
	return IMAGE_PLACEHOLDER_ANSWERS.has(normalized);
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!sources.some(existing => existing.url === source.url)) {
		sources.push(source);
	}
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const char of text) {
		if (char === target) {
			count += 1;
		}
	}
	return count;
}

/** The opening delimiter of each closing delimiter a trailing URL character may be. */
const OPENING_DELIMITER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Strips prose punctuation and unmatched closing delimiters from extracted URLs.
 * Codex often returns links in markdown or sentence text without structured annotations.
 */
function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();

	while (url.length > 0) {
		const lastCharacter = url.at(-1) ?? "";
		const opening = OPENING_DELIMITER[lastCharacter];
		const unmatchedClosing =
			opening !== undefined && countCharacter(url, lastCharacter) > countCharacter(url, opening);
		if (!unmatchedClosing && !/[.,!?;:'"]/u.test(lastCharacter)) break;
		url = url.slice(0, -1);
	}

	if (!/^https?:\/\//.test(url)) {
		return null;
	}

	try {
		return new URL(url).toString();
	} catch {
		// A citation URL trimmed out of model prose. The trailing-punctuation loop above strips what it can,
		// and what is left either parses or was never a URL, so the throw is the answer: no citation rather
		// than a guessed one, since the URL is shown to the reader as a source.
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;

	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") {
			return null;
		}
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return index;
		}
		if (depth < 0) {
			return null;
		}
	}

	return null;
}

/**
 * Extracts citation sources from markdown links and bare URLs in the answer text.
 * Used as a fallback when the Codex response omits `url_citation` annotations.
 */
function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") {
			continue;
		}
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") {
			continue;
		}
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) {
			continue;
		}
		const title = text.slice(index + 1, titleEnd).trim();
		const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
		if (url) {
			addSource(sources, { title: title || url, url });
		}
		index = urlEnd;
	}

	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (!url) continue;
		addSource(sources, { title: url, url });
	}

	return sources;
}

/**
 * Folds a search's stream events into one answer. The answer is the text of the final output items,
 * message text and reasoning summaries joined by a blank line, else the streamed text deltas; either
 * is discarded when it is only image placeholder prose. Sources are the `url_citation` annotations,
 * else the links and URLs in the answer.
 */
export class CodexAnswerCollector {
	readonly #finalParts: string[] = [];
	readonly #streamedParts: string[] = [];
	readonly #sources: SearchSource[] = [];
	#model: string;
	#requestId = "";
	#usage: CodexSearchUsage | undefined;

	constructor(requestedModel: string) {
		this.#model = requestedModel;
	}

	/** Folds one event. Throws on an `error` or `response.failed` event. */
	accept(event: CodexSearchEvent): void {
		switch (event.type) {
			case "response.output_text.delta":
				if (typeof event.delta === "string" && event.delta) this.#streamedParts.push(event.delta);
				return;
			case "response.output_item.done":
				if (event.item) this.#acceptItem(event.item);
				return;
			case "response.completed":
			case "response.done":
				if (event.response) this.#acceptResponse(event.response);
				return;
			case "error":
				throw new SearchProviderError(
					"codex",
					`Codex error (${event.code ?? ""}): ${event.message ?? "Unknown error"}`,
					500,
				);
			case "response.failed":
				throw new SearchProviderError(
					"codex",
					`Codex request failed: ${event.response?.error?.message ?? "Request failed"}`,
					500,
				);
		}
	}

	/** The folded search. Throws when it holds neither answer text nor a source. */
	finish(): CodexSearchAnswer {
		const finalAnswer = this.#finalParts.join("\n\n").trim();
		const streamedAnswer = this.#streamedParts.join("").trim();
		// The model occasionally streams the same placeholder text it publishes as the final
		// output_text, so each is checked on its own.
		const hasFinalText = finalAnswer.length > 0 && !isImagePlaceholderAnswer(finalAnswer);
		const hasStreamedText = streamedAnswer.length > 0 && !isImagePlaceholderAnswer(streamedAnswer);
		const answer = hasFinalText ? finalAnswer : hasStreamedText ? streamedAnswer : "";
		if (!answer && this.#sources.length === 0) {
			throw new SearchProviderError("codex", "Codex returned image-only response", 502);
		}
		if (this.#sources.length === 0) {
			for (const source of extractTextSources(answer)) addSource(this.#sources, source);
		}
		return {
			answer,
			sources: this.#sources,
			model: this.#model,
			requestId: this.#requestId,
			usage: this.#usage,
		};
	}

	#acceptItem(item: CodexOutputItem): void {
		if (item.type === "message") {
			for (const part of item.content ?? []) this.#acceptContent(part);
		} else if (item.type === "reasoning") {
			for (const part of item.summary ?? []) {
				if (part.type === "summary_text" && part.text) this.#finalParts.push(part.text);
			}
		}
	}

	#acceptContent(part: CodexContentPart): void {
		if (part.type !== "output_text" || !part.text) return;
		this.#finalParts.push(part.text);
		for (const annotation of part.annotations ?? []) {
			if (annotation.type === "url_citation" && annotation.url) {
				addSource(this.#sources, { title: annotation.title ?? annotation.url, url: annotation.url });
			}
		}
	}

	#acceptResponse(response: CodexResponse): void {
		if (response.model) this.#model = response.model;
		if (response.id) this.#requestId = response.id;
		if (response.usage) {
			const cachedTokens = response.usage.input_tokens_details?.cached_tokens ?? 0;
			this.#usage = {
				inputTokens: (response.usage.input_tokens ?? 0) - cachedTokens,
				outputTokens: response.usage.output_tokens ?? 0,
				totalTokens: response.usage.total_tokens ?? 0,
			};
		}
	}
}
