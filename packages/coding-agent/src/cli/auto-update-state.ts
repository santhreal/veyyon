import { getAutoUpdateStatePath, isEnoent, isRecord, logger, tryParseJson } from "@veyyon/utils";

export const AUTO_UPDATE_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

export const AUTO_UPDATE_LOCK_STALE_MS = 15 * 60 * 1_000;

export interface AutoUpdateState {
	failedVersion?: string;
	failedAtMs?: number;
	failedError?: string;
}

export function normalizeAutoUpdateState(value: unknown): AutoUpdateState | undefined {
	if (!isRecord(value)) return undefined;
	const state: AutoUpdateState = {};
	if (typeof value.failedVersion === "string") state.failedVersion = value.failedVersion;
	if (typeof value.failedAtMs === "number" && Number.isFinite(value.failedAtMs)) state.failedAtMs = value.failedAtMs;
	if (typeof value.failedError === "string") state.failedError = value.failedError;
	return state;
}

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

export function shouldAttemptAutoUpdate(state: AutoUpdateState, version: string, nowMs: number): boolean {
	if (state.failedVersion !== version) return true;
	const failedAtMs = state.failedAtMs;
	if (failedAtMs === undefined || !Number.isFinite(failedAtMs)) return true;
	if (failedAtMs > nowMs) return true;
	return nowMs - failedAtMs >= AUTO_UPDATE_FAILURE_COOLDOWN_MS;
}

export async function recordAutoUpdateFailure(
	version: string,
	error: string,
	statePath: string = getAutoUpdateStatePath(),
	nowMs: number = Date.now(),
): Promise<void> {
	const state: AutoUpdateState = { failedVersion: version, failedAtMs: nowMs, failedError: error };
	await writeAutoUpdateState(statePath, state);
}

export async function clearAutoUpdateFailure(statePath: string = getAutoUpdateStatePath()): Promise<void> {
	await writeAutoUpdateState(statePath, {});
}

async function writeAutoUpdateState(statePath: string, state: AutoUpdateState): Promise<void> {
	try {
		await Bun.write(statePath, JSON.stringify(state));
	} catch (err) {
		logger.warn("Could not write auto-update state", { statePath, error: String(err) });
	}
}
