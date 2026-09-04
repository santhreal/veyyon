import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { BaseAstMutation, nodeLine, noopInfo, snippetFromNode, snippetFromSource } from "./base";
import type { Candidate, MutationInfo, Parsed } from "./types";

export class UnicodeHyphenMutation extends BaseAstMutation {
	name = "unicode-hyphen";
	category = "unicode";
	fixHint = "Replace the unicode dash with a plain ASCII hyphen.";
	description = "A string literal contains a lookalike unicode dash.";

	collectCandidates(parsed: Parsed): Candidate<t.StringLiteral | t.TemplateElement>[] {
		const out: Candidate<t.StringLiteral | t.TemplateElement>[] = [];
		traverse(parsed.ast, {
			StringLiteral: path => {
				if (path.node.value.includes("-"))
					out.push({ path: path as NodePath<t.StringLiteral | t.TemplateElement> });
			},
			TemplateElement: path => {
				if (path.node.value.raw.includes("-"))
					out.push({ path: path as NodePath<t.StringLiteral | t.TemplateElement> });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.StringLiteral | t.TemplateElement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));

		if (t.isStringLiteral(node)) {
			const idx = node.value.indexOf("-");
			if (idx === -1) return noopInfo();
			node.value = `${node.value.slice(0, idx)}–${node.value.slice(idx + 1)}`;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		const idx = node.value.raw.indexOf("-");
		if (idx === -1) return noopInfo();
		node.value.raw = `${node.value.raw.slice(0, idx)}–${node.value.raw.slice(idx + 1)}`;
		node.value.cooked = (node.value.cooked ?? node.value.raw).replace("-", "–");
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}
