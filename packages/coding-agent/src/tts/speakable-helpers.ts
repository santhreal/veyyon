import { hasAlphanumeric } from "@veyyon/utils";

export const FIRST_SEGMENT_MIN = 12;
export const FIRST_CLAUSE_MIN = 40;
export const FIRST_FORCED_MAX = 140;
export const MIN_SEGMENT = 24;
export const SOFT_CLAUSE_LEN = 160;
export const MAX_SEGMENT = 280;

export const SENTENCE_BOUNDARY_RE = /[.!?…]+[)\]"'»”’]*\s/g;
export const CLAUSE_BOUNDARY_RE = /[,;:—–]\s/g;
export const ABBREVIATION_RE = /(?:^|\s)(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|No)\.$/i;

export const UNDECIDED_PREFIX_RE = /^(?:#{1,6}|[-*+]|-{2,}|\*{2,}|_{2,}|\d{1,3}|\d{1,3}[.)]|>+|`{1,2}|~{1,2})$/;
export const HR_LINE_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

export const IMAGE_RE = /!\[([^\]]*)\]\(([^()]*)\)/g;
export const LINK_RE = /\[([^\]]+)\]\(([^()]*)\)/g;
export const AUTOLINK_RE = /<(https?:\/\/[^\s>]+)>/g;
export const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()"'\]]+|\bwww\.[\w-]+(?:\.[\w-]+)+[^\s<>()"'\]]*/g;
export const INLINE_CODE_RE = /`{1,2}([^`]+)`{1,2}/g;
export const BOLD_STRIKE_RE = /\*\*|__|~~/g;
export const EMPHASIS_ASTERISK_RE = /\*(?=\S)|(?<=\S)\*/g;
export const EMPHASIS_UNDERSCORE_RE = /(^|\s)_+|_+(?=\s|$)/g;
export const HTML_TAG_RE = /<\/?[a-zA-Z][^<>]*>/g;
export const HR_INLINE_RE = /(^|\s)[-*_]{3,}(?=\s|$)/g;
export const PATH_RE = /(^|[\s("'`])((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+){2,}\/?)/g;

export function speakableUrl(url: string): string {
	return url
		.replace(/^[a-z][\w+.-]*:\/\//i, "")
		.replace(/^www\./i, "")
		.replace(/[/?#].*$/, "");
}

export function normalizeSpeakable(raw: string): string {
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

export function findSentenceCut(text: string, min: number): number {
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

export function findClauseCut(text: string, min: number): number {
	CLAUSE_BOUNDARY_RE.lastIndex = 0;
	for (let match = CLAUSE_BOUNDARY_RE.exec(text); match; match = CLAUSE_BOUNDARY_RE.exec(text)) {
		const cut = match.index + match[0].length;
		if (cut >= min) return cut;
	}
	return -1;
}

export function findLastClauseCut(text: string, min: number, max: number): number {
	CLAUSE_BOUNDARY_RE.lastIndex = 0;
	let best = -1;
	for (let match = CLAUSE_BOUNDARY_RE.exec(text); match; match = CLAUSE_BOUNDARY_RE.exec(text)) {
		const cut = match.index + match[0].length;
		if (cut > max) break;
		if (cut >= min) best = cut;
	}
	return best;
}

export function findForcedCut(text: string, max: number): number {
	const space = text.lastIndexOf(" ", max);
	return space > 0 ? space + 1 : Math.min(max, text.length);
}

export type PrefixDecision =
	| { kind: "undecided" }
	| { kind: "prose"; text: string }
	| { kind: "marker"; spoken: string }
	| { kind: "swallow" }
	| { kind: "fence"; fence: string };

export function classifyPrefix(prefix: string): PrefixDecision {
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

export type BlockMode = "linestart" | "prose" | "swallow" | "code";
