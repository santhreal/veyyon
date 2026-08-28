/** Session-bound file snapshot store. Used by `read` and `search` to record exactly what the model saw, and by */
import * as fs from "node:fs";
import * as path from "node:path";
import { InMemorySnapshotStore } from "@veyyon/hashline";
import { normalizeToLF } from "./normalize";

/** Upper bound on the file size we snapshot. A section tag is a content hash of the *whole* file, so minting one means holding the full normalized text in */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

interface FileSnapshotStoreOwner {
	fileSnapshotStore?: InMemorySnapshotStore;
}

/** Look up (or lazily create) the file snapshot store attached to a session. Storage lives on `session.fileSnapshotStore` so it ages out exactly with */
export function getFileSnapshotStore(session: FileSnapshotStoreOwner): InMemorySnapshotStore {
	if (!session.fileSnapshotStore) session.fileSnapshotStore = new InMemorySnapshotStore();
	return session.fileSnapshotStore;
}

/** Canonicalize an absolute path into the stable key the snapshot store uses. Different code paths reach the snapshot store via different path forms: */
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

/** The 1-indexed line numbers `count` lines from `startLine`, inclusive. ONE owner for a calculation three producers need: range reads, raw reads and */
export function contiguousLineNumbers(startLine: number, count: number): number[] {
	const lines: number[] = [];
	for (let offset = 0; offset < count; offset++) lines.push(startLine + offset);
	return lines;
}

/** Every line of `normalizedText`, as `seenLines` for a snapshot the model authored in full. */
export function allLineNumbers(normalizedText: string): number[] {
	let lines = 1;
	for (let i = 0; i < normalizedText.length; i++) if (normalizedText.charCodeAt(i) === 10) lines++;
	return contiguousLineNumbers(1, lines);
}

/** Read the full text of `absolutePath` (within {@link SNAPSHOT_MAX_BYTES}), record it as a version snapshot, and return its content-hash tag. Returns */
export async function recordFileSnapshot(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	seenLines?: Iterable<number>,
	normalizedText?: string,
): Promise<string | undefined> {
	try {
		if (normalizedText !== undefined) {
			// The cap is one rule, not one per path: a caller that read the file itself is held to the
			// same ceiling as the read below, so an over-size file yields no tag either way.
			if (Buffer.byteLength(normalizedText) > SNAPSHOT_MAX_BYTES) return undefined;
			return getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalizedText, seenLines);
		}
		const file = Bun.file(absolutePath);
		if (file.size > SNAPSHOT_MAX_BYTES) return undefined;
		const normalized = normalizeToLF(await file.text());
		return getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized, seenLines);
	} catch {
		// A snapshot is taken BEFORE an edit so the edit can be described against it, and a file that does not exist yet is the ordinary case for a write. Undefined means "no snapshot to compare against",
		return undefined;
	}
}

/** Leading line-number prefix the hashline/summary/grep formatters stamp on every displayed body line: `NN:` or a collapsed summary `NN-MM:` from `read`, */
const HASHLINE_LINE_PREFIX = /^[ *]?(\d+)(?:-(\d+))?:/;

/** The 1-indexed file lines a hashline-formatted body actually displayed. Single `NN:` rows contribute that line; a collapsed summary `NN-MM:` row */
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

/** Merge explicit 1-indexed displayed lines into a recorded hashline snapshot. */
export function recordSeenLines(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
	tag: string,
	lines: readonly number[],
): void {
	if (lines.length === 0) return;
	getFileSnapshotStore(session).recordSeenLines(canonicalSnapshotKey(absolutePath), tag, lines);
}

/** Attach the lines a read displayed to the snapshot it minted, so the patcher can reject edits anchored on lines the model never saw. Best-effort: a no-op */
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
