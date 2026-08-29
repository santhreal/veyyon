export interface Snapshot {
	readonly path: string;
	readonly text: string;
	readonly hash: string;
	recordedAt: number;
	seenLines?: Set<number>;
	clippedLines?: Set<number>;
}

export abstract class SnapshotStore {
	abstract head(path: string): Snapshot | null;

	abstract byHash(path: string, hash: string): Snapshot | null;

	abstract byContent(path: string, fullText: string): Snapshot | null;

	findByHash(_hash: string): Snapshot[] {
		return [];
	}

	abstract record(path: string, fullText: string, seenLines?: Iterable<number>): string;

	abstract recordSeenLines(path: string, hash: string, lines: Iterable<number>): void;

	abstract recordClippedLines(path: string, hash: string, lines: Iterable<number>): void;

	abstract invalidate(path: string): void;

	abstract relocate(from: string, to: string): void;

	abstract clear(): void;
}

export const DEFAULT_MAX_PATHS = 30;
export const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	if (snapshot.seenLines === undefined) snapshot.seenLines = new Set<number>();
	for (const line of lines) snapshot.seenLines.add(line);
}

export function mergeClippedLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	if (snapshot.clippedLines === undefined) snapshot.clippedLines = new Set<number>();
	for (const line of lines) snapshot.clippedLines.add(line);
}

export interface InMemorySnapshotStoreOptions {
	maxPaths?: number;
	maxVersionsPerPath?: number;
	maxTotalBytes?: number;
}
