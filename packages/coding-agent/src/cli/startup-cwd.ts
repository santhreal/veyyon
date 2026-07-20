import * as os from "node:os";
import * as path from "node:path";
import { directoryExists, expandTilde, getProjectDir, normalizePathForComparison, setProjectDir } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import type { Args } from "./args";

async function maybeAutoChdir(parsed: Args): Promise<void> {
	if (parsed.allowHome || parsed.cwd) {
		return;
	}

	const home = os.homedir();
	if (!home) {
		return;
	}

	const normalizePath = normalizePathForComparison;

	const cwd = normalizePath(getProjectDir());
	const normalizedHome = normalizePath(home);
	if (cwd !== normalizedHome) {
		return;
	}

	const candidates = [path.join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await directoryExists(candidate))) {
				continue;
			}
			setProjectDir(candidate);
			return;
		} catch {
			// Try next candidate.
		}
	}

	try {
		const fallback = os.tmpdir();
		if (fallback && normalizePath(fallback) !== cwd && (await directoryExists(fallback))) {
			setProjectDir(fallback);
		}
	} catch {
		// Ignore fallback errors.
	}
}

/**
 * Apply an explicit CLI `--cwd` (highest precedence), otherwise maybe auto-chdir
 * away from `$HOME`. Profile `session.workdir` is applied later by
 * {@link applySessionWorkdir} after Settings.init — it outranks process cwd but
 * loses to an explicit `--cwd`.
 */
export async function applyStartupCwd(parsed: Args): Promise<void> {
	if (parsed.cwd) {
		setProjectDir(parsed.cwd);
		// setProjectDir resolves the (possibly relative) target against the launch
		// cwd and chdirs into it. Re-sync parsed.cwd to the resolved absolute path
		// so downstream consumers (buildSessionOptions, settings/discovery, session
		// persistence) don't re-resolve a relative string against the new cwd.
		parsed.cwd = getProjectDir();
		return;
	}
	await maybeAutoChdir(parsed);
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
