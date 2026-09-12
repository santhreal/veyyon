import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import type { Model } from "@veyyon/catalog/types";
import { buildCanonicalModelIndex, buildCanonicalReferenceData } from "../scripts/equivalence";

/**
 * Canonical normalization must retain model identity and override precedence.
 * These cases cover alias families and empty transformation results through the
 * production index builder, not live discovery or every future alias spelling.
 */
function model(id: string, provider = "custom"): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
		maxTokens: 4000,
	});
}

const aliases = [
	["hf:atlas", "atlas"],
	["atlas-latest", "atlas"],
	["glm-4.7-turbo", "glm-4.7"],
	["vendor_gpt-9", "gpt-9"],
	["atlas-v2:1", "atlas"],
	["atlas-20260901", "atlas"],
	["atlas-high", "atlas"],
	["hf:claude-10.12-sonnet-high", "claude-sonnet-10.12"],
	["claude-10.12-sonnet", "claude-sonnet-10.12"],
	["hf:atlas-v2:1-latest-high", "atlas"],
	["duo-chat-atlas", "atlas"],
	["atlas-47", "atlas-4.7"],
] as const;

describe("canonical model identity", () => {
	it.each(aliases)("resolves %s to %s with cold and warm reference state", (id, canonical) => {
		const reference = buildCanonicalReferenceData([model(canonical, "openai")]);
		for (let pass = 0; pass < 2; pass++) {
			const index = buildCanonicalModelIndex([model(id)], reference);
			expect([...index.bySelector]).toEqual([[`custom/${id}`, canonical]]);
			expect(
				index.records.map(record => ({ id: record.id, sources: record.variants.map(variant => variant.source) })),
			).toEqual([{ id: canonical, sources: ["heuristic"] }]);
		}
	});

	it.each(["hf:", "-latest", "-v2", "-20260901", "-high", "atlas-search"])(
		"does not replace %s with an empty or unrelated identity",
		id => {
			const index = buildCanonicalModelIndex([model(id)], buildCanonicalReferenceData([model("atlas", "openai")]));
			expect([...index.bySelector]).toEqual([[`custom/${id}`, id]]);
			expect(index.records.map(record => record.id)).toEqual([id]);
		},
	);

	it("isolates overrides, exclusions and reference sets across cached resolutions", () => {
		const input = [model("atlas-latest")];
		const reference = buildCanonicalReferenceData([model("atlas", "openai")]);
		const key = "custom/atlas-latest";
		expect(buildCanonicalModelIndex(input, reference).bySelector.get(key)).toBe("atlas");
		expect(
			buildCanonicalModelIndex(input, reference, { overrides: { [key]: "pinned" }, exclude: [key] }).bySelector.get(
				key,
			),
		).toBe("pinned");
		expect(buildCanonicalModelIndex(input, reference, { exclude: [key] }).bySelector.get(key)).toBe("atlas-latest");
		expect(buildCanonicalModelIndex(input, reference).bySelector.get(key)).toBe("atlas");
		expect(buildCanonicalModelIndex(input, buildCanonicalReferenceData([])).bySelector.get(key)).toBe("atlas-latest");
	});
});
