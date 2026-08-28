/** Per-session snapshot store binding hashline section tags to file content. */
import { LRUCache } from "lru-cache/raw";
import { computeFileHash } from "./format";

/** One full-file version snapshot. */
export interface Snapshot {
	/** Canonical path this version belongs to. */
	readonly path: string;
	/** Full normalized (LF, no BOM) file text as observed. */
	readonly text: string;
	/** Content-derived tag for {@link Snapshot.text} (see {@link computeFileHash}). */
	readonly hash: string;
	/** Timestamp (ms since epoch) the version was recorded. */
	recordedAt: number;
	/** 1-indexed lines displayed under this tag. */
	seenLines?: Set<number>;
	/** 1-indexed lines displayed but clipped at column limit. */
	clippedLines?: Set<number>;
}

/** Storage seam for full-file version snapshots. */
export abstract class SnapshotStore {
	/** Most-recently recorded version for `path`, or `null` if none. */
	abstract head(path: string): Snapshot | null;

	/** Recorded version for path whose tag equals hash. */
	abstract byHash(path: string, hash: string): Snapshot | null;

	/** Recorded version for path whose text equals fullText. */
	abstract byContent(path: string, fullText: string): Snapshot | null;

	/** Every retained version across all paths whose tag equals hash. */
	findByHash(_hash: string): Snapshot[] {
		return [];
	}

	/** Record full normalized text of path and return content tag. */
	abstract record(path: string, fullText: string, seenLines?: Iterable<number>): string;

	/** Merge lines into seenLines of the version whose tag equals hash. */
	abstract recordSeenLines(path: string, hash: string, lines: Iterable<number>): void;

	/** Merge lines into clippedLines of the version whose tag equals hash. */
	abstract recordClippedLines(path: string, hash: string, lines: Iterable<number>): void;

	/** Drop the version history for a single path. */
	abstract invalidate(path: string): void;

	/** Relocate version history from one path to another. */
	abstract relocate(from: string, to: string): void;

	/** Drop every version history. */
	abstract clear(): void;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
/** Global ceiling on retained snapshot text across all paths (UTF-16 code units). */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Union `lines` into `snapshot.seenLines`, lazily creating the set. */
function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	if (snapshot.seenLines === undefined) snapshot.seenLines = new Set<number>();
	for (const line of lines) snapshot.seenLines.add(line);
}

/** Union `lines` into `snapshot.clippedLines`, lazily creating the set. */
function mergeClippedLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	if (snapshot.clippedLines === undefined) snapshot.clippedLines = new Set<number>();
	for (const line of lines) snapshot.clippedLines.add(line);
}

export interface InMemorySnapshotStoreOptions {
	/** Maximum number of distinct paths tracked at once (default 30). LRU eviction. */
	maxPaths?: number;
	/** Maximum full-file versions retained per path (default 4). Oldest dropped first. */
	maxVersionsPerPath?: number;
	/** Global ceiling on retained snapshot text in UTF-16 code units. */
	maxTotalBytes?: number;
}

/** In-memory SnapshotStore backed by LRU cache. */
export class InMemorySnapshotStore extends SnapshotStore {
	readonly #versions: LRUCache<string, Snapshot[]>;
	readonly #maxVersionsPerPath: number;

	constructor(options: InMemorySnapshotStoreOptions = {}) {
		super();
		this.#versions = new LRUCache<string, Snapshot[]>({
			max: options.maxPaths ?? DEFAULT_MAX_PATHS,
			maxSize: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
			sizeCalculation: history => {
				let total = 1;
				for (const version of history) total += version.text.length;
				return total;
			},
		});
		this.#maxVersionsPerPath = options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
	}

	head(path: string): Snapshot | null {
		return this.#versions.get(path)?.[0] ?? null;
	}

	byHash(path: string, hash: string): Snapshot | null {
		const history = this.#versions.get(path);
		return history?.find(version => version.hash === hash) ?? null;
	}

	byContent(path: string, fullText: string): Snapshot | null {
		const history = this.#versions.get(path);
		return history?.find(version => version.text === fullText) ?? null;
	}

	findByHash(hash: string): Snapshot[] {
		const matches: Snapshot[] = [];
		for (const history of this.#versions.values()) {
			for (const version of history) {
				if (version.hash === hash) matches.push(version);
			}
		}
		return matches;
	}

	record(path: string, fullText: string, seenLines?: Iterable<number>): string {
		const hash = computeFileHash(fullText);
		const history = this.#versions.get(path) ?? [];
		const existing = history.find(version => version.hash === hash && version.text === fullText);
		if (existing) {
			existing.recordedAt = Date.now();
			mergeSeenLines(existing, seenLines);
			if (history[0] !== existing) {
				this.#versions.set(path, [existing, ...history.filter(version => version !== existing)]);
			}
			return hash;
		}

		const snapshot: Snapshot = { path, text: fullText, hash, recordedAt: Date.now() };
		mergeSeenLines(snapshot, seenLines);
		this.#versions.set(path, [snapshot, ...history].slice(0, this.#maxVersionsPerPath));
		return hash;
	}

	recordSeenLines(path: string, hash: string, lines: Iterable<number>): void {
		const version = this.#versions.get(path)?.find(snapshot => snapshot.hash === hash);
		if (version) mergeSeenLines(version, lines);
	}

	recordClippedLines(path: string, hash: string, lines: Iterable<number>): void {
		const version = this.#versions.get(path)?.find(snapshot => snapshot.hash === hash);
		if (version) mergeClippedLines(version, lines);
	}

	invalidate(path: string): void {
		this.#versions.delete(path);
	}

	relocate(from: string, to: string): void {
		const sourceHistory = this.#versions.get(from);
		if (sourceHistory === undefined || sourceHistory.length === 0) return;
		const relocated = sourceHistory.map(version => ({ ...version, path: to }));
		const destHistory = this.#versions.get(to);
		if (destHistory === undefined) {
			this.#versions.set(to, relocated);
		} else {
			const seen = new Set<string>();
			const merged: Snapshot[] = [];
			for (const version of relocated.concat(destHistory)) {
				if (seen.has(version.hash)) continue;
				seen.add(version.hash);
				merged.push(version);
			}
			this.#versions.set(to, merged.slice(0, this.#maxVersionsPerPath));
		}
		this.#versions.delete(from);
	}

	clear(): void {
		this.#versions.clear();
	}
}
