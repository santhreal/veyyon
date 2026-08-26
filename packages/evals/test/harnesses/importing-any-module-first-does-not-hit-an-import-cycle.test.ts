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
 * The class this closes: any load-time cycle between two modules the package ships,
 * whichever module the process enters from. Every module under `src` that runs in a
 * process is a candidate — the CLI, the core registries, the backends, the manager,
 * the report writers, the server and its controllers, the benches, the harnesses and
 * the suites — and each is imported first in a fresh process, because module
 * evaluation order, and therefore whether a binding is still in its temporal dead
 * zone, depends entirely on the entry point.
 *
 * `src/web` is excluded: those modules load in a browser, and the bundle entry reads
 * `document` at module scope, so a process-entry probe cannot tell a missing DOM from
 * a cycle. The dashboard's own suites drive those modules.
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

/**
 * Every directory under `src` whose modules run in a process. `src/web` is the one
 * omission, for the reason in the header.
 */
const PROBED_DIRS = [
	"src/backends",
	"src/benches",
	"src/core",
	"src/harnesses",
	"src/manager",
	"src/report",
	"src/run",
	"src/server",
	"src/suites",
] as const;

/** The modules that sit directly under `src`, which no directory scan reaches. */
const TOP_LEVEL_MODULES = ["src/cli.ts", "src/index.ts", "src/paths.ts", "src/wire.ts"] as const;

async function moduleFiles(): Promise<string[]> {
	const glob = new Bun.Glob("**/*.ts");
	const files: string[] = [...TOP_LEVEL_MODULES];
	for (const dir of PROBED_DIRS) {
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
	"src/benches/goal-budget-context-bench.ts",
	"src/suites/deep-swe/context-encode-ceiling.ts",
	"src/suites/deep-swe/measure-channel-split.ts",
	"src/suites/deep-swe/measure-retype-likelihood.ts",
	"src/suites/deep-swe/online-codec-ceiling.ts",
	"src/suites/deep-swe/prefix-composition.ts",
	"src/suites/typescript-edit/generate.ts",
];

/** A load-time cycle surfaces as a dead-zone read or a binding that is not yet a value. */
const CYCLE_ERROR = /before initialization|is not defined|is not a function|is not an object|circular/i;

describe("importing any module the package ships first", () => {
	test("never enters a load-time import cycle, whichever module the process starts from", async () => {
		const files = await moduleFiles();
		// A broken glob would otherwise pass this suite with nothing to prove.
		expect(files).toContain("src/cli.ts");
		expect(files).toContain("src/wire.ts");
		expect(files).toContain("src/backends/harbor/runner/config.ts");
		expect(files).toContain("src/benches/goal-budget-context-bench.ts");
		expect(files).toContain("src/core/harness-registry.ts");
		expect(files).toContain("src/harnesses/index.ts");
		expect(files).toContain("src/harnesses/system-comparison.ts");
		expect(files).toContain("src/manager/store.ts");
		expect(files).toContain("src/report/bench-report.ts");
		expect(files).toContain("src/run/index.ts");
		expect(files).toContain("src/server/controllers/runs.ts");
		expect(files).toContain("src/suites/deep-swe/runner/executor.ts");
		expect(files).toContain("src/suites/deep-swe/replay-manifest.ts");

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
