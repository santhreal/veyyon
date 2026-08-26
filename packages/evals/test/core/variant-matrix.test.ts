/**
 * Tests for variant matrix expansion, deterministic naming, and input fingerprinting.
 *
 * Proves that:
 * 1. The variant matrix is the complete and stably ordered product across all axes.
 * 2. Empty axes are refused with EmptyAxisError.
 * 3. Duplicate resolved variant names are refused with DuplicateVariantNameError.
 * 4. Input fingerprinting is canonical, order-invariant on object keys, and detects 0-IV collisions.
 */

import { describe, expect, it } from "bun:test";
import {
	canonicalizeConfig,
	computeVariantFingerprint,
	DuplicateVariantNameError,
	EmptyAxisError,
	expandVariantMatrix,
	findVariantCollisions,
} from "../../src/core/variant-matrix";

describe("expandVariantMatrix", () => {
	it("expands a complete 4-axis Cartesian product with stable ordering", () => {
		const harnesses = ["veyyon", "omp"];
		const configs = [
			{ name: "baseline", path: "arms/baseline.yml" },
			{ name: "candidate", path: "arms/candidate.yml" },
		];
		const promptVariants = [null, { name: "concise", path: "arms/concise.prompts.yml" }];
		const models = ["anthropic/claude-sonnet", "openai/gpt-4o"];

		const variants = expandVariantMatrix({
			harnesses,
			configs,
			promptVariants,
			models,
		});

		// 2 harnesses * 2 configs * 2 promptVariants * 2 models = 16 variants
		expect(variants.length).toBe(16);

		// Assert stable outer-to-inner ordering
		expect(variants[0]).toEqual({
			name: "veyyon:baseline@anthropic/claude-sonnet",
			harness: "veyyon",
			configPath: "arms/baseline.yml",
			promptVariantPath: null,
			model: "anthropic/claude-sonnet",
			attachments: [],
		});

		expect(variants[1]).toEqual({
			name: "veyyon:baseline@openai/gpt-4o",
			harness: "veyyon",
			configPath: "arms/baseline.yml",
			promptVariantPath: null,
			model: "openai/gpt-4o",
			attachments: [],
		});

		expect(variants[2]).toEqual({
			name: "veyyon:baseline+concise@anthropic/claude-sonnet",
			harness: "veyyon",
			configPath: "arms/baseline.yml",
			promptVariantPath: "arms/concise.prompts.yml",
			model: "anthropic/claude-sonnet",
			attachments: [],
		});

		expect(variants[15]).toEqual({
			name: "omp:candidate+concise@openai/gpt-4o",
			harness: "omp",
			configPath: "arms/candidate.yml",
			promptVariantPath: "arms/concise.prompts.yml",
			model: "openai/gpt-4o",
			attachments: [],
		});
	});

	it("produces standard single-axis names when other axes are single/default", () => {
		const singleHarness = expandVariantMatrix({
			harnesses: ["veyyon"],
			configs: ["baseline", "candidate"],
			models: ["claude-3-7-sonnet"],
		});

		expect(singleHarness.map(v => v.name)).toEqual(["baseline", "candidate"]);
		expect(singleHarness[0].configPath).toBe("baseline");
		expect(singleHarness[1].configPath).toBe("candidate");
	});

	it("refuses empty harnesses axis", () => {
		expect(() =>
			expandVariantMatrix({
				harnesses: [],
				models: ["claude-3-7-sonnet"],
			}),
		).toThrow(EmptyAxisError);

		try {
			expandVariantMatrix({ harnesses: [], models: ["claude"] });
		} catch (err) {
			expect((err as EmptyAxisError).axis).toBe("harnesses");
		}
	});

	it("refuses empty models axis", () => {
		expect(() =>
			expandVariantMatrix({
				harnesses: ["veyyon"],
				models: [],
			}),
		).toThrow(EmptyAxisError);

		try {
			expandVariantMatrix({ harnesses: ["veyyon"], models: [] });
		} catch (err) {
			expect((err as EmptyAxisError).axis).toBe("models");
		}
	});

	it("refuses empty configs or promptVariants array when explicitly passed empty", () => {
		expect(() =>
			expandVariantMatrix({
				harnesses: ["veyyon"],
				models: ["claude"],
				configs: [],
			}),
		).toThrow(EmptyAxisError);

		expect(() =>
			expandVariantMatrix({
				harnesses: ["veyyon"],
				models: ["claude"],
				promptVariants: [],
			}),
		).toThrow(EmptyAxisError);
	});

	it("refuses duplicate resolved variant names", () => {
		// When custom formatter maps different cells to the same name
		expect(() =>
			expandVariantMatrix({
				harnesses: ["veyyon", "omp"],
				models: ["claude"],
				nameFormatter: () => "constant-collision-name",
			}),
		).toThrow(DuplicateVariantNameError);

		try {
			expandVariantMatrix({
				harnesses: ["veyyon", "omp"],
				models: ["claude"],
				nameFormatter: () => "collision",
			});
		} catch (err) {
			expect((err as DuplicateVariantNameError).variantName).toBe("collision");
		}
	});

	it("supports custom nameFormatter", () => {
		const variants = expandVariantMatrix({
			harnesses: ["veyyon", "omp"],
			configs: ["arms/fast.yml"],
			models: ["sonnet", "haiku"],
			nameFormatter: cell => `${cell.harness}__${cell.config?.name}__${cell.model}`,
		});

		expect(variants.map(v => v.name)).toEqual([
			"veyyon__fast__sonnet",
			"veyyon__fast__haiku",
			"omp__fast__sonnet",
			"omp__fast__haiku",
		]);
	});

	it("attaches files per variant when specified", () => {
		const variants = expandVariantMatrix({
			harnesses: ["veyyon"],
			configs: ["baseline"],
			models: ["claude"],
			attachments: ["rules/test.rule.md"],
		});

		expect(variants[0].attachments).toEqual(["rules/test.rule.md"]);
	});
});

describe("canonicalizeConfig and computeVariantFingerprint", () => {
	it("canonicalizeConfig is invariant to object key order and whitespace", () => {
		const objA = { z: 1, a: { y: 2, b: 3 } };
		const objB = { a: { b: 3, y: 2 }, z: 1 };

		expect(canonicalizeConfig(objA)).toBe(canonicalizeConfig(objB));
	});

	it("computeVariantFingerprint changes when any independent variable changes", () => {
		const baseFp = computeVariantFingerprint({
			config: { timeout: 30 },
		});

		const diffConfigFp = computeVariantFingerprint({
			config: { timeout: 60 },
		});
		expect(diffConfigFp).not.toBe(baseFp);

		const promptOverrideFp = computeVariantFingerprint({
			config: { timeout: 30 },
			prompts: { sys: "custom prompt" },
		});
		expect(promptOverrideFp).not.toBe(baseFp);

		const ruleFp = computeVariantFingerprint({
			config: { timeout: 30 },
			rule: new TextEncoder().encode("always apply rule"),
		});
		expect(ruleFp).not.toBe(baseFp);
	});

	it("findVariantCollisions identifies 0-IV duplicates", () => {
		const fingerprints = new Map<string, string>([
			["arm-1", "fp-aaa"],
			["arm-2", "fp-bbb"],
			["arm-3", "fp-aaa"],
			["arm-4", "fp-ccc"],
			["arm-5", "fp-aaa"],
		]);

		const collisions = findVariantCollisions(fingerprints);
		expect(collisions).toEqual([["arm-1", "arm-3", "arm-5"]]);
	});
});
