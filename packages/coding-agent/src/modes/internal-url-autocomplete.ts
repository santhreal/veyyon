import { type AutocompleteItem, isSubsequenceMatch, subsequenceScore } from "@veyyon/tui";
import type { Skill } from "../extensibility/skills";
import { InternalUrlRouter } from "../internal-urls/router";

const MAX_URL_SUGGESTIONS = 25;

const URL_TOKEN_RE = /(?:^|[\s"'`(<=])([a-z][a-z0-9+.-]*:\/{1,2}[^\s"'`()<>]*)$/i;
const SCHEME_SPLIT_RE = /^([a-z][a-z0-9+.-]*):\/{1,2}(.*)$/i;

export interface InternalUrlContext {
	scheme: string;
	query: string;
	token: string;
}

function decodeUrlCompletionValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function extractInternalUrlContext(textBeforeCursor: string): InternalUrlContext | null {
	const tokenMatch = URL_TOKEN_RE.exec(textBeforeCursor);
	if (!tokenMatch) return null;
	const token = tokenMatch[1]!;
	const parts = SCHEME_SPLIT_RE.exec(token);
	if (!parts) return null;
	const scheme = parts[1]!.toLowerCase();
	if (!InternalUrlRouter.instance().completionSchemes().includes(scheme)) return null;
	return { scheme, query: parts[2] ?? "", token };
}

export async function getInternalUrlSuggestions(
	textBeforeCursor: string,
	cwd?: string,
	skills?: readonly Skill[],
): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
	const ctx = extractInternalUrlContext(textBeforeCursor);
	if (!ctx) return null;

	const candidates = await InternalUrlRouter.instance().complete(ctx.scheme, ctx.query, {
		...(cwd === undefined ? {} : { cwd }),
		...(skills === undefined ? {} : { skills }),
	});
	if (!candidates || candidates.length === 0) return null;

	const query = ctx.query.toLowerCase();
	const scored: Array<{ item: AutocompleteItem; score: number }> = [];
	for (const candidate of candidates) {
		const target = decodeUrlCompletionValue(candidate.value).toLowerCase();
		if (!isSubsequenceMatch(query, target)) continue;
		scored.push({
			item: {
				value: `${ctx.scheme}://${candidate.value}`,
				label: candidate.label ?? candidate.value,
				...(candidate.description ? { description: candidate.description } : {}),
			},
			score: subsequenceScore(query, target),
		});
	}
	if (scored.length === 0) return null;

	scored.sort((a, b) => b.score - a.score);
	return {
		items: scored.slice(0, MAX_URL_SUGGESTIONS).map(entry => entry.item),
		prefix: ctx.token,
	};
}

export function isInternalUrlPrefix(prefix: string): boolean {
	return extractInternalUrlContext(prefix) !== null;
}

export function applyInternalUrlCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] || "";
	const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
	const afterCursor = currentLine.slice(cursorCol);
	const insert = `${item.value} `;
	const newLines = lines.slice();
	newLines[cursorLine] = beforePrefix + insert + afterCursor;
	return {
		lines: newLines,
		cursorLine,
		cursorCol: beforePrefix.length + insert.length,
	};
}
