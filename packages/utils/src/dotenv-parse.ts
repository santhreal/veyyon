/**
 * Applying a user's `.env` happens in two phases that cannot share a module: `$HOME/.env` needs only `os.homedir()` and must run before `dirs.ts`.
 * `<configRoot>/.env` and `<agentDir>/.env` can only be applied after `dirs.ts` exists. Both phases share one parser and one admission rule.
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
