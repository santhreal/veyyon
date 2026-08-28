import * as fs from "node:fs";
import * as path from "node:path";
import { InMemorySnapshotStore } from "@veyyon/hashline";
import { normalizeToLF } from "./normalize";

export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

interface FileSnapshotStoreOwner {
	fileSnapshotStore?: InMemorySnapshotStore;
}

export function getFileSnapshotStore(session: FileSnapshotStoreOwner): InMemorySnapshotStore {
	if (!session.fileSnapshotStore) session.fileSnapshotStore = new InMemorySnapshotStore();
	return session.fileSnapshotStore;
}

export function canonicalSnapshotKey(absolutePath: string): string {
	try {
		return fs.realpathSync.native(absolutePath);
	} catch {
		try {
			const parent = fs.realpathSync.native(path.dirname(absolutePath));
			return path.join(parent, path.basename(absolutePath));
		} catch {
			return absolutePath;
		}
	}
}

export function contiguousLineNumbers(startLine: number, count: number): number[] {
	const lines: number[] = [];
	for (let offset = 0; offset < count; offset++) lines.push(startLine + offset);
	return lines;
}

export function allLineNumbers(normalizedText: string): number[] {
	let lines = 1;
	for (let i = 0; i < normalizedText.length; i++) if (normalizedText.charCodeAt(i) === 10) lines++;
	return contiguousLineNumbers(1, lines);
}

export async function recordFileSnapshot(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	seenLines?: Iterable<number>,
	normalizedText?: string,
): Promise<string | undefined> {
	try {
		if (normalizedText !== undefined) {
			if (Buffer.byteLength(normalizedText) > SNAPSHOT_MAX_BYTES) return undefined;
			return getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalizedText, seenLines);
		}
		const file = Bun.file(absolutePath);
		if (file.size > SNAPSHOT_MAX_BYTES) return undefined;
		const normalized = normalizeToLF(await file.text());
		return getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized, seenLines);
	} catch {
		return undefined;
	}
}

const HASHLINE_LINE_PREFIX = /^[ *]?(\d+)(?:-(\d+))?:/;

export function parseSeenLinesFromHashlineBody(body: string): number[] {
	const seen: number[] = [];
	for (const row of body.split("\n")) {
		const match = HASHLINE_LINE_PREFIX.exec(row);
		if (!match) continue;
		seen.push(Number(match[1]));
		if (match[2] !== undefined) seen.push(Number(match[2]));
	}
	return seen;
}

export function recordSeenLines(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	tag: string,
	lines: readonly number[],
): void {
	if (lines.length === 0) return;
	getFileSnapshotStore(session).recordSeenLines(canonicalSnapshotKey(absolutePath), tag, lines);
}

export function recordSeenLinesFromBody(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	tag: string,
	body: string,
	clippedLines?: ReadonlySet<number>,
): void {
	const parsed = parseSeenLinesFromHashlineBody(body);
	if (!clippedLines || clippedLines.size === 0) {
		recordSeenLines(session, absolutePath, tag, parsed);
		return;
	}
	recordSeenLines(
		session,
		absolutePath,
		tag,
		parsed.filter(line => !clippedLines.has(line)),
	);
	const displayedAndClipped = parsed.filter(line => clippedLines.has(line));
	if (displayedAndClipped.length > 0) {
		getFileSnapshotStore(session).recordClippedLines(canonicalSnapshotKey(absolutePath), tag, displayedAndClipped);
	}
}
