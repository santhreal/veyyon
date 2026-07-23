import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "../src/dirs";
import { scanShippedSourceLines } from "./support/scan-shipped-source";

/**
 * The working directory has exactly one owner: `setProjectDir`, which moves the
 * process and the `projectDir` global together.
 *
 * Anything that calls `process.chdir` directly moves only half of that pair. The
 * two then disagree for the rest of the process's life, and every lookup built
 * on `getProjectDir` (project settings, AGENTS.md discovery, git detection,
 * relative paths in file tools) resolves against a directory the user never
 * chose. The failure is silent and arrives long after the call that caused it.
 */
describe("setProjectDir as the single owner of the working directory", () => {
	test("moves the process and getProjectDir together", () => {
		const before = getProjectDir();
		try {
			setProjectDir(path.dirname(before));

			expect(getProjectDir()).toBe(path.resolve(path.dirname(before)));
			expect(path.resolve(process.cwd())).toBe(getProjectDir());
		} finally {
			setProjectDir(before);
		}
	});

	test("resolves a relative directory rather than storing it as given", () => {
		const before = getProjectDir();
		try {
			setProjectDir(".");

			expect(path.isAbsolute(getProjectDir())).toBe(true);
			expect(getProjectDir()).toBe(path.resolve(before));
		} finally {
			setProjectDir(before);
		}
	});

	test("throws on a directory that does not exist instead of recording it", () => {
		// Failing closed is the point. Recording an unusable directory and carrying
		// on would leave getProjectDir naming a path the process cannot reach, which
		// is the desynchronized state this whole suite exists to prevent.
		const before = getProjectDir();

		expect(() => setProjectDir(path.join(before, "definitely-not-a-real-directory-xyzzy"))).toThrow();

		expect(getProjectDir()).toBe(before);
		expect(path.resolve(process.cwd())).toBe(before);
	});
});

describe("single-owner lock", () => {
	test("no shipped source file calls process.chdir outside the owner", () => {
		// REGRESSION: `loadPuppeteer` and the dev launcher shim both chdir'd around
		// the process behind `projectDir`'s back. If a new one appears, this fails
		// and names the file so it can be re-pointed at setProjectDir.
		//
		// Anchored at the repo root, not cwd: a cwd-relative scan finds nothing when
		// the suite runs from inside a package and would pass without checking. The
		// scan is a self-contained file walk (no external `rg`, which is absent on
		// GitHub-hosted runners and used to throw here, red-lining the release gate).
		const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
		const hits = scanShippedSourceLines(repoRoot, /process\.chdir\(/)
			// The owner itself.
			.filter(line => !line.includes("packages/utils/src/dirs.ts"))
			// The JS eval sandbox hands `chdir` to code running in a separate process,
			// where the working directory is that process's own and there is no
			// `projectDir` to keep in step with it.
			.filter(line => !line.includes("packages/coding-agent/src/eval/js/process-entry.ts"))
			// Comments explaining why chdir is not used.
			.filter(line => !/^\S+:\d+:\s*(\*|\/\/)/.test(line));

		expect(hits).toEqual([]);
	});
});
