import * as os from "node:os";
import * as path from "node:path";
import { directoryExists, expandTilde, getProjectDir, normalizePathForComparison, setProjectDir } from "@veyyon/utils";
import chalk from "chalk";
import type { Settings } from "../config/settings";
import type { Args } from "./args";

/** When you launch from your bare home directory (and pass neither `--cwd` nor `--allow-home`), rooting the session at `$HOME` would make every project-relative */
async function maybeAutoChdir(parsed: Args): Promise<string | undefined> {
	if (parsed.allowHome || parsed.cwd) {
		return undefined;
	}

	const home = os.homedir();
	if (!home) {
		return undefined;
	}

	const normalizePath = normalizePathForComparison;

	const cwd = normalizePath(getProjectDir());
	const normalizedHome = normalizePath(home);
	if (cwd !== normalizedHome) {
		return undefined;
	}

	const candidates = [path.join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await directoryExists(candidate))) {
				continue;
			}
			setProjectDir(candidate);
			return getProjectDir();
		} catch {
			// Try next candidate.
		}
	}

	try {
		const fallback = os.tmpdir();
		if (fallback && normalizePath(fallback) !== cwd && (await directoryExists(fallback))) {
			setProjectDir(fallback);
			return getProjectDir();
		}
	} catch {
		// Ignore fallback errors.
	}
	return undefined;
}

/** Tell the operator that the launch relocated away from `$HOME`, and how to opt out or choose a directory. One line on stderr (safe in every output mode; JSON */
export function announceAutoChdir(home: string, target: string): void {
	process.stderr.write(
		`${chalk.yellow(`Not rooting the session at your home directory (${home}).`)}` +
			`${chalk.dim(` Started in ${target} instead.`)}\n` +
			`${chalk.dim(
				"  Use --cwd <dir> to choose a directory, --allow-home to stay in home, " +
					"or set session.workdir for a per-profile default.",
			)}\n`,
	);
}

/** Apply an explicit CLI `--cwd` (highest precedence), otherwise maybe auto-chdir away from `$HOME`. Profile `session.workdir` is applied later by */
export async function applyStartupCwd(parsed: Args): Promise<string | undefined> {
	if (parsed.cwd) {
		setProjectDir(parsed.cwd);
		// setProjectDir resolves the (possibly relative) target against the launch cwd and chdirs into it. Re-sync parsed.cwd to the resolved absolute path
		parsed.cwd = getProjectDir();
		return undefined;
	}
	return maybeAutoChdir(parsed);
}

/** Re-root the session at the profile `session.workdir` setting when the user launched without an explicit --cwd. */
export async function applySessionWorkdir(
	settings: Pick<Settings, "get" | "reloadForCwd">,
	parsedCwd: string | undefined,
): Promise<boolean> {
	if (parsedCwd) {
		// An explicit --cwd already re-rooted the session and outranks the setting.
		return false;
	}

	const raw = settings.get("session.workdir")?.trim();
	if (!raw) {
		return false;
	}

	const expanded = expandTilde(raw);
	if (!path.isAbsolute(expanded)) {
		throw new Error(
			`session.workdir must be an absolute or ~-relative path, got ${JSON.stringify(raw)}. ` +
				`Set an absolute directory: veyyon config set session.workdir /path/to/project`,
		);
	}

	const resolved = path.resolve(expanded);
	if (!(await directoryExists(resolved))) {
		throw new Error(
			`session.workdir points at a missing directory: ${resolved}. ` +
				`Create it, or clear the setting: veyyon config set session.workdir ""`,
		);
	}

	if (normalizePathForComparison(resolved) === normalizePathForComparison(getProjectDir())) {
		// Already rooted here; nothing to change.
		return false;
	}

	setProjectDir(resolved);
	await settings.reloadForCwd(getProjectDir());
	return true;
}
