/**
 * The sandbox driver's refusal contract, exercised through its real interface.
 *
 * `scripts/test-sandbox/run.sh` is the only thing standing between an unreviewed
 * test process and the operator's home directory, and every property below is one
 * a plausible edit silently breaks:
 *
 * - a PINNED rung that is unavailable must FAIL, not quietly descend to a weaker
 *   boundary. The whole point of `--rung=microvm` is that you asked for that
 *   boundary; getting a container instead and being told nothing is worse than
 *   getting an error, because you will believe you tested what you asked for.
 * - when NO rung is available the command must not run at all. "Fall back to the
 *   host" is the one behaviour that turns this harness into decoration, and it is
 *   a two-line change away at all times.
 * - an unknown rung name must be an error rather than a silently ignored flag.
 *
 * These are asserted by RUNNING the driver with a command that prints a sentinel.
 * The sentinel is the load-bearing half: an exit code alone cannot tell you whether
 * the command ran somewhere it should not have, and a driver that ran your suite on
 * the bare host and then exited nonzero has still already lost.
 *
 * Nothing here greps the script. A source scan would pass while the arithmetic is
 * wrong, and this file exists because of a class of bug that only shows up when the
 * thing actually runs.
 *
 * WHAT IS NOT HERE, AND WHY. Every property that needs a WORKING rung lives in
 * `scripts/test-sandbox/leak-proof.sh` instead: exit-status pass-through, the
 * per-rung marker, and the hostile write probes. A `bun test` process is by
 * construction already inside a guest, and a guest has no docker socket, no qemu
 * and no ssh key, so a test here that spawned a rung would skip on every machine
 * forever. A test that can only skip is not a test. The proof script runs on the
 * host, where those rungs exist.
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "test-sandbox", "run.sh");

/** Printed by the command the driver is asked to run. Its ABSENCE is the assertion. */
const SENTINEL = "__RUNG_CONTRACT_COMMAND_RAN__";

/**
 * The rung ids the guests export, keyed by the rung that exports them.
 *
 * Spelled out rather than imported from anywhere: the point is to pin the exact
 * strings a guest sets, and importing them from the same place the guest reads
 * would follow a rename instead of catching one.
 */
const MARKER_BY_RUNG: Record<string, string> = {
	remote: "remote-docker",
	docker: "container-docker",
	microvm: "qemu-microvm",
	bwrap: "bwrap-userns",
};

interface Run {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * Run the driver with a clean slate.
 *
 * `VEYYON_TEST_SANDBOX` is cleared because this suite itself runs inside a guest,
 * where the driver's bootstrap hatch would exec the command directly and every
 * assertion below would be about nothing.
 */
function runDriver(args: string[], env: Record<string, string> = {}): Run {
	const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
	// Deleted, not set to undefined: an env object with an undefined value hands the
	// child the literal string "undefined", and the bootstrap hatch treats any
	// non-empty marker as "already inside a sandbox, run it directly".
	delete childEnv.VEYYON_TEST_SANDBOX;
	delete childEnv.VEYYON_SANDBOX_RUNG;
	childEnv.VEYYON_SANDBOX_REPO_ROOT = REPO_ROOT;
	Object.assign(childEnv, env);

	const child = Bun.spawnSync({
		cmd: ["bash", RUNNER, ...args],
		cwd: REPO_ROOT,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		status: child.exitCode ?? -1,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

/**
 * An environment in which every rung is unavailable, built only from the knobs the
 * rungs document plus one shim.
 *
 * Three probes take a documented override that points them at something that cannot
 * exist. `bwrap` has none, so a directory holding a `bwrap` goes on the front of
 * PATH. The bwrap probe is written to RUN bubblewrap rather than to look for it,
 * because the sysctls on this workstation advertise a capability AppArmor then
 * refuses, and the shim is how that behaviour gets asserted: the reason the probe
 * reports has to name the shim, which it can only do by having executed it.
 */
function noRungEnv(): { env: Record<string, string>; binDir: string } {
	const binDir = mkdtempSync(path.join(os.tmpdir(), "rung-contract-bin-"));
	const shim = path.join(binDir, "bwrap");
	writeFileSync(shim, "#!/bin/sh\necho 'shimmed: no user namespace here' >&2\nexit 1\n");
	chmodSync(shim, 0o755);
	return {
		binDir,
		env: {
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			DOCKER_HOST: "unix:///nonexistent/rung-contract-no-docker.sock",
			VIRTIOFSD: "/nonexistent/rung-contract-no-virtiofsd",
			VEYYON_SANDBOX_REMOTE_KEY: "/nonexistent/rung-contract-no-key",
		},
	};
}

/** The reason text `--probe` printed under one rung's `unavailable` line. */
function reasonFor(probeStdout: string, rung: string): string {
	const after = probeStdout.split(new RegExp(`^ {2}${rung}\\s+unavailable$`, "m"))[1];
	if (after === undefined) return `(--probe did not report ${rung} as unavailable)`;
	return after.split(/^ {2}\S/m)[0] ?? "";
}

describe("the rung table", () => {
	/**
	 * A rung missing from the table is a boundary nobody can see the state of, and
	 * `--probe` is the one place a reader looks before spending twenty minutes
	 * blaming their own change for an environment failure.
	 */
	it("names every known rung with a verdict", () => {
		const probe = runDriver(["--probe"]);
		expect(probe.status).toBe(0);
		for (const rung of Object.keys(MARKER_BY_RUNG)) {
			expect(probe.stdout, `--probe said nothing about the ${rung} rung`).toMatch(
				new RegExp(`^ {2}${rung}\\s+(AVAILABLE|unavailable|not in the selection order)`, "m"),
			);
		}
	});

	/**
	 * An unavailable rung has to say WHY, and the reason has to come from the thing
	 * that actually failed. A bare "unavailable" sends the reader to read four shell
	 * files to discover that a socket is missing.
	 *
	 * The bwrap case is the strong one: the reason must name the shim on PATH, which
	 * the probe can only report by having executed it. A probe rewritten to trust
	 * `command -v` would find the shim, call the rung available, and this goes red.
	 */
	it("prints a reason naming what it actually tried", () => {
		const { env, binDir } = noRungEnv();
		const probe = runDriver(["--probe"], env);

		expect(reasonFor(probe.stdout, "docker")).toMatch(/docker (daemon not reachable|not on PATH)/);
		expect(reasonFor(probe.stdout, "remote")).toMatch(/(is not readable|cannot reach|not on PATH)/);
		expect(reasonFor(probe.stdout, "bwrap")).toContain(path.join(binDir, "bwrap"));
	});
});

describe("a pinned rung", () => {
	/**
	 * The substitution bug. `--rung=remote` on a host that cannot reach the remote
	 * must fail; descending to docker would hand back a green run on a boundary the
	 * caller explicitly did not ask for. The sentinel proves no OTHER rung ran it.
	 */
	it("fails rather than substituting a different rung when it is unavailable", () => {
		const run = runDriver(["--rung=remote", "sh", "-c", `echo ${SENTINEL}`], {
			VEYYON_SANDBOX_REMOTE_KEY: "/nonexistent/rung-contract-no-key",
		});

		expect(run.status).not.toBe(0);
		expect(run.stdout).not.toContain(SENTINEL);
		expect(run.stderr).toContain("Refusing to substitute a weaker boundary");
	});

	/**
	 * A typo'd rung name must be an error. Silently ignoring it would run the suite
	 * on whatever the ladder picked while the caller believed they had pinned
	 * something, which is the substitution bug wearing a different hat.
	 */
	it("refuses a name that is not a rung", () => {
		const run = runDriver(["--rung=totally-not-a-rung", "sh", "-c", `echo ${SENTINEL}`]);

		expect(run.status).not.toBe(0);
		expect(run.stdout).not.toContain(SENTINEL);
		expect(run.stderr).toContain("unknown rung 'totally-not-a-rung'");
	});
});

describe("when no rung is available", () => {
	/**
	 * The one behaviour that would make this whole directory a lie: running the
	 * command on the bare host because nothing else could be arranged. The sentinel
	 * is the assertion; the exit code alone would pass even if the suite had already
	 * scribbled through the operator's home on its way to failing.
	 */
	it("refuses to run the command at all", () => {
		const run = runDriver(["sh", "-c", `echo ${SENTINEL}`], noRungEnv().env);

		expect(run.stdout).not.toContain(SENTINEL);
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("this script will not run it on the host");
	});
});

describe("the guest this suite is running in", () => {
	/**
	 * The marker contract, asserted from inside rather than by spawning a container:
	 * this process IS a guest, so its own environment is the real evidence.
	 *
	 * A rung that forgot to export the marker, or exported a name nothing else
	 * knows, fails here. The bootstrap gate in `packages/utils/test/helpers/
	 * sandbox-gate.ts` reads the same variable, so an unrecognised value is a suite
	 * that believes it is sandboxed by a rung that does not exist.
	 */
	it("carries the marker of a rung that actually exists", () => {
		// `<unset>` rather than a cast: no marker at all is its own failure, and it
		// should read as one instead of as an unrecognised rung name.
		const marker = process.env.VEYYON_TEST_SANDBOX ?? "<unset>";

		expect(Object.values(MARKER_BY_RUNG)).toContain(marker);
	});

	/*
	 * There is deliberately no test here for "the declared host home is unreadable".
	 * The bootstrap preload asserts exactly that before any test in this process
	 * runs, so a rung that leaves the home reachable aborts the run with its own
	 * report and a test asserting it again can never go red. It was written, its
	 * mutation (binding HOST_HOME into the docker rung) was caught by the preload
	 * instead, and it was deleted rather than kept as a case that cannot fail.
	 */
});

/**
 * The remote rung's rsync honours `.gitignore`, and a few generated files that are
 * gitignored live inside a package's `src/` and are imported at runtime. A local
 * rung binds the work tree and gets them for free. The remote rung has to put them
 * back explicitly, and the list it uses has to be narrow.
 */
describe("the files the remote rung puts back after honouring .gitignore", () => {
	/** The `+ /path` rsync include lines `remote_sync` prepends to its filter chain. */
	function includeLines(): string[] {
		const child = Bun.spawnSync({
			cmd: [
				"bash",
				"-c",
				`REPO_ROOT=${JSON.stringify(REPO_ROOT)}; . ${JSON.stringify(path.join(REPO_ROOT, "scripts", "test-sandbox", "rungs", "remote.sh"))}; remote_generated_sources_filter`,
			],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.stderr.toString()).toBe("");
		return child.stdout.toString().split("\n").filter(Boolean);
	}

	/**
	 * The reported outage. Every coding-agent suite died on the remote rung with
	 * "Cannot find module './tool-views.generated.js'", which reads like a broken
	 * import and is really a file rsync declined to ship. The file is generated, so
	 * it is gitignored, so the gitignore filter dropped it.
	 */
	it("carries a generated source that a package imports at runtime", () => {
		expect(includeLines()).toContain("+ /packages/coding-agent/src/export/html/tool-views.generated.js");
	});

	/**
	 * The safety rail on the fix. `git ls-files --others --ignored` collapses a wholly
	 * ignored directory into one entry and disregards the pathspec when it does, so
	 * the unfiltered answer offers to re-include `packages/deepswe-bench/repo-cache`:
	 * thousands of cloned repositories, tens of gigabytes, on every test run over the
	 * LAN. Nothing that is not a regular file under a package's own src is put back.
	 */
	it("puts back nothing but regular files under a package's own src", () => {
		for (const line of includeLines()) {
			expect(line).toMatch(/^\+ \/packages\/[^/]+\/src\/[^\n]*[^/]$/);
		}
	});
});
