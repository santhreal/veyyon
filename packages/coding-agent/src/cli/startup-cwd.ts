import * as os from "node:os";
import * as path from "node:path";
import { directoryExists, expandTilde, getProjectDir, normalizePathForComparison, setProjectDir } from "@veyyon/utils";
import chalk from "chalk";
import type { Settings } from "../config/settings";
import type { Args } from "./args";

/**
 * When you launch from your bare home directory (and pass neither `--cwd` nor
 * `--allow-home`), rooting the session at `$HOME` would make every project-relative
 * scan walk your whole home tree, so the launch relocates to a scratch directory
 * (`~/tmp`, then `/tmp`, then `/var/tmp`, then `os.tmpdir()`).
 *
 * This relocation MUST be surfaced, never silent (Law 10): a silent jump to `.`
 * is exactly what makes `--cwd` / `/cwd` / `session.workdir` feel broken, because a
 * user who launched "in their project" (home) lands somewhere else with no
 * explanation. The caller announces the returned target to the operator.
 *
 * The chain once held `.` between `~/tmp` and `/var/tmp`: it always exists, so
 * it shadowed every later fallback, and it rooted the session at the RELATIVE
 * path "." — $HOME with a broken base, the exact state this feature exists to
 * avoid (set_cwd resolved "." against ".", project discovery walked nothing).
 *
 * @returns the directory relocated to, or `undefined` when no relocation happened.
 */
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

/**
 * Tell the operator that the launch relocated away from `$HOME`, and how to opt
 * out or choose a directory. One line on stderr (safe in every output mode; JSON
 * and print keep stdout clean), so the relocation is loud instead of silent.
 *
 * The CALLER announces this, and only AFTER {@link applySessionWorkdir} has run:
 * a profile `session.workdir` re-roots the session away from the `/tmp` fallback,
 * so announcing at relocation time would print a false "Started in /tmp instead"
 * to a user who actually lands in their configured workdir (and tell them to set
 * a setting they already have). Announce only when the `/tmp` relocation is the
 * session's final resting place.
 */
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

/**
 * Apply an explicit CLI `--cwd` (highest precedence), otherwise maybe auto-chdir
 * away from `$HOME`. Profile `session.workdir` is applied later by
 * {@link applySessionWorkdir} after Settings.init — it outranks process cwd but
 * loses to an explicit `--cwd`.
 *
 * The relocation happens here (before Settings.init, because settings discovery
 * is cwd-relative) but is NOT announced here: the caller announces it via
 * {@link announceAutoChdir} only after `applySessionWorkdir`, and only if
 * `session.workdir` did not re-root elsewhere — otherwise the "Started in /tmp
 * instead" line is false for a user whose workdir takes over.
 *
 * @returns the auto-chdir target when the launch relocated away from home, else
 * `undefined`. The caller uses it to decide whether to announce.
 */
export async function applyStartupCwd(parsed: Args): Promise<string | undefined> {
	if (parsed.cwd) {
		setProjectDir(parsed.cwd);
		// setProjectDir resolves the (possibly relative) target against the launch
		// cwd and chdirs into it. Re-sync parsed.cwd to the resolved absolute path
		// so downstream consumers (buildSessionOptions, settings/discovery, session
		// persistence) don't re-resolve a relative string against the new cwd.
		parsed.cwd = getProjectDir();
		return undefined;
	}
	return maybeAutoChdir(parsed);
}

/**
 * Re-root the session at the profile `session.workdir` setting when the user
 * launched without an explicit --cwd.
 *
 * Precedence for the session working directory is: an explicit --cwd (already
 * applied by {@link applyStartupCwd}) wins, then this setting, then the
 * directory the process launched from. Call this AFTER `Settings.init`, because
 * `session.workdir` lives in the profile layer (cwd-independent) and the value
 * is only known once settings are loaded.
 *
 * The path is expanded (`~`) and must resolve to an existing absolute
 * directory. A relative path or a missing directory fails loudly rather than
 * silently rooting somewhere unexpected (no silent fallback). On a successful
 * re-root the project-local settings layer is reloaded from the new root so
 * per-project config follows the working directory.
 *
 * @returns `true` when the working directory was changed, `false` otherwise.
 */
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
