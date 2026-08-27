/**
 * WHY:
 * Tests that the mutation registry is the single owner of mutation categorization,
 * that every registered mutation declares complete generation metadata (isMultiEdit,
 * isStructural, allowsMultipleHunks), that categories are derived without duplication,
 * and that prompt generation/hunk counting read these declared capabilities instead
 * of hardcoded name checks.
 *
 * This closes the defect class where adding a new mutation kind silently resulted in
 * unindexed categories or broken multi-hunk / prompt generation.
 */
import { describe, expect, it } from "bun:test";
import { buildPrompt } from "../../../src/suites/typescript-edit/generate";
import {
	ALL_MUTATIONS,
	allMutations,
	BaseAstMutation,
	CATEGORY_MAP,
	DuplicateMutationError,
	type Mutation,
	type MutationInfo,
	MutationNotFoundError,
	MutationRegistry,
	mutationCategoryMap,
	mutationIds,
	requireMutation,
} from "../../../src/suites/typescript-edit/mutations";
import * as accessFamily from "../../../src/suites/typescript-edit/mutations/access";
import * as callFamily from "../../../src/suites/typescript-edit/mutations/call";
import * as duplicateFamily from "../../../src/suites/typescript-edit/mutations/duplicate";
import * as identifierFamily from "../../../src/suites/typescript-edit/mutations/identifier";
import * as importFamily from "../../../src/suites/typescript-edit/mutations/import";
import * as literalFamily from "../../../src/suites/typescript-edit/mutations/literal";
import * as operatorFamily from "../../../src/suites/typescript-edit/mutations/operator";
import * as regexFamily from "../../../src/suites/typescript-edit/mutations/regex";
import * as structuralFamily from "../../../src/suites/typescript-edit/mutations/structural";
import * as unicodeFamily from "../../../src/suites/typescript-edit/mutations/unicode";

/**
 * Every family module, swept at run time. A mutation class exported by a family module and left out
 * of BUILTIN_MUTATIONS is invisible to generation: the registry is the only thing generation reads,
 * so an unregistered class ships as dead code that no corpus ever exercises.
 */
const MUTATION_FAMILIES: Readonly<Record<string, Record<string, unknown>>> = {
	access: accessFamily,
	call: callFamily,
	duplicate: duplicateFamily,
	identifier: identifierFamily,
	import: importFamily,
	literal: literalFamily,
	operator: operatorFamily,
	regex: regexFamily,
	structural: structuralFamily,
	unicode: unicodeFamily,
};

describe("mutation registry and declared metadata", () => {
	it("sweeps every registered mutation at runtime and asserts full declared metadata", () => {
		const mutations = allMutations();
		expect(mutations.length).toBeGreaterThanOrEqual(20);
		expect(ALL_MUTATIONS.length).toBe(mutations.length);

		const ids = mutationIds();
		expect(ids.length).toBe(mutations.length);

		const categoryMap = mutationCategoryMap();
		const allCategories = Object.keys(categoryMap);
		expect(allCategories.length).toBeGreaterThan(0);
		expect(CATEGORY_MAP).toEqual(categoryMap);

		for (const mutation of mutations) {
			// Id and Name
			expect(typeof mutation.id).toBe("string");
			expect(mutation.id.length).toBeGreaterThan(0);
			expect(mutation.name).toBe(mutation.id);
			expect(ids).toContain(mutation.id);
			expect(requireMutation(mutation.id)).toBe(mutation);
			// Id and Name
			expect(typeof mutation.id).toBe("string");
			expect(mutation.id.length).toBeGreaterThan(0);
			expect(mutation.name).toBe(mutation.id);

			// Category
			expect(typeof mutation.category).toBe("string");
			expect(mutation.category.length).toBeGreaterThan(0);

			// Fix hint
			expect(typeof mutation.fixHint).toBe("string");
			expect(mutation.fixHint.length).toBeGreaterThan(0);

			// Capabilities / generation metadata
			expect(typeof mutation.isMultiEdit).toBe("boolean");
			expect(typeof mutation.isStructural).toBe("boolean");
			expect(typeof mutation.allowsMultipleHunks).toBe("boolean");

			// Consistent hunk allowance: multi-edit and structural mutations must allow multiple hunks
			if (mutation.isMultiEdit || mutation.isStructural) {
				expect(mutation.allowsMultipleHunks).toBe(true);
			}

			// Must appear in the category map under its category exactly once
			const categoryMembers = categoryMap[mutation.category];
			expect(categoryMembers).toBeDefined();
			expect(categoryMembers).toContain(mutation.id);

			// Must NOT appear in any other category
			for (const otherCat of allCategories) {
				if (otherCat !== mutation.category) {
					expect(categoryMap[otherCat]).not.toContain(mutation.id);
				}
			}
		}
	});

	it("registers every mutation class each family module exports", () => {
		const registeredConstructors = new Set(allMutations().map(mutation => mutation.constructor.name));
		const unregistered: string[] = [];

		for (const [family, module] of Object.entries(MUTATION_FAMILIES)) {
			const classes = Object.entries(module).filter(
				([name, value]) => typeof value === "function" && name.endsWith("Mutation") && name !== "BaseAstMutation",
			);
			expect(classes.length).toBeGreaterThan(0);
			for (const [name] of classes) {
				if (!registeredConstructors.has(name)) unregistered.push(`${family}: ${name}`);
			}
		}

		expect(unregistered).toEqual([]);
	});

	it("refuses duplicate mutation ID registration with DuplicateMutationError", () => {
		const testRegistry = new MutationRegistry();

		class DummyMutation extends BaseAstMutation {
			name = "test-dup-mutation";
			category = "test-cat";
			fixHint = "Test hint";
			description = "Test description";
			collectCandidates() {
				return [];
			}
			applyCandidate() {
				return { lineNumber: 0, originalSnippet: "", mutatedSnippet: "" };
			}
		}

		const inst1 = new DummyMutation();
		const inst2 = new DummyMutation();

		testRegistry.register(inst1);
		// Re-registering identical instance is idempotent
		expect(() => testRegistry.register(inst1)).not.toThrow();

		// Registering different instance with same ID throws DuplicateMutationError
		expect(() => testRegistry.register(inst2)).toThrow(DuplicateMutationError);
		expect(() => testRegistry.register(inst2)).toThrow(/already registered as "test-dup-mutation"/);
	});

	it("throws MutationNotFoundError when requiring an unknown mutation ID", () => {
		const testRegistry = new MutationRegistry();
		expect(() => testRegistry.require("unknown-id")).toThrow(MutationNotFoundError);
		expect(() => testRegistry.require("unknown-id")).toThrow(/Unknown mutation "unknown-id"/);
	});

	it("derives category map dynamically when new mutations are registered", () => {
		const testRegistry = new MutationRegistry();

		class CustomMutationA extends BaseAstMutation {
			name = "custom-a";
			category = "custom-cat-1";
			fixHint = "Hint A";
			description = "Desc A";
			collectCandidates() {
				return [];
			}
			applyCandidate() {
				return { lineNumber: 0, originalSnippet: "", mutatedSnippet: "" };
			}
		}

		class CustomMutationB extends BaseAstMutation {
			name = "custom-b";
			category = "custom-cat-1";
			fixHint = "Hint B";
			description = "Desc B";
			collectCandidates() {
				return [];
			}
			applyCandidate() {
				return { lineNumber: 0, originalSnippet: "", mutatedSnippet: "" };
			}
		}

		class CustomMutationC extends BaseAstMutation {
			name = "custom-c";
			category = "custom-cat-2";
			fixHint = "Hint C";
			description = "Desc C";
			collectCandidates() {
				return [];
			}
			applyCandidate() {
				return { lineNumber: 0, originalSnippet: "", mutatedSnippet: "" };
			}
		}

		testRegistry.register(new CustomMutationA());
		testRegistry.register(new CustomMutationB());
		testRegistry.register(new CustomMutationC());

		const map = testRegistry.categoryMap();
		expect(map["custom-cat-1"]).toEqual(["custom-a", "custom-b"]);
		expect(map["custom-cat-2"]).toEqual(["custom-c"]);
		expect(testRegistry.listIds()).toEqual(["custom-a", "custom-b", "custom-c"]);
	});

	it("buildPrompt uses declared metadata rather than matching mutation name string", () => {
		const dummyEntry = {
			path: "test.ts",
			content: "export const x = 1;\n",
			lineCount: 1,
			repeatedLines: new Map<string, number[]>(),
			similarBlockCount: 0,
			density: 0.5,
			maxIndent: 0,
			functionRanges: [] as Array<[string, number, number]>,
		};
		const dummyInfo: MutationInfo = {
			lineNumber: 10,
			originalSnippet: "orig",
			mutatedSnippet: "mut",
		};

		// A custom multi-edit mutation with an arbitrary name
		const customMultiEdit: Mutation = {
			id: "arbitrary-multi-edit-name",
			name: "arbitrary-multi-edit-name",
			category: "custom",
			fixHint: "Fix all",
			isMultiEdit: true,
			isStructural: false,
			allowsMultipleHunks: true,
			canApply: () => true,
			mutate: c => [c, dummyInfo],
			describe: () => "An identifier is wrong.",
		};

		const hardPrompt = buildPrompt("test.ts", customMultiEdit, dummyInfo, "hard", dummyEntry);
		expect(hardPrompt).toContain("Find and fix all occurrences of this issue.");

		const nightmarePrompt = buildPrompt("test.ts", customMultiEdit, dummyInfo, "nightmare", dummyEntry);
		expect(nightmarePrompt).toContain("An identifier is consistently misspelled throughout this file.");

		// A custom structural mutation with an arbitrary name
		const customStructural: Mutation = {
			id: "arbitrary-structural-name",
			name: "arbitrary-structural-name",
			category: "custom",
			fixHint: "Fix structure",
			isMultiEdit: false,
			isStructural: true,
			allowsMultipleHunks: true,
			canApply: () => true,
			mutate: c => [c, dummyInfo],
			describe: () => "Structure is wrong.",
		};

		const easyPrompt = buildPrompt("test.ts", customStructural, dummyInfo, "easy", dummyEntry);
		expect(easyPrompt).toContain("The issue starts around line 10.");

		const hardStructPrompt = buildPrompt("test.ts", customStructural, dummyInfo, "hard", dummyEntry);
		expect(hardStructPrompt).toContain("The fix may involve multiple lines.");

		const nightmareStructPrompt = buildPrompt("test.ts", customStructural, dummyInfo, "nightmare", dummyEntry);
		expect(nightmareStructPrompt).toContain("There is a structural bug in this file.");
	});
});
