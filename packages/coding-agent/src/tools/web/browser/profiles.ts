/**
 * The directories a launched browser runs on. An ordinary launch gets a temporary profile, removed with its
 * browser. A named profile is a persistent directory under the agent directory: its cookies, localStorage,
 * IndexedDB, service workers, cache and history outlive the browser and the session.
 *
 * Both start from {@link PROFILE_PREFERENCES}. A named profile is brought back to them on every launch, since
 * Chrome writes its whole preference file back on exit.
 *
 * Chromium allows one process per profile directory and marks the holder with a lock: `SingletonLock`, a
 * symlink to `<host>-<pid>`, on Linux and macOS, and `lockfile`, held open without sharing, on Windows. A
 * second Chromium started on a held directory hands its window to the holder and exits, so a named profile
 * is checked for the lock before anything in it is written and its browser starts; a process that takes the
 * lock after that check is found by the launcher, which checks again when the launch fails.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	errorMessage,
	getBrowserProfilesDir,
	isEnoent,
	isMissingPath,
	isProcessAlive,
	isRecord,
	logger,
} from "@veyyon/utils";
import { bestEffort } from "@veyyon/utils/discarded-fault";
import { ToolError } from "../../core/tool-errors";

/**
 * The preferences a launched browser's profile starts with. Chrome's password manager offers to save
 * a password after a sign-in, and checks it against breach lists, through bubbles and dialogs drawn
 * over the tab. Nothing in the page can see or dismiss them, and while one is up no click or key
 * reaches the page: after any sign-in form, every later action silently did nothing.
 */
const PROFILE_PREFERENCES = {
	credentials_enable_service: false,
	profile: { password_manager_leak_detection: false },
};

/** The prefix of every temporary profile directory {@link createProfile} makes. */
const TEMPORARY_PROFILE_PREFIX = "veyyon-chrome-profile-";

/** The file in a temporary profile holding `<host>-<pid>` of the process that made it. */
const PROFILE_OWNER_FILE = "veyyon-owner";

/**
 * A fresh profile directory holding {@link PROFILE_PREFERENCES}; whoever disposes the browser removes it.
 * The temporary profiles of processes that ended without removing theirs are removed first
 * ({@link sweepOrphanedProfiles}).
 */
export async function createProfile(): Promise<string> {
	const parent = os.tmpdir();
	await sweepOrphanedProfiles(parent);
	const dir = await fs.promises.mkdtemp(path.join(parent, TEMPORARY_PROFILE_PREFIX));
	await fs.promises.writeFile(path.join(dir, PROFILE_OWNER_FILE), `${os.hostname()}-${process.pid}`);
	await fs.promises.mkdir(path.join(dir, "Default"));
	await fs.promises.writeFile(path.join(dir, "Default", "Preferences"), JSON.stringify(PROFILE_PREFERENCES));
	return dir;
}

/**
 * Remove every temporary profile in `parent` whose owner, a process on this host, no longer runs and
 * which no running Chromium holds: a process that crashed or was killed never removed its own. A
 * profile with no owner file, an owner file this process cannot read, an owner on another host, or a
 * live owner is kept: the system temp directory is shared, and another user's profile is theirs.
 */
export async function sweepOrphanedProfiles(parent: string): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(parent);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	const host = os.hostname();
	for (const entry of entries) {
		if (!entry.startsWith(TEMPORARY_PROFILE_PREFIX)) continue;
		const dir = path.join(parent, entry);
		let owner: string;
		try {
			owner = await fs.promises.readFile(path.join(dir, PROFILE_OWNER_FILE), "utf8");
		} catch (error) {
			// No owner file: a profile from before owners were written, or one still being made. An owner
			// file that cannot be read (another user's profile, mode 0700 like every `mkdtemp`, or anything
			// else planted under the prefix) is not this process's to sweep, and must not stop the launch.
			if (!isMissingPath(error)) {
				logger.debug("Keeping a temporary browser profile whose owner cannot be read", {
					dir,
					error: errorMessage(error),
				});
			}
			continue;
		}
		const dash = owner.lastIndexOf("-");
		const pid = Number(owner.slice(dash + 1));
		if (owner.slice(0, dash) !== host || !Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;
		if (await profileLock(dir)) continue;
		await removeProfile(dir);
	}
}

/** Remove a temporary profile directory {@link createProfile} made, once its browser is gone. */
export async function removeProfile(dir: string): Promise<void> {
	await bestEffort(
		fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 }),
		"a profile a process still holds open goes with the next temp sweep",
	);
}

/** One directory name on every platform: lowercase, so two spellings never share a directory on a case-folding disk. */
const PROFILE_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/;

/** Device names Windows reserves in every directory, with or without an extension. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** `name` when it can name a persistent profile directory; a ToolError stating the rule otherwise. */
export function validateProfileName(name: string): string {
	if (!PROFILE_NAME.test(name) || WINDOWS_RESERVED.test(name.split(".")[0] ?? "")) {
		throw new ToolError(
			`Invalid browser profile name ${JSON.stringify(name)}: use 1 to 64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit, not ending with ".", and not a Windows device name such as "con" or "nul".`,
		);
	}
	return name;
}

/** Where profile `name` lives. The name must already be valid. */
export function profileDirectory(name: string): string {
	return path.join(getBrowserProfilesDir(), name);
}

/** A Chromium lock on a profile directory, and who holds it. */
export interface ProfileLock {
	readonly path: string;
	readonly holder: string;
}

/** `SingletonLock`: a symlink to `<host>-<pid>`. One whose process on this host is gone is stale, and Chromium takes it over. */
async function singletonLock(dir: string): Promise<ProfileLock | undefined> {
	const lockPath = path.join(dir, "SingletonLock");
	let target: string;
	try {
		target = await fs.promises.readlink(lockPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		// Something other than Chromium's symlink sits at the lock's path; Chromium refuses it too.
		return { path: lockPath, holder: "an unreadable lock" };
	}
	const dash = target.lastIndexOf("-");
	const host = dash > 0 ? target.slice(0, dash) : "";
	const pid = Number(target.slice(dash + 1));
	if (host === os.hostname() && Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) return undefined;
	return { path: lockPath, holder: host === os.hostname() ? `pid ${pid}` : `pid ${pid} on host ${host}` };
}

/** `lockfile`: Chromium on Windows holds it open without sharing; a file that opens is left from a process that exited. */
async function windowsLock(dir: string): Promise<ProfileLock | undefined> {
	const lockPath = path.join(dir, "lockfile");
	try {
		const handle = await fs.promises.open(lockPath, "r+");
		await handle.close();
		return undefined;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
			return { path: lockPath, holder: "another Chromium process" };
		}
		throw error;
	}
}

/** The lock another process holds on profile directory `dir`, if one does. */
export function profileLock(dir: string): Promise<ProfileLock | undefined> {
	return process.platform === "win32" ? windowsLock(dir) : singletonLock(dir);
}

/** The error for profile `name` held by `lock`. */
export function profileLockedError(name: string, lock: ProfileLock): ToolError {
	return new ToolError(
		`Browser profile ${JSON.stringify(name)} is in use by ${lock.holder} (lock ${lock.path}). Close the browser running on it, or open another profile.`,
	);
}

/**
 * Bring `Default/Preferences` of a profile back to {@link PROFILE_PREFERENCES}, keeping every other
 * preference Chrome wrote; a file that is missing or not JSON is replaced.
 */
async function applyProfilePreferences(dir: string): Promise<void> {
	const file = path.join(dir, "Default", "Preferences");
	let prefs: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await fs.promises.readFile(file, "utf8"));
		if (isRecord(parsed)) prefs = parsed;
	} catch (error) {
		if (!isEnoent(error) && !(error instanceof SyntaxError)) throw error;
	}
	prefs.profile = { ...(isRecord(prefs.profile) ? prefs.profile : {}), ...PROFILE_PREFERENCES.profile };
	prefs.credentials_enable_service = PROFILE_PREFERENCES.credentials_enable_service;
	await fs.promises.writeFile(file, JSON.stringify(prefs));
}

/**
 * The directory of persistent profile `name`, ready for a browser to start on: created on first use,
 * refused while another process holds it, and holding {@link PROFILE_PREFERENCES}.
 */
export async function preparePersistentProfile(name: string): Promise<string> {
	const dir = profileDirectory(validateProfileName(name));
	await fs.promises.mkdir(path.join(dir, "Default"), { recursive: true });
	const lock = await profileLock(dir);
	if (lock) throw profileLockedError(name, lock);
	await applyProfilePreferences(dir);
	return dir;
}
