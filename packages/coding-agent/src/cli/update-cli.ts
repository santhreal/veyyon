import * as fs from "node:fs";
import * as path from "node:path";
import {
	APP_NAME,
	changelogUrlForVersion,
	compareSemver,
	errorMessage,
	getAutoUpdateStatePath,
	getUpdateHistoryPath,
	isEnoent,
	isNewerVersion,
	isValidSemver,
	logger,
	tryWithFileLock,
	VERSION,
} from "@veyyon/utils";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import {
	AUTO_UPDATE_FAILURE_COOLDOWN_MS,
	AUTO_UPDATE_LOCK_STALE_MS,
	clearAutoUpdateFailure,
	readAutoUpdateState,
	recordAutoUpdateFailure,
	shouldAttemptAutoUpdate,
} from "./auto-update-state";

import {
	CONSOLE_UPDATE_REPORTER,
	defaultInstalledMethod,
	getLatestRelease,
	type InstallReleaseResult,
	type ReleaseInfo,
	resolveUpdateTarget,
	SILENT_UPDATE_REPORTER,
	type UpdateMethod,
	type UpdateReporter,
	updateViaBinaryAt,
	updateViaSourceAt,
} from "./update-cli-helpers";

export {
	type BinaryReplacementOptions,
	type CheckoutVersionReader,
	CONSOLE_UPDATE_REPORTER,
	chooseUpdateTargetPath,
	formatBinaryDownloadFailure,
	getAllReleases,
	getBinaryName,
	getLatestRelease,
	type InstalledVersionVerification,
	type InstallLocation,
	type InstallReleaseResult,
	parseSha256Sidecar,
	probeSearchWorks,
	type ReleaseInfo,
	type ReleaseListing,
	readInstallLocation,
	refreshCompletionsForInstalledBinary,
	replaceBinaryForUpdate,
	resolveUpdateMethod,
	restampOwnerReceipt,
	type SearchProbe,
	SILENT_UPDATE_REPORTER,
	SOURCE_VERSION_FILE,
	type SourceUpdateExec,
	type SourceUpdateStepResult,
	sourceInstallUpdateGuidance,
	sweepStaleBackups,
	type UpdateMethod,
	type UpdateReporter,
	updateViaBinaryAt,
	updateViaSourceAt,
	verifyBinaryUsable,
	verifyBinaryVersion,
	verifyDownloadChecksum,
	windowsCompletionTargets,
} from "./update-cli-helpers";

export async function installRelease(
	version: string,
	force: boolean,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
	currentVersion: string = VERSION,
	historyPath: string = getUpdateHistoryPath(),
): Promise<InstallReleaseResult> {
	void force;
	const target = await resolveUpdateTarget();
	const result =
		target.method === "source"
			? await updateViaSourceAt(target.path, version, report)
			: await updateViaBinaryAt(target.path, version, report);
	if (version !== currentVersion) {
		await recordVersionMove({ from: currentVersion, to: version, at: new Date().toISOString() }, historyPath);
	}
	return result;
}

export function rollbackUnsupportedReason(method: UpdateMethod): string | undefined {
	if (method !== "source") return undefined;
	return (
		`This is a source install (its launcher points into a git checkout), which updates by fast-forwarding ` +
		`that checkout. Fast-forward only moves forward, so there is no supported way to roll it back to an ` +
		`older release. To run an older version, check that version out yourself in the checkout, or install the ` +
		`prebuilt binary build with the install script and roll back from there.`
	);
}

export async function isRollbackSupported(installedMethod?: () => Promise<UpdateMethod>): Promise<boolean> {
	try {
		const method = installedMethod ? await installedMethod() : (await resolveUpdateTarget()).method;
		return rollbackUnsupportedReason(method) === undefined;
	} catch {
		return true;
	}
}

export interface UpdateHistoryEntry {
	from: string;
	to: string;
	at: string;
}

export async function recordVersionMove(
	entry: UpdateHistoryEntry,
	historyPath: string = getUpdateHistoryPath(),
): Promise<void> {
	try {
		let entries: UpdateHistoryEntry[] = [];
		try {
			const parsed: unknown = JSON.parse(await Bun.file(historyPath).text());
			if (Array.isArray(parsed)) entries = parsed as UpdateHistoryEntry[];
		} catch (err) {
			if (!isEnoent(err))
				logger.warn(`update history at ${historyPath} was unreadable, starting a new one: ${errorMessage(err)}`);
		}
		entries.push(entry);
		await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
		await Bun.write(historyPath, `${JSON.stringify(entries, null, 2)}\n`);
	} catch (err) {
		logger.warn(`could not record the version move to ${historyPath}: ${errorMessage(err)}`);
	}
}

export async function readVersionMoves(historyPath: string = getUpdateHistoryPath()): Promise<UpdateHistoryEntry[]> {
	try {
		const parsed: unknown = JSON.parse(await Bun.file(historyPath).text());
		return Array.isArray(parsed) ? (parsed as UpdateHistoryEntry[]) : [];
	} catch (err) {
		if (!isEnoent(err)) logger.warn(`update history at ${historyPath} was unreadable: ${errorMessage(err)}`);
		return [];
	}
}

export async function rollbackToVersion(
	version: string,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
	currentVersion: string = VERSION,
	historyPath: string = getUpdateHistoryPath(),
): Promise<void> {
	if (!isValidSemver(version)) {
		throw new Error(`${JSON.stringify(version)} is not a version number — expected something like 1.2.3`);
	}
	if (version === currentVersion) {
		throw new Error(
			`Already running ${currentVersion}. Pick a different version, or run \`${APP_NAME} rollback --list\` to see what is published.`,
		);
	}
	const target = await resolveUpdateTarget();
	const unsupported = rollbackUnsupportedReason(target.method);
	if (unsupported) throw new Error(unsupported);

	report(`Moving from ${currentVersion} to ${version}...`);
	await installRelease(version, true, report, currentVersion, historyPath);
	report(`Now on ${version}. Restart ${APP_NAME} to run it.`);
}

export type AutoUpdateOutcome =
	| { status: "up-to-date" }
	| { status: "updated"; version: string; warnings: string[] }
	| { status: "failed"; version?: string; error: string }
	| { status: "skipped"; version: string; reason: AutoUpdateSkipReason };

export type AutoUpdateSkipReason = "another-process" | "recent-failure" | "source-install";

export async function runAutoUpdate(
	currentVersion: string = VERSION,
	knownRelease?: ReleaseInfo,
	statePath: string = getAutoUpdateStatePath(),
	resolveInstalledMethod: () => UpdateMethod | undefined = defaultInstalledMethod,
	install: (
		version: string,
		reporter: typeof SILENT_UPDATE_REPORTER,
	) => Promise<void> | Promise<InstallReleaseResult> = (version, reporter) => installRelease(version, false, reporter),
): Promise<AutoUpdateOutcome> {
	let release: ReleaseInfo;
	if (knownRelease) {
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

	if (resolveInstalledMethod() === "source") {
		logger.info("Skipping automatic update: veyyon is installed from source (update with git pull)", {
			version: release.version,
		});
		return { status: "skipped", version: release.version, reason: "source-install" };
	}

	try {
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
				let installResult: InstallReleaseResult | undefined;
				try {
					installResult = (await install(release.version, SILENT_UPDATE_REPORTER)) as
						| InstallReleaseResult
						| undefined;
				} catch (err) {
					const error = errorMessage(err);
					try {
						await recordAutoUpdateFailure(release.version, error, statePath);
					} catch (stateErr) {
						logger.warn("Could not record automatic update failure", {
							version: release.version,
							error: errorMessage(stateErr),
						});
					}
					return { status: "failed", version: release.version, error };
				}
				await clearAutoUpdateFailure(statePath);
				return { status: "updated", version: release.version, warnings: installResult?.warnings ?? [] };
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
	} catch (err) {
		return { status: "failed", version: release.version, error: errorMessage(err) };
	}
}

export type ReleaseInstaller = (version: string, force: boolean) => Promise<void> | Promise<InstallReleaseResult>;

export async function runUpdateCommand(
	opts: { force: boolean; check: boolean },
	install: ReleaseInstaller = installRelease,
): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${errorMessage(err)}`));
		process.exit(1);
	}

	const comparison = compareSemver(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${typeof theme === "undefined" ? "✓" : theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else if (opts.check) {
		console.log(chalk.yellow(`Up to date at ${release.version}; --force would reinstall it`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		return;
	}

	try {
		await install(release.version, opts.force);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${errorMessage(err)}`));
		if (await isRollbackSupported()) {
			console.error(
				chalk.dim(`To return to a version that worked, run \`${APP_NAME} rollback\` and pick it from the list.`),
			);
		}
		process.exit(1);
	}
	console.log(chalk.dim(`Changelog for ${release.version}: ${changelogUrlForVersion(release.version)}`));
}

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

${chalk.bold("Going back:")}
  ${APP_NAME} rollback            Pick any published version, forward or back
  ${APP_NAME} rollback --list     Print every published version and dates
`);
}
