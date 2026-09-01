/**
 * WHY: flattening content blocks to a string has exactly two owners —
 * `contentText` in `@veyyon/utils` for user and custom content, and
 * `assistantText` in `@veyyon/ai` for assistant content. The failure mode is
 * not a wrong result, it is a third owner: a call site writes
 * `.filter(b => b.type === "text").map(...).join(...)` inline, and from then on
 * the separator, the image rendering and the malformed-block handling on that
 * path drift from every other path. That is how the utils owner and the copy
 * this package used to carry ended up disagreeing about a text block whose
 * `text` is not a string.
 *
 * The behavior of the owner is asserted in `packages/utils/test/content-text.test.ts`.
 * This file defends only the structural half: no session source rebuilds the
 * chain. It reads sources, which a behavior test must never do, and is the
 * narrow exception where that is the contract — a re-created owner is invisible
 * at runtime precisely because it returns a plausible answer.
 *
 * Not covered: a hand-rolled flatten written some other way (a `for` loop, a
 * `reduce`), and one written outside `src/session`.
 */

import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

const SESSION_DIR = path.join(import.meta.dir, "..", "src", "session");

// The lazy `[\s\S]` spans the nested parens of a
// `.filter((b): b is TextContent => ...)` guard.
const FLATTEN_CHAIN = /\.filter\([\s\S]{0,90}?\.type === "text"[\s\S]{0,170}?\.join\(/;

describe("the flatten-chain matcher", () => {
	it("catches the chain, with or without a type guard", () => {
		expect(
			FLATTEN_CHAIN.test('c.filter((b): b is TextContent => b.type === "text").map(b => b.text).join(" ")'),
		).toBe(true);
		expect(FLATTEN_CHAIN.test('c.filter(b => b.type === "text").map(b => b.text).join("")')).toBe(true);
	});

	it("does not catch an unrelated filter/map/join", () => {
		expect(FLATTEN_CHAIN.test('items.filter(x => x.active).map(x => x.name).join(", ")')).toBe(false);
	});

	it("does not catch a type comparison with no join", () => {
		expect(FLATTEN_CHAIN.test('c.filter(b => b.type === "text").map(b => b.text)')).toBe(false);
	});
});

describe("session sources", () => {
	it("call an owner instead of rebuilding the chain", async () => {
		const offenders: string[] = [];
		for (const entry of await readdir(SESSION_DIR, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
			const body = await readFile(path.join(SESSION_DIR, entry.name), "utf8");
			if (FLATTEN_CHAIN.test(body)) offenders.push(entry.name);
		}
		// No exemptions: the owner lives in @veyyon/utils, so nothing in this
		// directory has a reason to carry the chain.
		expect(offenders, "content-block flatten — call contentText or assistantText instead").toEqual([]);
	});

	it("scans a directory that is actually there", async () => {
		// A typo in SESSION_DIR would make the sweep above pass over nothing.
		const files = (await readdir(SESSION_DIR)).filter(n => n.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(10);
	});
});
