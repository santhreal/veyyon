import type { SQLQueryBindings } from "bun:sqlite";

export const ALLOWED_DELTA_TABLES = new Set(["working_memory", "episodic_memory"] as const);
export type DeltaTable = "working_memory" | "episodic_memory";

export const QUALIFIED_TABLE_NAMES: Record<DeltaTable, string> = {
	working_memory: '"main"."working_memory"',
	episodic_memory: '"main"."episodic_memory"',
};
export const DELTA_UPDATABLE_COLUMNS = new Set([
	"content",
	"importance",
	"metadata_json",
	"veracity",
	"memory_type",
	"binary_vector",
	"source",
	"summary_of",
]);
export const DELTA_INSERTABLE_COLUMNS = new Set([
	"id",
	"content",
	"importance",
	"metadata_json",
	"veracity",
	"memory_type",
	"binary_vector",
	"source",
	"summary_of",
	"timestamp",
]);

export enum EventType {
	MEMORY_ADDED = "MEMORY_ADDED",
	MEMORY_RECALLED = "MEMORY_RECALLED",
	MEMORY_INVALIDATED = "MEMORY_INVALIDATED",
	MEMORY_CONSOLIDATED = "MEMORY_CONSOLIDATED",
	MEMORY_UPDATED = "MEMORY_UPDATED",
}

export interface MemoryEventInit {
	readonly eventType?: string;
	readonly event_type?: string;
	readonly memoryId?: string;
	readonly memory_id?: string;
	readonly timestamp?: string;
	readonly sessionId?: string | null;
	readonly session_id?: string | null;
	readonly content?: string | null;
	readonly source?: string | null;
	readonly importance?: number | null;
	readonly metadata?: Record<string, unknown> | null;
	readonly delta?: Record<string, unknown> | null;
}

export type MemoryEventDict = {
	event_type: string;
	memory_id: string;
	timestamp: string;
	session_id?: string | null;
	content?: string | null;
	source?: string | null;
	importance?: number | null;
	metadata?: Record<string, unknown> | null;
	delta?: Record<string, unknown> | null;
};

export function normalizeEventType(value: string | undefined): EventType {
	if (value === undefined) throw new TypeError("event_type is required");
	switch (value) {
		case EventType.MEMORY_ADDED:
		case EventType.MEMORY_RECALLED:
		case EventType.MEMORY_INVALIDATED:
		case EventType.MEMORY_CONSOLIDATED:
		case EventType.MEMORY_UPDATED:
			return value;
		default: {
			const mapped = EventType[value as keyof typeof EventType];
			if (mapped !== undefined) return mapped;
			throw new RangeError(`Unknown event type: ${value}`);
		}
	}
}

export function isSqlQueryBinding(value: unknown): value is SQLQueryBindings {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "boolean" ||
		(ArrayBuffer.isView(value) && !(value instanceof DataView))
	);
}
