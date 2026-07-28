/**
 * A REAL update, over each install the environment matrix produces.
 *
 * `installer-environment-matrix.test.ts` proves the installer handles an
 * environment. It says nothing about the OTHER half of the product, which runs
 * on the same machines and touches the same files: `veyyon update` swaps the
 * binary, and then everything AROUND the binary has to still be right. An update
 * that edits an rc it has no business editing, adds a second PATH entry, leaves
 * `vey` pointing at the file it replaced, or leaves completion scripts describing
 * the previous version is an update that reports success and degrades the install.
 * None of those is visible to a suite that only checks the binary's version.
 *
 * So this takes each case's real install and updates it for real, running the
 * shipped `replaceBinaryForUpdate`, `refreshCompletionsForInstalledBinary` and
 * `sweepStaleBackups` against it.
 *
 * The update runs in a CHILD process carrying the case's environment, and that is
 * a requirement rather than a convenience: the completion paths are resolved from
 * `process.env` (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `HOME`), so a child started
 * with the case's variables is the only way to ask where THAT environment's
 * completion files live rather than where this machine's do. Running it in-process
 * would resolve the developer's own paths and pass while covering nothing.
 *
 * The download is deliberately not part of this. Which bytes arrive is
 * `update-binary-integrity.test.ts`'s contract and is environment-independent;
 * what an environment decides is where those bytes land and what else moves with
 * them, which starts at the swap.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type EnvironmentCase,
	type InstallRun,
	cleanupEnvironmentMatrixTempRoots,
	environmentCases as cases,
	INSTALLED_VERSION,
	PATH_MARKER,
	pathLineFor,
	rcTargetFor,
	repoRoot,
	runInstall,
	standInBinary,
	STAND_IN_BINARY,
	UPDATED_STAND_IN_BINARY,
	UPDATED_VERSION,
} from "./install-tests/environment-matrix-harness";

const UPDATE_CLI = path.join(repoRoot, "packages/coding-agent/src/cli/update-cli.ts");

/** Where the child runtime keeps its own cache, deliberately not in the case's `$HOME`. */
const BUN_CACHE_OUTSIDE_THE_CASE = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-update-matrix-bun-cache-"));

afterAll(() => {
	cleanupEnvironmentMatrixTempRoots();
	fs.rmSync(BUN_CACHE_OUTSIDE_THE_CASE, { recursive: true, force: true });
});

interface UpdateRun {
	exitCode: number;
	output: string;
	/** Completion files the refresh reported rewriting, as absolute paths. */
	refreshed: string[];
	/** Completion files that existed and could not be rewritten, with the reason. */
	failed: { filePath: string; reason: string }[];
}

/**
 * Stage the new binary beside the installed one and run the real swap, in the
 * case's environment.
 *
 * The staged temp and the backup are named the way `updateViaBinaryAt` names
 * them, because the sweep matches on those names: a test that invented its own
 * spelling would assert that a sweep it never exercised leaves nothing behind.
 */
function runUpdate(install: InstallRun, toVersion: string = UPDATED_VERSION): UpdateRun {
	const target = path.join(install.installDir, "veyyon");
	const binary = standInBinary(toVersion);
	const script = `
import {
	refreshCompletionsForInstalledBinary,
	replaceBinaryForUpdate,
	SILENT_UPDATE_REPORTER,
	sweepStaleBackups,
	verifyBinaryVersion,
} from ${JSON.stringify(UPDATE_CLI)};
import * as fs from "node:fs";

const target = ${JSON.stringify(target)};
const temp = target + ".new";
const backup = target + "." + Date.now() + "." + process.pid + ".bak";
fs.writeFileSync(temp, ${JSON.stringify(binary)}, { mode: 0o755 });

const verified = await replaceBinaryForUpdate({
	targetPath: target,
	tempPath: temp,
	backupPath: backup,
	expectedVersion: ${JSON.stringify(toVersion)},
	verifyInstalledVersion: expected => verifyBinaryVersion(target, expected),
});
if (!verified.ok) throw new Error("the swap did not verify: " + JSON.stringify(verified));

const refresh = await refreshCompletionsForInstalledBinary(target, SILENT_UPDATE_REPORTER);
await sweepStaleBackups(target);
process.stdout.write("\\n__RESULT__" + JSON.stringify(refresh) + "\\n");
`;
	// `process.execPath` rather than `"bun"`: the case's PATH is the one the
	// installer was given, which holds the system tools and nothing else. Putting
	// bun on it would change the environment under test to make the test runnable.
	const run = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: repoRoot,
		env: {
			...install.env,
			// Bun's own caches default under `$HOME/.bun`, and $HOME here is the
			// case's disposable one. Left alone, the runtime running the update
			// writes a few dozen of its own files into the very tree the assertions
			// call "what the update created" — the transpiler cache is the noisy
			// one, hence disabling it outright rather than relocating it. Pointed
			// away, so the tree holds only what the product put there.
			BUN_INSTALL_CACHE_DIR: BUN_CACHE_OUTSIDE_THE_CASE,
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${run.stdout.toString()}${run.stderr.toString()}`;
	const marker = run.stdout.toString().indexOf("__RESULT__");
	const parsed =
		marker === -1
			? { refreshed: [], failed: [] }
			: (JSON.parse(run.stdout.toString().slice(marker + "__RESULT__".length).trim()) as {
					refreshed: string[];
					failed: { filePath: string; reason: string }[];
				});
	return { exitCode: run.exitCode, output, refreshed: parsed.refreshed, failed: parsed.failed };
}

/**
 * Every file under `root`, as paths relative to it.
 *
 * The update's completion refresh is allowed to rewrite files, never to create
 * them, and the TOML's `expect_completions` lists only the paths a case cares
 * about rather than every file an install writes. So the pre-update tree is what
 * "created nothing" is measured against.
 */
function filesUnder(root: string): Set<string> {
	const found = new Set<string>();
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else found.add(full);
		}
	};
	walk(root);
	return found;
}

describe.each(cases.map(c => [c.name, c] as const))("update an install in %s", (_name, testCase: EnvironmentCase) => {
	const install = runInstall(testCase);
	const binary = path.join(install.installDir, "veyyon");
	const alias = path.join(install.installDir, "vey");
	const rcRel = testCase.expect_rc;
	const rcBefore = rcRel === undefined ? undefined : fs.readFileSync(rcTargetFor(testCase, rcRel, install.home), "utf8");
	const completionsBefore = (testCase.expect_completions ?? []).map(rel => ({
		rel,
		content: fs.readFileSync(path.join(install.home, rel), "utf8"),
	}));
	const filesBefore = filesUnder(install.home);
	const update = runUpdate(install);

	/**
	 * The control. Every assertion below is about what an update left behind, and
	 * each of them would also hold if the update had never run — an unchanged rc
	 * and a single PATH entry are exactly what a no-op produces.
	 */
	it("actually performed the swap", () => {
		expect(update.output).not.toContain("did not verify");
		expect(update.exitCode).toBe(0);
	});

	it("leaves the new version's bytes at the installed path, still executable", () => {
		// Byte-exact rather than "the version string changed": a partial write
		// also changes the version string, and a binary that is no longer
		// executable is an install the user's shell can no longer run.
		expect(fs.readFileSync(binary, "utf8")).toBe(UPDATED_STAND_IN_BINARY);
		expect(fs.statSync(binary).mode & 0o111).toBe(0o111);
	});

	it("reports the new version when run through the installed path", () => {
		// The file is right; this asserts the thing the user actually observes,
		// which is what `veyyon --version` prints after an update.
		const run = Bun.spawnSync([binary, "--version"], { env: install.env });
		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString().trim()).toBe(`veyyon/${UPDATED_VERSION}`);
		expect(run.stdout.toString()).not.toContain(INSTALLED_VERSION);
	});

	it("keeps `vey` resolving to the updated binary", () => {
		// The swap is a rename over the target. A `vey` symlink that pointed at
		// the file rather than the path would now dangle, or worse, resolve to
		// the backup: the documented command would run the OLD version silently.
		expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(fs.realpathSync(alias)).toBe(fs.realpathSync(binary));
		const run = Bun.spawnSync([alias, "--version"], { env: install.env });
		expect(run.stdout.toString().trim()).toBe(`veyyon/${UPDATED_VERSION}`);
	});

	it("leaves no backup or staged download in the install directory", () => {
		// The staged `.new` is a full copy of the binary and the backup is
		// another; both sit in the install directory under names one keystroke
		// from the real one. The sweep is what reclaims them, and this is the
		// assertion that proves the pair works rather than each alone.
		const litter = fs
			.readdirSync(install.installDir)
			.filter(name => name.endsWith(".bak") || name.endsWith(".new") || name.startsWith(".veyyon."));
		expect(litter).toEqual([]);
	});

	if (rcRel !== undefined && rcBefore !== undefined) {
		it(`does not touch ${rcRel}`, () => {
			// An updater has no business editing a shell rc: the installer already
			// put the directory on PATH, the directory has not moved, and the file
			// belongs to the user. A rewrite here is the update silently taking
			// ownership of a file it was never asked to manage.
			expect(fs.readFileSync(rcTargetFor(testCase, rcRel, install.home), "utf8")).toBe(rcBefore);
		});

		it(`leaves exactly one PATH entry for the install directory in ${rcRel}`, () => {
			// A second entry is the classic update defect: harmless-looking, and
			// it compounds on every update until the rc is unreadable.
			// Compared against the line install.sh writes, not against the raw
			// directory: a `$HOME` holding a quote is written escaped, so a
			// substring search would report zero entries in exactly the
			// environment most likely to have the bug.
			const content = fs.readFileSync(rcTargetFor(testCase, rcRel, install.home), "utf8");
			const line = pathLineFor(rcRel, install.installDir);
			expect(content.split("\n").filter(l => l === line)).toEqual([line]);
			expect(content.split("\n").filter(l => l === PATH_MARKER)).toHaveLength(1);
		});
	}

	for (const before of completionsBefore) {
		it(`rewrites the completion at ${before.rel} from the new binary`, () => {
			// The whole point of refreshing completions on update: a script that
			// still describes the previous version completes flags that no longer
			// exist and misses the ones that do. Asserted by the version the new
			// stand-in stamps into its output, so "the file was touched" is not
			// enough to pass.
			const file = path.join(install.home, before.rel);
			const after = fs.readFileSync(file, "utf8");
			expect(after).toContain(UPDATED_VERSION);
			expect(after).not.toBe(before.content);
			expect(update.refreshed).toContain(file);
		});
	}

	it("reports no completion it could not rewrite", () => {
		// The refresh is best effort by design and reports failures rather than
		// failing the update. That makes an environment where it silently cannot
		// write invisible unless the report itself is asserted.
		expect(update.failed).toEqual([]);
	});

	it("rewrites only files the install had already written", () => {
		// The refresh regenerates what is there; it must never CREATE a completion
		// file. A file in a directory the user's shell autoloads, for a shell they
		// do not use, is the update deciding on their behalf what to complete.
		const created = [...filesUnder(install.home)].filter(file => !filesBefore.has(file));
		expect(created).toEqual([]);
		for (const refreshed of update.refreshed) expect(filesBefore.has(refreshed)).toBe(true);
	});

	for (const rel of testCase.expect_absent ?? []) {
		it(`still writes nothing at ${rel}`, () => {
			// The install matrix asserts the installer respects these paths. An
			// update resolves the same directories again, from the same variables,
			// and is the second chance to get them wrong.
			expect(fs.existsSync(path.join(install.home, rel)), `${rel} must not be created`).toBe(false);
		});
	}

	/**
	 * Then back down again, to the version that was installed to begin with.
	 *
	 * `veyyon rollback` reaches the same swap through `installRelease`, so a
	 * rollback is an update whose target version is older. That direction is worth
	 * asserting separately because the thing a user rolls back FROM is a broken
	 * release, and finding that the completions still describe it, or that the
	 * install directory now holds two backups, is finding it at the worst moment.
	 */
	describe("and then rolled back to the version it started on", () => {
		// In `beforeAll`, not at collection time: everything above asserts the state
		// the UPDATE left, and a rollback run while the suite is still being built
		// would undo all of it before the first assertion executed.
		let rollback: UpdateRun;
		beforeAll(() => {
			rollback = runUpdate(install, INSTALLED_VERSION);
		});

		it("puts the original bytes back, executable, reporting the original version", () => {
			expect(rollback.exitCode).toBe(0);
			expect(fs.readFileSync(binary, "utf8")).toBe(STAND_IN_BINARY);
			expect(fs.statSync(binary).mode & 0o111).toBe(0o111);
			const run = Bun.spawnSync([binary, "--version"], { env: install.env });
			expect(run.stdout.toString().trim()).toBe(`veyyon/${INSTALLED_VERSION}`);
		});

		for (const before of completionsBefore) {
			it(`restores the completion at ${before.rel} to the rolled-back version`, () => {
				// Byte-identical to what the install wrote, which is stronger than
				// "it no longer says 9.9.10": a rollback that regenerated from the
				// wrong binary would also stop saying that.
				expect(fs.readFileSync(path.join(install.home, before.rel), "utf8")).toBe(before.content);
			});
		}

		it("leaves the rc and the install directory as clean as the update did", () => {
			// Two swaps in a row is where litter accumulates: each stages a temp and
			// moves a backup aside, and the second is the one that finds the first's
			// leftovers in its way.
			const litter = fs
				.readdirSync(install.installDir)
				.filter(name => name.endsWith(".bak") || name.endsWith(".new") || name.startsWith(".veyyon."));
			expect(litter).toEqual([]);
			if (rcRel !== undefined && rcBefore !== undefined) {
				expect(fs.readFileSync(rcTargetFor(testCase, rcRel, install.home), "utf8")).toBe(rcBefore);
			}
		});

		it("creates nothing new under the home either", () => {
			const created = [...filesUnder(install.home)].filter(file => !filesBefore.has(file));
			expect(created).toEqual([]);
		});
	});
});
