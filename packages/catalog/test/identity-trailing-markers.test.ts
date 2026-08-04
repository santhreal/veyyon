import { describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
import { buildModelReferenceIndex, resolveModelReference } from "../src/identity/reference";
import * as markers from "../src/identity/markers";
import type { Api, Model, Provider } from "../src/types";

function reference(id: string, provider: Provider = "openai"): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	}) as Model<Api>;
}

/**
 * `identity/markers` is the runtime trailing-marker vocabulary. It once also
 * exported `CANONICAL_TRAILING_MARKER_PATTERN`, a second pattern with `search`
 * excluded, described as "used by canonical-id resolution" — but canonical
 * resolution lives in the build-only generator (`scripts/equivalence.ts`) and
 * deliberately keeps its own private copy of the vocabulary, so the runtime
 * canonical pattern had no consumer anywhere in the tree.
 *
 * That dead export was a drift trap: it read as the canonical vocabulary, so
 * adding a marker here would look like it reached canonical coalescing when it
 * reaches only proxy-reference lookup. If this export set regresses to two
 * patterns, the trap is back — a reseller suffix added to the runtime list
 * would silently fail to collapse duplicate catalog entries.
 */
describe("identity/markers export surface", () => {
	it("exports exactly one marker pattern, the proxy-reference one", () => {
		expect(Object.keys(markers).sort()).toEqual(["REFERENCE_TRAILING_MARKER_PATTERN"]);
	});
});

/**
 * The surviving pattern is the proxy-reference vocabulary: every routing /
 * quantization / effort suffix a reseller appends, plus the reference-only
 * `search`. Removing the dead sibling must not have disturbed any entry, so
 * these assert the exact vocabulary rather than that the regex merely matches
 * something.
 */
describe("REFERENCE_TRAILING_MARKER_PATTERN", () => {
	const VOCABULARY = [
		"thinking",
		"customtools",
		"high",
		"low",
		"medium",
		"minimal",
		"xhigh",
		"free",
		"cloud",
		"exacto",
		"nitro",
		"original",
		"optimized",
		"nvfp4",
		"fp8",
		"fp4",
		"bf16",
		"int8",
		"int4",
		"search",
	] as const;

	it("matches every marker in the vocabulary under both separators", () => {
		for (const marker of VOCABULARY) {
			expect(markers.REFERENCE_TRAILING_MARKER_PATTERN.test(`claude-opus-4-6-${marker}`)).toBe(true);
			expect(markers.REFERENCE_TRAILING_MARKER_PATTERN.test(`claude-opus-4-6:${marker}`)).toBe(true);
		}
		// Case-insensitive: aggregator ids are not normalized before matching.
		expect(markers.REFERENCE_TRAILING_MARKER_PATTERN.test("claude-opus-4-6-THINKING")).toBe(true);
	});

	it("rejects non-markers and markers that are not a trailing token", () => {
		// Not in the vocabulary.
		expect(markers.REFERENCE_TRAILING_MARKER_PATTERN.test("claude-opus-4-6-turbo")).toBe(false);
		// A marker must terminate the id: an infix occurrence is part of the SKU.
		expect(markers.REFERENCE_TRAILING_MARKER_PATTERN.test("claude-opus-4-6-thinking-turbo")).toBe(false);
		// A marker must be a whole token behind `-` or `:`, never a bare suffix
		// of a longer word — `sonar-pro-searching` is its own model.
		expect(markers.REFERENCE_TRAILING_MARKER_PATTERN.test("sonar-pro-searching")).toBe(false);
		expect(markers.REFERENCE_TRAILING_MARKER_PATTERN.test("gpt-5.4cloud")).toBe(false);
	});
});

/**
 * `search` is the one marker that is reference-only. Proxy-reference lookup
 * must strip it so a proxied `claude-opus-4-6-search` inherits upstream
 * pricing, while canonical coalescing must not (Perplexity's `sonar-pro-search`
 * is a distinct model from `sonar-pro`). Locking the reference half here keeps
 * the split honest now that the unused canonical pattern is gone.
 */
describe("proxy-reference lookup strips trailing markers", () => {
	const index = buildModelReferenceIndex([reference("claude-opus-4-6"), reference("sonar-pro", "perplexity")]);

	it("resolves a marker-suffixed proxy id to the bundled upstream model", () => {
		expect(resolveModelReference("claude-opus-4-6-thinking", index)?.id).toBe("claude-opus-4-6");
		expect(resolveModelReference("claude-opus-4-6:nitro", index)?.id).toBe("claude-opus-4-6");
		expect(resolveModelReference("claude-opus-4-6-search", index)?.id).toBe("claude-opus-4-6");
	});

	it("does not invent a reference for an unknown trailing token", () => {
		expect(resolveModelReference("claude-opus-4-6-turbo", index)).toBeUndefined();
		expect(resolveModelReference("sonar-pro-searching", index)).toBeUndefined();
	});
});
