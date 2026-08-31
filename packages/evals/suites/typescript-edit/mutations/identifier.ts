import traverse, { type Binding, type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
	applySourceEdits,
	BaseAstMutation,
	mutateIdentifier,
	nodeRange,
	noopInfo,
	parseCode,
	randomChoice,
	randomSample,
} from "./base";
import type { Candidate, MutationInfo, Parsed, SourceEdit } from "./types";

export class IdentifierMultiEditMutation extends BaseAstMutation {
	name = "identifier-multi-edit";
	category = "identifier";
	fixHint = "Restore the identifier to its original spelling in all affected locations.";
	description = "An identifier is misspelled in multiple separate locations.";

	override get isMultiEdit(): boolean {
		return true;
	}

	override get isStructural(): boolean {
		return false;
	}

	override get allowsMultipleHunks(): boolean {
		return true;
	}

	#keywords = new Set([
		"await",
		"break",
		"case",
		"catch",
		"class",
		"const",
		"continue",
		"debugger",
		"default",
		"delete",
		"do",
		"else",
		"export",
		"extends",
		"finally",
		"for",
		"function",
		"if",
		"import",
		"in",
		"instanceof",
		"new",
		"return",
		"super",
		"switch",
		"this",
		"throw",
		"try",
		"typeof",
		"var",
		"void",
		"while",
		"with",
		"yield",
		"let",
		"enum",
		"implements",
		"interface",
		"package",
		"private",
		"protected",
		"public",
		"static",
		"null",
		"true",
		"false",
	]);

	collectCandidates(parsed: Parsed): Candidate<t.Program>[] {
		const out: Candidate<t.Program>[] = [];
		traverse(parsed.ast, {
			Program: path => {
				out.push({ path });
			},
		});
		return out;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];
		const candidate = randomChoice(candidates, rng);

		const bindings: Array<{ name: string; binding: Binding }> = [];
		candidate.path.traverse({
			Scope: path => {
				for (const [name, binding] of Object.entries(path.scope.bindings)) {
					if (name.length < 2) continue;
					if (name.startsWith("_")) continue;
					if (name === "arguments") continue;
					if (this.#keywords.has(name)) continue;
					bindings.push({ name, binding });
				}
			},
		});

		const distinctRefLines = (paths: NodePath<t.Identifier>[]): number => {
			return new Set(paths.map(p => p.node.loc?.start.line ?? -1)).size;
		};

		let bindingCandidates = bindings.filter(item => {
			const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
			return refs.length >= 3 && distinctRefLines(refs) >= 3;
		});

		if (bindingCandidates.length === 0) {
			bindingCandidates = bindings.filter(item => {
				const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
				return refs.length >= 2 && distinctRefLines(refs) >= 2;
			});
		}

		if (bindingCandidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(bindingCandidates, rng);
		const mutated = mutateIdentifier(chosen.name);
		if (!mutated) return [content, noopInfo()];

		const refPaths = chosen.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
		const lineMap = new Map<number, NodePath<t.Identifier>[]>();
		for (const refPath of refPaths) {
			const line = refPath.node.loc?.start.line;
			if (!line) continue;
			const list = lineMap.get(line) ?? [];
			list.push(refPath);
			lineMap.set(line, list);
		}

		const lines = [...lineMap.keys()];
		if (lines.length < 2) return [content, noopInfo()];

		const editCount = Math.min(lines.length, randomChoice(lines.length >= 3 ? [2, 3, 3, 4] : [2], rng));
		const chosenLines = randomSample(lines, editCount, rng);

		const selectedPaths: NodePath<t.Identifier>[] = [];
		for (const line of chosenLines) {
			const options = lineMap.get(line) ?? [];
			if (options.length === 0) continue;
			selectedPaths.push(randomChoice(options, rng));
		}
		if (selectedPaths.length < 2) return [content, noopInfo()];

		const edits: SourceEdit[] = [];
		for (const selectedPath of selectedPaths) {
			const range = nodeRange(selectedPath.node);
			if (range) {
				edits.push({ ...range, replacement: mutated });
			}
		}

		const bindingId = chosen.binding.identifier;
		const bindingLine = bindingId.loc?.start.line;
		if (bindingLine && chosenLines.includes(bindingLine)) {
			const range = nodeRange(bindingId);
			if (range) {
				edits.push({ ...range, replacement: mutated });
			}
		}

		const deduped = new Map<string, SourceEdit>();
		for (const edit of edits) {
			deduped.set(`${edit.start}:${edit.end}`, edit);
		}
		if (deduped.size < 2) return [content, noopInfo()];

		const mutatedContent = applySourceEdits(content, Array.from(deduped.values()));
		if (!mutatedContent || mutatedContent === content) return [content, noopInfo()];

		return [
			mutatedContent,
			{
				lineNumber: selectedPaths[0]?.node.loc?.start.line ?? 0,
				originalSnippet: chosen.name,
				mutatedSnippet: mutated,
			},
		];
	}

	applyCandidate(_parsed: Parsed, candidate: Candidate<t.Program>, rng: () => number): MutationInfo {
		const bindings: Array<{ name: string; binding: Binding }> = [];
		candidate.path.traverse({
			Scope: path => {
				for (const [name, binding] of Object.entries(path.scope.bindings)) {
					if (name.length < 2) continue;
					if (name.startsWith("_")) continue;
					if (name === "arguments") continue;
					if (this.#keywords.has(name)) continue;
					bindings.push({ name, binding });
				}
			},
		});

		const distinctRefLines = (paths: NodePath<t.Identifier>[]): number => {
			return new Set(paths.map(p => p.node.loc?.start.line ?? -1)).size;
		};

		let candidates = bindings.filter(item => {
			const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
			return refs.length >= 3 && distinctRefLines(refs) >= 3;
		});

		if (candidates.length === 0) {
			candidates = bindings.filter(item => {
				const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
				return refs.length >= 2 && distinctRefLines(refs) >= 2;
			});
		}

		if (candidates.length === 0) return noopInfo();

		const chosen = randomChoice(candidates, rng);
		const mutated = mutateIdentifier(chosen.name);
		if (!mutated) return noopInfo();

		const refPaths = chosen.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
		const lineMap = new Map<number, NodePath<t.Identifier>[]>();
		for (const refPath of refPaths) {
			const line = refPath.node.loc?.start.line;
			if (!line) continue;
			const list = lineMap.get(line) ?? [];
			list.push(refPath);
			lineMap.set(line, list);
		}

		const lines = [...lineMap.keys()];
		if (lines.length < 2) return noopInfo();

		const editCount = Math.min(lines.length, randomChoice(lines.length >= 3 ? [2, 3, 3, 4] : [2], rng));
		const chosenLines = randomSample(lines, editCount, rng);

		const selectedPaths: NodePath<t.Identifier>[] = [];
		for (const line of chosenLines) {
			const options = lineMap.get(line) ?? [];
			if (options.length === 0) continue;
			selectedPaths.push(randomChoice(options, rng));
		}
		if (selectedPaths.length < 2) return noopInfo();

		for (const selectedPath of selectedPaths) {
			selectedPath.node.name = mutated;
		}

		const bindingId = chosen.binding.identifier;
		const bindingLine = bindingId.loc?.start.line;
		if (bindingLine && chosenLines.includes(bindingLine)) {
			bindingId.name = mutated;
		}

		return {
			lineNumber: selectedPaths[0]?.node.loc?.start.line ?? 0,
			originalSnippet: chosen.name,
			mutatedSnippet: mutated,
		};
	}
}
