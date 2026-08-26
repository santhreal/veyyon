/**
 * WHY: expandVariantMatrix previously hardcoded the axis set in multiple places:
 * as named fields, nested loops, error checks, and comments. Adding or reordering axes
 * required fragile edits across multiple locations.
 *
 * This test suite defends the invariant that the variant matrix axis set is declared
 * as data (ordered AxisDescriptor list). It verifies at runtime that:
 * 1. Every declared axis provides a valid normalizer function.
 * 2. Every declared axis rejects empty selections with its own id and English plural in the refusal.
 * 3. Produced variant names contain axis components in declaration order.
 * 4. Produced variants strictly adhere to the declared outer-to-inner axis hierarchy.
 * 5. Adding an axis to the descriptor list multiplies the Cartesian product size accordingly.
 * 6. Attachment cycling is driven by the Cartesian product index across all matrix cells.
 */

import { describe, expect, it } from "bun:test";
import {
	AXIS_PLURAL,
	type AxisDescriptor,
	EmptyAxisError,
	expandVariantMatrix,
	type MutableVariantCellInput,
	VARIANT_MATRIX_AXES,
	type VariantMatrixSelection,
} from "../../src/core/variant-matrix";

describe("variant matrix declared axis contracts", () => {
	it("sweeps declared axes at runtime and verifies normalizers, ids, and plurals", () => {
		expect(VARIANT_MATRIX_AXES.length).toBeGreaterThanOrEqual(4);

		for (const axis of VARIANT_MATRIX_AXES) {
			expect(typeof axis.id).toBe("string");
			expect(axis.id.length).toBeGreaterThan(0);

			expect(typeof axis.plural).toBe("string");
			expect(axis.plural.length).toBeGreaterThan(0);
			expect(axis.plural).toBe(AXIS_PLURAL[axis.id] ?? axis.plural);

			expect(typeof axis.select).toBe("function");
			expect(typeof axis.normalize).toBe("function");
			expect(typeof axis.project).toBe("function");
		}
	});

	it("each axis appears in the produced variant name in declaration order", () => {
		const selection: VariantMatrixSelection = {
			harnesses: ["veyyonHarness", "ompHarness"],
			configs: [{ name: "customConfig", path: "arms/custom.yml" }],
			promptVariants: [{ name: "customPrompt", path: "prompts/custom.yml" }],
			models: ["customModelA", "customModelB"],
		};

		const variants = expandVariantMatrix(selection);
		expect(variants.length).toBe(4);

		for (const variant of variants) {
			const harnessPos = variant.name.indexOf(variant.harness);
			const configPos = variant.name.indexOf("customConfig");
			const promptPos = variant.name.indexOf("customPrompt");
			const modelPos = variant.name.indexOf(variant.model);

			expect(harnessPos).toBeGreaterThanOrEqual(0);
			expect(configPos).toBeGreaterThanOrEqual(0);
			expect(promptPos).toBeGreaterThanOrEqual(0);
			expect(modelPos).toBeGreaterThanOrEqual(0);

			expect(harnessPos).toBeLessThan(configPos);
			expect(configPos).toBeLessThan(promptPos);
			expect(promptPos).toBeLessThan(modelPos);
		}
	});

	it("orders variants according to the declared axis hierarchy (outer to inner)", () => {
		const selection: VariantMatrixSelection = {
			harnesses: ["h0", "h1"],
			configs: ["c0", "c1"],
			promptVariants: ["p0", "p1"],
			models: ["m0", "m1"],
		};
		const variants = expandVariantMatrix(selection);
		expect(variants.length).toBe(16);

		// Outer axes must change slower than inner axes across all Cartesian product rows
		const expectedCombinations: [string, string, string, string][] = [
			["h0", "c0", "p0", "m0"],
			["h0", "c0", "p0", "m1"],
			["h0", "c0", "p1", "m0"],
			["h0", "c0", "p1", "m1"],
			["h0", "c1", "p0", "m0"],
			["h0", "c1", "p0", "m1"],
			["h0", "c1", "p1", "m0"],
			["h0", "c1", "p1", "m1"],
			["h1", "c0", "p0", "m0"],
			["h1", "c0", "p0", "m1"],
			["h1", "c0", "p1", "m0"],
			["h1", "c0", "p1", "m1"],
			["h1", "c1", "p0", "m0"],
			["h1", "c1", "p0", "m1"],
			["h1", "c1", "p1", "m0"],
			["h1", "c1", "p1", "m1"],
		];

		for (let i = 0; i < 16; i++) {
			const [h, c, p, m] = expectedCombinations[i];
			expect(variants[i].harness).toBe(h);
			expect(variants[i].configPath).toBe(c);
			expect(variants[i].promptVariantPath).toBe(p);
			expect(variants[i].model).toBe(m);
		}
	});

	it("cycles 2D attachment lists across the product index", () => {
		const attachmentLists = [["rules/alpha.md"], ["rules/beta.md"], ["rules/gamma.md"]];

		const variants = expandVariantMatrix({
			harnesses: ["veyyon", "omp"],
			models: ["claude", "gpt"],
			attachments: attachmentLists,
		});

		// 4 variants total, cycled across 3 attachment lists:
		// index 0 -> alpha
		// index 1 -> beta
		// index 2 -> gamma
		// index 3 -> alpha (3 % 3 = 0)
		expect(variants.length).toBe(4);
		expect(variants[0].attachments).toEqual(["rules/alpha.md"]);
		expect(variants[1].attachments).toEqual(["rules/beta.md"]);
		expect(variants[2].attachments).toEqual(["rules/gamma.md"]);
		expect(variants[3].attachments).toEqual(["rules/alpha.md"]);
	});

	it("each declared axis rejects an empty selection with its own id and plural in the refusal", () => {
		for (const axis of VARIANT_MATRIX_AXES) {
			const emptySelection: VariantMatrixSelection = {
				harnesses: axis.id === "harnesses" ? [] : ["veyyon"],
				configs: axis.id === "configs" ? [] : ["baseline"],
				promptVariants: axis.id === "promptVariants" ? [] : ["concise"],
				models: axis.id === "models" ? [] : ["claude-3-7-sonnet"],
			};

			let caughtError: EmptyAxisError | null = null;
			try {
				expandVariantMatrix(emptySelection);
			} catch (err) {
				if (err instanceof EmptyAxisError) {
					caughtError = err;
				}
			}

			expect(caughtError).not.toBeNull();
			expect(caughtError?.axis).toBe(axis.id);
			expect(caughtError?.plural).toBe(axis.plural);
			expect(caughtError?.message).toContain(axis.id);
			expect(caughtError?.message).toContain(axis.plural);
		}
	});

	it("adding an axis to the list changes the Cartesian product size", () => {
		const baseSelection: VariantMatrixSelection = {
			harnesses: ["veyyon", "omp"],
			models: ["sonnet", "haiku"],
		};

		const baseVariants = expandVariantMatrix(baseSelection);
		expect(baseVariants.length).toBe(4);

		interface ExtendedSelection extends VariantMatrixSelection {
			readonly suites?: readonly string[];
		}

		interface ExtendedCellInput extends MutableVariantCellInput {
			suite?: string;
		}

		const suiteAxis: AxisDescriptor<string, string> = {
			id: "suites",
			plural: "suites",
			select: (selection: VariantMatrixSelection) => (selection as ExtendedSelection).suites,
			defaultValues: ["default-suite"],
			normalize: suite => suite,
			project: (cell: MutableVariantCellInput, val: string) => {
				(cell as ExtendedCellInput).suite = val;
			},
		};

		const customAxes = [...VARIANT_MATRIX_AXES, suiteAxis as AxisDescriptor<unknown, unknown>];

		const extendedSelection: ExtendedSelection = {
			...baseSelection,
			suites: ["deep-swe", "terminal-bench", "typescript-edit"],
			nameFormatter: cell =>
				`${cell.harness}@${cell.model}::${(cell as unknown as ExtendedCellInput).suite ?? "default"}`,
		};

		const extendedVariants = expandVariantMatrix(extendedSelection, customAxes);
		expect(extendedVariants.length).toBe(12);
	});

	it("fails when an axis is added without a normalizer function", () => {
		const invalidAxis = {
			id: "custom",
			plural: "customs",
			select: () => ["val1", "val2"],
			project: () => {},
		} as unknown as AxisDescriptor<unknown, unknown>;

		const customAxes = [...VARIANT_MATRIX_AXES, invalidAxis];
		const selection: VariantMatrixSelection = {
			harnesses: ["veyyon"],
			models: ["claude"],
		};

		expect(() => expandVariantMatrix(selection, customAxes)).toThrow();
	});
});
