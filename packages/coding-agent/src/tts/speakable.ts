import { hasAlphanumeric } from "@veyyon/utils";

const FIRST_SEGMENT_MIN = 12;
const FIRST_CLAUSE_MIN = 40;
const FIRST_FORCED_MAX = 140;
const MIN_SEGMENT = 24;
const SOFT_CLAUSE_LEN = 160;
const MAX_SEGMENT = 280;

const SENTENCE_BOUNDARY_RE = /[.!?…]+[)\]"'»”’]*\s/g;
const CLAUSE_BOUNDARY_RE = /[,;:—–]\s/g;
const ABBREVIATION_RE = /(?:^|\s)(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|No)\.$/i;

const UNDECIDED_PREFIX_RE = /^(?:#{1,6}|[-*+]|-{2,}|\*{2,}|_{2,}|\d{1,3}|\d{1,3}[.)]|>+|`{1,2}|~{1,2})$/;
const HR_LINE_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

const IMAGE_RE = /!\[([^\]]*)\]\(([^()]*)\)/g;
const LINK_RE = /\[([^\]]+)\]\(([^()]*)\)/g;
const AUTOLINK_RE = /<(https?:\/\/[^\s>]+)>/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()"'\]]+|\bwww\.[\w-]+(?:\.[\w-]+)+[^\s<>()"'\]]*/g;
const INLINE_CODE_RE = /`{1,2}([^`]+)`{1,2}/g;
const BOLD_STRIKE_RE = /\*\*|__|~~/g;
const EMPHASIS_ASTERISK_RE = /\*(?=\S)|(?<=\S)\*/g;
const EMPHASIS_UNDERSCORE_RE = /(^|\s)_+|_+(?=\s|$)/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^<>]*>/g;
const HR_INLINE_RE = /(^|\s)[-*_]{3,}(?=\s|$)/g;
const PATH_RE = /(^|[\s("'`])((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+){2,}\/?)/g;

function speakableUrl(url: string): string {
	return url
		.replace(/^[a-z][\w+.-]*:\/\//i, "")
		.replace(/^www\./i, "")
		.replace(/[/?#].*$/, "");
}

function normalizeSpeakable(raw: string): string {
	const spoken = raw
		.replace(IMAGE_RE, "$1")
		.replace(LINK_RE, "$1")
		.replace(AUTOLINK_RE, (_match, url: string) => speakableUrl(url))
		.replace(BARE_URL_RE, match => speakableUrl(match))
		.replace(INLINE_CODE_RE, "$1")
		.replace(BOLD_STRIKE_RE, "")
		.replace(EMPHASIS_ASTERISK_RE, "")
		.replace(EMPHASIS_UNDERSCORE_RE, "$1")
		.replace(HTML_TAG_RE, " ")
		.replace(HR_INLINE_RE, "$1")
		.replace(PATH_RE, (_match, lead: string, path: string) => {
			const parts = path.split("/").filter(part => part.length > 0);
			return lead + (parts[parts.length - 1] ?? path);
		})
		.replace(/\s+/g, " ")
		.trim();
	return hasAlphanumeric(spoken) ? spoken : "";
}

function findSentenceCut(text: string, min: number): number {
	SENTENCE_BOUNDARY_RE.lastIndex = 0;
	for (let match = SENTENCE_BOUNDARY_RE.exec(text); match; match = SENTENCE_BOUNDARY_RE.exec(text)) {
		const cut = match.index + match[0].length;
		if (cut < min) continue;
		const head = text.slice(0, cut);
		if (ABBREVIATION_RE.test(head.trimEnd())) continue;
		if ((head.match(/`/g)?.length ?? 0) % 2 !== 0) continue;
		return cut;
	}
	return -1;
}

function findClauseCut(text: string, min: number): number {
	CLAUSE_BOUNDARY_RE.lastIndex = 0;
	for (let match = CLAUSE_BOUNDARY_RE.exec(text); match; match = CLAUSE_BOUNDARY_RE.exec(text)) {
		const cut = match.index + match[0].length;
		if (cut >= min) return cut;
	}
	return -1;
}

function findLastClauseCut(text: string, min: number, max: number): number {
	CLAUSE_BOUNDARY_RE.lastIndex = 0;
	let best = -1;
	for (let match = CLAUSE_BOUNDARY_RE.exec(text); match; match = CLAUSE_BOUNDARY_RE.exec(text)) {
		const cut = match.index + match[0].length;
		if (cut > max) break;
		if (cut >= min) best = cut;
	}
	return best;
}

function findForcedCut(text: string, max: number): number {
	const space = text.lastIndexOf(" ", max);
	return space > 0 ? space + 1 : Math.min(max, text.length);
}

type PrefixDecision =
	| { kind: "undecided" }
	| { kind: "prose"; text: string }
	| { kind: "marker"; spoken: string }
	| { kind: "swallow" }
	| { kind: "fence"; fence: string };

function classifyPrefix(prefix: string): PrefixDecision {
	if (prefix === "|") return { kind: "swallow" };
	if (/^(?:`{3}|~{3})/.test(prefix)) return { kind: "fence", fence: prefix.slice(0, 3) };
	if (/^#{1,6}[ \t]/.test(prefix)) return { kind: "marker", spoken: "" };
	if (/^[-*+][ \t]/.test(prefix)) return { kind: "marker", spoken: "" };
	const numbered = /^(\d{1,3})[.)][ \t]/.exec(prefix);
	if (numbered) return { kind: "marker", spoken: `${numbered[1]}, ` };
	if (/^>+/.test(prefix) && !/^>+$/.test(prefix)) {
		return { kind: "prose", text: prefix.replace(/^>+[ \t]?/, "") };
	}
	if (UNDECIDED_PREFIX_RE.test(prefix)) return { kind: "undecided" };
	return { kind: "prose", text: prefix };
}

type BlockMode = "linestart" | "prose" | "swallow" | "code";

export class SpeakableStream {
	#mode: BlockMode = "linestart";
	#prefix = "";
	#fence = "";
	#codeLine = "";
	#afterSwallow: BlockMode = "linestart";
	#buf = "";
	#spoke = false;

	push(delta: string): string[] {
		const out: string[] = [];
		for (const ch of delta) this.#consume(ch, out);
		this.#extract(out);
		return out;
	}

	flush(): string[] {
		const out: string[] = [];
		if (this.#mode === "linestart" && this.#prefix.length > 0 && !HR_LINE_RE.test(this.#prefix)) {
			this.#buf += this.#prefix;
		}
		this.#prefix = "";
		this.#mode = "linestart";
		this.#drain(out);
		return out;
	}

	flushIdle(): string[] {
		const out: string[] = [];
		const pending = this.#buf.trimEnd();
		const completeThought = /[.!?…][)\]"'»”’]*$/.test(pending);
		if (!completeThought && pending.length < MIN_SEGMENT) return out;
		this.#drain(out);
		return out;
	}

	#consume(ch: string, out: string[]): void {
		switch (this.#mode) {
			case "linestart":
				this.#consumeLineStart(ch, out);
				return;
			case "prose":
				if (ch === "\n") this.#hardBreak(out);
				else this.#buf += ch;
				return;
			case "swallow":
				if (ch === "\n") this.#mode = this.#afterSwallow;
				return;
			case "code":
				this.#consumeCode(ch);
				return;
		}
	}

	#consumeLineStart(ch: string, out: string[]): void {
		if (ch === "\n") {
			const line = this.#prefix;
			this.#prefix = "";
			if (line.length > 0 && !HR_LINE_RE.test(line)) this.#buf += line;
			this.#hardBreak(out);
			return;
		}
		this.#prefix += ch;
		const decision = classifyPrefix(this.#prefix);
		if (decision.kind === "undecided") {
			if (this.#prefix.length > 8) {
				this.#buf += this.#prefix;
				this.#prefix = "";
				this.#mode = "prose";
			}
			return;
		}
		this.#prefix = "";
		switch (decision.kind) {
			case "prose":
				this.#buf += decision.text;
				this.#mode = "prose";
				return;
			case "marker":
				this.#buf += decision.spoken;
				this.#mode = "prose";
				return;
			case "swallow":
				this.#mode = "swallow";
				this.#afterSwallow = "linestart";
				return;
			case "fence":
				this.#fence = decision.fence;
				this.#codeLine = "";
				this.#mode = "swallow";
				this.#afterSwallow = "code";
				return;
		}
	}

	#consumeCode(ch: string): void {
		if (ch === "\n") {
			this.#codeLine = "";
			return;
		}
		if (this.#codeLine.length < 3) {
			this.#codeLine += ch;
			if (this.#codeLine === this.#fence) {
				this.#mode = "swallow";
				this.#afterSwallow = "linestart";
			}
		}
	}

	#hardBreak(out: string[]): void {
		this.#mode = "linestart";
		this.#drain(out);
	}

	#drain(out: string[]): void {
		this.#extract(out);
		const text = this.#buf;
		this.#buf = "";
		this.#emit(text, out);
	}

	#extract(out: string[]): void {
		for (;;) {
			const buf = this.#buf;
			const min = this.#spoke ? MIN_SEGMENT : FIRST_SEGMENT_MIN;
			const sentence = findSentenceCut(buf, min);
			if (sentence !== -1 && sentence <= MAX_SEGMENT) {
				this.#cut(sentence, out);
				continue;
			}
			if (!this.#spoke && buf.length >= FIRST_CLAUSE_MIN) {
				const clause = findClauseCut(buf, FIRST_SEGMENT_MIN);
				if (clause !== -1 && clause <= FIRST_FORCED_MAX) {
					this.#cut(clause, out);
					continue;
				}
				if (buf.length >= FIRST_FORCED_MAX) {
					this.#cut(findForcedCut(buf, FIRST_FORCED_MAX), out);
					continue;
				}
			}
			if (this.#spoke && buf.length >= SOFT_CLAUSE_LEN) {
				const clause = findLastClauseCut(buf, MIN_SEGMENT, SOFT_CLAUSE_LEN);
				if (clause !== -1) {
					this.#cut(clause, out);
					continue;
				}
			}
			if (buf.length > MAX_SEGMENT) {
				const clause = findLastClauseCut(buf, MIN_SEGMENT, MAX_SEGMENT);
				this.#cut(clause !== -1 ? clause : findForcedCut(buf, MAX_SEGMENT), out);
				continue;
			}
			return;
		}
	}

	#cut(at: number, out: string[]): void {
		const head = this.#buf.slice(0, at);
		this.#buf = this.#buf.slice(at);
		this.#emit(head, out);
	}

	#emit(raw: string, out: string[]): void {
		const spoken = normalizeSpeakable(raw);
		if (!spoken) return;
		out.push(spoken);
		this.#spoke = true;
	}
}
