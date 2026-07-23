import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { escapeRegExp } from "../src/regex";
import { collectPackageSourceFiles, PACKAGES_DIR } from "./support/package-sources";

// Repo-wide source lock: escapeRegExp has exactly ONE owner,
// packages/utils/src/regex.ts. Hand-rolled local copies drift (two character-
// class orderings already existed when this lock landed) — import the owner.
//
// GRANDFATHERED lists the sites that still carry a local copy. Convert a file,
// remove its entry — a stale entry fails the lock so the list can only shrink.
const GRANDFATHERED = new Set<string>([
	// Empty: every hand-rolled copy now imports escapeRegExp from @veyyon/utils.
]);

// Matches any hand-rolled regex-escaper: escapeRegExp / escapeRegex /
// escapeRegexLiteral (and future variants). Anchored on "escapeReg" + word
// chars — the earlier form ("escapeRege…") silently missed the capital-E
// "escapeRegExp" spelling, letting a third copy slip through the lock.
const LOCAL_DEF = /function\s+escapeReg\w*\s*\(/;

// The monorepo walk + skip-set is shared with every other source-ownership lock
// (see ./support/package-sources). Production scans src only; the test check
// scans test too, because a hand-rolled copy in a test helper is still a second
// definition that drifts, and the src-only scan never saw it (that is exactly
// how one slipped in).
function sourceFiles(): Promise<string[]> {
	return collectPackageSourceFiles({ dirs: ["src"] });
}

function testFiles(): Promise<string[]> {
	return collectPackageSourceFiles({ dirs: ["test"], includeTests: true });
}

describe("escapeRegExp source lock", () => {
	it("escapes every regex metacharacter and nothing else", () => {
		expect(escapeRegExp("a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o")).toBe(
			"a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o",
		);
		expect(escapeRegExp("plain-text_123")).toBe("plain-text_123");
		expect(new RegExp(`^${escapeRegExp("a.b*c")}$`).test("a.b*c")).toBe(true);
		expect(new RegExp(`^${escapeRegExp("a.b*c")}$`).test("aXbbbc")).toBe(false);
	});

	it("no production source defines a local escapeRegExp outside the grandfathered set", async () => {
		const offenders: string[] = [];
		const cleared: string[] = [];
		const seen = new Set<string>();
		for (const file of await sourceFiles()) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			if (rel === "utils/src/regex.ts") continue;
			const text = await readFile(file, "utf8");
			if (!LOCAL_DEF.test(text)) continue;
			seen.add(rel);
			if (!GRANDFATHERED.has(rel)) offenders.push(rel);
		}
		for (const rel of GRANDFATHERED) {
			if (!seen.has(rel)) cleared.push(rel);
		}
		expect(offenders, "new local escapeRegExp copies — import it from @veyyon/utils instead").toEqual([]);
		expect(cleared, "grandfathered entries whose local copy is gone — remove them from the list").toEqual([]);
	});

	it("no test file defines a local escapeRegExp — tests must dogfood the owner too", async () => {
		const offenders: string[] = [];
		for (const file of await testFiles()) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			if (LOCAL_DEF.test(await readFile(file, "utf8"))) offenders.push(rel);
		}
		expect(offenders, "test-local escapeRegExp copies — import it from @veyyon/utils instead").toEqual([]);
	});
});
