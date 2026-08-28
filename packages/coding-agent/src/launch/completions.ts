/** The on-disk store of completed daemon records, one file per project runtime directory. per-daemon `meta.json`, both of which the next start of the same name overwrites: a completed */
import { readFile } from "node:fs/promises";

import { atomicWriteFile, errorMessage, isEnoent, isRecord, logger } from "@veyyon/utils";
import { daemonCompletionsPath } from "./paths";
import { type DaemonCompletionRecord, parseDaemonCompletionRecord } from "./protocol";

/** Schema version of the completions file. Bump when the record or envelope shape changes. */
export const DAEMON_COMPLETIONS_SCHEMA_VERSION = 1;
/** How many completed records are retained. */
export const DAEMON_COMPLETIONS_LIMIT = 100;
/** How long a completed record is retained, in milliseconds (24h). */
export const DAEMON_COMPLETIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Decode the completions envelope, rejecting any other schema version. Throws on a missing or mismatched `version`, a non-array `records`, and on any record that */
export function parseDaemonCompletionsFile(value: unknown): DaemonCompletionRecord[] {
	if (!isRecord(value)) {
		throw new Error("daemon completions file must be an object");
	}
	if (!("version" in value) || value.version !== DAEMON_COMPLETIONS_SCHEMA_VERSION) {
		const version = "version" in value ? String(value.version) : "missing";
		throw new Error(
			`Unsupported daemon completions schema version: ${version} (expected ${DAEMON_COMPLETIONS_SCHEMA_VERSION})`,
		);
	}
	if (!("records" in value) || !Array.isArray(value.records)) {
		throw new Error("daemon completions records must be an array");
	}
	return value.records.map(parseDaemonCompletionRecord);
}

/** Read the retained completion records, oldest first. Throws on an unreadable or stale store. */
export async function readDaemonCompletions(
	runtimeDir: string,
	now: number = Date.now(),
): Promise<DaemonCompletionRecord[]> {
	let decoded: unknown;
	try {
		decoded = JSON.parse(await readFile(daemonCompletionsPath(runtimeDir), "utf8"));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const cutoff = now - DAEMON_COMPLETIONS_MAX_AGE_MS;
	return parseDaemonCompletionsFile(decoded)
		.filter(entry => entry.exitedAt >= cutoff)
		.slice(-DAEMON_COMPLETIONS_LIMIT);
}

/** Append one completion record, applying the retention bounds, and return what the store now holds. A store that cannot be read (corrupt, or written by another schema version) is */
export async function appendDaemonCompletion(
	runtimeDir: string,
	record: DaemonCompletionRecord,
	now: number = Date.now(),
): Promise<DaemonCompletionRecord[]> {
	let existing: DaemonCompletionRecord[] = [];
	try {
		existing = await readDaemonCompletions(runtimeDir, now);
	} catch (error) {
		logger.warn("Discarding unreadable daemon completion records", {
			path: daemonCompletionsPath(runtimeDir),
			error: errorMessage(error),
		});
	}
	const cutoff = now - DAEMON_COMPLETIONS_MAX_AGE_MS;
	const records = existing
		.concat([record])
		.filter(entry => entry.exitedAt >= cutoff)
		.slice(-DAEMON_COMPLETIONS_LIMIT);
	await atomicWriteFile(
		daemonCompletionsPath(runtimeDir),
		JSON.stringify({ version: DAEMON_COMPLETIONS_SCHEMA_VERSION, records }),
	);
	return records;
}
