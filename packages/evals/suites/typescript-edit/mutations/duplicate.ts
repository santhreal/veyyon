import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { BaseAstMutation, nodeLine, noopInfo, randomChoice, snippetFromNode, snippetFromSource } from "./base";
import type { Candidate, MutationInfo, Parsed } from "./types";

export class DuplicateLineLiteralFlipMutation extends BaseAstMutation {
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
