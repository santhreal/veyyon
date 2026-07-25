/**
 * The one guard that stands between a corruption/edge-case test and the
 * developer's REAL data.
 *
 * The corruption campaign deliberately does destructive things: it writes
 * garbage over credential databases, truncates SQLite files, corrupts settings,
 * contaminates profile directories, and interrupts installs. Every one of those
 * is safe against a temp directory and catastrophic against `~/.veyyon` — it
 * would destroy real logins and real settings on the machine running the suite.
 * A test that resolves its paths through the normal helpers will silently target
 * the real home the moment its isolation setup is wrong, incomplete, or removed
 * by a later edit, and nothing about that failure looks like a failure: the test
 * still passes, and the damage is to files no assertion looks at.
 *
 * So isolation is not left to each test's good intentions. Two mechanisms:
 *
 *  1. {@link assertHermeticEnvironment} — call it before ANY destructive
 *     operation. It refuses to continue unless `HOME` has been redirected into
 *     the OS temp directory, which is the property that makes every downstream
 *     path helper resolve somewhere disposable. It fails CLOSED: if it cannot
 *     prove isolation, the test errors instead of proceeding.
 *  2. {@link guardDestructivePath} — a belt-and-braces check on a specific path
 *     about to be corrupted or deleted, for operations that build a path
 *     directly rather than through the helpers.
 *
 * Operations that genuinely cannot be sandboxed — a real install that mutates
 * PATH, an update that replaces the binary on disk, anything touching the
 * machine's shell profile — must not run on a developer machine at all. Those
 * are gated behind {@link DESTRUCTIVE_TESTS_ENABLED}, which CI opts into
 * explicitly and a local run never does. See {@link describeDestructive}.
 */
import * as os from "node:os";
import * as path from "node:path";

/**
 * The home directory as it was BEFORE any test redirected `HOME`, captured once
 * at module load. Comparing against this catches the case where a test's
 * isolation silently no-ops and the app still resolves the real home.
 */
const REAL_HOME_AT_LOAD = os.homedir();

/**
 * The home directory the APPLICATION will actually use, which is what every
 * config/credential path is built from (`getBaseConfigRoot` joins
 * `os.homedir()`).
 *
 * This deliberately does NOT read `process.env.HOME`, and that distinction is
 * the whole point of this function. Bun resolves `os.homedir()` ONCE at process
 * start; assigning `process.env.HOME` afterwards changes the env var and changes
 * nothing else. A guard that trusted `process.env.HOME` therefore reported
 * "isolated" for a suite whose paths still resolved to the developer's real
 * `~/.veyyon` — which is exactly how a credential-store test came to write rows
 * into the real shared store. Isolation must be proven against the value the app
 * reads, never against the value the test hoped to set.
 */
function applicationHome(): string {
	return os.homedir();
}

/** Env var CI sets to opt into tests that mutate machine state outside a temp dir. */
export const DESTRUCTIVE_TESTS_ENV = "VEYYON_DESTRUCTIVE_TESTS";

/**
 * Whether irreversible, machine-mutating tests (real installs, PATH edits,
 * binary replacement) may run. False on a developer machine unless explicitly
 * opted in, true in the CI job that is meant to be disposable.
 */
export const DESTRUCTIVE_TESTS_ENABLED: boolean = process.env[DESTRUCTIVE_TESTS_ENV] === "1";

function normalize(candidate: string): string {
	return path.resolve(candidate);
}

/** True when `candidate` lives inside `root` (or is `root`). */
function isInside(candidate: string, root: string): boolean {
	const rel = path.relative(normalize(root), normalize(candidate));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Refuse to proceed unless the process is running against an isolated,
 * disposable HOME. Call this at the top of any test (or harness) that corrupts,
 * truncates, or deletes state that the app would normally keep under the user's
 * home directory.
 *
 * `context` is quoted in the failure so a tripped guard names the suite that
 * forgot to isolate itself.
 */
export function assertHermeticEnvironment(context: string, home: string = applicationHome()): void {
	if (!home) {
		throw new Error(
			`${context}: refusing to run a destructive test with no home directory resolved. ` +
				`Start the test process with HOME already pointing into a temp directory (see destructive-guard).`,
		);
	}
	const tempRoot = os.tmpdir();
	if (!isInside(home, tempRoot)) {
		throw new Error(
			`${context}: refusing to run a destructive test — the application's home directory is "${home}", which is NOT ` +
				`inside the OS temp directory ("${tempRoot}"). This test corrupts or deletes state under that home, so running ` +
				`it here would damage real user data. Note that setting process.env.HOME in beforeEach does NOT work: Bun ` +
				`resolves os.homedir() once at process start, so isolation must come from the spawned process's environment, ` +
				`or from an explicit app-level path override validated with assertIsolatedAppPath.`,
		);
	}
	if (normalize(home) === normalize(REAL_HOME_AT_LOAD)) {
		throw new Error(
			`${context}: refusing to run a destructive test — the home directory still equals the real one captured at startup ` +
				`("${REAL_HOME_AT_LOAD}"). The isolation setup did not take effect.`,
		);
	}
}

/**
 * Prove that a path the APPLICATION resolved (not one the test constructed) is
 * disposable, before writing to it.
 *
 * Use this whenever a suite isolates itself through an app-level override rather
 * than through the process environment — for example pointing the config root at
 * a temp directory. In that setup {@link assertHermeticEnvironment} cannot help,
 * because the real home is still the process home; the only trustworthy evidence
 * is the path the app's own resolver returned. Feed that value here BEFORE
 * opening or writing the file.
 *
 * This is the check whose absence let a profile-isolation test open the real
 * `~/.veyyon/shared-auth/agent.db`: the test asserted on paths it expected, and
 * wrote to the path the app actually computed, and nothing compared the two.
 */
export function assertIsolatedAppPath(resolved: string, context: string): string {
	return guardDestructivePath(resolved, `${context}: application-resolved path`);
}

/**
 * Assert one specific path is disposable before corrupting or deleting it.
 *
 * Use for paths built directly (not via the app's path helpers), where the HOME
 * check alone would not prove the target is safe.
 */
export function guardDestructivePath(target: string, context: string): string {
	const resolved = normalize(target);
	const tempRoot = os.tmpdir();
	if (!isInside(resolved, tempRoot)) {
		throw new Error(
			`${context}: refusing to corrupt/delete "${resolved}" — it is outside the OS temp directory ("${tempRoot}"). ` +
				`Destructive tests may only target disposable paths.`,
		);
	}
	if (isInside(resolved, REAL_HOME_AT_LOAD)) {
		throw new Error(
			`${context}: refusing to corrupt/delete "${resolved}" — it is inside the real home directory ` +
				`("${REAL_HOME_AT_LOAD}").`,
		);
	}
	return resolved;
}

/**
 * Reason a machine-mutating suite is being skipped, for the skip message, so a
 * local run says WHY rather than silently reporting zero tests.
 */
export const DESTRUCTIVE_SKIP_REASON: string =
	`skipped: mutates machine state outside a temp dir (install/PATH/binary replacement). ` +
	`Set ${DESTRUCTIVE_TESTS_ENV}=1 to run — intended for disposable CI runners only.`;
