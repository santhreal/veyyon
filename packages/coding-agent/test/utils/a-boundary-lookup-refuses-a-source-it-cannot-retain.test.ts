import { describe, expect, it } from "bun:test";
import { generateDiffString } from "@veyyon/coding-agent/edit/diff";
import { exceedsBlockContextScanCeiling, findBlockContextLines } from "@veyyon/coding-agent/utils/block-context";

/**
 * WHY: both backends behind `findBlockContextLines` scan the whole source --
 * tree-sitter parses it, the lexical fallback walks every character -- and the
 * native parse cache retains nothing past 4 MiB. A streamed edit preview asks
 * twice per redraw (the file on disk, then the file the edit would produce), so
 * on an 11.7 MiB source that was ~1.9s of scanning per redraw for at most two
 * boundary rows, and the preview could only redraw as fast as it could parse.
 * The lookup now refuses a source over the ceiling.
 *
 * The class this closes is "an unbounded whole-source scan per redraw", so the
 * suite pins the decision itself: where the ceiling sits, that it is measured
 * in BYTES rather than UTF-16 units, that a caller who kept the source string
 * and a caller who only has the line array get the same answer, and that the
 * predicate the diff consults before allocating its line arrays agrees with the
 * lookup's own refusal. A divergence between those two is how a source would be
 * scanned anyway or refused twice at different sizes.
 *
 * What it does not catch: the early return in `addMatchingBracketContextRows`
 * saves two whole-file `split("\n")` allocations and is invisible in output --
 * only the predicate agreement below constrains it. The ceiling mirrors
 * `MAX_CACHED_BYTES` in `natives/code/ast/src/parse_cache.rs` by policy, not
 * by a shared constant; if the Rust cap moves, this suite still passes.
 */

const CEILING_BYTES = 4 * 1024 * 1024;

/**
 * A source whose first line opens a block and whose last line closes it, padded
 * with comment lines to exactly `bytes` bytes of ASCII. A window on the opener
 * therefore has exactly one off-window boundary row: the closer.
 */
function paddedBlock(bytes: number): { text: string; lines: string[]; closerLine: number } {
	const head = "export function wrapper() {";
	const tail = "}";
	const pad = "  // pad";
	// head + "\n" + N * (pad + "\n") + tail
	const fixedBytes = head.length + 1 + tail.length;
	const padBytes = pad.length + 1;
	const padCount = Math.floor((bytes - fixedBytes) / padBytes);
	const slack = bytes - fixedBytes - padCount * padBytes;
	// Slack rides on the first pad line: the opener and the closer are asserted
	// verbatim, so neither may carry filler.
	const rows = [head, `${pad}${" ".repeat(slack)}`, ...Array.from({ length: padCount - 1 }, () => pad), tail];
	const text = rows.join("\n");
	if (Buffer.byteLength(text) !== bytes)
		throw new Error(`fixture is ${Buffer.byteLength(text)} bytes, wanted ${bytes}`);
	return { text, lines: rows, closerLine: rows.length };
}

describe("a boundary lookup refuses a source it cannot retain", () => {
	it("answers a source of exactly the ceiling", () => {
		const { text, lines, closerLine } = paddedBlock(CEILING_BYTES);

		expect(findBlockContextLines(lines, [1], { path: "wrapper.ts", text })).toEqual(new Map([[closerLine, "}"]]));
		expect(exceedsBlockContextScanCeiling(text)).toBe(false);
	});

	it("refuses a source one byte over the ceiling", () => {
		const { text, lines } = paddedBlock(CEILING_BYTES + 1);

		expect(findBlockContextLines(lines, [1], { path: "wrapper.ts", text }).size).toBe(0);
		expect(exceedsBlockContextScanCeiling(text)).toBe(true);
	});

	it("sizes the source in bytes, not UTF-16 units", () => {
		// Half the ceiling in characters, every one of them two bytes: under the
		// ceiling by `.length`, over it by the bytes a parser would read.
		const half = CEILING_BYTES / 2;
		const text = `// ${"é".repeat(half)}\n{\n}`;
		expect(text.length).toBeLessThan(CEILING_BYTES);
		expect(Buffer.byteLength(text)).toBeGreaterThan(CEILING_BYTES);

		expect(exceedsBlockContextScanCeiling(text)).toBe(true);
		expect(findBlockContextLines(text.split("\n"), [2], { path: "wrapper.ts", text }).size).toBe(0);
	});

	it("refuses a line array over the ceiling when the caller kept no source string", () => {
		const { lines } = paddedBlock(CEILING_BYTES + 1);

		// No `text`: the size has to come from the array, newline separators
		// included, or a file that is over the ceiling only by its line breaks
		// gets scanned anyway.
		expect(findBlockContextLines(lines, [1], { path: "wrapper.ts" }).size).toBe(0);
	});

	it("answers a line array at the ceiling when the caller kept no source string", () => {
		const { lines, closerLine } = paddedBlock(CEILING_BYTES);

		expect(findBlockContextLines(lines, [1], { path: "wrapper.ts" })).toEqual(new Map([[closerLine, "}"]]));
	});

	it("keeps the predicate the diff consults in step with the lookup's refusal", () => {
		// Straddle the ceiling: the diff asks the predicate before allocating
		// two whole-file line arrays, so a predicate that disagrees with the
		// lookup either pays for a scan that returns nothing or drops rows the
		// lookup would have produced.
		for (const bytes of [CEILING_BYTES - 1, CEILING_BYTES, CEILING_BYTES + 1, CEILING_BYTES + 4096]) {
			const { text, lines } = paddedBlock(bytes);
			const refused = findBlockContextLines(lines, [1], { path: "wrapper.ts", text }).size === 0;
			expect(exceedsBlockContextScanCeiling(text)).toBe(refused);
		}
	});

	it("still diffs a pair over the ceiling, without boundary rows", () => {
		const { text, closerLine } = paddedBlock(CEILING_BYTES + 1);
		const edited = text.replace("export function wrapper() {", "export function wrapper(arg: number) {");

		const over = generateDiffString(text, edited, undefined, { path: "wrapper.ts" });
		expect(over.firstChangedLine).toBe(1);
		expect(over.diff.split("\n").slice(0, 2)).toEqual([
			"-1|export function wrapper() {",
			"+1|export function wrapper(arg: number) {",
		]);
		expect(over.diff).not.toContain(`${closerLine}|}`);
	});

	it("keeps boundary rows in a diff of a pair under the ceiling", () => {
		const { text, closerLine } = paddedBlock(1024);
		const edited = text.replace("export function wrapper() {", "export function wrapper(arg: number) {");

		const under = generateDiffString(text, edited, undefined, { path: "wrapper.ts" });
		expect(under.diff).toContain(`${closerLine}|}`);
	});
});
