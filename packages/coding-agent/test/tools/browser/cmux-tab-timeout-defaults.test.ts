import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Single-owner lock for the cmux-tab per-operation timeout default.
 *
 * Every tab operation (click, screenshot, waitForSelector, evaluate, ...) needs
 * a fallback deadline when no active browser run context supplies one. That
 * value was inlined as the bare literal `30_000` in 12 separate places across
 * cmux-tab.ts (twice on the two lines that also cap with `Math.min`). Twelve
 * byte-identical copies of one magic number drift: a future edit that changes
 * the default in one operation but not the others silently gives different
 * operations different deadlines, which is invisible until an operation hangs
 * or aborts differently from its siblings.
 *
 * The literal now lives in exactly one place, `DEFAULT_OP_TIMEOUT_MS`, and
 * every operation references it. This lock reads the source and fails if a bare
 * `?? 30_000` (or a second `30_000` literal beyond the single const definition)
 * reappears, which is exactly how the duplication would creep back.
 */
describe("cmux-tab per-operation timeout default single-owner", () => {
	const src = readFileSync(path.resolve(import.meta.dir, "../../../src/tools/browser/cmux/cmux-tab.ts"), "utf8");

	it("defines the default exactly once as a named constant", () => {
		const constDefs = src.match(/const DEFAULT_OP_TIMEOUT_MS = 30_000;/g) ?? [];
		expect(constDefs).toHaveLength(1);
	});

	it("contains no inlined 30_000 timeout literal outside that one definition", () => {
		// Strip the single const definition line, then assert no other 30_000
		// literal survives anywhere in the file.
		const withoutDef = src.replace(/const DEFAULT_OP_TIMEOUT_MS = 30_000;/, "");
		expect(withoutDef).not.toContain("30_000");
		expect(withoutDef).not.toMatch(/\?\?\s*30_?000/);
	});

	it("routes operation timeouts through the named constant", () => {
		// The fallback idiom every operation uses must reference the owner.
		expect(src).toContain("?? DEFAULT_OP_TIMEOUT_MS");
		// The two capped operations still cap against the same owner.
		expect(src).toContain("Math.min(this.#runContext?.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS, DEFAULT_OP_TIMEOUT_MS)");
	});
});
