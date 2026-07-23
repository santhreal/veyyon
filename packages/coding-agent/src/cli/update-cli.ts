/**
 * Update CLI command handler.
 *
 * Handles `veyyon update` to check for and install updates.
 * Uses the installer that owns the active veyyon executable when it can be detected.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import {
	$which,
	APP_NAME,
	compareSemver,
	errorMessage,
	getAutoUpdateStatePath,
	isEnoent,
	isNewerVersion,
	isValidSemver,
	logger,
	tryWithFileLock,
	VERSION,
} from "@veyyon/utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";
import {
	AUTO_UPDATE_FAILURE_COOLDOWN_MS,
	AUTO_UPDATE_LOCK_STALE_MS,
	clearAutoUpdateFailure,
	readAutoUpdateState,
	recordAutoUpdateFailure,
	shouldAttemptAutoUpdate,
} from "./auto-update-state";

const REPO = "santhreal/veyyon";
/**
 * GitHub REST base for {@link REPO}. Veyyon ships only through GitHub Releases
 * (see the Distribution section in the root `AGENTS.md`): the `curl` installer
 * and this self-updater both resolve versions here, never from a package
 * registry, so the running binary and a fresh install always agree on what
 * "latest" means. `releases/latest` already excludes drafts and prereleases, so
 * an unpublished draft never triggers an update.
 */
const GITHUB_RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
/**
 * GitHub requires a User-Agent on every API request and rejects requests
 * without one. Identify the updater so the traffic is attributable.
 */
const GITHUB_API_USER_AGENT = `${APP_NAME}-updater`;
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * The in-checkout launcher a source install links onto PATH.
 *
 * `install.sh --source` clones the repo under `~/.veyyon/src` and symlinks
 * `~/.local/bin/veyyon` at `<checkout>/packages/coding-agent/scripts/veyyon`.
 * That launcher runs veyyon straight from TypeScript, so a source install must
 * update with `git pull`, never by swapping in a downloaded release binary. The
 * resolved (realpath) veyyon path ending in this suffix is how we tell the two
 * apart; see {@link resolveUpdateMethod}.
 */
const SOURCE_LAUNCHER_SUFFIX = path.join("packages", "coding-agent", "scripts", APP_NAME);

export interface ReleaseInfo {
	tag: string;
	version: string;
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

/**
 * How the veyyon on PATH was installed, which decides how it updates.
 *
 * `binary` is the `curl | sh` standalone binary: update by downloading the new
 * release binary and swapping it in place. `source` is `install.sh --source`,
 * whose PATH entry is a symlink to the in-checkout launcher: a binary swap would
 * overwrite the checkout's launcher, so it must not self-update at all (update
 * with `git pull`). Veyyon ships GitHub-only, so there is no package-manager
 * (bun/npm/Homebrew/mise) install path to detect.
 */
type UpdateMethod = "binary" | "source";

type UpdateTarget = { method: "binary"; path: string } | { method: "source"; path: string };

/**
 * Classify an on-PATH veyyon path as a binary or source install.
 *
 * A source install links PATH's veyyon to `<checkout>/<SOURCE_LAUNCHER_SUFFIX>`,
 * so following the symlink (realpath) and matching that suffix is what tells the
 * two apart. Everything else is a standalone binary the updater can swap.
 * Exported for direct unit testing without a real install on disk.
 */
export function resolveUpdateMethod(veyyonPath: string): UpdateMethod {
	const resolved = tryRealpath(veyyonPath) ?? veyyonPath;
	return resolved.endsWith(SOURCE_LAUNCHER_SUFFIX) ? "source" : "binary";
}

async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const veyyonPath = resolveVeyyonPath();
	if (!veyyonPath) throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
	return { method: resolveUpdateMethod(veyyonPath), path: veyyonPath };
}

/**
 * How the veyyon on PATH is installed, or `undefined` when no veyyon resolves in
 * PATH. The default the background updater uses to decide whether to skip a
 * source install; injectable into {@link runAutoUpdate} so tests do not depend on
 * what happens to be installed on the machine running them.
 */
function defaultInstalledMethod(): UpdateMethod | undefined {
	const veyyonPath = resolveVeyyonPath();
	return veyyonPath ? resolveUpdateMethod(veyyonPath) : undefined;
}

/**
 * Look up the latest published release from GitHub Releases.
 *
 * The one place the release source is asked what the newest version is. Startup
 * and `veyyon update` both come through here, so they can never disagree about
 * where to ask or how to read the answer, and it is the same source
 * `install.sh` uses so a self-update and a fresh `curl` install always resolve
 * the same version. Veyyon has no npm package; the GitHub release is the only
 * catalog (see {@link GITHUB_RELEASES_API}).
 *
 * `releases/latest` returns the newest non-draft, non-prerelease release, so a
 * draft that has been uploaded but not published never triggers an update.
 *
 * `timeoutMs` exists because the two callers want different patience: a
 * startup check runs while you are waiting to type and gives up quickly, while
 * an explicit `veyyon update` is worth waiting on.
 */
export async function getLatestRelease(timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseInfo> {
	const url = `${GITHUB_RELEASES_API}/latest`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { "User-Agent": GITHUB_API_USER_AGENT, Accept: "application/vnd.github+json" },
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching release info after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
		}
		throw err;
	}
	if (!response.ok) {
		const hint =
			response.status === 404
				? ` — ${REPO} has no published GitHub release yet (a draft or untagged release does not count)`
				: response.status === 403 || response.status === 429
					? " — GitHub is rate-limiting this address; retry in a few minutes"
					: "";
		throw new Error(
			`Failed to fetch release info from ${url}: HTTP ${response.status} ${response.statusText}${hint}`,
		);
	}

	const data = (await response.json()) as { tag_name?: unknown };
	const tag = typeof data.tag_name === "string" ? data.tag_name : "";
	const version = tag.replace(/^v/, "");
	if (!isValidSemver(version)) {
		throw new Error(`GitHub returned a release with an unusable tag ${JSON.stringify(tag)} from ${url}`);
	}

	return {
		tag: tag.startsWith("v") ? tag : `v${version}`,
		version,
	};
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the path that `veyyon` maps to in the user's PATH.
 */
function resolveVeyyonPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run the resolved veyyon binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const veyyonPath = resolveVeyyonPath();
	if (!veyyonPath) return { ok: false };
	try {
		const result = await $`${veyyonPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: veyyonPath };
		const output = result.text().trim();
		// Output format: "veyyon/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: veyyonPath };
	} catch {
		return { ok: false, path: veyyonPath };
	}
}

/**
 * Where an in-progress update reports what it is doing.
 *
 * `veyyon update` is a plain CLI run and prints to the console. An automatic
 * update runs underneath a live TUI, where any stray write lands in the middle
 * of the rendered frame and corrupts it, so that caller passes
 * {@link SILENT_UPDATE_REPORTER} and reports the outcome through its own UI.
 */
export type UpdateReporter = (line: string) => void;

export const CONSOLE_UPDATE_REPORTER: UpdateReporter = line => {
	console.log(line);
};

export const SILENT_UPDATE_REPORTER: UpdateReporter = () => {};

function printVerifiedVersion(expectedVersion: string, report: UpdateReporter): void {
	report(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). The replacement and verification already
 * succeeded by the time we get here, so every error is swallowed; the leftover
 * is reclaimed by {@link sweepStaleBackups} on the next update once it is no
 * longer in use. Returns whether the file is gone.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update backups left by earlier runs.
 *
 * Each self-update moves the previous executable to `<binary>.<timestamp>.<pid>.bak`
 * before swapping the new one in. On Windows that backup cannot be deleted
 * while the updating process is alive, so it is left for a later run to reclaim
 * once its owning process has exited. Also matches the legacy fixed
 * `<binary>.bak` name produced before backups were timestamped, so users
 * upgrading from a buggy release get the orphaned file cleaned up.
 */
export async function sweepStaleBackups(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`) || !entry.endsWith(".bak")) continue;
		// Legacy "<base>.bak" → empty middle; new "<base>.<timestamp>.<pid>.bak"
		// → dot-separated numeric run. Anything else is an unrelated *.bak file.
		const middle = entry.slice(base.length + 1, entry.length - ".bak".length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		await removeBackupBestEffort(path.join(dir, entry));
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		// Refuse an empty or missing download BEFORE disturbing the live binary.
		// A truncated-but-HTTP-200 body would otherwise be renamed over the running
		// binary and only caught afterwards by the `--version` check, leaving the
		// user with a broken binary for the duration of the rollback. This mirrors
		// install.sh's `finalize_binary` guard (`[ -s "$tmp" ]`), which fails
		// before ever touching the destination. `backupReady` is still false, so
		// the catch cleans the junk temp and never runs a needless restore.
		let tempSize: number;
		try {
			tempSize = (await fs.promises.stat(options.tempPath)).size;
		} catch (err) {
			if (isEnoent(err)) throw new Error("Downloaded update is missing; not replacing the installed binary");
			throw err;
		}
		if (tempSize === 0) {
			throw new Error("Downloaded update is empty; not replacing the installed binary");
		}
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, so a
		// failure here must NOT fail an otherwise-successful update.
		await removeBackupBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string, report: UpdateReporter): Promise<void> {
	const binaryName = getBinaryName();
	const tag = `v${expectedVersion}`;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	const tempPath = `${targetPath}.new`;
	// Unique per attempt: a stale backup from an earlier update may still be
	// locked (it is the previous process image on Windows), and a fixed name
	// would force the move-aside rename to overwrite it. pid + timestamp keeps
	// two forced updates in the same millisecond from colliding.
	const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;
	report(chalk.dim(`Downloading ${binaryName}…`));

	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		throw err;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	try {
		await pipeline(response.body, fileStream);
	} catch (err) {
		// A mid-download failure (network drop) leaves a partial `<binary>.new`
		// behind: we throw here before reaching replaceBinaryForUpdate, whose catch
		// would otherwise clean it up. Remove it so a failed update never litters
		// the install dir, matching install.sh's EXIT/INT/TERM trap on its tmpbin.
		await unlinkIfExists(tempPath);
		throw err;
	}

	report(chalk.dim("Installing update..."));
	await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion,
		verifyInstalledVersion,
	});
	// Reclaim backups from earlier updates whose owning process has since exited.
	await sweepStaleBackups(targetPath);
	printVerifiedVersion(expectedVersion, report);
	report(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * Human-facing guidance for why a source install cannot be self-updated, and
 * what to run instead. Shared by the interactive path and the auto-update skip
 * so both say the same thing.
 */
export function sourceInstallUpdateGuidance(launcherPath: string): string {
	return (
		`${APP_NAME} is installed from source (its launcher is ${launcherPath}). ` +
		`A binary self-update would overwrite that launcher, so it is refused. ` +
		`Update the checkout instead: cd into it and run \`git pull && bun setup\`, ` +
		`or re-run the installer with \`--source\`.`
	);
}

/**
 * Install a specific release for the veyyon currently first in PATH.
 *
 * A binary install is updated by downloading the release binary and swapping it
 * in place. A source install (`install.sh --source`) is refused loudly: its PATH
 * entry is a symlink into the checkout, so a binary swap would overwrite the
 * launcher — never fall back to clobbering it (Law 10). This is the single owner
 * of that dispatch: both `veyyon update` and the automatic startup update go
 * through it, so they can never drift into updating by different rules.
 *
 * `force` is accepted for API symmetry with callers (the rollback path passes
 * it); a binary swap is unconditional, so it does not change binary behavior.
 */
export async function installRelease(
	version: string,
	force: boolean,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
): Promise<void> {
	void force;
	const target = await resolveUpdateTarget();
	if (target.method === "source") {
		throw new Error(sourceInstallUpdateGuidance(target.path));
	}
	await updateViaBinaryAt(target.path, version, report);
}

/**
 * Outcome of an automatic update attempt.
 *
 * `updated` means the new version is on disk and takes effect on the next
 * launch, not in the running process. `failed` carries the reason so the caller
 * can show it: an update that quietly does nothing would leave you pinned to an
 * old version with no way to notice (Law 10).
 */
export type AutoUpdateOutcome =
	| { status: "up-to-date" }
	| { status: "updated"; version: string }
	| { status: "failed"; version?: string; error: string }
	| { status: "skipped"; version: string; reason: AutoUpdateSkipReason };

/**
 * Why a background update did not attempt an install.
 *
 * `another-process` means a concurrently launched session is already installing
 * that version. `recent-failure` means installing this same version failed
 * recently enough that retrying now would only reproduce it; see
 * {@link AUTO_UPDATE_FAILURE_COOLDOWN_MS}. `source-install` means veyyon runs
 * from a source checkout (`install.sh --source`), which updates with `git pull`,
 * not a binary swap — attempting one would overwrite its launcher, so the
 * background updater leaves it alone instead of fail-looping.
 */
export type AutoUpdateSkipReason = "another-process" | "recent-failure" | "source-install";

/**
 * Update to the latest release without printing anything or exiting.
 *
 * {@link runUpdateCommand} is the interactive front end for the same work; this
 * is the form a running session can call, where `console.log` would corrupt the
 * TUI and `process.exit` would kill the user's session.
 *
 * Two things make this safe to run on every launch rather than only on demand.
 * The install runs under a cross-process lock, so opening several terminals at
 * once installs once instead of racing several package-manager writes at the
 * same binary. And a failure is recorded, so a machine that cannot install at
 * all reports the reason and then backs off instead of failing loudly on every
 * launch forever.
 *
 * `statePath` names the file holding that failure record and acting as the lock
 * target. It defaults to the per-user state file and exists as a parameter so a
 * test can point the whole mechanism at a temporary directory instead of the
 * real one.
 */
export async function runAutoUpdate(
	currentVersion: string = VERSION,
	knownRelease?: ReleaseInfo,
	statePath: string = getAutoUpdateStatePath(),
	resolveInstalledMethod: () => UpdateMethod | undefined = defaultInstalledMethod,
): Promise<AutoUpdateOutcome> {
	let release: ReleaseInfo;
	if (knownRelease) {
		// The startup check already asked the registry. Reusing its answer keeps a
		// launch to one round trip instead of two.
		release = knownRelease;
	} else {
		try {
			release = await getLatestRelease();
		} catch (err) {
			return { status: "failed", error: errorMessage(err) };
		}
	}
	if (!isNewerVersion(release.version, currentVersion)) {
		return { status: "up-to-date" };
	}

	// A source install updates via `git pull`, not a binary swap: a background
	// self-update would overwrite its launcher, so skip it loudly instead of
	// fail-looping on every launch. Only a confirmed source launcher skips; every
	// other install (including an unresolved path) takes the normal binary path.
	if (resolveInstalledMethod() === "source") {
		logger.info("Skipping automatic update: veyyon is installed from source (update with git pull)", {
			version: release.version,
		});
		return { status: "skipped", version: release.version, reason: "source-install" };
	}

	const state = await readAutoUpdateState(statePath);
	if (!shouldAttemptAutoUpdate(state, release.version, Date.now())) {
		logger.warn("Skipping automatic update: installing this version failed recently", {
			version: release.version,
			error: state.failedError,
			retryAfterMs: AUTO_UPDATE_FAILURE_COOLDOWN_MS,
		});
		return { status: "skipped", version: release.version, reason: "recent-failure" };
	}

	const attempt = await tryWithFileLock(
		statePath,
		async (): Promise<AutoUpdateOutcome> => {
			try {
				// Silent: this runs under a live TUI, where any console write corrupts the frame.
				await installRelease(release.version, false, SILENT_UPDATE_REPORTER);
			} catch (err) {
				const error = errorMessage(err);
				await recordAutoUpdateFailure(release.version, error, statePath);
				return { status: "failed", version: release.version, error };
			}
			await clearAutoUpdateFailure(statePath);
			return { status: "updated", version: release.version };
		},
		{ staleMs: AUTO_UPDATE_LOCK_STALE_MS },
	);
	if (!attempt.acquired) {
		logger.info("Skipping automatic update: another session is already installing it", {
			version: release.version,
		});
		return { status: "skipped", version: release.version, reason: "another-process" };
	}
	return attempt.value;
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		// err.message, not `${err}`: the latter stringifies as "Error: …" and
		// produces a doubled "Failed to check for updates: Error: Failed to …".
		console.error(chalk.red(`Failed to check for updates: ${errorMessage(err)}`));
		process.exit(1);
	}

	const comparison = compareSemver(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		// Just check, don't install
		return;
	}

	// A source install updates via `git pull`, not a binary swap. Say so as
	// guidance and exit cleanly (0) rather than attempting the install and
	// reporting a failure for a thing that was never going to work.
	const veyyonPath = resolveVeyyonPath();
	if (veyyonPath && resolveUpdateMethod(veyyonPath) === "source") {
		console.log(chalk.yellow(sourceInstallUpdateGuidance(veyyonPath)));
		return;
	}

	// Binary install: download the release binary and swap it in place.
	try {
		await installRelease(release.version, opts.force);
	} catch (err) {
		// errorMessage(err), not `${err}`: the latter stringifies as "Error: …"
		// and doubles the prefix into "Update failed: Error: …".
		console.error(chalk.red(`Update failed: ${errorMessage(err)}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins
`);
}
