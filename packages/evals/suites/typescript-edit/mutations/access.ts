import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { BaseAstMutation, nodeLine, snippetFromNode, snippetFromSource } from "./base";
import type { Candidate, MutationInfo, Parsed } from "./types";

export class OptionalChainRemovalMutation extends BaseAstMutation {
	name = "remove-optional-chain";
	category = "access";
	fixHint =
		"Restore the optional chaining operator (`?.`) at the ONE location where it was removed. Do not add optional chaining elsewhere.";
	description = "Optional chaining was removed from a property access.";

	collectCandidates(parsed: Parsed): Candidate<t.OptionalMemberExpression | t.OptionalCallExpression>[] {
		const out: Candidate<t.OptionalMemberExpression | t.OptionalCallExpression>[] = [];
		traverse(parsed.ast, {
			OptionalMemberExpression: path => {
				if (path.node.optional)
					out.push({ path: path as NodePath<t.OptionalMemberExpression | t.OptionalCallExpression> });
			},
			OptionalCallExpression: path => {
				if (path.node.optional)
					out.push({ path: path as NodePath<t.OptionalMemberExpression | t.OptionalCallExpression> });
			},
		});
		return out;
	}

	applyCandidate(
		parsed: Parsed,
		candidate: Candidate<t.OptionalMemberExpression | t.OptionalCallExpression>,
	): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.optional = false;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}
