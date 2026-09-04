import { createRequire } from "node:module";
import generate from "@babel/generator";
import { type ParserPlugin, parse } from "@babel/parser";
import * as t from "@babel/types";
import type { Candidate, Mutation, MutationInfo, Parsed, SourceEdit, SourceRange } from "./types";

const require = createRequire(import.meta.url);

/*
 * Babel parser 7.29 emits TSTypeCastExpression but generator/types don't define it.
 * Register it in VISITOR_KEYS (so the printer's isLastChild doesn't crash) and in
 * generatorInfosMap with a custom handler that unwraps the TSTypeAnnotation wrapper.
 */
t.VISITOR_KEYS.TSTypeCastExpression = ["expression", "typeAnnotation"];
{
	const { generatorInfosMap } = require("@babel/generator/lib/nodes") as {
		generatorInfosMap: Map<string, [any, number, unknown]>;
	};
	if (!generatorInfosMap.has("TSTypeCastExpression")) {
		const tsAs = generatorInfosMap.get("TSAsExpression");
		if (tsAs) {
			// Custom handler: like TSAsExpression but unwraps TSTypeAnnotation → TSType
			function TSTypeCastExpression(
				this: {
					print: (node: unknown, printComments?: boolean) => void;
					space: () => void;
					word: (word: string) => void;
				},
				node: Record<string, unknown>,
			): void {
				this.print(node.expression, true);
				this.space();
				this.word("as");
				this.space();
				const annot = node.typeAnnotation as Record<string, unknown> | undefined;
				// TSTypeCastExpression.typeAnnotation is TSTypeAnnotation {typeAnnotation: TSType}
				this.print(annot && "typeAnnotation" in annot ? annot.typeAnnotation : annot);
			}
			generatorInfosMap.set("TSTypeCastExpression", [TSTypeCastExpression, tsAs[1], tsAs[2]]);
		}
	}
}

export function randomChoice<T>(arr: T[], rng: () => number): T {
	return arr[Math.floor(rng() * arr.length)];
}

export function randomSample<T>(arr: T[], count: number, rng: () => number): T[] {
	const copy = [...arr];
	const result: T[] = [];
	for (let i = 0; i < count && copy.length > 0; i++) {
		const idx = Math.floor(rng() * copy.length);
		result.push(copy.splice(idx, 1)[0]);
	}
	return result;
}

export function mutateIdentifier(identifier: string): string | null {
	if (identifier.length < 2) return null;
	let mutated: string;
	if (identifier.length >= 3 && identifier[0] === identifier[1]) {
		mutated = identifier[identifier.length - 1] + identifier.slice(1, -1) + identifier[0];
	} else {
		mutated = identifier[1] + identifier[0] + identifier.slice(2);
	}
	return mutated === identifier ? null : mutated;
}

export function parseWithPlugins(code: string, plugins: ParserPlugin[]): t.File {
	return parse(code, {
		sourceType: "unambiguous",
		allowReturnOutsideFunction: true,
		errorRecovery: true,
		plugins,
	});
}

export function parseCode(code: string): Parsed | null {
	const pluginSets: ParserPlugin[][] = [
		[
			"flow",
			"flowComments",
			"jsx",
			"importAssertions",
			"decorators-legacy",
			"classPrivateMethods",
			"classPrivateProperties",
			"classProperties",
			"privateIn",
			"topLevelAwait",
			"optionalChaining",
			"nullishCoalescingOperator",
		],
		[
			"typescript",
			"jsx",
			"importAssertions",
			"decorators-legacy",
			"classPrivateMethods",
			"classPrivateProperties",
			"classProperties",
			"privateIn",
			"topLevelAwait",
			"optionalChaining",
			"nullishCoalescingOperator",
		],
	];

	for (const plugins of pluginSets) {
		try {
			return { ast: parseWithPlugins(code, plugins), code };
		} catch {}
	}

	return null;
}

export function nodeLine(node: t.Node): number {
	return node.loc?.start.line ?? 0;
}

export function nodeRange(node: t.Node): SourceRange | null {
	if (typeof node.start === "number" && typeof node.end === "number" && node.start <= node.end) {
		return { start: node.start, end: node.end };
	}
	return null;
}

export function snippetFromSource(src: string, node: t.Node, fallback = ""): string {
	const range = nodeRange(node);
	if (range) {
		return src.slice(range.start, range.end);
	}
	return fallback;
}

export function trimSnippet(snippet: string): string {
	return snippet.replace(/^\n+/, "").replace(/\n+$/, "");
}

export function snippetFromNode(node: t.Node): string {
	try {
		return trimSnippet(generate(node, { comments: false, compact: false, retainLines: false }).code);
	} catch {
		return "";
	}
}

export function applySourceEdits(content: string, edits: SourceEdit[]): string | null {
	if (edits.length === 0) return content;
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	let previousStart = content.length + 1;
	let out = content;
	for (const edit of sorted) {
		if (edit.start < 0 || edit.end < edit.start || edit.end > out.length) {
			return null;
		}
		if (edit.end > previousStart) {
			return null;
		}
		out = `${out.slice(0, edit.start)}${edit.replacement}${out.slice(edit.end)}`;
		previousStart = edit.start;
	}
	return out;
}

export function noopInfo(): MutationInfo {
	return { lineNumber: 0, originalSnippet: "", mutatedSnippet: "" };
}

export function applyBinaryOperatorSwap(
	parsed: Parsed,
	candidate: Candidate<t.BinaryExpression>,
	swap: Record<string, t.BinaryExpression["operator"]>,
): MutationInfo {
	const node = candidate.path.node;
	const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
	const swapped = swap[node.operator];
	if (!swapped) return noopInfo();
	node.operator = swapped;
	return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
}

export function isLengthMemberExpression(node: t.Node): node is t.MemberExpression {
	return t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property, { name: "length" });
}

export abstract class BaseAstMutation implements Mutation {
	abstract name: string;
	abstract category: string;
	abstract fixHint: string;
	abstract description: string;

	get id(): string {
		return this.name;
	}

	get isMultiEdit(): boolean {
		return false;
	}

	get isStructural(): boolean {
		return this.category === "structural";
	}

	get allowsMultipleHunks(): boolean {
		return this.isMultiEdit || this.isStructural;
	}

	describe(_info: MutationInfo): string {
		return this.description;
	}
	abstract collectCandidates(parsed: Parsed): Candidate[];
	abstract applyCandidate(parsed: Parsed, candidate: Candidate, rng: () => number): MutationInfo;

	#buildEdits(_parsed: Parsed, candidate: Candidate, originalRange: SourceRange | null): SourceEdit[] | null {
		if (!originalRange) return null;
		if (candidate.path.removed) {
			return [{ ...originalRange, replacement: "" }];
		}
		const replacement = snippetFromNode(candidate.path.node);
		if (!replacement) return null;
		return [{ ...originalRange, replacement }];
	}

	canApply(content: string): boolean {
		const parsed = parseCode(content);
		if (!parsed) return false;
		return this.collectCandidates(parsed).length > 0;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(candidates, rng);
		const originalRange = nodeRange(chosen.path.node);
		const info = this.applyCandidate(parsed, chosen, rng);
		if (info.lineNumber === 0) return [content, noopInfo()];
		const edits = this.#buildEdits(parsed, chosen, originalRange);
		if (!edits) return [content, noopInfo()];
		const mutated = applySourceEdits(content, edits);
		if (!mutated || mutated === content) return [content, noopInfo()];
		return [mutated, info];
	}
}
