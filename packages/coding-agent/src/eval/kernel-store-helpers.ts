export const STORE_VERSION = 1;
/** A single value above this is refused: the store is for handles and small state, not payloads. */
export const KV_VALUE_SIZE_LIMIT = 256 * 1024;
/** The whole store above this is refused: it rides no hot path, but a runaway loop should not grow it. */
export const KV_STORE_SIZE_LIMIT = 4 * 1024 * 1024;

export interface KernelStore {
	/** Absolute path of the backing file, for diagnostics. Never printed with values. */
	readonly filePath: string;
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	/** Key names only: listing must never move a value into a log line or a status event. */
	list(): Promise<string[]>;
}

export interface StoreFile {
	version: number;
	values: Record<string, unknown>;
}
