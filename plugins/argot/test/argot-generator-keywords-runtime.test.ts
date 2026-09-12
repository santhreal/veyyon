import { describe, expect, it } from "bun:test";
import { extractCandidates } from "../src/generate.js";

describe("argot generator keywords runtime derivation", () => {
	it("rejects whole source code statement lines across all keyword variants", () => {
		const keywords = [
			"if",
			"else",
			"for",
			"while",
			"switch",
			"case",
			"default",
			"const",
			"let",
			"var",
			"return",
			"function",
			"class",
			"type",
			"interface",
			"import",
			"export",
			"await",
			"async",
			"new",
			"throw",
			"try",
			"catch",
			"finally",
			"do",
			"break",
			"continue",
			"enum",
			"namespace",
			"declare",
			"public",
			"private",
			"protected",
			"static",
			"yield",
			"extends",
			"implements",
			"super",
			"this",
		];

		for (const kw of keywords) {
			const candidateLine = `${kw} sampleIdentifier = someHelper(arg1, arg2)`;
			const extracted = extractCandidates(candidateLine);
			// Whole line must not be extracted as a command handle
			expect(extracted).not.toContain(candidateLine);
		}
	});

	it("extracts valid command lines while skipping source keywords", () => {
		const command = "npm run build --filter=@scope/pkg";
		const extracted = extractCandidates(command);
		expect(extracted).toContain(command);
	});
});
