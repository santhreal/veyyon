import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clampLow, isRecord } from "@veyyon/utils";
import { DEFAULT_DB_FILENAME, dataDir } from "./config";
import { BankManager } from "./core/banks";
import { BeamMemory, type RecallOptions } from "./core/beam";
import { addTriple, queryTriples } from "./core/triples";
import { clampVeracity, VERACITY_DESCRIPTION, VERACITY_VALUES } from "./core/veracity";

import type { JsonValue } from "./types";

export type { JsonPrimitive, JsonValue } from "./types";
export type ToolArguments = Record<string, unknown>;
export type ToolResult = Record<string, unknown>;

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: {
		readonly type: "object";
		readonly properties: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

export const EMPTY_SCHEMA = { type: "object", properties: {} } as const;

export const REMEMBER_SCHEMA = {
	type: "object",
	properties: {
		content: { type: "string", description: "The memory content to store." },
		importance: { type: "number", description: "Importance score from 0.0 to 1.0.", default: 0.5 },
		source: { type: "string", description: "Source tag for this memory.", default: "user" },
		scope: {
			type: "string",
			description: "Memory scope: session, global, channel, or a custom scope.",
			default: "session",
		},
		valid_until: { type: "string", description: "Optional expiry date or timestamp." },
		extract_entities: {
			type: "boolean",
			description: "Extract named entities for fuzzy recall.",
			default: false,
		},
		extract: {
			type: "boolean",
			description: "Extract structured facts from content.",
			default: false,
		},
		metadata: { type: "object", description: "Optional key-value metadata.", default: {} },
		veracity: {
			type: "string",
			enum: VERACITY_VALUES,
			description: VERACITY_DESCRIPTION,
			default: "unknown",
		},
		author_id: { type: "string", description: "Author identifier for this MCP call." },
		author_type: { type: "string", description: "Author type: human, agent, or system." },
		channel_id: { type: "string", description: "Channel or group this memory belongs to." },
		bank: { type: "string", description: "Memory bank to store in.", default: "default" },
	},
	required: ["content"],
} as const;

export const RECALL_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string", description: "Natural-language search query." },
		limit: { type: "integer", description: "Maximum results to return.", default: 5 },
		top_k: { type: "integer", description: "Maximum results to return.", default: 5 },
		bank: { type: "string", description: "Memory bank to search.", default: "default" },
		temporal_weight: {
			type: "number",
			description: "Temporal boost weight. 0.0 disables recency boost.",
			default: 0.0,
		},
		query_time: {
			type: "string",
			description: "ISO timestamp to treat as now for temporal scoring.",
		},
		temporal_halflife: {
			type: "number",
			description: "Temporal decay half-life in hours.",
			default: 24,
		},
		vec_weight: { type: "number", description: "Vector similarity weight." },
		fts_weight: { type: "number", description: "Full-text search weight." },
		importance_weight: { type: "number", description: "Importance score weight." },
		author_id: { type: "string", description: "Filter by author identifier." },
		author_type: { type: "string", description: "Filter by author type." },
		channel_id: { type: "string", description: "Filter by channel/group." },
	},
	required: ["query"],
} as const;

export const SHARED_REMEMBER_SCHEMA = {
	type: "object",
	properties: {
		content: { type: "string", description: "Surface memory content to store." },
		kind: {
			type: "string",
			description: "meta | preference | correction | identity",
			default: "meta",
		},
		importance: { type: "number", description: "Importance score from 0.0 to 1.0.", default: 0.8 },
		veracity: {
			type: "string",
			enum: VERACITY_VALUES,
			description: VERACITY_DESCRIPTION,
			default: "unknown",
		},
		metadata: { type: "object", description: "Optional metadata object.", default: {} },
	},
	required: ["content"],
} as const;

export const SHARED_RECALL_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string", description: "Surface memory query." },
		limit: { type: "integer", default: 5 },
	},
	required: ["query"],
} as const;

export const SHARED_FORGET_SCHEMA = {
	type: "object",
	properties: { memory_id: { type: "string", description: "Memory ID to delete." } },
	required: ["memory_id"],
} as const;

export const SLEEP_SCHEMA = {
	type: "object",
	properties: {
		dry_run: {
			type: "boolean",
			description: "Preview consolidation without writes.",
			default: false,
		},
		all_sessions: {
			type: "boolean",
			description: "Consolidate all eligible sessions.",
			default: false,
		},
		bank: { type: "string", description: "Memory bank to consolidate.", default: "default" },
	},
} as const;

export const INVALIDATE_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "ID of memory to invalidate." },
		replacement_id: { type: "string", description: "Optional replacement memory ID." },
		bank: { type: "string", default: "default" },
	},
	required: ["memory_id"],
} as const;

export const VALIDATE_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "ID of memory to validate." },
		action: { type: "string", enum: ["attest", "update", "invalidate", "delete"] },
		validator: { type: "string", description: "Agent identifier performing validation." },
		new_content: { type: "string", description: "New content for action=update." },
		note: { type: "string", description: "Optional reason or evidence." },
		bank: { type: "string", enum: ["private", "surface"], default: "private" },
	},
	required: ["memory_id", "action"],
} as const;

export const GET_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "The memory ID to retrieve." },
		bank: { type: "string", default: "default" },
	},
	required: ["memory_id"],
} as const;

export const TRIPLE_ADD_SCHEMA = {
	type: "object",
	properties: {
		subject: { type: "string" },
		predicate: { type: "string" },
		object: { type: "string" },
		valid_from: { type: "string", description: "ISO date." },
		source: { type: "string", default: "conversation" },
		confidence: { type: "number", default: 1.0 },
		bank: { type: "string", default: "default" },
	},
	required: ["subject", "predicate", "object"],
} as const;

export const TRIPLE_QUERY_SCHEMA = {
	type: "object",
	properties: {
		subject: { type: "string" },
		predicate: { type: "string" },
		object: { type: "string" },
		as_of: { type: "string" },
		bank: { type: "string", default: "default" },
	},
} as const;

export const SCRATCHPAD_WRITE_SCHEMA = {
	type: "object",
	properties: {
		content: { type: "string", description: "Content to write to scratchpad." },
		bank: { type: "string", default: "default" },
	},
	required: ["content"],
} as const;

export const SCRATCHPAD_READ_SCHEMA = {
	type: "object",
	properties: { bank: { type: "string", default: "default" } },
} as const;

export const SCRATCHPAD_CLEAR_SCHEMA = {
	type: "object",
	properties: { bank: { type: "string", default: "default" } },
} as const;

export const EXPORT_SCHEMA = {
	type: "object",
	properties: {
		output_path: { type: "string", description: "File path to write the export JSON." },
		bank: { type: "string", default: "default" },
	},
	required: ["output_path"],
} as const;

export const UPDATE_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "ID of the memory to update." },
		content: { type: "string", description: "New content for the memory." },
		importance: { type: "number", description: "New importance score." },
		bank: { type: "string", default: "default" },
	},
	required: ["memory_id", "content"],
} as const;

export const FORGET_SCHEMA = {
	type: "object",
	properties: {
		memory_id: { type: "string", description: "ID of the memory to delete." },
		bank: { type: "string", default: "default" },
	},
	required: ["memory_id"],
} as const;

export const IMPORT_SCHEMA = {
	type: "object",
	properties: {
		input_path: { type: "string", description: "File path to read the export JSON from." },
		force: {
			type: "boolean",
			description: "Overwrite existing records instead of skipping.",
			default: false,
		},
		bank: { type: "string", default: "default" },
	},
	required: ["input_path"],
} as const;

export const GRAPH_QUERY_SCHEMA = {
	type: "object",
	properties: {
		seed_memory_id: { type: "string" },
		max_hops: { type: "integer", default: 2 },
		edge_type: { type: "string" },
		min_weight: { type: "number", default: 0.0 },
		bank: { type: "string", default: "default" },
	},
	required: ["seed_memory_id"],
} as const;

export const GRAPH_LINK_SCHEMA = {
	type: "object",
	properties: {
		source_id: { type: "string" },
		target_id: { type: "string" },
		relationship: { type: "string" },
		weight: { type: "number", default: 0.5 },
		bank: { type: "string", default: "default" },
	},
	required: ["source_id", "target_id", "relationship"],
} as const;

export const TOOLS: readonly ToolDefinition[] = [
	{
		name: "mnemopi_remember",
		description: "Store a durable memory in Mnemopi.",
		inputSchema: REMEMBER_SCHEMA,
	},
	{
		name: "mnemopi_recall",
		description: "Search memories with hybrid scoring.",
		inputSchema: RECALL_SCHEMA,
	},
	{
		name: "mnemopi_shared_remember",
		description: "Store compact cross-agent surface memory.",
		inputSchema: SHARED_REMEMBER_SCHEMA,
	},
	{
		name: "mnemopi_shared_recall",
		description: "Search only the shared Mnemopi surface DB.",
		inputSchema: SHARED_RECALL_SCHEMA,
	},
	{
		name: "mnemopi_shared_forget",
		description: "Delete one shared-surface memory by ID.",
		inputSchema: SHARED_FORGET_SCHEMA,
	},
	{
		name: "mnemopi_shared_stats",
		description: "Return shared surface DB path and counts.",
		inputSchema: EMPTY_SCHEMA,
	},
	{
		name: "mnemopi_sleep",
		description: "Run the consolidation sleep cycle.",
		inputSchema: SLEEP_SCHEMA,
	},
	{
		name: "mnemopi_stats",
		description: "Return Mnemopi memory statistics.",
		inputSchema: EMPTY_SCHEMA,
	},
	{
		name: "mnemopi_invalidate",
		description: "Mark a memory as expired or superseded.",
		inputSchema: INVALIDATE_SCHEMA,
	},
	{
		name: "mnemopi_validate",
		description: "Attest, update, invalidate, or delete a memory.",
		inputSchema: VALIDATE_SCHEMA,
	},
	{ name: "mnemopi_get", description: "Retrieve one memory by ID.", inputSchema: GET_SCHEMA },
	{
		name: "mnemopi_triple_add",
		description: "Add a temporal fact triple.",
		inputSchema: TRIPLE_ADD_SCHEMA,
	},
	{
		name: "mnemopi_triple_query",
		description: "Query temporal fact triples.",
		inputSchema: TRIPLE_QUERY_SCHEMA,
	},
	{
		name: "mnemopi_scratchpad_write",
		description: "Write a temporary scratchpad note.",
		inputSchema: SCRATCHPAD_WRITE_SCHEMA,
	},
	{
		name: "mnemopi_scratchpad_read",
		description: "Read scratchpad entries.",
		inputSchema: SCRATCHPAD_READ_SCHEMA,
	},
	{
		name: "mnemopi_scratchpad_clear",
		description: "Clear scratchpad entries.",
		inputSchema: SCRATCHPAD_CLEAR_SCHEMA,
	},
	{
		name: "mnemopi_export",
		description: "Export Mnemopi memories to a JSON file.",
		inputSchema: EXPORT_SCHEMA,
	},
	{
		name: "mnemopi_update",
		description: "Update the content or importance of an existing memory.",
		inputSchema: UPDATE_SCHEMA,
	},
	{
		name: "mnemopi_forget",
		description: "Permanently delete a memory by ID.",
		inputSchema: FORGET_SCHEMA,
	},
	{
		name: "mnemopi_import",
		description: "Import Mnemopi memories from a JSON file.",
		inputSchema: IMPORT_SCHEMA,
	},
	{
		name: "mnemopi_diagnose",
		description: "Run PII-safe diagnostics on the active Mnemopi database.",
		inputSchema: EMPTY_SCHEMA,
	},
	{
		name: "mnemopi_graph_query",
		description: "Traverse the memory graph from a seed memory.",
		inputSchema: GRAPH_QUERY_SCHEMA,
	},
	{
		name: "mnemopi_graph_link",
		description: "Declare a semantic edge between two memories.",
		inputSchema: GRAPH_LINK_SCHEMA,
	},
];

// circular import: tool handlers moved to helpers
export { handleToolCall, getToolDefinitions } from "./mcp-tools-helpers";
