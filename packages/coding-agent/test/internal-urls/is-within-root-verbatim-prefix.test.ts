/**
 * isWithinRoot is the single containment predicate for local://, vault://,
 * memory://, and skill://. It compares strings, not resolved paths: callers
 * must path.resolve / realpath first (filesystem-resource.ts says so).
 *
 * Two properties still have to hold on the verbatim strings they pass in,
 * because a missed resolve is exactly how a handler leaks:
 *
 * 1. A sibling whose name only shares a prefix (`/vault` vs `/vault-extra`)
 *    is outside. startsWith(root + sep) is the whole defense; if anyone ever
 *    "simplifies" it to startsWith(root), every scheme starts leaking.
 * 2. A root that still carries a trailing separator is the same root.
 *    path.resolve usually strips it; realpath on a symlink-to-dir sometimes
 *    does not, and a listing URL that the operator typed with a trailing
 *    slash can be forwarded as-is. `/vault/` + `/vault/note.md` must be
 *    inside. Today `root${sep}` becomes `/vault//` and the file
 *    fails the prefix check, so a legal descendant is reported as an escape.
 *
 * Unresolved `..` is deliberately NOT treated as a containment check here:
 * the documented contract is "compare verbatim". Handlers that skip resolve
 * are tested at those handlers (see relative-path-only-real-escapes and
 * vault decode). This file only pins the predicate.
 */
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { ensureWithinRoot, isWithinRoot } from "@veyyon/coding-agent/internal-urls/filesystem-resource";

describe("a sibling that shares a prefix is outside", () => {
	it("does not treat /vault-extra as inside /vault", () => {
		expect(isWithinRoot(`/vault-extra/note.md`, "/vault")).toBe(false);
		expect(isWithinRoot("/vault", "/vault")).toBe(true);
		expect(isWithinRoot(`/vault${path.sep}note.md`, "/vault")).toBe(true);
	});
});

describe("a trailing separator on the root is still the same root", () => {
	it("contains a descendant of /vault/ the same way it contains a descendant of /vault", () => {
		expect(isWithinRoot(`/vault${path.sep}note.md`, `/vault${path.sep}`)).toBe(true);
		expect(() => ensureWithinRoot(`/vault${path.sep}note.md`, `/vault${path.sep}`, "vault")).not.toThrow();
	});
});

describe("scheme is only a label in the error", () => {
	it("names the scheme the caller passed, not a hardcoded vault://", () => {
		expect(() => ensureWithinRoot("/etc/passwd", "/vault", "skill")).toThrow(
			"skill:// URL escapes skill root",
		);
	});
});
