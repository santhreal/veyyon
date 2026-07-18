import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { titleCaseSentence, titleCaseWords } from "../src/string-case";

describe("titleCaseWords", () => {
	it("uppercases the first letter of every word", () => {
		expect(titleCaseWords("phase one cleanup")).toBe("Phase One Cleanup");
		expect(titleCaseWords("already Title Cased")).toBe("Already Title Cased");
	});

	it("collapses runs of whitespace to single spaces", () => {
		expect(titleCaseWords("fix   the\tbug")).toBe("Fix The Bug");
		expect(titleCaseWords("  leading and trailing  ")).toBe("Leading And Trailing");
	});

	it("keeps interior casing of each word intact", () => {
		expect(titleCaseWords("use gpuAccel for iOS")).toBe("Use GpuAccel For IOS");
	});

	it("returns empty string for empty or whitespace-only input", () => {
		expect(titleCaseWords("")).toBe("");
		expect(titleCaseWords("   ")).toBe("");
	});
});

describe("titleCaseSentence", () => {
	it("capitalizes only the first letter and preserves the rest", () => {
		expect(titleCaseSentence("fix the API rate limiter")).toBe("Fix the API rate limiter");
		expect(titleCaseSentence("already Capitalized")).toBe("Already Capitalized");
	});

	it("trims surrounding whitespace", () => {
		expect(titleCaseSentence("  add tests  ")).toBe("Add tests");
	});

	it("returns empty string for empty or whitespace-only input", () => {
		expect(titleCaseSentence("")).toBe("");
		expect(titleCaseSentence("   ")).toBe("");
	});
});

// Repo-wide source lock: titleCaseWords/titleCaseSentence have exactly ONE
// owner, packages/utils/src/string-case.ts. Both known local copies (todo.ts,
// todo-command-controller.ts) were converted when this lock landed, so no
// grandfathered set — any new local definition fails outright.
const PACKAGES_DIR = path.join(import.meta.dir, "../..");

const LOCAL_DEF = /function\s+titleCase(?:Words|Sentence)?\s*\(/;

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

describe("titleCase source lock", () => {
	it("no production source defines a local titleCase variant outside utils/src/string-case.ts", async () => {
		const offenders: string[] = [];
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			const files: string[] = [];
			try {
				await walk(path.join(PACKAGES_DIR, pkg.name, "src"), files);
			} catch {
				// Package without a src/ directory (assets-only) — nothing to scan.
			}
			for (const file of files) {
				const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
				if (rel === "utils/src/string-case.ts") continue;
				if (LOCAL_DEF.test(await readFile(file, "utf8"))) offenders.push(rel);
			}
		}
		expect(offenders, "local titleCase copies — import from @veyyon/utils instead").toEqual([]);
	});
});
