import * as path from "node:path";
import { pathStateSync } from "@veyyon/utils/fs-optional";
import { sessionFileName, sessionFileStem } from "@veyyon/utils/session-file";
import type { SessionCheckpoint, SessionCheckpointEntry, SessionEntry, SessionLifecycleState } from "./session-entries";

export function mintSessionId(): string {
	return Bun.randomUUIDv7();
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function fileSafeTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

export function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	return sessionFile ? sessionFileStem(sessionFile) : null;
}

export function resolveBreadcrumbToInteractiveRoot(sessionFile: string): string {
	let current = path.resolve(sessionFile);
	for (let depth = 0; depth < 8; depth++) {
		const parentSessionFile = sessionFileName(path.dirname(current));
		if (pathStateSync(parentSessionFile) !== "present") return current;
		current = parentSessionFile;
	}
	return current;
}

export function isSessionIncarnationTelemetry(entry: SessionEntry): boolean {
	return entry.type === "session_lifecycle" || entry.type === "session_checkpoint";
}

export function assertSessionSequence(sequence: unknown): asserts sequence is number {
	if (!Number.isSafeInteger(sequence) || (sequence as number) < 0 || (sequence as number) >= Number.MAX_SAFE_INTEGER) {
		throw new Error(
			`Session sequence must be a non-negative safe integer below ${Number.MAX_SAFE_INTEGER}; repair or remove the invalid telemetry entry before resuming`,
		);
	}
}

export function nextSessionSequence(entries: readonly SessionEntry[]): number {
	let highest = entries.length;
	for (const entry of entries) {
		if (entry.sequence === undefined) continue;
		assertSessionSequence(entry.sequence);
		if (entry.sequence > highest) highest = entry.sequence;
	}
	assertSessionSequence(highest);
	return highest + 1;
}

export function getLifecycleStateFromEntries(entries: readonly SessionEntry[]): SessionLifecycleState | "unknown" {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "session_lifecycle") return entry.state;
	}
	return "unknown";
}

export function findEntriesThroughCheckpoint(
	entries: readonly SessionEntry[],
	checkpoint: SessionCheckpoint | string,
): SessionEntry[] {
	const checkpointId = typeof checkpoint === "string" ? checkpoint : checkpoint.id;
	const index = entries.findIndex(
		(entry): entry is SessionCheckpointEntry => entry.type === "session_checkpoint" && entry.id === checkpointId,
	);
	if (index < 0) throw new Error(`Session checkpoint ${checkpointId} not found`);
	const entry = entries[index] as SessionCheckpointEntry;
	if (typeof checkpoint !== "string" && entry.prefixSequence !== checkpoint.prefixSequence) {
		throw new Error(`Session checkpoint ${checkpointId} identity does not match`);
	}
	return entries.slice(0, index);
}
