import { describe, expect, it } from "bun:test";
import {
	renderCodeBlock,
	renderDescriptionSection,
	renderHeader,
	renderKeyValues,
	renderReadme,
	renderSimpleList,
	renderStringList,
} from "@veyyon/web/scrapers/engine/markdown-assembly";

/**
 * The scraper declarations assemble their markdown from these fragments, so an
 * empty input yields an empty fragment (no orphan heading), a counted list carries
 * its length in the heading, a limit caps the rendered items, a key-value row
 * drops nullish and empty values but keeps `0` and `false`, and a code block is
 * trimmed and fenced with the requested language.
 */
describe("markdown assembly", () => {
	it("omits a section for an absent or empty input", () => {
		expect(renderStringList("Tags", [])).toBe("");
		expect(renderStringList("Tags", null)).toBe("");
		expect(renderSimpleList("Items", undefined, String)).toBe("");
		expect(renderDescriptionSection("")).toBe("");
		expect(renderReadme(null)).toBe("");
		expect(renderCodeBlock("   \n")).toBe("");
		expect(
			renderKeyValues([
				["Version", undefined],
				["Name", ""],
			]),
		).toBe("");
	});

	it("renders a header with an optional description paragraph", () => {
		expect(renderHeader("pkg")).toBe("# pkg\n\n");
		expect(renderHeader("pkg", "A package")).toBe("# pkg\n\nA package\n\n");
	});

	it("counts a list in its heading only when asked and caps a simple list at its limit", () => {
		expect(renderStringList("Tags", ["a", "b"])).toBe("\n## Tags\n\n- a\n- b\n");
		expect(renderStringList("Tags", ["a", "b"], true)).toBe("\n## Tags (2)\n\n- a\n- b\n");
		expect(renderSimpleList("Versions", [3, 2, 1], v => `v${v}`, 2)).toBe("\n## Versions\n\n- v3\n- v2\n");
		expect(renderSimpleList("Versions", [3], v => `v${v}`, 2)).toBe("\n## Versions\n\n- v3\n");
	});

	it("keeps falsy-but-present values in a key-value block", () => {
		expect(
			renderKeyValues([
				["Downloads", 0],
				["Deprecated", false],
				["License", null],
				["Name", "x"],
			]),
		).toBe("**Downloads:** 0\n**Deprecated:** false\n**Name:** x\n");
	});

	it("fences a trimmed code block, as a section when titled", () => {
		expect(renderCodeBlock("  npm i x \n")).toBe("```bash\nnpm i x\n```\n\n");
		expect(renderCodeBlock("print(1)", "python", "Usage")).toBe("\n## Usage\n\n```python\nprint(1)\n```\n");
		expect(renderDescriptionSection("Body", "About")).toBe("\n## About\n\nBody\n");
		expect(renderReadme("Read me")).toBe("\n---\n\n## README\n\nRead me\n");
	});
});
