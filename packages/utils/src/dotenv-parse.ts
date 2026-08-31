/**
 * Reading a `.env` file, and deciding which names and values may enter the environment at all.
 *
 * WHY THIS IS ITS OWN MODULE. Applying a user's `.env` happens in TWO phases and the two phases cannot
 * share a module. `$HOME/.env` needs nothing but `os.homedir()`, and `dirs.ts` has to see it: the resolver
 * builds its paths at module load, and `VEYYON_CODING_AGENT_DIR` or `XDG_CONFIG_HOME` arriving from
 * `$HOME/.env` decides what those paths ARE. `<configRoot>/.env` and `<agentDir>/.env` are the opposite
 * case: you cannot read them until you know where those directories are, so they can only be applied after
 * `dirs.ts` exists. `dotenv-home.ts` is phase one and `dirs.ts` imports it; `env.ts` is phase two and
 * imports `dirs.ts`.
 *
 * Both phases need the same parser and the same admission rules, and there is exactly one copy of each,
 * here, in a module that imports `node:fs` and one predicate. Two copies would be worse than a cycle: the
 * phases would disagree about which keys are acceptable, and a key admitted in one and rejected in the
 * other reads as a `.env` line that works in some processes.
 *
 * THE REPORTER IS A PARAMETER, not a default. Phase one runs before `logger.ts` can be imported (the logger
 * asks `dirs.ts` where the log directory is, which is the cycle this split exists to avoid), so it reports
 * through `process.emitWarning`, the same channel `dirs.ts` already uses at module scope. Phase two has the
 * logger and uses it. Neither may be omitted: a `.env` that exists and cannot be read is usually the file
 * holding the user's API keys, and the symptom of dropping it silently is an authentication failure nobody
 * can trace back to a permission bit (Law 10).
 */

import * as fs from "node:fs";
// `isMissingPath` has one owner and `fs-error.ts` imports nothing, so naming it here adds one module
// and no cycle. Phase one of the `.env` application imports this file before the directory resolver
// exists, which rules out `logger.ts` and `dirs.ts` but not a predicate over an error code.
import { isMissingPath } from "./fs-error";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into `Bun.env` -- those should be
 * referenceable as `$NAME` from POSIX shells, so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

/**
 * The only names that are genuinely unsafe to forward to a native `execve` spawn: empty, containing `=`
 * (would corrupt the `KEY=VALUE` framing) or NUL (terminates the C string mid-entry). Windows ships
 * standard variables whose names contain parentheses (e.g. `ProgramFiles(x86)`,
 * `CommonProgramFiles(x86)`) -- those MUST survive the scrub so downstream resolvers (Git Bash discovery
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

/** How a caller is told that a `.env` file exists and could not be read. */
export type UnreadableEnvFileReporter = (filePath: string, error: unknown) => void;

/**
 * Parse a `.env` file into key-value pairs. Blank lines and `#` comments are skipped, whitespace is
 * trimmed, and a value may be wrapped in single or double quotes.
 *
 * A missing file yields an empty record and says nothing, because most of the probed locations do not
 * exist. Any OTHER failure is reported through `onUnreadable` before the empty record is returned, so a
 * permission bit on the file holding the user's keys cannot read as "no `.env` configured".
 */
export function parseEnvFile(filePath: string, onUnreadable: UnreadableEnvFileReporter): Record<string, string> {
	const result: Record<string, string> = {};
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if (!isMissingPath(error)) onUnreadable(filePath, error);
		return result;
	}

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;

		const key = trimmed.slice(0, eqIndex).trim();
		if (!isValidEnvName(key)) continue;

		let value = trimmed.slice(eqIndex + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (!isSafeEnvValue(value)) continue;

		result[key] = value;
	}
	return result;
}
