import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";

describe("collapseWhitespace", () => {
	it("collapses runs of mixed whitespace to single spaces and trims the ends", () => {
		expect(collapseWhitespace("  hello   world  ")).toBe("hello world");
		expect(collapseWhitespace("a\t\tb\n\nc")).toBe("a b c");
		expect(collapseWhitespace("line one\r\n  line two")).toBe("line one line two");
	});

	it("returns an empty string for null, undefined, empty, and all-whitespace input", () => {
		expect(collapseWhitespace(null)).toBe("");
		expect(collapseWhitespace(undefined)).toBe("");
		expect(collapseWhitespace("")).toBe("");
		expect(collapseWhitespace("   \t\n  ")).toBe("");
	});

	it("leaves already-normalized text unchanged", () => {
		expect(collapseWhitespace("clean single spaced text")).toBe("clean single spaced text");
	});

	it("is exported from the package barrel as well as the subpath", async () => {
		const barrel = await import("@veyyon/utils");
		expect(barrel.collapseWhitespace).toBe(collapseWhitespace);
	});
});

/**
 * ONE-PLACE source lock (H1-8d): the collapse idiom
 * `replace(/\s+/g, " ").trim()` has exactly one production owner,
 * collapse-whitespace.ts. Inline copies drifted across five modes/ files
 * before the extraction; this scan fails if any production source outside the
 * owner re-inlines it, so the copy-drift class of bug cannot return.
 */
describe("collapse-whitespace source lock", () => {
	const IDIOM = 'replace(/\\s+/g, " ").trim()';
	const PACKAGES_DIR = path.join(import.meta.dir, "../..");

	async function walk(dir: string, out: string[]): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
				await walk(full, out);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
				out.push(full);
			}
		}
	}

	it("no production source re-inlines the collapse idiom outside the owner", async () => {
		const offenders: string[] = [];
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			const files: string[] = [];
			try {
				await walk(path.join(PACKAGES_DIR, pkg.name, "src"), files);
			} catch {
				// Package without a src directory (assets-only) — nothing to scan.
			}
			for (const file of files) {
				const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
				if (rel === "utils/src/collapse-whitespace.ts") continue;
				if ((await readFile(file, "utf8")).includes(IDIOM)) offenders.push(rel);
			}
		}
		expect(offenders, "inline collapse idiom — import collapseWhitespace from @veyyon/utils").toEqual([]);
	});
});
