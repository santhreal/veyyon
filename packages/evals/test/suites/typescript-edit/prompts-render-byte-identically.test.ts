/**
 * WHY:
 * Model-facing prompt strings were previously assembled via ad-hoc string concatenation
 * across multiple files (`argot-bench.ts` and `generate.ts`).
 *
 * This suite proves that all moved prompts are loaded from static `.md` files, compiled
 * with Handlebars, and render byte-identically to the expected output for all parameter
 * combinations and difficulty levels.
 */

import { describe, expect, it } from "bun:test";
import Handlebars from "handlebars";
import { buildPrompt, type FileEntry } from "../../../src/suites/typescript-edit/generate";
import type { Mutation, MutationInfo } from "../../../src/suites/typescript-edit/mutations";
import forcedAdoptionPromptText from "../../../src/suites/typescript-edit/prompts/argot-forced-adoption.md" with {
	type: "text",
};
import sigilEmissionPromptText from "../../../src/suites/typescript-edit/prompts/argot-sigil-emission.md" with {
	type: "text",
};
import reproBarrelPromptText from "../../../src/suites/typescript-edit/prompts/repro-barrel-reexport.md" with {
	type: "text",
};
import reproFeaturePromptText from "../../../src/suites/typescript-edit/prompts/repro-new-feature.md" with {
	type: "text",
};

describe("prompts render byte-identically", () => {
	it("renders repro-barrel-reexport template byte-identically", () => {
		const template = Handlebars.compile(reproBarrelPromptText, { noEscape: true });
		const rendered = template({
			pkg: "@veyyon/wire",
			deepPath: "src/internal/pool",
			url: "https://rubygems.org/api/v1/gems",
		});

		const expected =
			"Create a new file `src/barrel.ts`. In it:\n" +
			"- re-export `helper` from '@veyyon/wire'\n" +
			"- re-export `pool` from 'src/internal/pool'\n" +
			"- export a constant `ENDPOINT` set to the string 'https://rubygems.org/api/v1/gems'\n" +
			"Write only that file.";

		expect(rendered).toBe(expected);
	});

	it("renders repro-new-feature template byte-identically", () => {
		const template = Handlebars.compile(reproFeaturePromptText, { noEscape: true });
		const rendered = template({
			pkg: "@veyyon/wire",
			deepPath: "src/internal/pool",
			url: "https://rubygems.org/api/v1/gems",
		});

		const expected =
			"Create `src/feature-6.ts` following the exact same shape as the other feature files in `src/`: " +
			"import `helper` from '@veyyon/wire', import `pool` from 'src/internal/pool', " +
			"define `const ENDPOINT = 'https://rubygems.org/api/v1/gems'`, and export a function `feature6()` that returns " +
			"`helper(pool, ENDPOINT)`. Write only that file.";

		expect(rendered).toBe(expected);
	});

	it("renders argot-sigil-emission template byte-identically", () => {
		const template = Handlebars.compile(sigilEmissionPromptText, { noEscape: true });
		const rendered = template({
			repetitions: 5,
			token: "§kx7qz",
		});

		const expected =
			"Output this exact token 5 times, separated by single spaces, and write nothing else at all (no quotes, no explanation): §kx7qz";

		expect(rendered).toBe(expected);
	});

	it("renders argot-forced-adoption template byte-identically", () => {
		const template = Handlebars.compile(forcedAdoptionPromptText, { noEscape: true });
		const expansions = ["https://registry.npmjs.org", "@veyyon/utils", "https://rubygems.org/api/v1/gems"];
		const teaching = "PREAMBLE_TEXT\n\nVOCABULARY_FRAGMENT";
		const rendered = template({
			teaching,
			references: expansions.join("\n"),
		});

		const expected =
			`${teaching}\n\n` +
			"Now apply that shorthand. Reproduce the following three references exactly, one per line, " +
			"but replace any value that appears in the dictionary above with its handle. Output only the " +
			"three lines, nothing else:\n" +
			`${expansions.join("\n")}`;

		expect(rendered).toBe(expected);
	});

	describe("generate.ts buildPrompt byte-identical rendering across all difficulty modes", () => {
		const dummyEntry: FileEntry = {
			path: "src/server/router.ts",
			content: "export function handleRequest() {\n  return 42;\n}\n",
			lineCount: 150,
			repeatedLines: new Map<string, number[]>(),
			similarBlockCount: 0,
			density: 0.5,
			maxIndent: 2,
			functionRanges: [["handleRequest", 1, 3]],
		};

		const dummyInfo: MutationInfo = {
			lineNumber: 2,
			originalSnippet: "return 42;",
			mutatedSnippet: "return 43;",
		};

		const standardMutation: Mutation = {
			id: "swap-arithmetic",
			name: "swap-arithmetic",
			category: "operator",
			fixHint: "Correct the arithmetic operator.",
			isMultiEdit: false,
			isStructural: false,
			allowsMultipleHunks: false,
			canApply: () => true,
			mutate: c => [c, dummyInfo],
			describe: () => "An arithmetic operator was swapped.",
		};

		const structuralMutation: Mutation = {
			id: "swap-if-else",
			name: "swap-if-else",
			category: "structural",
			fixHint: "Swap the if and else branch bodies back to their original positions.",
			isMultiEdit: false,
			isStructural: true,
			allowsMultipleHunks: true,
			canApply: () => true,
			mutate: c => [c, dummyInfo],
			describe: () => "The if and else branches are swapped.",
		};

		const multiEditMutation: Mutation = {
			id: "identifier-multi-edit",
			name: "identifier-multi-edit",
			category: "identifier",
			fixHint: "Restore the identifier to its original spelling in all affected locations.",
			isMultiEdit: true,
			isStructural: false,
			allowsMultipleHunks: true,
			canApply: () => true,
			mutate: c => [c, dummyInfo],
			describe: () => "An identifier is misspelled in multiple separate locations.",
		};

		it("renders easy difficulty prompts byte-identically", () => {
			const prompt1 = buildPrompt("src/server/router.ts", standardMutation, dummyInfo, "easy", dummyEntry);
			expect(prompt1).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"An arithmetic operator was swapped.\n\n" +
					"The issue is on line 2.\n\n" +
					"Correct the arithmetic operator.",
			);

			const prompt2 = buildPrompt("src/server/router.ts", structuralMutation, dummyInfo, "easy", dummyEntry);
			expect(prompt2).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"The if and else branches are swapped.\n\n" +
					"The issue starts around line 2.\n\n" +
					"Swap the if and else branch bodies back to their original positions.",
			);
		});

		it("renders medium difficulty prompts byte-identically", () => {
			const prompt1 = buildPrompt("src/server/router.ts", standardMutation, dummyInfo, "medium", dummyEntry);
			expect(prompt1).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"An arithmetic operator was swapped.\n\n" +
					"The issue is in the `handleRequest` function.\n\n" +
					"Correct the arithmetic operator.",
			);

			const noFuncEntry: FileEntry = { ...dummyEntry, functionRanges: [] };
			const prompt2 = buildPrompt("src/server/router.ts", standardMutation, dummyInfo, "medium", noFuncEntry);
			expect(prompt2).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"An arithmetic operator was swapped.\n\n" +
					"The issue is near the top of the file.\n\n" +
					"Correct the arithmetic operator.",
			);

			const prompt3 = buildPrompt("src/server/router.ts", multiEditMutation, dummyInfo, "medium", dummyEntry);
			expect(prompt3).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"An identifier is misspelled in multiple separate locations.\n\n" +
					"The issue is in the `handleRequest` function. The same error appears in multiple places.\n\n" +
					"Restore the identifier to its original spelling in all affected locations.",
			);
		});

		it("renders hard difficulty prompts byte-identically", () => {
			const prompt1 = buildPrompt("src/server/router.ts", standardMutation, dummyInfo, "hard", dummyEntry);
			expect(prompt1).toBe(
				"# Fix the bug in `router.ts`\n\n" + "An arithmetic operator was swapped.\n\n" + "Find and fix this issue.",
			);

			const prompt2 = buildPrompt("src/server/router.ts", multiEditMutation, dummyInfo, "hard", dummyEntry);
			expect(prompt2).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"An identifier is misspelled in multiple separate locations.\n\n" +
					"Find and fix all occurrences of this issue.",
			);

			const prompt3 = buildPrompt("src/server/router.ts", structuralMutation, dummyInfo, "hard", dummyEntry);
			expect(prompt3).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"The if and else branches are swapped.\n\n" +
					"The fix may involve multiple lines.",
			);
		});

		it("renders nightmare difficulty prompts byte-identically", () => {
			const prompt1 = buildPrompt("src/server/router.ts", standardMutation, dummyInfo, "nightmare", dummyEntry);
			expect(prompt1).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"There is a subtle bug in this file.\n\n" +
					"Track it down and fix it with a minimal edit.",
			);

			const prompt2 = buildPrompt("src/server/router.ts", structuralMutation, dummyInfo, "nightmare", dummyEntry);
			expect(prompt2).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"There is a structural bug in this file.\n\n" +
					"Track it down and fix it with a minimal edit.",
			);

			const prompt3 = buildPrompt("src/server/router.ts", multiEditMutation, dummyInfo, "nightmare", dummyEntry);
			expect(prompt3).toBe(
				"# Fix the bug in `router.ts`\n\n" +
					"An identifier is consistently misspelled throughout this file.\n\n" +
					"Find all occurrences and fix them.",
			);
		});
	});
});
