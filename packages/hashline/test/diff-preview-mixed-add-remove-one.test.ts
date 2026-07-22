/**
 * Classic replace one line: remove 1 add 1 renumbers tail by 0.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview one-for-one replace", () => {
	it("mid replace", () => {
		const diff = [" 1|a", "-2|old", "+2|new", " 3|c"].join("\n");
		const p = buildCompactDiffPreview(diff);
		expect(p.addedLines).toBe(1);
		expect(p.removedLines).toBe(1);
		expect(p.preview.split("\n")).toEqual(["1:a", "2:new", "3:c"]);
	});

	it("first line replace", () => {
		const diff = ["-1|old", "+1|new", " 2|b"].join("\n");
		const p = buildCompactDiffPreview(diff);
		expect(p.preview.split("\n")).toEqual(["1:new", "2:b"]);
	});

	it("last line replace", () => {
		const diff = [" 1|a", "-2|old", "+2|new"].join("\n");
		const p = buildCompactDiffPreview(diff);
		expect(p.preview.split("\n")).toEqual(["1:a", "2:new"]);
	});
});
