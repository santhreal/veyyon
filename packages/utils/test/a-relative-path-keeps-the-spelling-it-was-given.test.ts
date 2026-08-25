/**
 * WHY THIS EXISTS. `relativePathWithinRoot` decides containment on
 * `normalizePathForComparison`, which lowercases on Windows because that filesystem is
 * case-insensitive, and then computed the returned path from those same lowercased strings. So
 * on Windows a project in `C:\Users\dev\Projects\MyApp\Src` reported `myapp\src`. That string
 * is not diagnostic output: the status line paints it, and `AgentSession` names rule files by
 * it, so a Windows session read its own directories in a case it had never used.
 *
 * THE CLASS: any caller that treats a case-folded comparison key as display output. Case
 * folding is for the decision only; the string handed back is the caller's own.
 *
 * WHAT THIS DOES NOT CATCH: a filesystem that folds something other than case (NFD vs NFC on
 * macOS). `resolveEquivalentPath` realpaths, so an existing path comes back in the form the
 * filesystem holds, and a path that does not exist comes back as given.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathIsWithin, relativePathWithinRoot } from "@veyyon/utils";

let tempRoot = "";

beforeAll(() => {
	tempRoot = mkdtempSync(path.join(os.tmpdir(), "veyyon-relative-spelling-"));
});

afterAll(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

const RESTORE: (() => void)[] = [];

afterEach(() => {
	while (RESTORE.length > 0) RESTORE.pop()?.();
});

/**
 * The platform, for the length of one call. `normalizePathForComparison` reads it at call time
 * and `node:path` stays bound to the real platform, which is the combination this is about: a
 * case-insensitive comparison over posix-shaped strings.
 */
function withPlatform(value: NodeJS.Platform, run: () => void): void {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value, configurable: true });
	RESTORE.push(() => {
		if (original) Object.defineProperty(process, "platform", original);
	});
	run();
}

describe("a path relative to a root keeps the spelling it was given", () => {
	it("returns the candidate's own case where the comparison folded it", () => {
		withPlatform("win32", () => {
			const root = path.join(path.sep, "Users", "dev", "Projects");
			const candidate = path.join(root, "MyApp", "Src");
			expect(pathIsWithin(root, candidate)).toBe(true);
			expect(relativePathWithinRoot(root, candidate)).toBe(path.join("MyApp", "Src"));
		});
	});

	it("finds a candidate under a root spelled in another case, and still answers in the candidate's", () => {
		// The other half of a case-insensitive filesystem: the root as configured need not
		// match the root as spelled on disk. The walk has to succeed, and the answer still
		// belongs to the candidate.
		withPlatform("win32", () => {
			const candidate = path.join(path.sep, "Users", "dev", "Projects", "MyApp", "Src");
			expect(relativePathWithinRoot(path.join(path.sep, "users", "DEV", "projects"), candidate)).toBe(
				path.join("MyApp", "Src"),
			);
		});
	});

	it("keeps the case of a directory that exists, on this platform, with nothing faked", () => {
		// The guard against fixing the above by lowercasing everywhere: a real mixed-case
		// directory on the running platform comes back exactly as it sits on disk.
		const root = path.join(tempRoot, "case-preserved");
		const nested = path.join(root, "MixedCase", "Inner");
		mkdirSync(nested, { recursive: true });
		expect(relativePathWithinRoot(root, nested)).toBe(path.join("MixedCase", "Inner"));
	});

	it("answers null for a candidate outside the root, and for a case difference where case matters", () => {
		const root = path.join(tempRoot, "outside");
		mkdirSync(path.join(root, "child"), { recursive: true });
		expect(relativePathWithinRoot(root, path.join(tempRoot, "not-under-this-root"))).toBeNull();
		// On a case-sensitive filesystem a differently-cased root is a different root, and the
		// answer is that the candidate is not under it -- not a relative path computed anyway.
		if (process.platform === "linux") {
			expect(relativePathWithinRoot(root.toUpperCase(), path.join(root, "child"))).toBeNull();
		}
	});
});
