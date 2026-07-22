import { describe, expect, it } from "bun:test";
import { generateUnifiedDiffString } from "@veyyon/coding-agent/edit/diff";

/**
 * generateUnifiedDiffString renders the numbered unified diff the edit tool shows the model and the
 * user: `@@` hunk headers plus `<prefix><lineNum>|<content>` rows, and it reports the first changed
 * line so callers can scroll a preview to the edit. It had no direct test. The contracts pinned here
 * are the ones a rendering regression would most quietly break:
 *   - identical inputs produce an empty diff and an undefined firstChangedLine (nothing changed);
 *   - a replacement emits the `-` (old line number) and `+` (new line number) rows around unchanged
 *     ` ` context rows, and firstChangedLine is reported in NEW-file coordinates;
 *   - a pure addition/deletion numbers its rows correctly and points firstChangedLine at the edit;
 *   - the context window governs hunk splitting: a small context makes two distant edits render as two
 *     separate hunks rather than one giant merged block.
 * The default source ({}) is used so the bracket-context enrichment stays inert and these tests pin
 * the base unified-diff shape alone.
 */
describe("generateUnifiedDiffString", () => {
	it("returns an empty diff and undefined firstChangedLine when nothing changed", () => {
		const result = generateUnifiedDiffString("a\nb\n", "a\nb\n", 3);
		expect(result.diff).toBe("");
		expect(result.firstChangedLine).toBeUndefined();
	});

	it("emits numbered -/+ rows around context and reports firstChangedLine in new-file coordinates", () => {
		const result = generateUnifiedDiffString("a\nb\nc\n", "a\nB\nc\n", 1);
		expect(result.firstChangedLine).toBe(2);
		expect(result.diff).toBe(["@@ -1,3 +1,3 @@", " 1|a", "-2|b", "+2|B", " 3|c"].join("\n"));
	});

	it("numbers a pure appended line and points firstChangedLine at it", () => {
		const result = generateUnifiedDiffString("a\nb\n", "a\nb\nc\n", 3);
		expect(result.firstChangedLine).toBe(3);
		expect(result.diff).toBe(["@@ -1,2 +1,3 @@", " 1|a", " 2|b", "+3|c"].join("\n"));
	});

	it("numbers a pure deleted line by its old line number and reports its new-file position", () => {
		const result = generateUnifiedDiffString("a\nb\nc\n", "a\nc\n", 3);
		expect(result.firstChangedLine).toBe(2);
		expect(result.diff).toBe(["@@ -1,3 +1,2 @@", " 1|a", "-2|b", " 3|c"].join("\n"));
	});

	it("splits two distant edits into two hunks when the context window is small", () => {
		const oldContent = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
		const newContent = "1\nX\n3\n4\n5\n6\n7\nY\n9\n";
		const result = generateUnifiedDiffString(oldContent, newContent, 1);
		expect(result.firstChangedLine).toBe(2);
		expect(result.diff).toBe(
			["@@ -1,3 +1,3 @@", " 1|1", "-2|2", "+2|X", " 3|3", "@@ -7,3 +7,3 @@", " 7|7", "-8|8", "+8|Y", " 9|9"].join(
				"\n",
			),
		);
	});
});
