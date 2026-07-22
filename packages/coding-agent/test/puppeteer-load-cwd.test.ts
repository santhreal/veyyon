import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { loadPuppeteer } from "@veyyon/coding-agent/tools/browser/launch";
import { getProjectDir, getPuppeteerDir } from "@veyyon/utils";

/**
 * `loadPuppeteer` has to point the working directory at a scratch directory
 * while `puppeteer-core` evaluates, because puppeteer probes the cwd during
 * module load and a malformed `package.json` in the user's project makes it
 * throw.
 *
 * It used to do that with `process.chdir`, which moved the entire process. This
 * suite locks in the replacement, which swaps `process.cwd` for the duration of
 * the import instead. The distinction is not cosmetic: `chdir` changes what
 * every other concurrent caller sees, desynchronizes the `projectDir` global in
 * `@veyyon/utils` that nothing puts back, and throws from its own `finally`
 * block when the directory it is restoring has been deleted, stranding the
 * process in the scratch directory permanently.
 */
describe("loadPuppeteer working directory", () => {
	test("leaves the process working directory exactly where it found it", async () => {
		const before = process.cwd();

		await loadPuppeteer();

		expect(process.cwd()).toBe(before);
	});

	test("leaves getProjectDir agreeing with the process working directory", async () => {
		// The real defect a bare chdir causes. `setProjectDir` is the one owner that
		// moves both, so anything that moves only the process leaves the two
		// disagreeing, and every project-relative lookup after that resolves against
		// a directory the user never chose.
		const before = getProjectDir();

		await loadPuppeteer();

		expect(getProjectDir()).toBe(before);
		expect(path.resolve(process.cwd())).toBe(path.resolve(getProjectDir()));
	});

	test("does not leave the process sitting in the puppeteer scratch directory", async () => {
		await loadPuppeteer();

		expect(path.resolve(process.cwd())).not.toBe(path.resolve(getPuppeteerDir()));
	});

	test("returns the same module instance on a second call without touching the cwd again", async () => {
		const first = await loadPuppeteer();
		const before = process.cwd();

		const second = await loadPuppeteer();

		expect(second).toBe(first);
		expect(process.cwd()).toBe(before);
	});
});
