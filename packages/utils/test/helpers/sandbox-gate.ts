/**
 * The fail-closed gate: a test process that cannot PROVE the operator's home is
 * unreachable does not run.
 *
 * ## The bug this locks out
 *
 * Every earlier protection in this directory is a redirect or a detector, and both
 * shapes share one defect: they still run the suite. `./sandbox-home` moves
 * `os.homedir()` to a temp directory; `./real-data-tripwire` throws on a write that
 * names the real config root. Both are in-process, both are written in the same
 * language the tests are, and both can be walked around by any test that resolves a
 * path some way they did not anticipate. The scoreboard for that design is 136 stray
 * `.veyyon*` directories in the operator's real home, every one created while the
 * redirect and the tripwire were installed and reporting success.
 *
 * ## Why this is a PROOF and not a marker
 *
 * The first version of this file checked one environment variable for non-emptiness.
 * That is the same defect wearing a hat: a control that is declared, defaulted,
 * documented, and enforcing nothing, because the developer it inconveniences can
 * satisfy it with an `export`. The gate now verifies the PROPERTY -- that the
 * operator's home is not reachable through this process's filesystem view -- by
 * reading the filesystem. A kernel boundary passes it. A hand-set string cannot,
 * because no environment variable can make a directory unreadable.
 *
 * ## What is checked, and against what
 *
 * Measured on this repository's two real configurations, host and rung-one container
 * (`docker run --rm --network none -v "$PWD":/repo:ro -w /repo oven/bun:<version>`):
 *
 * | fact                              | host               | container      |
 * | --------------------------------- | ------------------ | -------------- |
 * | `/etc/passwd` home for this uid   | `/home/<operator>` | `/root`        |
 * | that path readable                | yes                | yes            |
 * | `.veyyon*` entries in it          | 137                | 0              |
 * | entries under `/home`             | `<operator>`       | `bun`          |
 * | `/Users`                          | absent             | absent         |
 * | `/home/<operator>`                | readable           | ENOENT         |
 *
 * So readability alone does not separate them -- the container's `/root` is readable too --
 * and the separating facts are: is a veyyon config root reachable from the account home,
 * and is the path the sandbox says it hid actually gone. Both are properties of the mount
 * namespace. Neither can be forged from the environment.
 *
 * The account home is read from `/etc/passwd` and NOT from `os.userInfo().homedir`, which
 * follows `$HOME` under Bun and therefore answers whatever the last redirect set. Measured:
 * `HOME=/tmp/x bun -e 'os.userInfo().homedir'` prints `/tmp/x`. Using it made the first
 * version of this clause both unsound (a HOME redirect hid the operator's real home from
 * the check) and wrong in the other direction (the sandbox's own disposable home, once a
 * suite had created `.veyyon` in it, was reported as the operator's).
 *
 * ## The residual, stated plainly
 *
 * A machine that has never run veyyon, whose home therefore holds no `.veyyon*`, is
 * not distinguishable from a sandbox by clause A or B alone; clause C is what closes
 * it, and clause C rests on the sandbox naming the path it hid. Forging clause C means
 * naming a path you know to be absent, which is a deliberate act, and it does not help
 * anyone who has ever run veyyon on the machine, because clause A still bites. The
 * boundary that removes the residual entirely is the microVM rung, where there is no
 * host filesystem to reach; this gate is what refuses to proceed when that boundary is
 * not there.
 *
 * ## What breaks if this regresses
 *
 * Softening any clause to a warning, or reinstating "the marker is enough", returns the
 * repository to the state that produced the 136 directories. The gate suite
 * `packages/utils/test/sandbox-gate-contracts.test.ts` fails when it does.
 */

import * as path from "node:path";
import { SANDBOX_MARKER_ENV_KEY } from "../../src/dir-env-keys";

/**
 * `node:fs` and `node:os` through `require`, and NEVER through `import * as`.
 *
 * This module is the FIRST thing the test preload graph evaluates, which makes it the
 * most dangerous possible place to materialize an ESM namespace for either module. Bun
 * builds a module's ESM namespace once for the whole graph and freezes it, so an
 * `import * as fs from "node:fs"` here would hand every later importer the UNPATCHED
 * functions: `./real-data-tripwire` patches the CJS export object, and the patch would
 * become invisible. The same trap already disabled the home redirect once through
 * `./temp-dir-janitor`. It cost the entire tripwire the first time this gate was
 * written with plain imports: 14 suites went from guarded to silently unguarded.
 * `scripts/tests-never-touch-real-home.test.ts` walks this graph and fails if either
 * ESM binding reappears.
 *
 * `node:path` is exempt because nothing patches it -- it is pure string arithmetic.
 */
const fsModule = require("node:fs") as typeof import("node:fs");
const osModule = require("node:os") as typeof import("node:os");

/**
 * The marker the sandbox guest sets. A FAST PRE-CHECK ONLY.
 *
 * Its absence refuses immediately with the command to run, which is the message a
 * developer needs and which costs no syscalls. Its presence decides nothing: the proof
 * below runs regardless and is what actually admits the process. Keeping the two apart
 * is the point -- the first version of this gate stopped at this line.
 */
export const SANDBOX_MARKER_ENV = SANDBOX_MARKER_ENV_KEY;

/**
 * The path the sandbox declares it removed from the filesystem view.
 *
 * Additive evidence, never a grant: the gate requires this path to be UNREADABLE, so
 * the variable can only ever make the check harder to pass. That asymmetry is what
 * makes it safe to read a value the process itself could have written.
 */
export const HOST_HOME_ENV = "VEYYON_TEST_HOST_HOME";

/** The one command that puts a shell inside the sandbox. */
export const SANDBOX_ENTRYPOINT = "bash scripts/test-sandbox.sh";

/**
 * The config-root directory name, spelled here rather than imported.
 *
 * `CONFIG_DIR_NAME` lives in `packages/utils/src/dirs.ts`, and `dirs.ts` is precisely
 * the module that must not be evaluated before this gate has decided: it resolves and
 * caches every veyyon path at module load, from the home this gate has not yet cleared.
 * A four-character literal is the cheaper of the two couplings, and
 * `sandbox-gate-contracts.test.ts` asserts the two spellings agree.
 */
const CONFIG_ROOT_PREFIX = ".veyyon";

/** The conventional roots under which a human home sits, on the two platforms CI runs. */
const HOME_ROOTS = ["/home", "/Users"] as const;

/** One reason the process is not provably isolated, in the words the developer needs. */
export interface Breach {
	/** The clause that failed: `A` passwd home, `B` home-root scan, `C` declared host home, `D` config root. */
	readonly clause: "A" | "B" | "C" | "D";
	/** The path that proved reachable. */
	readonly path: string;
	/** What about it proves the operator's filesystem is in reach. */
	readonly detail: string;
}

/**
 * The `.veyyon*` entries directly inside `dir`, or `undefined` when `dir` cannot be read.
 *
 * Unreadable is the ANSWER, not an error: a home that cannot be listed cannot be written
 * into either, which is the property under test. Every failure mode collapses to the
 * same safe answer, so a permission model this code has not anticipated cannot produce
 * a false pass.
 */
function veyyonEntriesIn(dir: string): string[] | undefined {
	try {
		return fsModule.readdirSync(dir).filter(entry => entry.startsWith(CONFIG_ROOT_PREFIX));
	} catch {
		return undefined;
	}
}

/** True when `candidate` is `root` or sits underneath it. */
function isUnder(candidate: string, root: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * The home directory the ACCOUNT DATABASE records for this process's uid, or `undefined`
 * when there is no readable entry for it.
 *
 * Read out of `/etc/passwd` by hand rather than through `os.userInfo()`, because
 * `os.userInfo().homedir` follows `$HOME` under Bun and so answers whatever the last
 * redirect set, which is exactly the value this function exists to see past.
 *
 * `undefined` on a container run under an arbitrary `--user` with no passwd entry, and on
 * any platform that keeps accounts somewhere else. That is a missing anchor, not a pass:
 * clause C is mandatory precisely so the proof does not rest on this one.
 */
function accountDatabaseHome(): string | undefined {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid === undefined) return undefined;
	let passwd: string;
	try {
		passwd = fsModule.readFileSync("/etc/passwd", "utf8");
	} catch {
		return undefined;
	}
	for (const line of passwd.split("\n")) {
		// name:password:uid:gid:gecos:home:shell
		const fields = line.split(":");
		if (fields.length < 7 || fields[2] !== String(uid)) continue;
		const home = fields[5];
		if (home && path.isAbsolute(home)) return path.resolve(home);
	}
	return undefined;
}

/**
 * Every reason this process is not provably isolated. Empty means the proof holds.
 *
 * Exported whole rather than as a boolean so the gate suite can assert WHICH clause
 * caught a given forgery. A test that only knows "it refused" cannot tell a working
 * proof from a proof that refuses everything.
 */
export function isolationBreaches(): Breach[] {
	const breaches: Breach[] = [];
	// This process's OWN home. Inside the sandbox it is a disposable tmpfs path, and clauses
	// C and D ask where it sits relative to the home the sandbox says it removed.
	const home = osModule.homedir();

	// A. The ACCOUNT DATABASE home, read out of /etc/passwd for this uid.
	//
	//    NOT `os.userInfo().homedir`, which is what this clause used first and which does
	//    not do what its name says: measured under Bun 1.3.14, `HOME=/tmp/x bun -e
	//    'os.userInfo().homedir'` answers `/tmp/x`. It follows the environment, so it was
	//    worthless as an anchor and worse than worthless as a claim -- the comment here
	//    asserted "no environment variable moves it" while an environment variable moved it.
	//    It also produced a live false positive: inside the sandbox `HOME` is a temp
	//    directory, a suite legitimately creates `.veyyon` in it, and the next child this
	//    process spawned was refused for finding a config root in its own disposable home.
	//
	//    /etc/passwd cannot be moved by the environment. On the host it names the operator's
	//    real home whatever `HOME` has been redirected to, which is the hole the in-process
	//    redirect leaves open; inside the sandbox it names the guest account, and the
	//    redirected temp `HOME` is not it, so the guest's own config root does not trip this.
	//
	//    macOS resolves real accounts through Directory Services rather than /etc/passwd, so
	//    on a Mac this clause usually finds nothing and clauses B and C carry the weight.
	//    That is stated rather than papered over: it is why C is mandatory.
	const passwdHome = accountDatabaseHome();
	if (passwdHome) {
		const stray = veyyonEntriesIn(passwdHome);
		if (stray && stray.length > 0) {
			breaches.push({
				clause: "A",
				path: passwdHome,
				detail: `readable and holds ${stray.length} veyyon config root(s) (${stray.slice(0, 3).join(", ")}), so this is the operator's real home`,
			});
		}
	}

	// B. Any OTHER account's home on this filesystem. A run as a second user, or a
	//    container that bind-mounted /home wholesale, reaches the operator through it.
	for (const root of HOME_ROOTS) {
		let entries: string[];
		try {
			entries = fsModule.readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const candidate = path.join(root, entry);
			const stray = veyyonEntriesIn(candidate);
			if (stray && stray.length > 0) {
				breaches.push({
					clause: "B",
					path: candidate,
					detail: `readable and holds ${stray.length} veyyon config root(s), so a real home is in reach`,
				});
			}
		}
	}

	// C. The path the sandbox says it hid. Required to be gone, so the declaration can
	//    only tighten the check. Its ABSENCE from the environment is itself a breach:
	//    a sandbox that cannot name what it removed has not demonstrated it removed one.
	const declared = process.env[HOST_HOME_ENV];
	if (declared === undefined || declared === "") {
		breaches.push({
			clause: "C",
			path: "(none)",
			detail: `${HOST_HOME_ENV} is unset, so no host home was declared removed and there is nothing to verify`,
		});
	} else {
		try {
			fsModule.accessSync(declared, fsModule.constants.R_OK);
			breaches.push({
				clause: "C",
				path: declared,
				detail: "declared as removed from this filesystem view, but it is readable",
			});
		} catch {
			// Absent or unreadable: the declaration holds.
		}
		if (isUnder(home, declared)) {
			breaches.push({
				clause: "C",
				path: home,
				detail: `os.homedir() resolves inside the declared host home (${declared})`,
			});
		}
	}

	// D. The config root this process would use. `dirs.ts` refuses the same shape at its
	//    own layer; this is the copy that runs BEFORE `dirs.ts` is allowed to load, so a
	//    module-load-time resolution cannot get in ahead of the proof.
	const override = process.env.VEYYON_CONFIG_DIR;
	if (override !== undefined && override.trim() !== "") {
		const resolved = path.isAbsolute(override) ? path.resolve(override) : path.resolve(home, override);
		for (const breach of breaches) {
			if (breach.path !== "(none)" && isUnder(resolved, breach.path)) {
				breaches.push({
					clause: "D",
					path: resolved,
					detail: `VEYYON_CONFIG_DIR resolves inside a reachable real home (${breach.path})`,
				});
				break;
			}
		}
	}

	return breaches;
}

/**
 * The refusal, as text.
 *
 * Separate from the exit so the gate suite can assert the wording without spawning, and
 * so the one thing a developer needs -- the command that works -- is written once.
 *
 * `argv` is rebuilt from `process.argv`, whose shape under a `--preload` is
 * `[<absolute bun binary>, ...test paths]`: Bun has already consumed the `test`
 * subcommand and its own flags. Printing the run they actually asked for beats generic
 * advice, because the whole point is that they can paste one line and continue.
 */
export function refusalMessage(argv: readonly string[], breaches: readonly Breach[]): string {
	const rerun = argv.length > 0 ? `${SANDBOX_ENTRYPOINT} ${argv.join(" ")}` : `${SANDBOX_ENTRYPOINT} bun test`;
	const reasons = breaches.map(breach => `  [${breach.clause}] ${breach.path}\n        ${breach.detail}\n`).join("");
	return (
		`REFUSED: this test process cannot prove the operator's home is out of reach.\n` +
		`\n` +
		`${reasons}` +
		`\n` +
		`A test run against a reachable real home is what left 136 stray ${CONFIG_ROOT_PREFIX}* directories in one.\n` +
		`Nothing has been read or written.\n` +
		`\n` +
		`Run it inside the sandbox instead:\n` +
		`  ${rerun}\n` +
		`\n` +
		`There is no flag to skip this, and setting ${SANDBOX_MARKER_ENV} by hand does not help: the checks above\n` +
		`read the filesystem, and no environment variable can make a directory unreadable. If you are seeing this\n` +
		`from inside the sandbox, the sandbox failed to isolate and the run must not continue.\n`
	);
}

/**
 * Refuse to continue unless isolation is proven.
 *
 * Writes to stderr and exits rather than throwing. A throw from a `--preload` module is
 * reported by Bun as an unhandled error with a stack trace through the loader, and the
 * one line that matters ends up under twenty that do not. Exit code 1 so CI fails on it.
 *
 * Called at module load, below. Exported so the gate suite can drive it directly.
 */
export function enforceIsolationOrExit(): void {
	const argv = ["bun", "test", ...process.argv.slice(1)];
	if (!process.env[SANDBOX_MARKER_ENV]) {
		process.stderr.write(
			refusalMessage(argv, [
				{
					clause: "C",
					path: "(none)",
					detail: `${SANDBOX_MARKER_ENV} is unset, so this process was not started by the sandbox`,
				},
			]),
		);
		process.exit(1);
	}
	const breaches = isolationBreaches();
	if (breaches.length === 0) return;
	process.stderr.write(refusalMessage(argv, breaches));
	process.exit(1);
}

enforceIsolationOrExit();
