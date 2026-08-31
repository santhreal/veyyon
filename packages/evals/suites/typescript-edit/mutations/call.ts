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

export class CallArgumentSwapMutation extends BaseAstMutation {
	name = "swap-call-args";
	category = "call";
	fixHint = "Swap the two arguments to their original order.";
	description = "Two arguments in a call are swapped.";

	collectCandidates(parsed: Parsed): Candidate<t.CallExpression>[] {
		const out: Candidate<t.CallExpression>[] = [];
		traverse(parsed.ast, {
			CallExpression: path => {
				const args = path.node.arguments;
				if (args.length >= 2 && !t.isSpreadElement(args[0]) && !t.isSpreadElement(args[1])) out.push({ path });
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
		const first = node.arguments[0];
		const second = node.arguments[1];
		if (!first || !second || t.isSpreadElement(first) || t.isSpreadElement(second)) return [content, noopInfo()];

		const firstRange = nodeRange(first);
		const secondRange = nodeRange(second);
		const callRange = nodeRange(node);
		if (!firstRange || !secondRange || !callRange) return [content, noopInfo()];
		if (firstRange.start >= firstRange.end || secondRange.start >= secondRange.end) return [content, noopInfo()];
		if (firstRange.end > secondRange.start) return [content, noopInfo()];

		const betweenArgs = content.slice(firstRange.end, secondRange.start);
		const swappedArgs = `${content.slice(secondRange.start, secondRange.end)}${betweenArgs}${content.slice(firstRange.start, firstRange.end)}`;
		const mutated = applySourceEdits(content, [
			{ start: firstRange.start, end: secondRange.end, replacement: swappedArgs },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: nodeLine(node),
				originalSnippet: content.slice(callRange.start, callRange.end),
				mutatedSnippet: mutated.slice(callRange.start, callRange.end),
			},
		];
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.CallExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const first = node.arguments[0];
		const second = node.arguments[1];
		if (!first || !second) return noopInfo();
		node.arguments[0] = second;
		node.arguments[1] = first;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}
