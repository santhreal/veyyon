import { getAutoUpdateStatePath, isEnoent, logger, tryParseJson } from "@veyyon/utils";

/**
 * How long a failed background update is left alone before it is tried again.
 *
 * The failure is reported the first time it happens, and again after this
 * window, but not on every launch in between. Without the window a machine that
 * cannot install at all (a binary owned by root, a read-only image, a locked
 * package manager) shows the same red error every single time you start, which
 * teaches you to ignore errors.
 *
 * Six hours is short enough that a fixed permission problem is picked up the
 * same working day and long enough that a normal day of launches reports it
 * once.
 */
export const AUTO_UPDATE_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

/**
 * How long an in-progress install may hold the lock before another launch
 * treats it as abandoned.
 *
 * This has to exceed the slowest real install. A package-manager update on a
 * cold cache and a slow connection can run for minutes, and reaping the lock
 * underneath it would let a second process install over the top of the first.
 */
export const AUTO_UPDATE_LOCK_STALE_MS = 15 * 60 * 1_000;

/** What the last background update attempt did, as recorded on disk. */
export interface AutoUpdateState {
	/** Version whose install failed, absent when the last attempt succeeded. */
	failedVersion?: string;
	/** When that failure happened, as epoch milliseconds. */
	failedAtMs?: number;
	/** The failure message, kept so a repeat report can name the same cause. */
	failedError?: string;
}

/**
 * Read the recorded state, treating anything unreadable as "no record".
 *
 * A missing file is the normal first-run case. A corrupt one is not worth
 * failing a launch over: the only thing lost is a backoff window, so the next
 * attempt runs and rewrites the file.
 */
export async function readAutoUpdateState(statePath: string = getAutoUpdateStatePath()): Promise<AutoUpdateState> {
	try {
		const parsed = tryParseJson<AutoUpdateState>(await Bun.file(statePath).text());
		if (!parsed) {
			logger.warn("Auto-update state file is not valid JSON; treating it as empty", { statePath });
			return {};
		}
		return parsed;
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("Could not read auto-update state", { statePath, error: String(err) });
		}
		return {};
	}
}

/**
 * Whether a background install of `version` should be attempted now.
 *
 * Returns false only while the same version's recorded failure is still inside
 * {@link AUTO_UPDATE_FAILURE_COOLDOWN_MS}. A different version always retries
 * immediately, because the failure may have been specific to the build that
 * failed rather than to this machine.
 *
 * This never suppresses an explicit `veyyon update`: that command does not
 * consult this state at all, so a user who wants to see the failure again can
 * always ask for it.
 */
export function shouldAttemptAutoUpdate(state: AutoUpdateState, version: string, nowMs: number): boolean {
	if (state.failedVersion !== version) return true;
	if (state.failedAtMs === undefined) return true;
	return nowMs - state.failedAtMs >= AUTO_UPDATE_FAILURE_COOLDOWN_MS;
}

/** Record that installing `version` failed, starting a fresh backoff window. */
export async function recordAutoUpdateFailure(
	version: string,
	error: string,
	statePath: string = getAutoUpdateStatePath(),
	nowMs: number = Date.now(),
): Promise<void> {
	const state: AutoUpdateState = { failedVersion: version, failedAtMs: nowMs, failedError: error };
	await writeAutoUpdateState(statePath, state);
}

/**
 * Clear any recorded failure after a successful install.
 *
 * Without this a later failure of a different version would be compared against
 * a stale record, and more importantly a machine that recovered would keep a
 * failure on disk that nothing ever removes.
 */
export async function clearAutoUpdateFailure(statePath: string = getAutoUpdateStatePath()): Promise<void> {
	await writeAutoUpdateState(statePath, {});
}

async function writeAutoUpdateState(statePath: string, state: AutoUpdateState): Promise<void> {
	try {
		await Bun.write(statePath, JSON.stringify(state));
	} catch (err) {
		// Losing the record costs a backoff window, not correctness, and a launch
		// must not fail because a state directory is read-only. Say so rather than
		// swallowing it, so an unwritable config dir is diagnosable.
		logger.warn("Could not write auto-update state", { statePath, error: String(err) });
	}
}
