import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

import {
	applySourceEdits,
	BaseAstMutation,
	BooleanLiteralFlipMutation,
	CallArgumentSwapMutation,
	type Candidate,
	IdentifierMultiEditMutation,
	isLengthMemberExpression,
	type Mutation,
	type MutationInfo,
	NullishCoalescingSwapMutation,
	nodeLine,
	nodeRange,
	noopInfo,
	OptionalChainRemovalMutation,
	type Parsed,
	parseCode,
	RegexQuantifierSwapMutation,
	RemoveNegationMutation,
	randomChoice,
	SwapArithmeticMutation,
	SwapComparisonMutation,
	SwapEqualityMutation,
	SwapIncDecMutation,
	SwapLogicalMutation,
	snippetFromNode,
	snippetFromSource,
	UnicodeHyphenMutation,
} from "./mutations-helpers";

export type {
	Mutation,
	MutationInfo,
} from "./mutations-helpers";

class DuplicateLineLiteralFlipMutation extends BaseAstMutation {
	name = "duplicate-line-flip";
	category = "duplicate";
	fixHint = "Fix the literal or operator on the duplicated line.";
	description = "A duplicated line contains a subtle literal/operator change.";

	collectCandidates(parsed: Parsed): Candidate<t.Statement, { group: string }>[] {
		const out: Candidate<t.Statement, { group: string }>[] = [];
		const statements: Array<{ path: NodePath<t.Statement>; text: string }> = [];

		traverse(parsed.ast, {
			Statement: path => {
				if (!path.node.loc) return;
				if (t.isBlockStatement(path.node)) return;
				const text = snippetFromSource(parsed.code, path.node, "");
				if (text.trim().length === 0) return;
				statements.push({ path, text });
			},
		});

		const counts = new Map<string, number>();
		for (const statement of statements) {
			counts.set(statement.text, (counts.get(statement.text) ?? 0) + 1);
		}

		for (const statement of statements) {
			if ((counts.get(statement.text) ?? 0) < 2) continue;
			out.push({ path: statement.path, meta: { group: statement.text } });
		}

		return out;
	}

	applyCandidate(
		parsed: Parsed,
		candidate: Candidate<t.Statement, { group: string }>,
		rng: () => number,
	): MutationInfo {
		const flips: Candidate<t.BooleanLiteral | t.BinaryExpression>[] = [];
		candidate.path.traverse({
			BooleanLiteral: path => {
				flips.push({ path: path as NodePath<t.BooleanLiteral | t.BinaryExpression> });
			},
			BinaryExpression: path => {
				const op = path.node.operator;
				if (
					op === "===" ||
					op === "!==" ||
					op === "==" ||
					op === "!=" ||
					op === "<" ||
					op === "<=" ||
					op === ">" ||
					op === ">="
				) {
					flips.push({ path: path as NodePath<t.BooleanLiteral | t.BinaryExpression> });
				}
			},
		});

		if (flips.length === 0) return noopInfo();

		const chosen = randomChoice(flips, rng);
		const node = chosen.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));

		if (t.isBooleanLiteral(node)) {
			node.value = !node.value;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		const eqSwap: Partial<Record<t.BinaryExpression["operator"], t.BinaryExpression["operator"]>> = {
			"===": "!==",
			"!==": "===",
			"==": "!=",
			"!=": "==",
		};
		const compSwap: Partial<Record<t.BinaryExpression["operator"], t.BinaryExpression["operator"]>> = {
			"<=": "<",
			"<": "<=",
			">=": ">",
			">": ">=",
		};
		const swapped = eqSwap[node.operator] ?? compSwap[node.operator];
		if (!swapped) return noopInfo();
		node.operator = swapped;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class SwapAdjacentLinesMutation extends BaseAstMutation {
	name = "swap-adjacent-lines";
	category = "structural";
	fixHint = "Swap the two adjacent lines back to their original order.";
	description = "Two adjacent statements are in the wrong order.";

	collectCandidates(parsed: Parsed): Candidate<t.Program | t.BlockStatement, { index: number }>[] {
		const out: Candidate<t.Program | t.BlockStatement, { index: number }>[] = [];

		const considerList = (
			path: NodePath<t.Program | t.BlockStatement>,
			body: Array<t.Statement | t.ModuleDeclaration>,
		): void => {
			for (let i = 0; i < body.length - 1; i++) {
				const left = body[i];
				const right = body[i + 1];
				if (!left || !right) continue;
				if (!t.isStatement(left) || !t.isStatement(right)) continue;
				if (!left.loc || !right.loc) continue;
				if (left.loc.start.line !== left.loc.end.line) continue;
				if (right.loc.start.line !== right.loc.end.line) continue;

				const leftText = snippetFromSource(parsed.code, left, "").trim();
				const rightText = snippetFromSource(parsed.code, right, "").trim();
				if (!leftText || !rightText) continue;
				if (leftText === rightText) continue;

				const gap = right.loc.start.line - left.loc.end.line;
				if (gap > 2) continue;

				out.push({ path, meta: { index: i } });
			}
		};

		traverse(parsed.ast, {
			Program: path => {
				considerList(path as NodePath<t.Program | t.BlockStatement>, path.node.body);
			},
			BlockStatement: path => {
				considerList(path as NodePath<t.Program | t.BlockStatement>, path.node.body);
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
		const container = chosen.path.node;
		const index = chosen.meta?.index;
		if (index === undefined) return [content, noopInfo()];

		const body = t.isProgram(container) ? container.body : container.body;
		const left = body[index];
		const right = body[index + 1];
		if (!left || !right) return [content, noopInfo()];
		if (!t.isStatement(left) || !t.isStatement(right)) return [content, noopInfo()];

		const leftRange = nodeRange(left);
		const rightRange = nodeRange(right);
		if (!leftRange || !rightRange) return [content, noopInfo()];
		if (leftRange.end > rightRange.start) return [content, noopInfo()];

		const between = content.slice(leftRange.end, rightRange.start);
		const swapped = `${content.slice(rightRange.start, rightRange.end)}${between}${content.slice(leftRange.start, leftRange.end)}`;
		const mutated = applySourceEdits(content, [
			{ start: leftRange.start, end: rightRange.end, replacement: swapped },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: left.loc?.start.line ?? 0,
				originalSnippet: `lines ${left.loc?.start.line ?? 0}-${right.loc?.end.line ?? 0}`,
				mutatedSnippet: "[swapped]",
			},
		];
	}

	applyCandidate(
		_parsed: Parsed,
		candidate: Candidate<t.Program | t.BlockStatement, { index: number }>,
	): MutationInfo {
		const container = candidate.path.node;
		const index = candidate.meta?.index;
		if (index === undefined) return noopInfo();

		const body = t.isProgram(container) ? container.body : container.body;
		const left = body[index];
		const right = body[index + 1];
		if (!left || !right) return noopInfo();
		if (!t.isStatement(left) || !t.isStatement(right)) return noopInfo();

		const before = `lines ${left.loc?.start.line ?? 0}-${right.loc?.end.line ?? 0}`;
		[body[index], body[index + 1]] = [body[index + 1]!, body[index]!];
		return {
			lineNumber: left.loc?.start.line ?? 0,
			originalSnippet: before,
			mutatedSnippet: "[swapped]",
		};
	}
}

class SwapIfElseBranchesMutation extends BaseAstMutation {
	name = "swap-if-else";
	category = "structural";
	fixHint = "Swap the if and else branch bodies back to their original positions.";
	description = "The if and else branches are swapped.";

	collectCandidates(parsed: Parsed): Candidate<t.IfStatement>[] {
		const out: Candidate<t.IfStatement>[] = [];
		traverse(parsed.ast, {
			IfStatement: path => {
				const node = path.node;
				if (!node.alternate) return;
				if (!t.isBlockStatement(node.consequent) || !t.isBlockStatement(node.alternate)) return;
				if (node.consequent.body.length === 0 || node.alternate.body.length === 0) return;
				if (node.consequent.body.length > 5 || node.alternate.body.length > 5) return;
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.IfStatement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		if (!t.isBlockStatement(node.consequent) || !t.isBlockStatement(node.alternate)) return noopInfo();
		const consequent = node.consequent;
		node.consequent = node.alternate;
		node.alternate = consequent;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: "[swapped]" };
	}
}

class RemoveEarlyReturnMutation extends BaseAstMutation {
	name = "remove-early-return";
	category = "structural";
	fixHint =
		"Restore the missing guard clause (if statement with early return). Add back the exact 3-line pattern: if condition, return statement, closing brace.";
	description = "A guard clause (early return) was removed.";

	collectCandidates(parsed: Parsed): Candidate<t.IfStatement>[] {
		const out: Candidate<t.IfStatement>[] = [];
		traverse(parsed.ast, {
			IfStatement: path => {
				const node = path.node;
				if (node.alternate) return;
				if (!t.isBlockStatement(node.consequent)) return;
				if (node.consequent.body.length !== 1) return;
				if (!t.isReturnStatement(node.consequent.body[0])) return;
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.IfStatement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		candidate.path.remove();
		return { lineNumber: nodeLine(node), originalSnippet: before.trim(), mutatedSnippet: "[removed]" };
	}
}

class SwapNamedImportsMutation extends BaseAstMutation {
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

class DeleteStatementMutation extends BaseAstMutation {
	name = "delete-statement";
	category = "structural";
	fixHint = "Restore the deleted statement.";
	description = "A critical statement was deleted from the code.";

	collectCandidates(parsed: Parsed): Candidate<t.Statement>[] {
		const out: Candidate<t.Statement>[] = [];
		traverse(parsed.ast, {
			Statement: path => {
				if (!path.node.loc) return;
				if (t.isVariableDeclaration(path.node)) {
					out.push({ path: path as NodePath<t.Statement> });
					return;
				}
				if (!t.isExpressionStatement(path.node)) return;
				if (t.isAssignmentExpression(path.node.expression) || t.isUpdateExpression(path.node.expression)) {
					out.push({ path: path as NodePath<t.Statement> });
				}
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.Statement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		candidate.path.remove();
		return { lineNumber: nodeLine(node), originalSnippet: before.trim(), mutatedSnippet: "[removed]" };
	}
}

class OffByOneMutation extends BaseAstMutation {
	name = "off-by-one";
	category = "literal";
	fixHint = "Fix the off-by-one error in the numeric literal or comparison.";
	description = "A numeric boundary has an off-by-one error.";

	collectCandidates(parsed: Parsed): Candidate<t.NumericLiteral | t.BinaryExpression>[] {
		const out: Candidate<t.NumericLiteral | t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			NumericLiteral: path => {
				if (path.node.value !== 0 && path.node.value !== 1) return;
				const hasBoundaryAncestor =
					path.findParent(parent => {
						return (
							parent.isForStatement() ||
							parent.isWhileStatement() ||
							parent.isDoWhileStatement() ||
							parent.isIfStatement() ||
							(parent.isBinaryExpression() && ["<", "<=", ">", ">="].includes(parent.node.operator))
						);
					}) != null;
				if (hasBoundaryAncestor) out.push({ path: path as NodePath<t.NumericLiteral | t.BinaryExpression> });
			},
			BinaryExpression: path => {
				if (
					(path.node.operator === "<" || path.node.operator === "<=") &&
					isLengthMemberExpression(path.node.right)
				) {
					out.push({ path: path as NodePath<t.NumericLiteral | t.BinaryExpression> });
					return;
				}
				if (
					path.node.operator === "-" &&
					isLengthMemberExpression(path.node.left) &&
					t.isNumericLiteral(path.node.right) &&
					(path.node.right.value === 1 || path.node.right.value === 2)
				) {
					out.push({ path: path as NodePath<t.NumericLiteral | t.BinaryExpression> });
				}
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.NumericLiteral | t.BinaryExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));

		if (t.isNumericLiteral(node)) {
			node.value = node.value === 0 ? 1 : 0;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		if (node.operator === "<" || node.operator === "<=") {
			if (!isLengthMemberExpression(node.right)) return noopInfo();
			node.operator = node.operator === "<" ? "<=" : "<";
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		if (
			node.operator === "-" &&
			isLengthMemberExpression(node.left) &&
			t.isNumericLiteral(node.right) &&
			(node.right.value === 1 || node.right.value === 2)
		) {
			node.right.value = node.right.value === 1 ? 2 : 1;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		return noopInfo();
	}
}

export const ALL_MUTATIONS: Mutation[] = [
	new SwapComparisonMutation(),
	new SwapEqualityMutation(),
	new SwapLogicalMutation(),
	new RemoveNegationMutation(),
	new SwapIncDecMutation(),
	new SwapArithmeticMutation(),
	new BooleanLiteralFlipMutation(),
	new OptionalChainRemovalMutation(),
	new CallArgumentSwapMutation(),
	new NullishCoalescingSwapMutation(),
	new RegexQuantifierSwapMutation(),
	new UnicodeHyphenMutation(),
	new IdentifierMultiEditMutation(),
	new DuplicateLineLiteralFlipMutation(),
	new SwapAdjacentLinesMutation(),
	new SwapIfElseBranchesMutation(),
	new RemoveEarlyReturnMutation(),
	new SwapNamedImportsMutation(),
	new DeleteStatementMutation(),
	new OffByOneMutation(),
];

export const CATEGORY_MAP: Record<string, string[]> = {
	operator: ALL_MUTATIONS.filter(m => m.category === "operator").map(m => m.name),
	literal: ALL_MUTATIONS.filter(m => m.category === "literal").map(m => m.name),
	access: ALL_MUTATIONS.filter(m => m.category === "access").map(m => m.name),
	call: ALL_MUTATIONS.filter(m => m.category === "call").map(m => m.name),
	regex: ALL_MUTATIONS.filter(m => m.category === "regex").map(m => m.name),
	unicode: ALL_MUTATIONS.filter(m => m.category === "unicode").map(m => m.name),
	identifier: ALL_MUTATIONS.filter(m => m.category === "identifier").map(m => m.name),
	duplicate: ALL_MUTATIONS.filter(m => m.category === "duplicate").map(m => m.name),
	structural: ALL_MUTATIONS.filter(m => m.category === "structural").map(m => m.name),
	import: ALL_MUTATIONS.filter(m => m.category === "import").map(m => m.name),
};
