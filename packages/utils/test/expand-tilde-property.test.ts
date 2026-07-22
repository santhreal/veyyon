import { describe, expect, it } from "bun:test";
import { expandTilde } from "@veyyon/utils/path";

/**
 * expandTilde property-style over many path shapes with a fixed home.
 */

describe("expandTilde property-style", () => {
	const home = "/home/fixture";

	it("never leaves a leading ~ for ~/… forms", () => {
		const samples = ["~/a", "~/a/b", "~/.", "~/..", "~/x y", "~/日本語"];
		for (const s of samples) {
			const out = expandTilde(s, home);
			expect(out.startsWith("~")).toBe(false);
			expect(out.startsWith(home)).toBe(true);
		}
	});

	it("absolute and relative non-tilde paths are identity", () => {
		const samples = ["/abs", "/abs/x", "rel", "rel/x", ".", "..", ""];
		for (const s of samples) {
			expect(expandTilde(s, home)).toBe(s);
		}
	});

	it("bare ~ is exactly home", () => {
		expect(expandTilde("~", home)).toBe(home);
	});

	it("home with trailing content concatenates correctly for ~/z", () => {
		expect(expandTilde("~/z", home)).toBe(`${home}/z`);
		expect(expandTilde("~/z/w", home)).toBe(`${home}/z/w`);
	});
});
