import { describe, expect, it } from "bun:test";
import { splitTextLines } from "../src/lines";

// `splitTextLines` is the ONE owner for "lines of a text, ignoring the trailing
// newline". typescript-edit-benchmark and metaharness both re-point here; these
// lock the exact semantics both diff-body consumers depend on.
describe("splitTextLines", () => {
	it("splits on newlines", () => {
		expect(splitTextLines("a\nb\nc")).toEqual(["a", "b", "c"]);
	});

	it("ignores a single trailing newline (it is not its own line)", () => {
		expect(splitTextLines("a\nb\n")).toEqual(["a", "b"]);
	});

	it("preserves interior blank lines", () => {
		expect(splitTextLines("a\n\nb")).toEqual(["a", "", "b"]);
	});

	it("keeps a blank line before a trailing newline, dropping only the last empty", () => {
		// "a\n\n".split("\n") === ["a", "", ""]; only the final empty is dropped.
		expect(splitTextLines("a\n\n")).toEqual(["a", ""]);
	});

	it("returns an empty array for empty input (the sole empty is a trailing-only line)", () => {
		expect(splitTextLines("")).toEqual([]);
	});

	it("returns the whole string when there is no newline", () => {
		expect(splitTextLines("solo")).toEqual(["solo"]);
	});
});
