import { LRUCache } from "lru-cache/raw";
import { computeFileHash } from "./format";

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

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	if (snapshot.seenLines === undefined) snapshot.seenLines = new Set<number>();
	for (const line of lines) snapshot.seenLines.add(line);
}

function mergeClippedLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	if (snapshot.clippedLines === undefined) snapshot.clippedLines = new Set<number>();
	for (const line of lines) snapshot.clippedLines.add(line);
}

export interface InMemorySnapshotStoreOptions {
	maxPaths?: number;
	maxVersionsPerPath?: number;
	maxTotalBytes?: number;
}

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
