import { describe, expect, it } from "bun:test";
import { normalizeToolName, normalizeToolNames } from "@veyyon/coding-agent/tools/builtin-names";

/**
 * normalizeToolName / normalizeToolNames lowercase user- or config-supplied tool names and
 * deduplicate them without aliases. A retired tool identity must stay retired rather than
 * silently resolving to a different public contract; persisted-config migration is the one
 * boundary that rewrites old IDs.
 */

describe("normalizeToolName", () => {
	it("keeps canonical builtin names stable", () => {
		expect(normalizeToolName("search")).toBe("search");
		expect(normalizeToolName("bash")).toBe("bash");
	});

	it("folds case without applying aliases", () => {
		expect(normalizeToolName("SEARCH")).toBe("search");
		expect(normalizeToolName("Bash")).toBe("bash");
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
