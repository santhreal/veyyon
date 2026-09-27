/**
 * WHY: marked tries its setext-heading rule before every paragraph, and the rule walks the paragraph one
 * character at a time, testing each line break against every block that can interrupt it. That walk was a
 * quarter of a transcript render. The Markdown tokenizer now skips the rule when the first line after the
 * first that is an underline or whitespace only is the whitespace-only one, since a heading's text never
 * crosses such a line. A precheck that rejects a source the rule matches drops a heading and renders its
 * text and underline as a paragraph and a rule.
 *
 * The class this closes: any source on which the tokenizer's setext decision differs from marked's. Every
 * sequence of up to three lines from a vocabulary of text lines, underlines at each indent and with
 * trailing spaces, whitespace-only lines and block openers that interrupt a paragraph is lexed with both
 * tokenizers, with and without a final newline, and the token trees must be equal. That includes headings
 * inside list items and block quotes, which marked lexes with the same tokenizer. Every character JavaScript
 * reads as whitespace is swept as a blank line between a paragraph and an underline.
 *
 * The gap: a line shape outside the vocabulary, longer than three lines, is covered by the precheck's
 * reasoning and by the random sweep of longer documents, not exhaustively.
 */
import { describe, expect, it } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { MarkdownTokenizer } from "@veyyon/tui/components/markdown-tokenizer";
import { getDefaults, Lexer, type Token } from "marked";

const TEXT_LINES = ["foo", "a b", "  y", "a\u2028b"];
const UNDERLINES = ["=", "===", "-", "---", " ==", "   --", "    ==", "== ", "--  ", "= =", "-=", "==x", "\t=="];
const BLANK_LINES = ["", " ", "\t"];
const INTERRUPTS = ["# h", "> q", "- i", "1. i", "```", "<div>", "| a | b |", "|---|---|", "***"];
const VOCABULARY = [...TEXT_LINES, ...UNDERLINES, ...BLANK_LINES, ...INTERRUPTS];

/** Every UTF-16 code unit JavaScript's `\s` matches, other than the line feed that separates lines. */
function whitespaceCodeUnits(): string[] {
	const units: string[] = [];
	for (let code = 0; code <= 0xffff; code++) {
		const unit = String.fromCharCode(code);
		if (unit !== "\n" && /\s/.test(unit)) units.push(unit);
	}
	return units;
}

/** Lexes `doc` with marked's default options, which the Markdown component's parser keeps (GFM on). */
function lexWith(tokenizer: MarkdownTokenizer | undefined, doc: string): Token[] {
	return new Lexer({ ...getDefaults(), tokenizer: tokenizer ?? null }).lex(doc);
}

/** Lexes `doc` with both tokenizers, returning the first document whose tokens differ, or undefined. */
function firstDifference(docs: Iterable<string>): { doc: string; ours: Token[]; marked: Token[] } | undefined {
	for (const doc of docs) {
		const ours = lexWith(new MarkdownTokenizer(), doc);
		const marked = lexWith(undefined, doc);
		if (!isDeepStrictEqual(ours, marked)) return { doc, ours, marked };
	}
	return undefined;
}

function* lineSequences(maxLines: number): Generator<string> {
	const sequence: string[] = [];
	function* extend(depth: number): Generator<string> {
		if (depth > 0) {
			const doc = sequence.join("\n");
			yield doc;
			yield `${doc}\n`;
		}
		if (depth === maxLines) return;
		for (const line of VOCABULARY) {
			sequence.push(line);
			yield* extend(depth + 1);
			sequence.pop();
		}
	}
	yield* extend(0);
}

function* randomDocuments(count: number, seed: number): Generator<string> {
	let state = seed >>> 0;
	const next = (bound: number): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (((t ^ (t >>> 14)) >>> 0) % bound) >>> 0;
	};
	for (let i = 0; i < count; i++) {
		const lines: string[] = [];
		const length = 4 + next(9);
		for (let j = 0; j < length; j++) lines.push(VOCABULARY[next(VOCABULARY.length)]!);
		yield lines.join("\n");
	}
}

function setextHeadingDepths(tokens: readonly Token[], depths: number[] = []): number[] {
	for (const token of tokens) {
		if (token.type === "heading" && !token.raw.trimStart().startsWith("#")) depths.push(token.depth as number);
		const children = (token as { tokens?: Token[] }).tokens;
		if (children) setextHeadingDepths(children, depths);
		const items = (token as { items?: Token[] }).items;
		if (items) setextHeadingDepths(items, depths);
	}
	return depths;
}

describe("the Markdown tokenizer's setext heading rule", () => {
	it("lexes every sequence of up to three vocabulary lines as marked does", () => {
		expect(firstDifference(lineSequences(3))).toBeUndefined();
	});

	it("lexes longer random documents as marked does", () => {
		expect(firstDifference(randomDocuments(4000, 0x5e7e47))).toBeUndefined();
	});

	it("stops at a line of any whitespace between a paragraph and an underline, as marked does", () => {
		const docs: string[] = [];
		for (const unit of whitespaceCodeUnits()) {
			docs.push(`foo\n${unit}\n===`, `foo\n ${unit} \n---`, `foo\n${unit}`, `foo\nbar${unit}\n===`);
		}
		expect(firstDifference(docs)).toBeUndefined();
	});

	it("sweeps sources where marked finds headings of both depths, at the top level and nested", () => {
		const topLevel = new Set<number>();
		const nested = new Set<number>();
		for (const doc of lineSequences(3)) {
			for (const token of lexWith(undefined, doc)) {
				if (token.type === "heading" && !token.raw.trimStart().startsWith("#")) topLevel.add(token.depth);
				else for (const depth of setextHeadingDepths([token])) nested.add(depth);
			}
		}
		expect([...topLevel].sort()).toEqual([1, 2]);
		expect([...nested].sort()).toEqual([1, 2]);
	});
});
