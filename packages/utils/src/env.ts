import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, refreshDirsFromEnv } from "./dirs";
// Phase one, for its side effect: the environment scrub and `$HOME/.env`, already applied by the time
// `./dirs` above resolved anything. Importing it here is not what makes it run for the resolver -- `dirs.ts`
// imports it itself -- but this module reads the key set it exports, and naming it states the ordering.
import { homeDotenvInjectedKeys } from "./dotenv-home";
import {
	isMacosMallocStackLoggingEnvName,
	isSafeEnvName,
	isSafeEnvValue,
	parseEnvFile as parseEnvFileWithReporter,
	type UnreadableEnvFileReporter,
} from "./dotenv-parse";
import * as logger from "./logger";
import { errorMessage } from "./type-guards";

export {
	isMacosMallocStackLoggingEnvName,
	isSafeEnvName,
	isSafeEnvValue,
	isValidEnvName,
} from "./dotenv-parse";
export * from "./worker-host";

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (
			!isSafeEnvName(key) ||
			isMacosMallocStackLoggingEnvName(key) ||
			value === undefined ||
			!isSafeEnvValue(value)
		) {
			continue;
		}
		result[key] = value;
	}
	return result;
}

/** Filters process env for child shells without launch-cwd `.env.local` values. */
export function filterChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = process.cwd(),
): Record<string, string> {
	const result = filterProcessEnv(env);
	const launchLocalEnv = parseEnvFile(path.join(cwd, ".env.local"));
	for (const key in launchLocalEnv) {
		if (result[key] === launchLocalEnv[key]) delete result[key];
	}
	return result;
}

/**
 * Report an unreadable `.env` through the logger, which phase two has and phase one does not.
 *
 * A missing file is silent (three of the four locations normally do not exist). A file that EXISTS and
 * cannot be read is reported with its path: it is usually the one holding the user's API keys, and the
 * symptom of dropping it silently is an authentication failure nobody can trace back to a permission bit.
 */
const reportUnreadableEnvFile: UnreadableEnvFileReporter = (filePath, error) => {
	logger.warn("Environment file exists but could not be read; none of its variables were applied.", {
		path: filePath,
		error: errorMessage(error),
	});
};

/**
 * Parse a `.env` file into key-value pairs, reporting an unreadable one through the logger.
 *
 * The parsing itself and the rules about which names and values may enter the environment live in
 * `./dotenv-parse`, which is the module both application phases share. This is the phase-two spelling of
 * it, kept because callers outside this package name `parseEnvFile` and because the reporter is not
 * something a caller should have to choose.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	return parseEnvFileWithReporter(filePath, reportUnreadableEnvFile);
}

// The environment scrub: names and values that cannot survive a native `execve` come out of `Bun.env`
// before anything is added to it. A key containing `=` corrupts the `KEY=VALUE` framing of a spawn, and
// macOS's malloc-logging variables make every child process print diagnostics.
//
// IT LIVES HERE AND NOT IN PHASE ONE, deliberately. Importing `./dirs` must not mutate the caller's
// environment -- `profiles.test.ts`'s "dirs module import behavior" pins that inherited
// `MallocStackLogging` survives importing the path resolver -- and `./dirs` imports phase one. A program
// that wants the environment scrubbed asks for the environment, which is this module.
for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}

// Phase two: all four layers, now that the resolver exists and `<configRoot>` and `<agentDir>` are known.
// Phase one already applied the DIRECTORY-LOCATION keys out of `$HOME/.env` -- that is what let the paths
// below be resolved with the user's overrides in place -- and deliberately nothing else, so the home layer
// is read again here for the rest of it.
const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const configRootEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(process.cwd(), ".env"));

// Highest priority first. A key already in `Bun.env` wins, EXCEPT one that phase one injected from
// `$HOME/.env`: home is the lowest-priority layer and only happens to have been applied first, so these
// three files may displace it. Displacing removes the key from the set, so the next (lower-priority) file
// cannot displace it again and the original order survives the split.
for (const file of [projectEnv, agentEnv, configRootEnv, homeEnv]) {
	for (const key in file) {
		if (isMacosMallocStackLoggingEnvName(key)) continue;
		if (Bun.env[key] && !homeDotenvInjectedKeys.has(key)) continue;
		Bun.env[key] = file[key];
		homeDotenvInjectedKeys.delete(key);
	}
}

// Directory-affecting keys (XDG_*_HOME, and in default mode VEYYON_CODING_AGENT_DIR)
// may have just arrived from the profile/agent `.env` applied above. The dirs
// resolver cached its paths at module load — before this file ran — so rebuild
// it now from the updated env. `getAgentDir()` already located the `.env` from
// the profile name + home, so this re-reads only the directory vars.
refreshDirsFromEnv();

/**
 * Intentional re-export of Bun.env.
 *
 * All users should import this env module (import { $env } from "@veyyon/utils")
 * before using environment variables. This ensures that .env files have been loaded and
 * overrides (project, home) have been applied, so $env always reflects the correct values.
 */
export const $env: Record<string, string> = Bun.env as Record<string, string>;

/**
 * Resolve the first environment variable value from the given keys.
 * @param keys - The keys to resolve.
 * @returns The first environment variable value, or undefined if no value is found.
 */
export function $pickenv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = Bun.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

/**
 * Parses a positive decimal integer from `$env[name]`, or `defaultValue` when the
 * variable is unset or empty.
 *
 * The WHOLE value must be digits. This used to be a bare `Number.parseInt`, which
 * stops at the first character it cannot use and returns what it read so far, so
 * `VEYYON_TASK_MAX_OUTPUT_BYTES=5OO000` (letter O for zero) silently capped agent
 * output at FIVE BYTES rather than five hundred thousand. Taking a prefix of a value
 * the user got wrong is worse than ignoring it: the number that reaches the code is
 * one nobody chose.
 *
 * A variable that IS set and is not a positive integer is reported before the default
 * is used. `=0`, `=-5`, `=1_000_000` (underscores are source syntax, not environment
 * syntax) and `=10s` all name something specific, and returning the built-in default
 * with no word leaves the operator reasoning about a limit that was never in effect
 * (Law 10). The call still returns the default rather than throwing: an override typo
 * must not stop the process from starting.
 *
 * This is the single owner of "positive integer from the environment". `task/types.ts`
 * had its own `parseNumber` with a dead `try/catch` around `Number.parseInt`, which
 * does not throw.
 */
const POSITIVE_INTEGER_RE = /^\d+$/;

export function $envpos(name: string, defaultValue: number): number {
	const raw = $env[name]?.trim();
	if (!raw) return defaultValue;
	const parsed = POSITIVE_INTEGER_RE.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
	if (Number.isNaN(parsed) || parsed <= 0) {
		logger.warn("Environment variable is not a positive integer; using the default instead.", {
			name,
			value: raw,
			default: defaultValue,
		});
		return defaultValue;
	}
	return parsed;
}

/** True when `BUN_ENV` or `NODE_ENV` is the string `test`. */
export function isBunTestRuntime(): boolean {
	return Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
}

let terminalHeadless = isBunTestRuntime();

/**
 * True when real-terminal side effects must be suppressed: stdout escape/frame
 * writes, stdin raw-mode + resume, CSI/OSC capability probes, SIGWINCH, window
 * title changes, and emergency restore. Defaults to {@link isBunTestRuntime} so
 * `bun test` launched inside a real TTY never paints the TUI, leaks probe
 * queries, or hijacks the developer's stdin; production runtimes stay
 * interactive.
 *
 * Terminal-contract tests that must exercise the real I/O path opt out with
 * `setTerminalHeadless(false)` and restore it afterwards.
 */
export function isTerminalHeadless(): boolean {
	return terminalHeadless;
}

/**
 * Override the {@link isTerminalHeadless} default and return the previous value
 * so callers can restore exact prior state (`const prev = setTerminalHeadless(false); … setTerminalHeadless(prev);`).
 */
export function setTerminalHeadless(headless: boolean): boolean {
	const previous = terminalHeadless;
	terminalHeadless = headless;
	return previous;
}

/**
 * True when this code is running inside a `bun build --compile` standalone
 * binary. Detects via the embedded virtual-filesystem path markers
 * (`$bunfs`, `~BUN`, or its URL-encoded form `%7EBUN`) in `import.meta.url`,
 * which Bun rewrites for every module bundled into the executable. The
 * `VEYYON_COMPILED` env var (set by the build script's `--define`) is checked
 * first for cheap fast-path detection.
 */
export function isCompiledBinary(): boolean {
	if (process.env.VEYYON_COMPILED || Bun.env.VEYYON_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

const TRUTHY: Dict<boolean> = {
	"1": true,
	Y: true,
	y: true,
	TRUE: true,
	true: true,
	YES: true,
	yes: true,
	ON: true,
	on: true,
};
export function $flag(name: string, def: boolean = false): boolean {
	const value = $env[name];
	if (!value) return def;
	return TRUTHY[value] === true;
}
