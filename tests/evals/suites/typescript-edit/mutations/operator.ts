import traverse from "@babel/traverse";
import type * as t from "@babel/types";
import { applyBinaryOperatorSwap, BaseAstMutation, nodeLine, snippetFromNode, snippetFromSource } from "./base";
import type { Candidate, MutationInfo, Parsed } from "./types";

export class SwapComparisonMutation extends BaseAstMutation {
	name = "swap-comparison";
	category = "operator";
	fixHint = "Swap the comparison operator to the correct variant.";
	description = "A comparison operator is subtly wrong.";

	#swap: Record<string, t.BinaryExpression["operator"]> = {
		"<=": "<",
		"<": "<=",
		">=": ">",
		">": ">=",
	};

	collectCandidates(parsed: Parsed): Candidate<t.BinaryExpression>[] {
		const out: Candidate<t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			BinaryExpression: path => {
				const op = path.node.operator;
				if (op === "<" || op === "<=" || op === ">" || op === ">=") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BinaryExpression>): MutationInfo {
		return applyBinaryOperatorSwap(parsed, candidate, this.#swap);
	}
}

export class SwapEqualityMutation extends BaseAstMutation {
	name = "swap-equality";
	category = "operator";
	fixHint = "Fix the equality comparison operator.";
	description = "An equality operator is inverted.";

	#swap: Record<string, t.BinaryExpression["operator"]> = {
		"===": "!==",
		"!==": "===",
		"==": "!=",
		"!=": "==",
	};

	collectCandidates(parsed: Parsed): Candidate<t.BinaryExpression>[] {
		const out: Candidate<t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			BinaryExpression: path => {
				const op = path.node.operator;
				if (op === "===" || op === "!==" || op === "==" || op === "!=") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BinaryExpression>): MutationInfo {
		return applyBinaryOperatorSwap(parsed, candidate, this.#swap);
	}
}

export class SwapLogicalMutation extends BaseAstMutation {
	name = "swap-logical";
	category = "operator";
	fixHint = "Use the intended boolean operator.";
	description = "A boolean operator is incorrect.";

	collectCandidates(parsed: Parsed): Candidate<t.LogicalExpression>[] {
		const out: Candidate<t.LogicalExpression>[] = [];
		traverse(parsed.ast, {
			LogicalExpression: path => {
				const op = path.node.operator;
				if (op === "&&" || op === "||") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.LogicalExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.operator = node.operator === "&&" ? "||" : "&&";
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

export class RemoveNegationMutation extends BaseAstMutation {
	name = "remove-negation";
	category = "operator";
	fixHint = "Add back the missing logical negation (`!`).";
	description = "A logical negation (`!`) was accidentally removed.";

	collectCandidates(parsed: Parsed): Candidate<t.UnaryExpression>[] {
		const out: Candidate<t.UnaryExpression>[] = [];
		traverse(parsed.ast, {
			UnaryExpression: path => {
				if (path.node.operator === "!" && path.node.prefix) out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.UnaryExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const replacement = node.argument;
		candidate.path.replaceWith(replacement);
		return {
			lineNumber: nodeLine(node),
			originalSnippet: before,
			mutatedSnippet: snippetFromNode(replacement),
		};
	}
}

export class SwapIncDecMutation extends BaseAstMutation {
	name = "swap-increment-decrement";
	category = "operator";
	fixHint = "Replace the increment/decrement operator with the intended one.";
	description = "An increment/decrement operator points the wrong direction.";

	collectCandidates(parsed: Parsed): Candidate<t.UpdateExpression>[] {
		const out: Candidate<t.UpdateExpression>[] = [];
		traverse(parsed.ast, {
			UpdateExpression: path => {
				if (path.node.operator === "++" || path.node.operator === "--") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.UpdateExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.operator = node.operator === "++" ? "--" : "++";
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

export class SwapArithmeticMutation extends BaseAstMutation {
	name = "swap-arithmetic";
	category = "operator";
	fixHint = "Correct the arithmetic operator.";
	description = "An arithmetic operator was swapped.";

	#swap: Record<string, t.BinaryExpression["operator"]> = { "+": "-", "-": "+", "*": "/", "/": "*" };

	collectCandidates(parsed: Parsed): Candidate<t.BinaryExpression>[] {
		const out: Candidate<t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			BinaryExpression: path => {
				const op = path.node.operator;
				if (op === "+" || op === "-" || op === "*" || op === "/") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BinaryExpression>): MutationInfo {
		return applyBinaryOperatorSwap(parsed, candidate, this.#swap);
	}
}

export class NullishCoalescingSwapMutation extends BaseAstMutation {
	name = "swap-nullish";
	category = "operator";
	fixHint = "Use the intended nullish/logical operator.";
	description = "A nullish coalescing operator was swapped.";

	collectCandidates(parsed: Parsed): Candidate<t.LogicalExpression>[] {
		const out: Candidate<t.LogicalExpression>[] = [];
		traverse(parsed.ast, {
			LogicalExpression: path => {
				const op = path.node.operator;
				if (op === "??" || op === "||") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.LogicalExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.operator = node.operator === "??" ? "||" : "??";
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}
