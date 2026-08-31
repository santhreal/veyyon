import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview", () => {
	it("returns empty preview for empty diff", () => {
		const result = buildCompactDiffPreview("");
		expect(result.preview).toBe("");
		expect(result.addedLines).toBe(0);
		expect(result.removedLines).toBe(0);
	});
	it("counts added lines", () => {
		const diff = "+1|new line 1\n+2|new line 2";
		const result = buildCompactDiffPreview(diff);
		expect(result.addedLines).toBe(2);
		expect(result.removedLines).toBe(0);
	});
	it("counts removed lines", () => {
		const diff = "-1|old line 1\n-2|old line 2";
		const result = buildCompactDiffPreview(diff);
		expect(result.addedLines).toBe(0);
		expect(result.removedLines).toBe(2);
	});
	it("handles mixed added and removed lines", () => {
		const diff = "-1|old line\n+1|new line";
		const result = buildCompactDiffPreview(diff);
		expect(result.addedLines).toBe(1);
		expect(result.removedLines).toBe(1);
	});
	it("handles context lines", () => {
		const diff = " 1|context\n+2|added\n 3|context";
		const result = buildCompactDiffPreview(diff);
		expect(result.addedLines).toBe(1);
		expect(result.removedLines).toBe(0);
		expect(result.preview).toContain("1:context");
		expect(result.preview).toContain("2:added");
	});
	it("renumbers context lines after additions", () => {
		const diff = " 1|context\n+2|added\n 2|context";
		const result = buildCompactDiffPreview(diff);
		expect(result.preview).toContain("3:context");
	});
	it("renumbers context lines after removals", () => {
		const diff = "-1|removed\n 2|context";
		const result = buildCompactDiffPreview(diff);
		expect(result.preview).toContain("1:context");
	});
	it("passes through non-diff lines", () => {
		const diff = "some header\n+1|added";
		const result = buildCompactDiffPreview(diff);
		expect(result.preview).toContain("some header");
		expect(result.addedLines).toBe(1);
	});
	it("collapses long added runs with elision marker", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `+${i + 1}|line ${i + 1}`);
		const result = buildCompactDiffPreview(lines.join("\n"), { maxAddedRunContext: 2 });
		expect(result.preview).toContain("…");
		expect(result.addedLines).toBe(20);
	});
	it("does not collapse short added runs", () => {
		const lines = Array.from({ length: 5 }, (_, i) => `+${i + 1}|line ${i + 1}`);
		const result = buildCompactDiffPreview(lines.join("\n"), { maxAddedRunContext: 2 });
		expect(result.preview).not.toContain("…");
	});
	it("uses maxUnchangedRun as fallback for context", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `+${i + 1}|line ${i + 1}`);
		const result1 = buildCompactDiffPreview(lines.join("\n"), { maxUnchangedRun: 3 });
		const result2 = buildCompactDiffPreview(lines.join("\n"), { maxAddedRunContext: 3 });
		expect(result1.preview).toBe(result2.preview);
	});
	it("trims trailing separator lines", () => {
		const diff = "+1|added\n ";
		const result = buildCompactDiffPreview(diff);
		expect(result.preview).not.toMatch(/\n$/);
	});
	it("handles single added line", () => {
		const result = buildCompactDiffPreview("+1|single");
		expect(result.addedLines).toBe(1);
		expect(result.preview).toContain("1:single");
	});
	it("handles single removed line", () => {
		const result = buildCompactDiffPreview("-1|single");
		expect(result.removedLines).toBe(1);
	});
	it("handles single context line", () => {
		const result = buildCompactDiffPreview(" 1|context");
		expect(result.addedLines).toBe(0);
		expect(result.removedLines).toBe(0);
		expect(result.preview).toContain("1:context");
	});
	it("normalizes raw elision markers in input", () => {
		const diff = "+1|line 1\n...\n+3|line 3";
		const result = buildCompactDiffPreview(diff);
		expect(result.preview).toContain("…");
	});
	it("does not produce consecutive separator lines", () => {
		const diff = "+1|line 1\n\n\n+2|line 2";
		const result = buildCompactDiffPreview(diff);
		const lines = result.preview.split("\n");
		for (let i = 1; i < lines.length; i++) {
			const prev = lines[i - 1];
			const curr = lines[i];
			const bothEmpty = prev === "" && curr === "";
			const bothElision = prev === "…" && curr === "…";
			expect(bothEmpty).toBe(false);
			expect(bothElision).toBe(false);
		}
	});
});
