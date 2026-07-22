/**
 * buildCompactDiffPreview default options match explicit maxAddedRunContext: 2.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview default options", () => {
	it("default equals maxAddedRunContext 2", () => {
		const diff = Array.from({ length: 9 }, (_, i) => `+${i + 1}|L${i}`).join("\n");
		const a = buildCompactDiffPreview(diff);
		const b = buildCompactDiffPreview(diff, { maxAddedRunContext: 2 });
		expect(a).toEqual(b);
	});

	it("default collapses 7-line add run", () => {
		const diff = Array.from({ length: 7 }, (_, i) => `+${i + 1}|x${i}`).join("\n");
		const p = buildCompactDiffPreview(diff);
		expect(p.preview).toContain("…");
		expect(p.addedLines).toBe(7);
	});

	it("empty string options object equals no options", () => {
		const diff = " 1|a\n+2|b";
		expect(buildCompactDiffPreview(diff, {})).toEqual(buildCompactDiffPreview(diff));
	});
});
