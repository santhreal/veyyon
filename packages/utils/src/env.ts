import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, refreshDirsFromEnv } from "./dirs";
import { isMissingPath } from "./fs-error";
import * as logger from "./logger";
import { errorMessage } from "./type-guards";

export * from "./worker-host";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

/**
 * The only names that are genuinely unsafe to forward to a native `execve`
 * spawn: empty, containing `=` (would corrupt the `KEY=VALUE` framing) or
 * NUL (terminates the C string mid-entry). Windows ships standard variables
 * whose names contain parentheses (e.g. `ProgramFiles(x86)`, `CommonProgramFiles(x86)`)
 * — those MUST survive the scrub so downstream resolvers (Git Bash discovery
 * in `procmgr.ts`, etc.) can still read them.
 */
export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function isMacosMallocStackLoggingEnvName(name: string): boolean {
	return name === "MallocStackLogging" || name === "MallocStackLoggingNoCompact";
}

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
 * Parses a .env file synchronously and extracts key-value string pairs.
 * Ignores lines that are empty or start with '#'. Trims whitespace.
 * Allows values to be quoted with single or double quotes.
 * Returns an object of key-value pairs.
 *
 * Four candidate paths are probed on startup (cwd, agent dir, config root, home)
 * and most of them are absent, so a missing file says nothing. A file that EXISTS
 * and cannot be read is reported: it is usually the one holding the user's API
 * keys, and the symptom of dropping it silently is an authentication failure
 * nobody can trace back to a permission bit (Law 10).
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			// Skip comments and blank lines
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;

			const key = trimmed.slice(0, eqIndex).trim();
			if (!isValidEnvName(key)) continue;

			let value = trimmed.slice(eqIndex + 1).trim();

			// Remove surrounding quotes (" or ')
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!isSafeEnvValue(value)) continue;

			result[key] = value;
		}
	} catch (error) {
		if (!isMissingPath(error)) {
			logger.warn("Environment file exists but could not be read; none of its variables were applied.", {
				path: filePath,
				error: errorMessage(error),
			});
		}
	}

	return result;
}

// Eagerly parse the user's $HOME/.env and the current project's .env (from cwd)
const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const configRootEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(process.cwd(), ".env"));

for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}

for (const file of [projectEnv, agentEnv, configRootEnv, homeEnv]) {
	for (const key in file) {
		if (!isMacosMallocStackLoggingEnvName(key) && !Bun.env[key]) {
			Bun.env[key] = file[key];
		}
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
