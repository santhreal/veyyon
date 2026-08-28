import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
	BaseAstMutation,
	isLengthMemberExpression,
	nodeLine,
	noopInfo,
	snippetFromNode,
	snippetFromSource,
} from "./base";
import type { Candidate, MutationInfo, Parsed } from "./types";

export class BooleanLiteralFlipMutation extends BaseAstMutation {
	name = "flip-boolean";
	category = "literal";
	fixHint = "Flip the boolean literal to the intended value.";
	description = "A boolean literal is inverted.";

	collectCandidates(parsed: Parsed): Candidate<t.BooleanLiteral>[] {
		const out: Candidate<t.BooleanLiteral>[] = [];
		traverse(parsed.ast, {
			BooleanLiteral: path => {
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BooleanLiteral>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.value = !node.value;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

export class OffByOneMutation extends BaseAstMutation {
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
