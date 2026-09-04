import traverse from "@babel/traverse";
import type * as t from "@babel/types";
import {
	generate as generateRegex,
	parse as parseRegex,
	type NodePath as RegexNodePath,
	traverse as traverseRegex,
} from "regexp-tree";
import type { AstRegExp, Quantifier as RegexQuantifier } from "regexp-tree/ast";
import { BaseAstMutation, nodeLine, noopInfo, randomChoice, snippetFromNode, snippetFromSource } from "./base";
import type { Candidate, MutationInfo, Parsed } from "./types";

export class RegexQuantifierSwapMutation extends BaseAstMutation {
	name = "swap-regex-quantifier";
	category = "regex";
	fixHint = "Fix the ONE regex quantifier that was swapped (between `+` and `*`). Do not modify other quantifiers.";
	description = "A regex quantifier was swapped, changing whitespace matching.";

	collectCandidates(parsed: Parsed): Candidate<t.RegExpLiteral>[] {
		const out: Candidate<t.RegExpLiteral>[] = [];
		traverse(parsed.ast, {
			RegExpLiteral: path => {
				const source = `/${path.node.pattern}/${path.node.flags ?? ""}`;
				try {
					const ast = parseRegex(source);
					let hasQuantifier = false;
					traverseRegex(ast, {
						Quantifier: quantPath => {
							const kind = quantPath.node.kind;
							if (kind === "+" || kind === "*") hasQuantifier = true;
						},
					});
					if (hasQuantifier) out.push({ path });
				} catch {
					return;
				}
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.RegExpLiteral>, rng: () => number): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const source = `/${node.pattern}/${node.flags ?? ""}`;

		try {
			const ast: AstRegExp = parseRegex(source);
			const quantifiers: Array<RegexNodePath<RegexQuantifier>> = [];
			traverseRegex(ast, {
				Quantifier: quantPath => {
					const kind = quantPath.node.kind;
					if (kind === "+" || kind === "*") quantifiers.push(quantPath as RegexNodePath<RegexQuantifier>);
				},
			});
			if (quantifiers.length === 0) return noopInfo();

			const chosen = randomChoice(quantifiers, rng);
			chosen.node.kind = chosen.node.kind === "+" ? "*" : "+";

			const regenerated = generateRegex(ast);
			const firstSlash = regenerated.indexOf("/");
			const lastSlash = regenerated.lastIndexOf("/");
			if (firstSlash === -1 || lastSlash <= firstSlash) return noopInfo();

			node.pattern = regenerated.slice(firstSlash + 1, lastSlash);
			node.flags = regenerated.slice(lastSlash + 1);
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		} catch {
			return noopInfo();
		}
	}
}
