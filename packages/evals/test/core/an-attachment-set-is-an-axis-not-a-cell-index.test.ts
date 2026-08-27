/**
 * WHY THIS SUITE EXISTS.
 *
 * `expandVariantMatrix` expanded four axes from a declarative table and handled attachments in the
 * loop instead: it paired a list of attachment sets to cells by `cellIndex % sets.length`. A
 * selection of two attachment sets over one harness and one model therefore produced one variant
 * carrying the first set, and the second set was dropped with nothing said. Two sets over two
 * harnesses produced two variants whose names came from the harness alone, so which set each arm
 * ran depended on the product's ordering and the report named neither.
 *
 * The class this closes: an axis expanded outside the axis table, so it does not multiply the
 * product, does not reach the arm name, and cannot be refused when empty. Attachments are now a row
 * in `VARIANT_MATRIX_AXES` like every other axis, and the name carries the set whenever more than
 * one is selected.
 *
 * What it does not catch: whether a backend applies the attachments a variant carries
 * (`core/variant-support.ts` refuses an axis nobody applies, and the pier suite proves the staging),
 * and the naming grammar of the other four axes, which the matrix suite owns.
 */

import { describe, expect, it } from "bun:test";
import {
	attachmentLabel,
	attachmentSets,
	EmptyAxisError,
	expandVariantMatrix,
	VARIANT_MATRIX_AXES,
} from "../../src/core/variant-matrix";

const HARNESS = "veyyon";
const MODEL = "anthropic/claude-sonnet-4-6";

describe("the axis table", () => {
	it("declares every axis the expansion multiplies, attachments included", () => {
		// Pinned by equality: an axis added or dropped is a decision, and an axis missing here is an
		// axis that neither multiplies the product nor refuses an empty selection.
		expect(VARIANT_MATRIX_AXES.map(axis => axis.id)).toEqual([
			"harnesses",
			"configs",
			"promptVariants",
			"models",
			"attachments",
		]);
		for (const axis of VARIANT_MATRIX_AXES) {
			expect(axis.plural).not.toBe("");
		}
	});
});

describe("a selection of several attachment sets", () => {
	it("expands one variant per set, each naming the set it carries", () => {
		const variants = expandVariantMatrix({
			harnesses: [HARNESS],
			models: [MODEL],
			attachments: [["prompts/terse.prompt.md"], ["prompts/verbose.prompt.md"]],
		});

		expect(variants.map(variant => variant.name)).toEqual(["veyyon~terse", "veyyon~verbose"]);
		expect(variants.map(variant => variant.attachments)).toEqual([
			["prompts/terse.prompt.md"],
			["prompts/verbose.prompt.md"],
		]);
	});

	it("multiplies with every other axis instead of tracking its cell index", () => {
		const variants = expandVariantMatrix({
			harnesses: [HARNESS, "omp"],
			models: [MODEL],
			attachments: [["prompts/terse.prompt.md"], []],
		});

		expect(variants).toHaveLength(4);
		expect(variants.map(variant => `${variant.name}=${variant.attachments.join("|")}`)).toEqual([
			"veyyon~terse=prompts/terse.prompt.md",
			"veyyon~none=",
			"omp~terse=prompts/terse.prompt.md",
			"omp~none=",
		]);
	});

	it("labels a set of several files by every file in it", () => {
		const variants = expandVariantMatrix({
			harnesses: [HARNESS],
			models: [MODEL],
			attachments: [["prompts/terse.prompt.md", "rules/strict.rule.md"], ["prompts/verbose.prompt.md"]],
		});

		expect(variants[0]?.name).toBe("veyyon~terse+strict");
		expect(attachmentLabel(["prompts/terse.prompt.md", "rules/strict.rule.md"])).toBe("terse+strict");
		expect(attachmentLabel([])).toBe("none");
	});
});

describe("a selection of one attachment set", () => {
	it("applies it to every cell and leaves the names alone", () => {
		const variants = expandVariantMatrix({
			harnesses: [HARNESS, "omp"],
			models: [MODEL],
			attachments: ["prompts/terse.prompt.md"],
		});

		expect(variants.map(variant => variant.name)).toEqual(["veyyon", "omp"]);
		for (const variant of variants) {
			expect(variant.attachments).toEqual(["prompts/terse.prompt.md"]);
		}
	});

	it("keeps a flat list of several files together as one set", () => {
		const flat = ["prompts/terse.prompt.md", "rules/strict.rule.md"];
		expect(attachmentSets(flat)).toEqual([flat]);

		const variants = expandVariantMatrix({ harnesses: [HARNESS], models: [MODEL], attachments: flat });

		// One arm carrying both files, not one arm per file: a flat list is a set, not a list of sets.
		expect(variants).toHaveLength(1);
		expect(variants[0]?.attachments).toEqual(flat);
		expect(variants[0]?.name).toBe("veyyon");
	});

	it("reads an absent or empty selection as the empty set, never as an empty axis", () => {
		expect(attachmentSets(undefined)).toBeUndefined();
		expect(attachmentSets([])).toEqual([[]]);

		for (const attachments of [undefined, [] as string[]]) {
			const variants = expandVariantMatrix({ harnesses: [HARNESS], models: [MODEL], attachments });
			expect(variants).toHaveLength(1);
			expect(variants[0]?.name).toBe("veyyon");
			expect(variants[0]?.attachments).toEqual([]);
		}
	});

	it("still refuses an axis whose selection is empty", () => {
		expect(() => expandVariantMatrix({ harnesses: [], models: [MODEL] })).toThrow(EmptyAxisError);
		expect(() => expandVariantMatrix({ harnesses: [HARNESS], models: [] })).toThrow(EmptyAxisError);
		expect(() => expandVariantMatrix({ harnesses: [HARNESS], models: [MODEL], configs: [] })).toThrow(EmptyAxisError);
	});
});
