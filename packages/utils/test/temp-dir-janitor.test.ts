/**
 * The janitor that removes the temp directories a test process created.
 *
 * WHY THIS SUITE EXISTS. `/tmp` reached 38,600 leaked `veyyon-*` directories and 240 GB,
 * and the root filesystem hit 100% full with 18 MB free, which stops every build and every
 * test run on the machine. They came from this suite: 233 test files call `mkdtempSync`
 * across 405 sites and 102 of those files never remove anything. `temp-dir-janitor.ts`
 * records what `mkdtemp` hands out and removes it when the process exits, so no test file
 * has to remember.
 *
 * TWO HALVES, TESTED TWO WAYS. The recording rules are pure and are asserted in process.
 * The removal is asserted from CHILD processes, deliberately: this file runs in a worker
 * that other test files share, the janitor's record is one per process, and calling
 * `removeRecordedTempDirs()` here would delete directories a suite running beside it is
 * still using. A child process is also the only place the real question can be asked,
 * which is not "does the function delete" but "does a process that preloads the tripwire
 * leave its temp directory behind".
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__janitor,
	janitorCleanupHook,
	recordCreatedDirectory,
	recordedTempDirs,
	recordTempDir,
	STALE_TEMP_DIR_AGE_MS,
	sweepStaleTempDirs,
	TEST_TEMP_DIR_PREFIXES,
} from "./helpers/temp-dir-janitor";

const TRIPWIRE = path.join(import.meta.dir, "helpers", "real-data-tripwire.ts");

/**
 * Run `body` as a one-case test file in a child `bun test` process that preloads the real
 * tripwire, and return what it printed.
 *
 * A CHILD `bun test`, NOT A CHILD `bun <script>`. The two do not patch the same thing. In
 * a `bun run` process, `require("node:fs")` and `import * as fs from "node:fs"` hand back
 * DIFFERENT function objects, so a preload that wraps the first is invisible to a module
 * that imports the second; under `bun test` they are the same object and the wrapping is
 * visible. Every process this janitor exists for is a `bun test` process, so that is the
 * shape asserted here. The divergence itself is filed separately: it means the real-data
 * tripwire does not guard ESM `fs` writes in a `bun run` process either.
 */
async function runInChild(body: string): Promise<{ stdout: string; exitCode: number }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-script-"));
	const file = path.join(dir, "child.test.ts");
	fs.writeFileSync(
		file,
		`import { it } from "bun:test";\n` +
			`import * as fs from "node:fs";\n` +
			`import * as os from "node:os";\n` +
			`import * as path from "node:path";\n` +
			`it("child", async () => {\n${body}\n});\n`,
	);
	const proc = Bun.spawn(["bun", "test", "--preload", TRIPWIRE, file], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		cwd: path.join(import.meta.dir, "..", "..", ".."),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: `${stdout}\n${stderr}`, exitCode };
}

/**
 * A token unique to this process and this call, so a case never collides with a sibling
 * worker or with a leftover from an earlier run of this same file.
 */
let uniqueCounter = 0;
function unique(): string {
	uniqueCounter += 1;
	return `${process.pid}-${uniqueCounter}`;
}

/** The single `TEMPDIR=` line a child prints, which is the path the parent then checks. */
function reportedDir(output: string): string {
	const line = output.split("\n").find(entry => entry.startsWith("TEMPDIR="));
	if (!line) throw new Error(`child printed no TEMPDIR= line:\n${output}`);
	return line.slice("TEMPDIR=".length).trim();
}

describe("what the janitor records", () => {
	/**
	 * The ordinary case. A path under the tmpdir is the thing this module exists to clean,
	 * and recording is what makes the exit handler able to find it.
	 */
	it("records a directory inside the tmpdir", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-record-"));

		expect(recordTempDir(dir)).toBe(true);
		expect(recordedTempDirs()).toContain(path.resolve(dir));
	});

	/**
	 * THE MOST IMPORTANT REFUSAL. A test may point `mkdtemp` at a repository path, and a
	 * janitor that recorded it would delete the developer's files at process exit. That is
	 * a far worse failure than the leak it was built to fix, so the tmpdir bound is not an
	 * optimisation, it is the safety property.
	 */
	it("refuses a directory outside the tmpdir", () => {
		const outside = path.join(import.meta.dir, "not-a-temp-dir");

		expect(recordTempDir(outside)).toBe(false);
		expect(recordedTempDirs()).not.toContain(path.resolve(outside));
	});

	/**
	 * The tmpdir ITSELF is not a temp directory to remove. Recording it would make the exit
	 * handler run `rm -rf /tmp`, which would take every other process's scratch with it.
	 */
	it("refuses the tmpdir itself", () => {
		expect(recordTempDir(os.tmpdir())).toBe(false);
		expect(recordTempDir(fs.realpathSync(os.tmpdir()))).toBe(false);
	});

	/** Neither an empty string nor a non-string can name a directory to remove. */
	it("refuses values that cannot be a path", () => {
		expect(recordTempDir("")).toBe(false);
		expect(recordTempDir(undefined)).toBe(false);
		expect(recordTempDir(42)).toBe(false);
	});

	/**
	 * A SIBLING WITH A SHARED PREFIX IS NOT INSIDE. `/tmp-other` starts with `/tmp` as a
	 * string, and a containment check written with `startsWith` would call it a temp path
	 * and delete it. `path.relative` is what makes the bound a directory bound rather than
	 * a string prefix.
	 */
	it("treats a sibling sharing a prefix as outside", () => {
		expect(__janitor.isInside("/tmp-other/x", "/tmp")).toBe(false);
		expect(__janitor.isInside("/tmp/x", "/tmp")).toBe(true);
		expect(__janitor.isInside("/tmp", "/tmp")).toBe(true);
		expect(__janitor.isInside("/var/x", "/tmp")).toBe(false);
	});

	/**
	 * THE HOME SANDBOX IS NOT THIS FILE'S SCRATCH. `scripts/ci-test-ts.ts` points `HOME` at
	 * one directory under `os.tmpdir()` and shares it across every chunk of a run, so the
	 * tmpdir bound alone swallows it whole. A test that made `<HOME>/.veyyon/cache/mupdf` had
	 * it recorded, and the janitor removed it at the end of that FILE while other chunk
	 * processes were still reading it. What surfaced was `convertBufferWithMarkit` answering
	 * `ok: false` in one chunk of a 4,186-file run, passing in every isolated rerun, and
	 * naming neither the janitor nor the directory.
	 */
	it("refuses a directory inside the home sandbox", () => {
		const inHome = path.join(os.homedir(), ".veyyon", "cache", `mupdf-${unique()}`);

		expect(recordTempDir(inHome)).toBe(false);
		expect(recordedTempDirs()).not.toContain(path.resolve(inHome));
	});

	/** The home directory itself is refused for the same reason, whatever its spelling. */
	it("refuses the home directory itself", () => {
		expect(recordTempDir(os.homedir())).toBe(false);
		expect(recordTempDir(fs.realpathSync(os.homedir()))).toBe(false);
	});

	/**
	 * And the refusal is scoped: a sibling of the home sandbox is ordinary scratch. Without
	 * this the fix could be a `startsWith` on the home path, which would exempt
	 * `/tmp/veyyon-test-home-123-other` from cleanup and quietly restore the leak.
	 */
	it("still records a sibling of the home sandbox", () => {
		const sibling = `${path.resolve(os.homedir())}-sibling-${unique()}`;
		// Under the runner the home sandbox lives in the tmpdir and the sibling is scratch;
		// in a bare `bun test` the home is the developer's and the sibling is outside the
		// bound. The expectation is the tmpdir rule either way, which is the point: home does
		// not widen or narrow it, it only carves itself out.
		const expected = __janitor.TMP_ROOTS.some(root => __janitor.isInside(sibling, root));

		expect(recordTempDir(sibling)).toBe(expected);
	});

	/** Recording the same directory twice leaves one entry, not two removals. */
	it("records a directory once", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-twice-"));
		recordTempDir(dir);
		recordTempDir(dir);

		const resolved = path.resolve(dir);
		expect(recordedTempDirs().filter(entry => entry === resolved)).toHaveLength(1);
	});
});

describe("the mkdtemp entry points the janitor wraps", () => {
	/**
	 * THE WIRING, and the assertion that would have caught both ways this shipped broken.
	 *
	 * Not `isRecording(fs.mkdtempSync)`: the tripwire wraps `mkdtempSync` too, and it wraps
	 * it AFTER this recorder, so the outermost function carries the tripwire's marker and not
	 * this one. A marker check would read as "not installed" while recording worked perfectly.
	 * What matters is the observable effect, so that is what is asserted: a directory made
	 * through the ordinary import is in the recorded set.
	 */
	it("record a directory created through the ordinary fs import", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-wired-"));

		expect(recordedTempDirs()).toContain(path.resolve(dir));
	});

	/**
	 * Cleanup must be wired to a hook bun actually runs. `bun test` does NOT run
	 * `process.on("exit")` handlers, so a janitor wired that way is dead code in the one
	 * process it exists for, and every other assertion in this file still passes.
	 */
	it("wire cleanup to a bun:test afterAll in a test process", () => {
		expect(janitorCleanupHook()).toBe("afterAll");
	});

	/**
	 * The wrapper must not change what `mkdtempSync` returns. A recorder that returned the
	 * prefix, or a normalised path, would break every caller that joins onto the result.
	 */
	it("return exactly the path the original returned", () => {
		const prefix = path.join(os.tmpdir(), "veyyon-janitor-passthrough-");
		const dir = fs.mkdtempSync(prefix);

		expect(dir.startsWith(prefix)).toBe(true);
		expect(fs.existsSync(dir)).toBe(true);
		expect(fs.statSync(dir).isDirectory()).toBe(true);
	});

	/** The promise form resolves to the path, and the path is recorded. */
	it("record the promise form", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "veyyon-janitor-promise-"));

		expect(fs.existsSync(dir)).toBe(true);
		expect(recordedTempDirs()).toContain(path.resolve(dir));
	});

	/** And the callback form, which is the shape a recorder is easiest to forget. */
	it("record the callback form", async () => {
		const dir = await new Promise<string>((resolve, reject) => {
			fs.mkdtemp(path.join(os.tmpdir(), "veyyon-janitor-callback-"), (err, created) => {
				if (err) reject(err);
				else resolve(created);
			});
		});

		expect(fs.existsSync(dir)).toBe(true);
		expect(recordedTempDirs()).toContain(path.resolve(dir));
	});

	/**
	 * Installing twice must not double-wrap. The preload is imported by every test module,
	 * and a wrapper that wrapped its own wrapper would record the same path once per import
	 * and grow a chain of closures for the whole run.
	 */
	it("are not wrapped a second time", () => {
		const before = __janitor.fsModule().mkdtempSync;
		__janitor.installRecorders();

		expect(__janitor.fsModule().mkdtempSync).toBe(before);
	});
});

describe("the mkdir entry points the janitor wraps", () => {
	/**
	 * WHY `mkdir` IS WRAPPED AT ALL. `mkdtemp` is the documented way to make scratch and 656
	 * test files do not use it, building a unique name by hand instead; 432 of those never
	 * call `rm`. Recording only `mkdtemp` left the larger half of the leak in place.
	 */
	it("record a directory created with a plain mkdirSync", () => {
		const dir = path.join(os.tmpdir(), `veyyon-janitor-plain-${unique()}`);
		fs.mkdirSync(dir);

		expect(recordedTempDirs()).toContain(path.resolve(dir));
	});

	/**
	 * With `recursive: true` the TOPMOST created directory is what gets recorded, not the
	 * leaf. Recording the leaf would remove `a/b/c` and leave `a` and `a/b` behind, which is
	 * still a leak and a quieter one, because the tree left behind is empty and small.
	 */
	it("record the topmost directory a recursive mkdirSync created", () => {
		const root = path.join(os.tmpdir(), `veyyon-janitor-deep-${unique()}`);
		fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });

		expect(recordedTempDirs()).toContain(path.resolve(root));
		expect(recordedTempDirs()).not.toContain(path.resolve(path.join(root, "a", "b")));
	});

	/**
	 * THE RULE THAT KEEPS THIS SAFE, stated against the decision function itself because the
	 * recorded set has no per-path undo. A recursive `mkdir` over a directory that already
	 * exists creates nothing and returns `undefined`, so nothing is recorded. Without this
	 * the janitor would claim any fixed-name directory a test merely touched, including a
	 * source-level cache another test file is reading at that moment. The end-to-end half of
	 * this is `leaves a directory it only re-created alone`, below.
	 */
	it("record nothing when a recursive mkdir created nothing", () => {
		const dir = path.join(os.tmpdir(), `veyyon-janitor-exists-${unique()}`);

		expect(recordCreatedDirectory(dir, { recursive: true }, undefined)).toBe(false);
		expect(recordedTempDirs()).not.toContain(path.resolve(dir));
	});

	/**
	 * The non-recursive form has no return value to read, and it THROWS when the target
	 * exists, so reaching the recorder at all means this process made the directory.
	 */
	it("record the target when a plain mkdir succeeded", () => {
		const dir = path.join(os.tmpdir(), `veyyon-janitor-plainrule-${unique()}`);

		expect(recordCreatedDirectory(dir, undefined, undefined)).toBe(true);
		expect(recordedTempDirs()).toContain(path.resolve(dir));
	});

	/** The promise form records on the same terms. */
	it("record the promise form", async () => {
		const root = path.join(os.tmpdir(), `veyyon-janitor-mkdirp-${unique()}`);
		await fs.promises.mkdir(path.join(root, "inner"), { recursive: true });

		expect(recordedTempDirs()).toContain(path.resolve(root));
	});

	/** And the callback form, including the two-argument shape that carries no options. */
	it("record the callback form with and without options", async () => {
		const plain = path.join(os.tmpdir(), `veyyon-janitor-mkdircb-${unique()}`);
		await new Promise<void>((resolve, reject) => {
			fs.mkdir(plain, err => (err ? reject(err) : resolve()));
		});
		const deep = path.join(os.tmpdir(), `veyyon-janitor-mkdircbr-${unique()}`);
		await new Promise<void>((resolve, reject) => {
			fs.mkdir(path.join(deep, "inner"), { recursive: true }, err => (err ? reject(err) : resolve()));
		});

		expect(recordedTempDirs()).toContain(path.resolve(plain));
		expect(recordedTempDirs()).toContain(path.resolve(deep));
	});

	/** A directory outside the tmpdir is never recorded, whichever call made it. */
	it("record nothing for a directory outside the tmpdir", () => {
		const outside = path.join(import.meta.dir, `janitor-outside-${unique()}`);
		fs.mkdirSync(outside);
		try {
			expect(recordedTempDirs()).not.toContain(path.resolve(outside));
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	/** The wrapper must not change what `mkdirSync` returns, in either form. */
	it("return exactly what the original returned", () => {
		const root = path.join(os.tmpdir(), `veyyon-janitor-ret-${unique()}`);

		expect(fs.mkdirSync(path.join(root, "a"), { recursive: true })).toBe(root);
		expect(fs.mkdirSync(path.join(root, "b"))).toBeUndefined();
	});
});

describe("what a process leaves behind when it exits", () => {
	/**
	 * THE POINT OF THE WHOLE MODULE. A process that preloads the tripwire and creates a
	 * temp directory must not leave it on disk. This is the assertion the 240 GB would have
	 * failed, and it is made against a real child process rather than by calling the
	 * removal function, because what leaked was processes, not function calls.
	 */
	it("removes a directory the process created with mkdtempSync", async () => {
		const { stdout, exitCode } = await runInChild(`
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-child-"));
			fs.writeFileSync(path.join(dir, "payload.txt"), "x".repeat(1024));
			console.log("TEMPDIR=" + dir);
		`);
		const dir = reportedDir(stdout);

		expect(exitCode).toBe(0);
		expect(dir).toContain("veyyon-janitor-child-");
		expect(fs.existsSync(dir)).toBe(false);
	}, 30_000);

	/** The promise form is cleaned up too, not only the synchronous one. */
	it("removes a directory the process created with the promise form", async () => {
		const { stdout } = await runInChild(`
			const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "veyyon-janitor-childp-"));
			console.log("TEMPDIR=" + dir);
		`);

		expect(fs.existsSync(reportedDir(stdout))).toBe(false);
	}, 30_000);

	/**
	 * A NON-EMPTY TREE, because that is what the leak actually was: 290 MB of staged native
	 * addon under a temp `HOME`. A removal that only handled empty directories would have
	 * reclaimed nothing.
	 */
	it("removes a directory that has subdirectories and files in it", async () => {
		const { stdout } = await runInChild(`
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-tree-"));
			fs.mkdirSync(path.join(dir, "a", "b", "c"), { recursive: true });
			fs.writeFileSync(path.join(dir, "a", "b", "c", "deep.bin"), Buffer.alloc(4096));
			console.log("TEMPDIR=" + dir);
		`);

		expect(fs.existsSync(reportedDir(stdout))).toBe(false);
	}, 30_000);

	/**
	 * A DIRECTORY THE PROCESS DID NOT GET FROM `mkdtemp` SURVIVES. The janitor removes what
	 * it was handed, never what it inferred from a name. A sweep by prefix would delete a
	 * sibling process's live scratch directory, and two test runs share one `/tmp`.
	 */
	it("leaves a temp directory it did not create alone", async () => {
		const keep = path.join(os.tmpdir(), `veyyon-janitor-untouched-${process.pid}`);
		fs.mkdirSync(keep, { recursive: true });
		try {
			const { stdout } = await runInChild(`
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-bystander-"));
				console.log("TEMPDIR=" + dir);
			`);

			expect(fs.existsSync(reportedDir(stdout))).toBe(false);
			expect(fs.existsSync(keep)).toBe(true);
		} finally {
			fs.rmSync(keep, { recursive: true, force: true });
		}
	}, 30_000);

	/**
	 * THE OTHER HALF OF THE LEAK. Most test files never call `mkdtemp`: they join a unique
	 * name onto the tmpdir and call `mkdirSync`. That directory has to be collected too, or
	 * the janitor covers the smaller half of the problem and reads as if it covered all of
	 * it.
	 */
	it("removes a directory the process created with mkdirSync", async () => {
		const { stdout, exitCode } = await runInChild(`
			const dir = path.join(os.tmpdir(), "veyyon-janitor-mkdirchild-" + process.pid);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "payload.txt"), "x".repeat(1024));
			console.log("TEMPDIR=" + dir);
		`);

		expect(exitCode).toBe(0);
		expect(fs.existsSync(reportedDir(stdout))).toBe(false);
	}, 30_000);

	/**
	 * AND THE REFUSAL THAT MAKES THAT SAFE. A directory the child only re-created with
	 * `recursive: true` survives, because that call created nothing. This is the fixed-name
	 * shared-cache case: a source module makes `veyyon-stats-client` once and whatever runs
	 * next opens it, and a janitor that claimed it on sight would delete it under a suite
	 * running in another worker.
	 */
	it("leaves a directory it only re-created alone", async () => {
		const shared = path.join(os.tmpdir(), `veyyon-janitor-shared-${unique()}`);
		fs.mkdirSync(shared, { recursive: true });
		fs.writeFileSync(path.join(shared, "cache.bin"), "kept");
		try {
			const { exitCode } = await runInChild(`
				fs.mkdirSync(${JSON.stringify(shared)}, { recursive: true });
				console.log("TEMPDIR=" + ${JSON.stringify(shared)});
			`);

			expect(exitCode).toBe(0);
			expect(fs.existsSync(path.join(shared, "cache.bin"))).toBe(true);
		} finally {
			fs.rmSync(shared, { recursive: true, force: true });
		}
	}, 30_000);

	/**
	 * A suite that cleaned up after itself must not turn the exit handler into a failure.
	 * Removal treats an already-absent directory as success, so the child still exits 0.
	 */
	it("exits cleanly when the directory was already removed", async () => {
		const { exitCode } = await runInChild(`
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-selfclean-"));
			fs.rmSync(dir, { recursive: true, force: true });
			console.log("TEMPDIR=" + dir);
		`);

		expect(exitCode).toBe(0);
	}, 30_000);

	/**
	 * A FAILING RUN STILL CLEANS UP, which is the run that matters: a developer repeats a
	 * failing suite far more often than a passing one, and a janitor that only ran on the
	 * happy path would leak hardest exactly there.
	 */
	it("removes the directory even when the test fails and the process exits non-zero", async () => {
		const { stdout, exitCode } = await runInChild(`
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-failing-"));
			console.log("TEMPDIR=" + dir);
			throw new Error("this child is meant to fail");
		`);

		expect(exitCode).not.toBe(0);
		expect(fs.existsSync(reportedDir(stdout))).toBe(false);
	}, 30_000);
});

describe("sweeping directories a dead process left behind", () => {
	/**
	 * THE LIST THE RUNNER SWEEPS. It ran with `veyyon-` alone while `/tmp` held 14,364 `pi-`
	 * directories from the coding-agent suite, so the sweep reported a clean reclaim and left
	 * the larger half of a killed run's scratch on disk. `scripts/ci-test-ts.ts` now walks
	 * every entry of this list, and this case pins the two ends of the contract: the
	 * coding-agent prefix is in it, and nothing generic enough to belong to another program
	 * is.
	 */
	it("names every prefix this suite creates and nothing generic", () => {
		expect(TEST_TEMP_DIR_PREFIXES).toContain("veyyon-");
		expect(TEST_TEMP_DIR_PREFIXES).toContain("pi-");
		expect(TEST_TEMP_DIR_PREFIXES).toContain("mnemopi-");
		for (const generic of ["read-", "auth-", "test-", "plan-", "search-", "tmp-", "-"]) {
			expect(TEST_TEMP_DIR_PREFIXES).not.toContain(generic);
		}
		for (const prefix of TEST_TEMP_DIR_PREFIXES) {
			expect(prefix.endsWith("-")).toBe(true);
			expect(prefix.length).toBeGreaterThanOrEqual(3);
		}
	});

	/**
	 * And the sweep actually honours a non-`veyyon-` prefix, which is the half of the fix
	 * that lives in the sweep rather than in the list.
	 */
	it("sweeps a prefix other than veyyon-", () => {
		const root = rootWithAges({ "pi-abandoned": STALE_TEMP_DIR_AGE_MS * 2 });

		const { removed } = sweepStaleTempDirs({ prefix: "pi-", root });

		expect(removed).toEqual([path.join(root, "pi-abandoned")]);
	});

	/**
	 * A fresh root with one directory per named age, so a case can say exactly which of them
	 * it expects to survive. Ages are applied with `utimesSync` rather than by waiting.
	 */
	function rootWithAges(ages: Record<string, number>): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-sweeproot-"));
		const now = Date.now();
		for (const [name, ageMs] of Object.entries(ages)) {
			const dir = path.join(root, name);
			fs.mkdirSync(dir, { recursive: true });
			// A stranded directory belongs to a process that is GONE. Creating it here records
			// it, and the sweep skips what this process recorded, so the fixture has to be
			// handed over before it models the case at all.
			__janitor.forget(dir);
			const when = new Date(now - ageMs);
			fs.utimesSync(dir, when, when);
		}
		return root;
	}

	/**
	 * THE RECOVERY CASE. A `SIGKILL`ed run leaves scratch no teardown will ever remove, and
	 * a machine that has been through a few of those is how 240 GB accumulates. The sweep is
	 * what turns that from permanent into temporary.
	 */
	it("removes a stale directory with the swept prefix", () => {
		const root = rootWithAges({ "veyyon-old": STALE_TEMP_DIR_AGE_MS * 2 });

		const { removed, failed } = sweepStaleTempDirs({ prefix: "veyyon-", root });

		expect(failed).toEqual([]);
		expect(removed).toEqual([path.join(root, "veyyon-old")]);
		expect(fs.existsSync(path.join(root, "veyyon-old"))).toBe(false);
	});

	/**
	 * THE SAFETY CASE, and the reason the sweep is bounded by age at all. Two runs share one
	 * `/tmp`, and a sweep that removed by prefix alone would delete the scratch of a run that
	 * started thirty seconds ago, turning a disk-space fix into a source of flaky failures in
	 * somebody else's terminal.
	 */
	it("leaves a recent directory alone even when the prefix matches", () => {
		const root = rootWithAges({ "veyyon-live": 60_000 });

		const { removed } = sweepStaleTempDirs({ prefix: "veyyon-", root });

		expect(removed).toEqual([]);
		expect(fs.existsSync(path.join(root, "veyyon-live"))).toBe(true);
	});

	/** A directory that is old but belongs to something else keeps its contents. */
	it("ignores a stale directory whose name does not carry the prefix", () => {
		const root = rootWithAges({ "someone-elses-cache": STALE_TEMP_DIR_AGE_MS * 10 });

		const { removed } = sweepStaleTempDirs({ prefix: "veyyon-", root });

		expect(removed).toEqual([]);
		expect(fs.existsSync(path.join(root, "someone-elses-cache"))).toBe(true);
	});

	/**
	 * A DIRECTORY THIS PROCESS IS STILL RECORDING IS LIVE, whatever its timestamp says. A
	 * suite can create its scratch in the first second of a run and not write to it again,
	 * and mtime cannot tell that apart from abandonment.
	 */
	it("never removes a directory the current process recorded", () => {
		const root = rootWithAges({ "veyyon-mine": STALE_TEMP_DIR_AGE_MS * 3 });
		const mine = path.join(root, "veyyon-mine");
		recordTempDir(mine);

		const { removed } = sweepStaleTempDirs({ prefix: "veyyon-", root });

		expect(removed).toEqual([]);
		expect(fs.existsSync(mine)).toBe(true);
	});

	/** Files are not directories, and the sweep removes directories. */
	it("leaves a stale FILE with the prefix alone", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-sweepfile-"));
		const file = path.join(root, "veyyon-stray.log");
		fs.writeFileSync(file, "x");
		const when = new Date(Date.now() - STALE_TEMP_DIR_AGE_MS * 4);
		fs.utimesSync(file, when, when);

		const { removed } = sweepStaleTempDirs({ prefix: "veyyon-", root });

		expect(removed).toEqual([]);
		expect(fs.existsSync(file)).toBe(true);
	});

	/**
	 * A NON-EMPTY STALE TREE, because the leak was 290 MB per directory and a sweep that only
	 * handled empty ones would reclaim nothing at all.
	 */
	it("removes a stale directory that still has contents", () => {
		const root = rootWithAges({ "veyyon-full": STALE_TEMP_DIR_AGE_MS * 2 });
		const dir = path.join(root, "veyyon-full");
		fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
		fs.writeFileSync(path.join(dir, "nested", "payload.bin"), Buffer.alloc(2048));
		const when = new Date(Date.now() - STALE_TEMP_DIR_AGE_MS * 2);
		fs.utimesSync(dir, when, when);

		const { removed } = sweepStaleTempDirs({ prefix: "veyyon-", root });

		expect(removed).toEqual([dir]);
		expect(fs.existsSync(dir)).toBe(false);
	});

	/**
	 * An unreadable root is reported, not thrown. The sweep runs before a test run starts,
	 * and a throw there would fail the run over housekeeping.
	 */
	it("reports an unreadable root instead of throwing", () => {
		const missing = path.join(os.tmpdir(), `veyyon-janitor-absent-${process.pid}`);

		const { removed, failed } = sweepStaleTempDirs({ prefix: "veyyon-", root: missing });

		expect(removed).toEqual([]);
		expect(failed).toHaveLength(1);
		expect(failed[0]?.dir).toBe(missing);
	});

	/**
	 * A READ-ONLY STALE DIRECTORY IS STILL COLLECTED. A suite that tests permission handling
	 * leaves scratch whose own mode forbids writing, so `rm -rf` answers `EACCES` and the
	 * directory becomes permanent: three of them were in `/tmp` when this was written, and
	 * the sweep reported the same three failures on every run. Permission is restored and the
	 * removal retried, once.
	 */
	it("collects a stale directory whose mode forbids writing", () => {
		const root = rootWithAges({ "veyyon-readonly": STALE_TEMP_DIR_AGE_MS * 2 });
		const dir = path.join(root, "veyyon-readonly");
		fs.writeFileSync(path.join(dir, "locked.txt"), "x");
		fs.chmodSync(dir, 0o500);
		const when = new Date(Date.now() - STALE_TEMP_DIR_AGE_MS * 2);
		fs.utimesSync(dir, when, when);

		const { removed, failed } = sweepStaleTempDirs({ prefix: "veyyon-", root });

		expect(failed).toEqual([]);
		expect(removed).toEqual([dir]);
		expect(fs.existsSync(dir)).toBe(false);
	});

	/** The default age bound is six hours, longer than any run in this repository. */
	it("defaults to a six hour age bound", () => {
		expect(STALE_TEMP_DIR_AGE_MS).toBe(6 * 60 * 60 * 1000);
	});

	/**
	 * The injected clock is what the bound is measured against, so a caller can sweep as if
	 * it were later without touching any timestamp.
	 */
	it("measures the age against the clock it was given", () => {
		const root = rootWithAges({ "veyyon-hour-old": 60 * 60 * 1000 });

		const untouched = sweepStaleTempDirs({ prefix: "veyyon-", root });
		expect(untouched.removed).toEqual([]);

		const later = sweepStaleTempDirs({ prefix: "veyyon-", root, now: Date.now() + STALE_TEMP_DIR_AGE_MS });
		expect(later.removed).toEqual([path.join(root, "veyyon-hour-old")]);
	});
});
