import traverse, { type NodePath } from "@babel/traverse";
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

export class SwapAdjacentLinesMutation extends BaseAstMutation {
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

		const body = container.body;
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

		const body = container.body;
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

export class SwapIfElseBranchesMutation extends BaseAstMutation {
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

export class RemoveEarlyReturnMutation extends BaseAstMutation {
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

export class DeleteStatementMutation extends BaseAstMutation {
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
