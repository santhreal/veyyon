export const HINDSIGHT_RETAIN_BATCH_SIZE = 16;
export const MEMORY_RETAIN_MAX_ITEM_BYTES = 64 * 1024;
export const MEMORY_RETAIN_MAX_ITEMS = 64;
export const MEMORY_RETAIN_MAX_BYTES = 256 * 1024;
export const RETAIN_FLUSH_INTERVAL_MS = 5_000;

export interface PendingRetainItem {
	content: string;
	context?: string;
	timestamp: Date;
	bytes: number;
}

export interface RecallOutcome {
	context: string | null;
	ok: boolean;
}
