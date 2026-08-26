/**
 * WHY: the harness barrel builds `builtinHarnesses` from the four adapter modules at
 * load time, and `harnesses/registry.ts` used to read `veyyonAdapter.name` at load
 * too. The veyyon adapter imports deep-swe suite modules, and three deep-swe modules
 * imported the harness barrel back. Entering that cycle from the deep-swe side left
 * the adapter module mid-initialization when the barrel body ran, so
 * `builtinHarnesses` threw "Cannot access 'veyyonAdapter' before initialization" —
 * an unhandled error between tests that killed four test files in the native bucket
 * while every file passed on its own.
 *
 * The class this closes: any load-time cycle between the harness modules and the
 * suite modules, whichever module the process enters from. Each candidate module is
 * imported first in a fresh process, because module evaluation order — and therefore
 * whether a binding is still in its temporal dead zone — depends entirely on the
 * entry point.
 *
 * What it does not catch: a cycle that only breaks when a module is imported after
 * some other specific module (this proves each module as a lone entry point, not
 * every pair), and a cycle whose only symptom is a wrong value rather than a throw.
 */

import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..", "..");

async function moduleFiles(): Promise<string[]> {
	const glob = new Bun.Glob("**/*.ts");
	const files: string[] = [];
	for (const dir of ["src/harnesses", "src/suites"]) {
		for await (const rel of glob.scan({ cwd: path.join(packageRoot, dir) })) {
			if (rel.endsWith(".d.ts")) continue;
			files.push(path.join(dir, rel));
		}
	}
	return files.sort();
}

async function importFailure(rel: string): Promise<string | null> {
	const abs = path.join(packageRoot, rel);
	try {
		await execFileAsync(process.execPath, ["-e", `await import(${JSON.stringify(abs)});`], {
			cwd: packageRoot,
			encoding: "utf-8",
			maxBuffer: 4 * 1024 * 1024,
			env: { ...process.env, VEYYON_EVALS_IMPORT_PROBE: "1" },
		});
		return null;
	} catch (error) {
		const stderr = typeof error === "object" && error && "stderr" in error ? String(error.stderr) : String(error);
		return stderr.trim().split("\n").slice(0, 12).join("\n");
	}
}

/**
 * Modules that run a CLI `main()` on import, so a nonzero exit says nothing about the
 * module graph. Pinned by exact equality: a new one has to be recorded here, and a
 * renamed or deleted one turns this suite red. Each is still required to fail for a
 * reason other than a cycle.
 */
const ENTRY_SCRIPTS = [
	"src/suites/deep-swe/gen-dicts.ts",
	"src/suites/typescript-edit/edit-prompt-bench.ts",
	"src/suites/typescript-edit/generate.ts",
];

/** A load-time cycle surfaces as a dead-zone read or a binding that is not yet a value. */
const CYCLE_ERROR = /before initialization|is not defined|is not a function|is not an object|circular/i;

describe("importing any harness or suite module first", () => {
	test("never enters a load-time import cycle, whichever module the process starts from", async () => {
		const files = await moduleFiles();
		// A broken glob would otherwise pass this suite with nothing to prove.
		expect(files).toContain("src/harnesses/index.ts");
		expect(files).toContain("src/harnesses/registry.ts");
		expect(files).toContain("src/suites/deep-swe/src/runner/executor.ts");
		expect(files).toContain("src/suites/deep-swe/replay-manifest.ts");
		expect(files.length).toBeGreaterThan(40);

		expect(files.filter(f => ENTRY_SCRIPTS.includes(f)).sort()).toEqual([...ENTRY_SCRIPTS].sort());

		const cycleErrors: string[] = [];
		const importErrors: string[] = [];
		const queue = [...files];
		const workers = Array.from({ length: 8 }, async () => {
			for (;;) {
				const next = queue.shift();
				if (!next) return;
				const failure = await importFailure(next);
				if (failure === null) continue;
				if (CYCLE_ERROR.test(failure)) cycleErrors.push(`${next}\n${failure}`);
				else if (!ENTRY_SCRIPTS.includes(next)) importErrors.push(`${next}\n${failure}`);
			}
		});
		await Promise.all(workers);

		expect(cycleErrors).toEqual([]);
		expect(importErrors).toEqual([]);
	}, 300_000);
});
