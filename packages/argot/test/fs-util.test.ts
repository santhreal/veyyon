/**
 * Locks `isNotFound`, the ENOENT classifier in src/fs-util.ts. This predicate is
 * load-bearing for the no-silent-fallback rule: both call sites (load.ts,
 * cache.ts) use it as `catch (err) { if (isNotFound(err)) return empty; throw err }`.
 * So it is the exact boundary that decides "the dict file is absent, treat it as
 * empty" (allowed) versus "a real IO error happened, surface it" (required). If
 * this ever returned true for a non-ENOENT error — a permission denial (EACCES),
 * a path that is a directory (EISDIR) — that real failure would be silently
 * swallowed and the caller would see an empty vocabulary instead of an error,
 * exactly the silent degrade the codec must never do. These tests assert the
 * classification for every shape, including errors produced by the real
 * filesystem, so a regression that widens or narrows it goes red here.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNotFound } from "../src/fs-util.js";

describe("isNotFound — ENOENT classification", () => {
	it("is true for an object carrying code ENOENT (a missing file)", () => {
		expect(isNotFound({ code: "ENOENT" })).toBe(true);
	});

	it("is true for a real Error decorated with code ENOENT", () => {
		const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
		expect(isNotFound(err)).toBe(true);
	});

	it("is false for other filesystem error codes that MUST surface, not be swallowed", () => {
		// Each of these is a real failure the caller has to see; misclassifying any
		// as "not found" would silently substitute an empty dict for a hard error.
		for (const code of ["EACCES", "EISDIR", "EPERM", "ENOTDIR", "EMFILE", "ELOOP"]) {
			expect(isNotFound({ code })).toBe(false);
		}
	});

	it("is false when there is no code property at all", () => {
		expect(isNotFound(new Error("plain error, no code"))).toBe(false);
		expect(isNotFound({ message: "shaped like an error but no code" })).toBe(false);
	});

	it("is false for a code that is present but not the ENOENT string", () => {
		expect(isNotFound({ code: 2 })).toBe(false); // numeric errno, not the string
		expect(isNotFound({ code: "enoent" })).toBe(false); // case-sensitive
		expect(isNotFound({ code: null })).toBe(false);
	});

	it("is false for non-object throwables (strings, numbers, null, undefined)", () => {
		expect(isNotFound("ENOENT")).toBe(false);
		expect(isNotFound(2)).toBe(false);
		expect(isNotFound(null)).toBe(false);
		expect(isNotFound(undefined)).toBe(false);
	});

	it("classifies a genuine ENOENT thrown by the real filesystem as not-found", async () => {
		let caught: unknown;
		try {
			await readFile(join(tmpdir(), "argot-fs-util-definitely-missing-file-xyz"), "utf8");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect(isNotFound(caught)).toBe(true);
	});

	it("does NOT classify a real EISDIR (reading a directory) as not-found", async () => {
		// The directory exists, so this is not ENOENT: reading it fails with EISDIR,
		// and the caller must rethrow rather than pretend the dict is empty.
		const dir = await mkdtemp(join(tmpdir(), "argot-fs-util-"));
		let caught: unknown;
		try {
			await readFile(dir, "utf8");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect(isNotFound(caught)).toBe(false);
	});
});
