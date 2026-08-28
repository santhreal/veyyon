import traverse from "@babel/traverse";
import * as t from "@babel/types";
import {
	applySourceEdits,
	BaseAstMutation,
	nodeLine,
	nodeRange,
	noopInfo,
	parseCode,
	randomChoice,
	snippetFromNode,
	snippetFromSource,
} from "./base";
import type { Candidate, MutationInfo, Parsed } from "./types";

export class SwapNamedImportsMutation extends BaseAstMutation {
	name = "swap-named-imports";
	category = "import";
	fixHint =
		"Swap ONLY the two imported names that are in the wrong order. Do not reorder other imports or modify other import statements.";
	description = "Two named imports are swapped in a destructuring import.";

	collectCandidates(parsed: Parsed): Candidate<t.ImportDeclaration, { i: number; j: number }>[] {
		const out: Candidate<t.ImportDeclaration, { i: number; j: number }>[] = [];
		traverse(parsed.ast, {
			ImportDeclaration: path => {
				const named = path.node.specifiers
					.map((spec, idx) => ({ spec, idx }))
					.filter((entry): entry is { spec: t.ImportSpecifier; idx: number } => t.isImportSpecifier(entry.spec))
					.filter(({ spec }) => t.isIdentifier(spec.imported) && t.isIdentifier(spec.local))
					.filter(
						({ spec }) =>
							t.isIdentifier(spec.imported) &&
							t.isIdentifier(spec.local) &&
							spec.imported.name === spec.local.name,
					);
				if (named.length < 2) return;
				for (let i = 0; i < named.length; i++) {
					for (let j = i + 1; j < named.length; j++) {
						out.push({ path, meta: { i: named[i]!.idx, j: named[j]!.idx } });
					}
				}
			},
		});
		return out;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(candidates, rng);
		const node = chosen.path.node;
		const indices = chosen.meta;
		if (!indices) return [content, noopInfo()];
		const { i, j } = indices;
		if (i < 0 || j < 0 || i >= node.specifiers.length || j >= node.specifiers.length) return [content, noopInfo()];

		const left = node.specifiers[i];
		const right = node.specifiers[j];
		if (!left || !right) return [content, noopInfo()];
		const leftRange = nodeRange(left);
		const rightRange = nodeRange(right);
		const importRange = nodeRange(node);
		if (!leftRange || !rightRange || !importRange) return [content, noopInfo()];
		if (leftRange.end > rightRange.start) return [content, noopInfo()];

		const leftText = content.slice(leftRange.start, leftRange.end);
		const rightText = content.slice(rightRange.start, rightRange.end);
		const mutated = applySourceEdits(content, [
			{ start: leftRange.start, end: leftRange.end, replacement: rightText },
			{ start: rightRange.start, end: rightRange.end, replacement: leftText },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: nodeLine(node),
				originalSnippet: content.slice(importRange.start, importRange.end).trim(),
				mutatedSnippet: mutated.slice(importRange.start, importRange.end).trim(),
			},
		];
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.ImportDeclaration, { i: number; j: number }>): MutationInfo {
		const node = candidate.path.node;
		const indices = candidate.meta;
		if (!indices) return noopInfo();
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const { i, j } = indices;
		if (i < 0 || j < 0 || i >= node.specifiers.length || j >= node.specifiers.length) return noopInfo();
		[node.specifiers[i], node.specifiers[j]] = [node.specifiers[j]!, node.specifiers[i]!];
		return {
			lineNumber: nodeLine(node),
			originalSnippet: before.trim(),
			mutatedSnippet: snippetFromNode(node).trim(),
		};
	}
}
