import * as path from "node:path";
import { isEnoent } from "@veyyon/utils";
import type { SessionEntry } from "./session-entries";
import type { SessionStorage } from "./session-storage";

export const DRAFT_ONLY_SESSION_MARKER = ".draft-only-session";

export function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

export function isDraftOnlyMetadataEntry(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "model_change":
		case "thinking_level_change":
		case "service_tier_change":
		case "mode_change":
		case "session_lifecycle":
			return true;
		default:
			return false;
	}
}

export function holdsOnlyDraftMetadata(entries: readonly SessionEntry[]): boolean {
	let goalIsLive = false;
	for (const entry of entries) {
		if (entry.type === "mode_change") {
			goalIsLive = entry.mode === "goal" || entry.mode === "goal_paused";
			continue;
		}
		if (!isDraftOnlyMetadataEntry(entry)) return false;
	}
	return !goalIsLive;
}

export function draftPathFor(artifactsDir: string | null): string | null {
	return artifactsDir ? path.join(artifactsDir, "draft.txt") : null;
}

function draftOnlyMarkerPathFor(artifactsDir: string | null): string | null {
	return artifactsDir ? path.join(artifactsDir, DRAFT_ONLY_SESSION_MARKER) : null;
}

export function hasDraftOnlyMarker(storage: SessionStorage, artifactsDir: string | null): boolean {
	const markerPath = draftOnlyMarkerPathFor(artifactsDir);
	return markerPath !== null && storage.existsStateSync(markerPath) === "present";
}

export async function writeDraftOnlyMarker(storage: SessionStorage, artifactsDir: string | null): Promise<void> {
	const markerPath = draftOnlyMarkerPathFor(artifactsDir);
	if (!markerPath) return;
	await storage.writeText(markerPath, "");
}

export async function clearDraftOnlyMarker(storage: SessionStorage, artifactsDir: string | null): Promise<void> {
	const markerPath = draftOnlyMarkerPathFor(artifactsDir);
	if (!markerPath) return;
	try {
		await storage.unlink(markerPath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}
