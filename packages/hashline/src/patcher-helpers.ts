import type { Filesystem } from "./fs";
import type { SnapshotStore } from "./snapshots";
import type { BlockResolution, BlockResolver } from "./types";

export const SEEN_LINE_REVEAL_CAP = 40;

export const SEEN_LINE_REVEAL_MAX_COLUMNS = 512;

export interface PatcherOptions {
	fs: Filesystem;
	snapshots: SnapshotStore;
	blockResolver?: BlockResolver;
}

export interface PatchSectionResult {
	path: string;
	canonicalPath: string;
	op: "create" | "update" | "delete" | "noop";
	before: string;
	after: string;
	persisted: string;
	written: string;
	fileHash: string;
	header: string;
	firstChangedLine?: number;
	warnings: string[];
	moveDest?: string;
	blockResolutions?: BlockResolution[];
}

export interface PatcherApplyResult {
	sections: PatchSectionResult[];
}
