import { describe, expect, it } from "bun:test";
import { normalizeToolName, normalizeToolNames } from "@veyyon/coding-agent/tools/builtin-names";

/**
 * normalizeToolName / normalizeToolNames map a user- or config-supplied tool name onto its canonical
 * builtin name: lowercase, then apply the legacy find -> glob alias so an old config or request still
 * resolves to the tool that replaced it. They had no direct test. A regression that skipped the alias
 * step would leave a legacy name unresolved (the tool silently disappears from an allowlist); one that
 * broke case folding would fail to match "Grep"/"BASH". The plural form additionally deduplicates by
 * canonical name while preserving first-seen order.
 */

describe("normalizeToolName", () => {
	it("rewrites the legacy alias while preserving canonical names", () => {
		expect(normalizeToolName("search")).toBe("search");
		expect(normalizeToolName("find")).toBe("glob");
	});

	it("folds case before looking up the alias or returning the name", () => {
		expect(normalizeToolName("SEARCH")).toBe("search");
		expect(normalizeToolName("Find")).toBe("glob");
		expect(normalizeToolName("Grep")).toBe("grep");
	});

	it("lowercases an unknown name and passes it through unchanged otherwise", () => {
		expect(normalizeToolName("MyTool")).toBe("mytool");
	});
});

describe("normalizeToolNames", () => {
	it("normalizes each name and deduplicates by canonical name, preserving first-seen order", () => {
		expect(normalizeToolNames(["search", "grep", "Find", "glob", "BASH", "bash"])).toEqual([
			"search",
			"grep",
			"glob",
			"bash",
		]);
	});

	it("returns an empty array for no names", () => {
		expect(normalizeToolNames([])).toEqual([]);
	});
});
