import { describe, expect, it } from "bun:test";
import { normalizeToolName, normalizeToolNames } from "@veyyon/coding-agent/tools/builtin-names";

/**
 * normalizeToolName / normalizeToolNames lowercase user- or config-supplied tool names,
 * translate every retired workspace-search identity at configuration and SDK boundaries,
 * and deduplicate the resulting canonical names. Translation keeps persisted agent fields
 * and caller allowlists usable without registering legacy names as model-facing tools.
 */

describe("normalizeToolName", () => {
	it("keeps canonical builtin names stable", () => {
		expect(normalizeToolName("search")).toBe("search");
		expect(normalizeToolName("bash")).toBe("bash");
	});

	it("folds case for canonical names", () => {
		expect(normalizeToolName("SEARCH")).toBe("search");
		expect(normalizeToolName("Bash")).toBe("bash");
	});

	it("translates every retired workspace-search identity to search", () => {
		expect(normalizeToolNames(["glob", "grep", "find", "ast_grep", "search"])).toEqual(["search"]);
	});

	it("lowercases an unknown name and passes it through unchanged otherwise", () => {
		expect(normalizeToolName("MyTool")).toBe("mytool");
	});
});

describe("normalizeToolNames", () => {
	it("normalizes each name and deduplicates while preserving first-seen order", () => {
		expect(normalizeToolNames(["Search", "search", "BASH", "bash", "MyTool"])).toEqual(["search", "bash", "mytool"]);
	});

	it("returns an empty array for no names", () => {
		expect(normalizeToolNames([])).toEqual([]);
	});
});
