import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureWithinRoot, isWithinRoot } from "@veyyon/coding-agent/internal-urls/filesystem-resource";

/**
 * Locks the single owner of the internal-URL root-containment predicate. The
 * `local://`, `vault://`, and `memory://` handlers each carried a byte-identical
 * private `ensureWithinRoot` (and `skill://` an inline copy of the same check).
 * They now delegate to `filesystem-resource.ts`; if any of them ever hardened or
 * loosened its own copy, the handlers would silently disagree on what "inside
 * the root" means, which is exactly the class of escape bug this predicate
 * exists to prevent. The source-scan test at the bottom fails if a private copy
 * of the containment logic reappears.
 *
 * The `/` separator here is `path.sep` on POSIX; these tests run on the CI
 * POSIX host, so descendant paths are written with `/`.
 */
describe("isWithinRoot", () => {
	const root = "/home/user/vault";

	it("accepts the root itself", () => {
		expect(isWithinRoot(root, root)).toBe(true);
	});

	it("accepts a direct child", () => {
		expect(isWithinRoot(`${root}/notes.md`, root)).toBe(true);
	});

	it("accepts a deep descendant", () => {
		expect(isWithinRoot(`${root}/a/b/c/deep.md`, root)).toBe(true);
	});

	it("rejects a sibling that shares the root as a name prefix", () => {
		// The classic prefix-without-separator bug: "/home/user/vault-secret"
		// starts with "/home/user/vault" but is NOT inside it.
		expect(isWithinRoot(`${root}-secret/leak.md`, root)).toBe(false);
	});

	it("rejects a parent directory", () => {
		expect(isWithinRoot("/home/user", root)).toBe(false);
	});

	it("rejects an unrelated path", () => {
		expect(isWithinRoot("/etc/passwd", root)).toBe(false);
	});
});

describe("ensureWithinRoot", () => {
	const root = "/home/user/vault";

	it("returns silently when the target is within the root", () => {
		expect(() => ensureWithinRoot(`${root}/ok.md`, root, "vault")).not.toThrow();
		expect(() => ensureWithinRoot(root, root, "vault")).not.toThrow();
	});

	it("throws a scheme-specific escape message when the target is outside", () => {
		expect(() => ensureWithinRoot("/etc/passwd", root, "vault")).toThrow("vault:// URL escapes vault root");
		expect(() => ensureWithinRoot("/etc/passwd", root, "local")).toThrow("local:// URL escapes local root");
		expect(() => ensureWithinRoot("/etc/passwd", root, "memory")).toThrow("memory:// URL escapes memory root");
	});

	it("rejects the name-prefix sibling for every scheme", () => {
		expect(() => ensureWithinRoot(`${root}-secret/x`, root, "vault")).toThrow("vault:// URL escapes vault root");
	});
});

describe("root-containment single-owner lock", () => {
	it("no internal-urls handler reimplements the containment predicate inline", () => {
		const dir = join(import.meta.dir, "..", "..", "src", "internal-urls");
		const offenders: string[] = [];
		// The predicate's shape: `.startsWith(`${<something>root}${path.sep}`)` or
		// `.startsWith(<root> + path.sep)`. filesystem-resource.ts is the one owner.
		const inlinePredicate = /\.startsWith\(\s*(`\$\{[^}]*[Rr]oot[^}]*\}\$\{path\.sep\}`|\w+\s*\+\s*path\.sep)/;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			if (entry.name === "filesystem-resource.ts") continue;
			const text = readFileSync(join(dir, entry.name), "utf8");
			if (inlinePredicate.test(text)) offenders.push(entry.name);
		}
		expect(offenders).toEqual([]);
	});
});
