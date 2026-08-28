import { getAutoUpdateStatePath, isEnoent, isRecord, logger, tryParseJson } from "@veyyon/utils";

/** How long a failed background update is left alone before it is tried again. The failure is reported the first time it happens, and again after this */
export const AUTO_UPDATE_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

/** How long an in-progress install may hold the lock before another launch treats it as abandoned. */
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

/** Coerce arbitrary parsed JSON into a state record, dropping anything unusable. `JSON.parse` succeeding says nothing about the shape: `42`, `"hello"` and */
export function normalizeAutoUpdateState(value: unknown): AutoUpdateState | undefined {
	if (!isRecord(value)) return undefined;
	const state: AutoUpdateState = {};
	if (typeof value.failedVersion === "string") state.failedVersion = value.failedVersion;
	// Finite only: `NaN` and the infinities all survive a `typeof === "number"`
	// check and then poison every comparison they reach.
	if (typeof value.failedAtMs === "number" && Number.isFinite(value.failedAtMs)) state.failedAtMs = value.failedAtMs;
	if (typeof value.failedError === "string") state.failedError = value.failedError;
	return state;
}

/** Read the recorded state, treating anything unreadable as "no record". A missing file is the normal first-run case. A corrupt one is not worth */
export async function readAutoUpdateState(statePath: string = getAutoUpdateStatePath()): Promise<AutoUpdateState> {
	let text: string;
	try {
		text = await Bun.file(statePath).text();
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("Could not read auto-update state", { statePath, error: String(err) });
		}
		return {};
	}
	const state = normalizeAutoUpdateState(tryParseJson<unknown>(text));
	if (!state) {
		logger.warn("Auto-update state file is unusable; resetting it and treating it as empty", { statePath });
		await writeAutoUpdateState(statePath, {});
		return {};
	}
	return state;
}

/** Whether a background install of `version` should be attempted now. Returns false only while the same version's recorded failure is still inside */
export function shouldAttemptAutoUpdate(state: AutoUpdateState, version: string, nowMs: number): boolean {
	if (state.failedVersion !== version) return true;
	const failedAtMs = state.failedAtMs;
	if (failedAtMs === undefined || !Number.isFinite(failedAtMs)) return true;
	if (failedAtMs > nowMs) return true;
	return nowMs - failedAtMs >= AUTO_UPDATE_FAILURE_COOLDOWN_MS;
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

/** Clear any recorded failure after a successful install. Without this a later failure of a different version would be compared against */
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
