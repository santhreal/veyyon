import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import type { StopReason, Usage } from "@veyyon/ai";
import type { GeneratedProvider } from "@veyyon/catalog/models";
import { emptyCost, getBundledModel, hasBillableCost } from "@veyyon/catalog/models";
import { DAY_MS, getConfigRootDir, getStatsDbPath } from "@veyyon/utils";
import { tableExists } from "@veyyon/utils/sqlite";
import { classifyAgentType } from "./parser";
import type {
	AgentType,
	AgentTypeStats,
	AggregatedStats,
	BehaviorModelStats,
	BehaviorOverallStats,
	BehaviorTimeSeriesPoint,
	CostTimeSeriesPoint,
	FolderStats,
	MessageStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
	ToolCallStats,
	ToolModelStats,
	ToolResultLink,
	ToolTimeSeriesPoint,
	ToolUsageStats,
	UserMessageLink,
	UserMessageStats,
} from "./types";

type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type UsageCost = Usage["cost"];
type CostTokens = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">;

interface CostBackfillRow {
	id: number;
	provider: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

let db: Database | null = null;

const BACKFILL_COMPLETE = "complete";
const BACKFILL_PENDING = "pending";
const USER_MESSAGES_BACKFILL_KEY = "user_messages_v8";
const USER_MESSAGE_LINKS_REPAIR_KEY = "user_message_links_v1";
const PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY = "premium_requests_priority_v1";
const AGENT_TYPE_BACKFILL_KEY = "agent_type_v1";
const FORK_DEDUPE_KEY = "fork_dedupe_v1";
const TOOL_CALLS_BACKFILL_KEY = "tool_calls_v1";
function shouldResetBackfill(value: string | undefined): boolean {
	return value !== BACKFILL_COMPLETE && value !== BACKFILL_PENDING;
}
/**
 * Initialize the database and create tables.
 */
export async function initDb(): Promise<Database> {
	if (db) return db;

	// Ensure directory exists
	await fs.mkdir(getConfigRootDir(), { recursive: true });

	db = new Database(getStatsDbPath());
	// Install the busy handler BEFORE any lock-taking statement.
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");

	// Whether `messages` predates this init — drives the one-time agent_type
	// backfill below, so it must be sampled before CREATE TABLE adds the table.
	const messagesTableExisted = tableExists(db, "messages");

	// Create tables
	db.run(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration INTEGER,
			ttft INTEGER,
			stop_reason TEXT NOT NULL,
			error_message TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			premium_requests REAL NOT NULL,
			cost_input REAL NOT NULL,
			cost_output REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_total REAL NOT NULL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model);
		CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_file);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_model_provider ON messages(timestamp, model, provider);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_folder ON messages(timestamp, folder);
		CREATE INDEX IF NOT EXISTS idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);

		CREATE TABLE IF NOT EXISTS file_offsets (
			session_file TEXT PRIMARY KEY,
			offset INTEGER NOT NULL,
			last_modified INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS user_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			model TEXT,
			provider TEXT,
			chars INTEGER NOT NULL,
			words INTEGER NOT NULL,
			yelling INTEGER NOT NULL,
			profanity INTEGER NOT NULL,
			anguish INTEGER NOT NULL,
			negation INTEGER NOT NULL DEFAULT 0,
			repetition INTEGER NOT NULL DEFAULT 0,
			blame INTEGER NOT NULL DEFAULT 0,
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);

		CREATE TABLE IF NOT EXISTS tool_calls (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			tool_call_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			calls_in_turn INTEGER NOT NULL DEFAULT 1,
			args_chars INTEGER NOT NULL DEFAULT 0,
			result_chars INTEGER,
			is_error INTEGER,
			UNIQUE(session_file, tool_call_id)
		);

		CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
		CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_timestamp ON tool_calls(tool_name, timestamp);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);

	const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
	if (!messageColumns.some(column => column.name === "premium_requests")) {
		db.run("ALTER TABLE messages ADD COLUMN premium_requests REAL NOT NULL DEFAULT 0");
	}
	db.run("UPDATE messages SET premium_requests = 0 WHERE premium_requests IS NULL");
	const hasAgentTypeColumn = messageColumns.some(column => column.name === "agent_type");
	if (!hasAgentTypeColumn) {
		db.run("ALTER TABLE messages ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'main'");
	}
	db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
		AGENT_TYPE_BACKFILL_KEY,
		messagesTableExisted ? BACKFILL_PENDING : BACKFILL_COMPLETE,
	);
	db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp_agent_type ON messages(timestamp, agent_type)");
	// Behavior-metric schema version check: drop stale tables to trigger re-ingest.
	const userMessageColumns = db.prepare("PRAGMA table_info(user_messages)").all() as {
		name: string;
	}[];
	const hasStaleColumn =
		userMessageColumns.length > 0 &&
		(userMessageColumns.some(column => column.name === "caps_words") ||
			userMessageColumns.some(column => column.name === "drama_runs") ||
			userMessageColumns.some(column => column.name === "yelling_sentences"));
	const hasV4Columns = userMessageColumns.some(column => column.name === "negation");
	const hasOldUserMessages = userMessageColumns.length > 0;
	if (hasStaleColumn || (hasOldUserMessages && !hasV4Columns)) {
		db.run("DROP TABLE user_messages");
		db.run(`
			CREATE TABLE user_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				model TEXT,
				provider TEXT,
				chars INTEGER NOT NULL,
				words INTEGER NOT NULL,
				yelling INTEGER NOT NULL,
				profanity INTEGER NOT NULL,
				anguish INTEGER NOT NULL,
				negation INTEGER NOT NULL DEFAULT 0,
				repetition INTEGER NOT NULL DEFAULT 0,
				blame INTEGER NOT NULL DEFAULT 0,
				UNIQUE(session_file, entry_id)
			);
			CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);
			CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);
		`);
	}
	backfillUserMessages(db);
	backfillToolCalls(db);
	repairUserMessageLinks(db);
	backfillPriorityPremiumRequests(db);
	backfillAgentType(db);
	backfillMissingCatalogCosts(db);
	backfillForkDuplicates(db);
	return db;
}

function getBundledModelCost(provider: string, modelId: string): ModelCost | null {
	const model = getBundledModel(provider as GeneratedProvider, modelId);
	return model?.cost ?? null;
}

function getCatalogCost(provider: string, modelId: string): ModelCost | null {
	const primaryCost = getBundledModelCost(provider, modelId);
	if (primaryCost && hasBillableCost(primaryCost)) {
		return primaryCost;
	}

	if (provider === "openai-codex") {
		const openAICost = getBundledModelCost("openai", modelId);
		if (openAICost && hasBillableCost(openAICost)) {
			return openAICost;
		}
	}

	return null;
}

function calculateCatalogCost(provider: string, modelId: string, tokens: CostTokens): UsageCost | null {
	const cost = getCatalogCost(provider, modelId);
	if (!cost) return null;

	const input = (cost.input / 1_000_000) * tokens.input;
	const output = (cost.output / 1_000_000) * tokens.output;
	const cacheRead = (cost.cacheRead / 1_000_000) * tokens.cacheRead;
	const cacheWrite = (cost.cacheWrite / 1_000_000) * tokens.cacheWrite;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	};
}

function resolveStoredCost(stats: MessageStats): UsageCost {
	// `usage.cost` was optional in older session files. Although current
	// MessageStats requires it, parsed JSONL can still carry that legacy shape.
	const storedCost: UsageCost | undefined = stats.usage.cost;
	if (storedCost && storedCost.total !== 0) {
		return storedCost;
	}

	return calculateCatalogCost(stats.provider, stats.model, stats.usage) ?? storedCost ?? emptyCost();
}

function backfillMissingCatalogCosts(database: Database): void {
	const rows = database
		.prepare(`
			SELECT id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
			FROM messages
			WHERE cost_total = 0 AND total_tokens > 0
		`)
		.all() as CostBackfillRow[];

	if (rows.length === 0) return;

	const update = database.prepare(`
		UPDATE messages
		SET cost_input = ?, cost_output = ?, cost_cache_read = ?, cost_cache_write = ?, cost_total = ?
		WHERE id = ?
	`);

	const applyBackfill = database.transaction(() => {
		for (const row of rows) {
			const cost = calculateCatalogCost(row.provider, row.model, {
				input: row.input_tokens,
				output: row.output_tokens,
				cacheRead: row.cache_read_tokens,
				cacheWrite: row.cache_write_tokens,
			});

			if (!cost || cost.total === 0) continue;

			update.run(cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total, row.id);
		}
	});

	applyBackfill();
}

/**
 * Get the stored offset for a session file.
 */
export function getFileOffset(sessionFile: string): { offset: number; lastModified: number } | null {
	if (!db) return null;

	const stmt = db.prepare("SELECT offset, last_modified FROM file_offsets WHERE session_file = ?");
	const row = stmt.get(sessionFile) as { offset: number; last_modified: number } | undefined;

	return row ? { offset: row.offset, lastModified: row.last_modified } : null;
}

/**
 * Update the stored offset for a session file.
 */
export function setFileOffset(sessionFile: string, offset: number, lastModified: number): void {
	if (!db) return;

	const stmt = db.prepare(`
		INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified)
		VALUES (?, ?, ?)
	`);
	stmt.run(sessionFile, offset, lastModified);
}

/** Insert message stats into the database. */
export function insertMessageStats(stats: MessageStats[]): number {
	if (!db || stats.length === 0) return 0;

	const stmt = db.prepare(`
		INSERT INTO messages (
			session_file, entry_id, folder, model, provider, api, timestamp,
			duration, ttft, stop_reason, error_message,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
			cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, agent_type
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM messages
			WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
		)
		ON CONFLICT(session_file, entry_id) DO UPDATE SET
			premium_requests = excluded.premium_requests
		WHERE messages.premium_requests < excluded.premium_requests
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const s of stats) {
			const cost = resolveStoredCost(s);
			const result = stmt.run(
				s.sessionFile,
				s.entryId,
				s.folder,
				s.model,
				s.provider,
				s.api,
				s.timestamp,
				s.duration,
				s.ttft,
				s.stopReason,
				s.errorMessage,
				s.usage.input,
				s.usage.output,
				s.usage.cacheRead,
				s.usage.cacheWrite,
				s.usage.totalTokens,
				s.usage.premiumRequests ?? 0,
				cost.input,
				cost.output,
				cost.cacheRead,
				cost.cacheWrite,
				cost.total,
				s.agentType,
				// `WHERE NOT EXISTS` binds: skip when a different session_file
				// already holds this (entry_id, timestamp).
				s.entryId,
				s.timestamp,
				s.sessionFile,
			);
			if (result.changes > 0) inserted++;
		}
	});

	insert();
	return inserted;
}

/** Raw row shapes for the SQL queries below. sqlite results cannot be */
interface AggregateRow {
	total_requests: number | null;
	failed_requests: number | null;
	total_input_tokens: number | null;
	total_output_tokens: number | null;
	total_cache_read_tokens: number | null;
	total_cache_write_tokens: number | null;
	total_premium_requests: number | null;
	total_cost: number | null;
	avg_duration: number | null;
	avg_ttft: number | null;
	avg_tokens_per_second: number | null;
	first_timestamp: number | null;
	last_timestamp: number | null;
}

interface AgentTypeTotalsRow {
	agent_type: string | null;
	total_requests: number | null;
	total_input_tokens: number | null;
	total_output_tokens: number | null;
	total_cache_read_tokens: number | null;
	total_cache_write_tokens: number | null;
	total_cost: number | null;
}

interface TimeSeriesRow {
	bucket: number;
	requests: number;
	errors: number;
	tokens: number | null;
	cost: number | null;
}

interface CostSeriesRow {
	bucket: number;
	model: string;
	provider: string;
	cost: number | null;
	cost_input: number | null;
	cost_output: number | null;
	cost_cache_read: number | null;
	cost_cache_write: number | null;
	requests: number;
}

/** Raw `messages` table row (SELECT *). */
interface MessageRow {
	id: number;
	session_file: string;
	entry_id: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number;
	ttft: number | null;
	stop_reason: string;
	error_message: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	premium_requests: number | null;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
	agent_type: string | null;
}

/**
 * Build aggregated stats from query results.
 */
function buildAggregatedStats(rows: AggregateRow[]): AggregatedStats {
	if (rows.length === 0) {
		return {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			errorRate: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			cacheRate: 0,
			totalCost: 0,
			totalPremiumRequests: 0,
			avgDuration: null,
			avgTtft: null,
			avgTokensPerSecond: null,
			firstTimestamp: 0,
			lastTimestamp: 0,
		};
	}

	const row = rows[0];
	const totalRequests = row.total_requests || 0;
	const failedRequests = row.failed_requests || 0;
	const successfulRequests = totalRequests - failedRequests;
	const totalInputTokens = row.total_input_tokens || 0;
	const totalCacheReadTokens = row.total_cache_read_tokens || 0;
	const totalPremiumRequests = row.total_premium_requests || 0;

	return {
		totalRequests,
		successfulRequests,
		failedRequests,
		errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
		totalInputTokens,
		totalOutputTokens: row.total_output_tokens || 0,
		totalCacheReadTokens,
		totalCacheWriteTokens: row.total_cache_write_tokens || 0,
		cacheRate:
			totalInputTokens + totalCacheReadTokens > 0
				? totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)
				: 0,
		totalCost: row.total_cost || 0,
		totalPremiumRequests,
		avgDuration: row.avg_duration,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
		firstTimestamp: row.first_timestamp || 0,
		lastTimestamp: row.last_timestamp || 0,
	};
}

/**
 * Get overall aggregated stats.
 */
export function getOverallStats(cutoff?: number): AggregatedStats {
	if (!db) return buildAggregatedStats([]);

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
	`);

	const rows = hasCutoff ? stmt.all(cutoff) : stmt.all();
	return buildAggregatedStats(rows as AggregateRow[]);
}
/**
 * Get stats grouped by model.
 */
export function getStatsByModel(cutoff?: number): ModelStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			model,
			provider,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model, provider
		ORDER BY total_requests DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as (AggregateRow & { model: string; provider: string })[];
	return rows.map(row => ({
		model: row.model,
		provider: row.provider,
		...buildAggregatedStats([row]),
	}));
}

/**
 * Get stats grouped by folder.
 */
export function getStatsByFolder(cutoff?: number): FolderStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			folder,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY folder
		ORDER BY total_requests DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as (AggregateRow & { folder: string })[];
	return rows.map(row => ({
		folder: row.folder,
		...buildAggregatedStats([row]),
	}));
}

/** Get token usage grouped by agent type (main agent, task subagents, advisor). */
export function getStatsByAgentType(cutoff?: number): AgentTypeStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			agent_type,
			COUNT(*) as total_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(cost_total) as total_cost
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY agent_type
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as AgentTypeTotalsRow[];
	return rows.map(row => ({
		agentType: (row.agent_type as AgentType | null) ?? "main",
		totalRequests: row.total_requests || 0,
		totalInputTokens: row.total_input_tokens || 0,
		totalOutputTokens: row.total_output_tokens || 0,
		totalCacheReadTokens: row.total_cache_read_tokens || 0,
		totalCacheWriteTokens: row.total_cache_write_tokens || 0,
		totalCost: row.total_cost || 0,
	}));
}

/**
 * Get time series data.
 */
export function getTimeSeries(hours = 24, cutoff?: number | null, bucketMs = 60 * 60 * 1000): TimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - hours * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			COUNT(*) as requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as errors,
			SUM(total_tokens) as tokens,
			SUM(cost_total) as cost
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket
		ORDER BY bucket ASC
	`);

	const rows = hasCutoff
		? (stmt.all(bucketMs, bucketMs, seriesCutoff) as TimeSeriesRow[])
		: (stmt.all(bucketMs, bucketMs) as TimeSeriesRow[]);
	return rows.map(row => ({
		timestamp: row.bucket,
		requests: row.requests,
		errors: row.errors,
		tokens: row.tokens ?? 0,
		cost: row.cost ?? 0,
	}));
}

/**
 * Get daily performance time series data for the last N days.
 */
/**
 * Get daily model usage time series data for the last N days.
 */
export function getModelTimeSeries(days = 14, cutoff?: number | null, bucketMs = DAY_MS): ModelTimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * DAY_MS) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			model,
			provider,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rowsRaw = hasCutoff ? stmt.all(bucketMs, bucketMs, seriesCutoff) : stmt.all(bucketMs, bucketMs);
	const rows = rowsRaw as Array<{ bucket: number; model: string; provider: string; requests: number }>;
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
	}));
}

/**
 * Get daily model performance time series data for the last N days.
 */
export function getModelPerformanceSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = DAY_MS,
): ModelPerformancePoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * DAY_MS) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			model,
			provider,
			COUNT(*) as requests,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rowsRaw = hasCutoff ? stmt.all(bucketMs, bucketMs, seriesCutoff) : stmt.all(bucketMs, bucketMs);
	const rows = rowsRaw as Array<{
		bucket: number;
		model: string;
		provider: string;
		requests: number;
		avg_ttft: number | null;
		avg_tokens_per_second: number | null;
	}>;
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
	}));
}

/**
 * Get total message count.
 */
export function getMessageCount(): number {
	if (!db) return 0;
	const stmt = db.prepare("SELECT COUNT(*) as count FROM messages");
	const row = stmt.get() as { count: number };
	return row.count;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function rowToMessageStats(row: MessageRow): MessageStats {
	return {
		id: row.id,
		sessionFile: row.session_file,
		entryId: row.entry_id,
		folder: row.folder,
		model: row.model,
		provider: row.provider,
		api: row.api,
		timestamp: row.timestamp,
		duration: row.duration,
		ttft: row.ttft,
		stopReason: row.stop_reason as StopReason,
		errorMessage: row.error_message,
		usage: {
			input: row.input_tokens,
			output: row.output_tokens,
			cacheRead: row.cache_read_tokens,
			cacheWrite: row.cache_write_tokens,
			totalTokens: row.total_tokens,
			premiumRequests: row.premium_requests ?? 0,
			cost: {
				input: row.cost_input,
				output: row.cost_output,
				cacheRead: row.cost_cache_read,
				cacheWrite: row.cost_cache_write,
				total: row.cost_total,
			},
		},
		agentType: (row.agent_type as AgentType) ?? "main",
	};
}

export function getRecentRequests(limit = 100): MessageStats[] {
	if (!db) return [];
	const stmt = db.prepare(`
		SELECT * FROM messages 
		ORDER BY timestamp DESC 
		LIMIT ?
	`);
	return (stmt.all(limit) as MessageRow[]).map(rowToMessageStats);
}

export function getRecentErrors(limit = 100): MessageStats[] {
	if (!db) return [];
	const stmt = db.prepare(`
		SELECT * FROM messages 
		WHERE stop_reason = 'error'
		ORDER BY timestamp DESC 
		LIMIT ?
	`);
	return (stmt.all(limit) as MessageRow[]).map(rowToMessageStats);
}

export function getMessageById(id: number): MessageStats | null {
	if (!db) return null;
	const stmt = db.prepare("SELECT * FROM messages WHERE id = ?");
	const row = stmt.get(id) as MessageRow | null;
	return row ? rowToMessageStats(row) : null;
}

/**
 * Get daily cost time series data for the last N days, broken down by model.
 */
export function getCostTimeSeries(days = 90, cutoff?: number | null): CostTimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * DAY_MS) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ${DAY_MS}) * ${DAY_MS} as bucket,
			model,
			provider,
			SUM(cost_total) as cost,
			SUM(cost_input) as cost_input,
			SUM(cost_output) as cost_output,
			SUM(cost_cache_read) as cost_cache_read,
			SUM(cost_cache_write) as cost_cache_write,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rows = hasCutoff ? (stmt.all(seriesCutoff) as CostSeriesRow[]) : (stmt.all() as CostSeriesRow[]);
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		cost: row.cost ?? 0,
		costInput: row.cost_input ?? 0,
		costOutput: row.cost_output ?? 0,
		costCacheRead: row.cost_cache_read ?? 0,
		costCacheWrite: row.cost_cache_write ?? 0,
		requests: row.requests,
	}));
}

/** Reset `file_offsets` (and any existing `user_messages` rows) so the next */
function backfillUserMessages(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(USER_MESSAGES_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM user_messages");
	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(USER_MESSAGES_BACKFILL_KEY, BACKFILL_PENDING);
}

/** One-shot wipe of `tool_calls` + `file_offsets` when the `tool_calls` table */
function backfillToolCalls(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(TOOL_CALLS_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM tool_calls");
	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(TOOL_CALLS_BACKFILL_KEY, BACKFILL_PENDING);
}

/** Reclassify pre-existing `messages` rows by agent type once, after the */
function backfillAgentType(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(AGENT_TYPE_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (row?.value !== BACKFILL_PENDING) return;

	const sessionFiles = database.prepare("SELECT DISTINCT session_file FROM messages").all() as {
		session_file: string;
	}[];
	const update = database.prepare("UPDATE messages SET agent_type = ? WHERE session_file = ?");
	const markComplete = database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
	const apply = database.transaction(() => {
		for (const { session_file } of sessionFiles) {
			const agentType = classifyAgentType(session_file);
			// Rows already default to 'main'; only the nested transcripts move.
			if (agentType !== "main") update.run(agentType, session_file);
		}
		markComplete.run(AGENT_TYPE_BACKFILL_KEY, BACKFILL_COMPLETE);
	});
	apply();
}

/** One-shot collapse of forked-session duplicates that landed under the old */
function backfillForkDuplicates(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(FORK_DEDUPE_KEY) as
		| { value: string }
		| undefined;
	if (row?.value === BACKFILL_COMPLETE) return;

	const markComplete = database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
	const apply = database.transaction(() => {
		database.run(`
			DELETE FROM messages
			WHERE id NOT IN (
				SELECT MIN(id) FROM messages GROUP BY entry_id, timestamp
			)
		`);
		database.run(`
			DELETE FROM user_messages
			WHERE id NOT IN (
				SELECT MIN(id) FROM user_messages GROUP BY entry_id, timestamp
			)
		`);
		markComplete.run(FORK_DEDUPE_KEY, BACKFILL_COMPLETE);
	});
	apply();
}

/** One-shot wipe of `file_offsets` to force `parseSessionFile` to re-parse */
function repairUserMessageLinks(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(USER_MESSAGE_LINKS_REPAIR_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(USER_MESSAGE_LINKS_REPAIR_KEY, BACKFILL_PENDING);
}

/** One-shot wipe of `file_offsets` so the next sync re-parses every session */
function backfillPriorityPremiumRequests(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY, BACKFILL_PENDING);
}

export function markPriorityPremiumRequestsBackfillComplete(): void {
	if (!db) return;
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
		PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY,
		BACKFILL_COMPLETE,
	);
}

export function markUserMessagesBackfillComplete(): void {
	if (!db) return;
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
		USER_MESSAGES_BACKFILL_KEY,
		BACKFILL_COMPLETE,
	);
}

export function markUserMessageLinksRepairComplete(): void {
	if (!db) return;
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
		USER_MESSAGE_LINKS_REPAIR_KEY,
		BACKFILL_COMPLETE,
	);
}

/** Insert user-message stats. Idempotent via UNIQUE(session_file, entry_id). */
export function insertUserMessageStats(stats: UserMessageStats[]): number {
	if (!db || stats.length === 0) return 0;

	const stmt = db.prepare(`
		INSERT OR IGNORE INTO user_messages (
			session_file, entry_id, folder, timestamp, model, provider,
			chars, words, yelling, profanity, anguish,
			negation, repetition, blame
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM user_messages
			WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
		)
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const s of stats) {
			const result = stmt.run(
				s.sessionFile,
				s.entryId,
				s.folder,
				s.timestamp,
				s.model,
				s.provider,
				s.chars,
				s.words,
				s.yelling,
				s.profanity,
				s.anguish,
				s.negation,
				s.repetition,
				s.blame,
				// `WHERE NOT EXISTS` binds: skip when a different session_file
				// already holds this (entry_id, timestamp).
				s.entryId,
				s.timestamp,
				s.sessionFile,
			);
			if (result.changes > 0) inserted++;
		}
	});
	insert();
	return inserted;
}

/** Backfill the responding `model`/`provider` on user-message rows that were */
export function updateUserMessageLinks(links: UserMessageLink[]): number {
	if (!db || links.length === 0) return 0;

	const stmt = db.prepare(`
		UPDATE user_messages
		   SET model = ?, provider = ?
		 WHERE session_file = ? AND entry_id = ? AND model IS NULL
	`);

	let updated = 0;
	const apply = db.transaction(() => {
		for (const link of links) {
			const result = stmt.run(link.model, link.provider, link.sessionFile, link.entryId);
			if (result.changes > 0) updated++;
		}
	});
	apply();
	return updated;
}

const UNKNOWN_MODEL = "unknown";

interface BehaviorSeriesRow {
	bucket: number;
	model: string;
	provider: string;
	messages: number;
	yelling: number | null;
	profanity: number | null;
	anguish: number | null;
	negation: number | null;
	repetition: number | null;
	blame: number | null;
	chars: number | null;
}

/**
 * Daily behavioral time series, grouped by responding model+provider.
 */
export function getBehaviorTimeSeries(cutoff?: number | null): BehaviorTimeSeriesPoint[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			(timestamp / ${DAY_MS}) * ${DAY_MS} as bucket,
			COALESCE(model, ?) as model,
			COALESCE(provider, ?) as provider,
			COUNT(*) as messages,
			SUM(yelling) as yelling,
			SUM(profanity) as profanity,
			SUM(anguish) as anguish,
			SUM(negation) as negation,
			SUM(repetition) as repetition,
			SUM(blame) as blame,
			SUM(chars) as chars
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);
	const rows = (
		hasCutoff ? stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL, cutoff) : stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL)
	) as BehaviorSeriesRow[];
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		messages: row.messages,
		yelling: row.yelling ?? 0,
		profanity: row.profanity ?? 0,
		anguish: row.anguish ?? 0,
		negation: row.negation ?? 0,
		repetition: row.repetition ?? 0,
		blame: row.blame ?? 0,
		chars: row.chars ?? 0,
	}));
}

interface BehaviorOverallRow {
	total_messages: number;
	total_yelling: number | null;
	total_profanity: number | null;
	total_anguish: number | null;
	total_negation: number | null;
	total_repetition: number | null;
	total_blame: number | null;
	total_chars: number | null;
	first_timestamp: number | null;
	last_timestamp: number | null;
}

/**
 * Overall behavioral totals across the cutoff window.
 */
export function getBehaviorOverall(cutoff?: number | null): BehaviorOverallStats {
	const empty: BehaviorOverallStats = {
		totalMessages: 0,
		totalYelling: 0,
		totalProfanity: 0,
		totalAnguish: 0,
		totalNegation: 0,
		totalRepetition: 0,
		totalBlame: 0,
		totalChars: 0,
		firstTimestamp: 0,
		lastTimestamp: 0,
	};
	if (!db) return empty;
	const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			COUNT(*) as total_messages,
			SUM(yelling) as total_yelling,
			SUM(profanity) as total_profanity,
			SUM(anguish) as total_anguish,
			SUM(negation) as total_negation,
			SUM(repetition) as total_repetition,
			SUM(blame) as total_blame,
			SUM(chars) as total_chars,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
	`);
	const row = (hasCutoff ? stmt.get(cutoff) : stmt.get()) as BehaviorOverallRow | undefined;
	if (!row?.total_messages) return empty;
	return {
		totalMessages: row.total_messages,
		totalYelling: row.total_yelling ?? 0,
		totalProfanity: row.total_profanity ?? 0,
		totalAnguish: row.total_anguish ?? 0,
		totalNegation: row.total_negation ?? 0,
		totalRepetition: row.total_repetition ?? 0,
		totalBlame: row.total_blame ?? 0,
		totalChars: row.total_chars ?? 0,
		firstTimestamp: row.first_timestamp ?? 0,
		lastTimestamp: row.last_timestamp ?? 0,
	};
}

interface BehaviorByModelRow {
	model: string;
	provider: string;
	total_messages: number;
	total_yelling: number | null;
	total_profanity: number | null;
	total_anguish: number | null;
	total_negation: number | null;
	total_repetition: number | null;
	total_blame: number | null;
	total_chars: number | null;
	last_timestamp: number | null;
}

/**
 * Per-model behavioral totals over the cutoff window. "Unknown" represents
 * user messages that never received an assistant reply.
 */
export function getBehaviorByModel(cutoff?: number | null): BehaviorModelStats[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			COALESCE(model, ?) as model,
			COALESCE(provider, ?) as provider,
			COUNT(*) as total_messages,
			SUM(yelling) as total_yelling,
			SUM(profanity) as total_profanity,
			SUM(anguish) as total_anguish,
			SUM(negation) as total_negation,
			SUM(repetition) as total_repetition,
			SUM(blame) as total_blame,
			SUM(chars) as total_chars,
			MAX(timestamp) as last_timestamp
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model, provider
		ORDER BY total_messages DESC
	`);
	const rows = (
		hasCutoff ? stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL, cutoff) : stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL)
	) as BehaviorByModelRow[];
	return rows.map(row => ({
		model: row.model,
		provider: row.provider,
		totalMessages: row.total_messages,
		totalYelling: row.total_yelling ?? 0,
		totalProfanity: row.total_profanity ?? 0,
		totalAnguish: row.total_anguish ?? 0,
		totalNegation: row.total_negation ?? 0,
		totalRepetition: row.total_repetition ?? 0,
		totalBlame: row.total_blame ?? 0,
		totalChars: row.total_chars ?? 0,
		lastTimestamp: row.last_timestamp ?? 0,
	}));
}

/** Insert tool-call rows. Idempotent via UNIQUE(session_file, tool_call_id); */
export function insertToolCalls(calls: ToolCallStats[]): number {
	if (!db || calls.length === 0) return 0;

	const stmt = db.prepare(`
		INSERT OR IGNORE INTO tool_calls (
			session_file, entry_id, tool_call_id, folder, tool_name,
			model, provider, timestamp, agent_type, calls_in_turn, args_chars
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM tool_calls
			WHERE entry_id = ? AND timestamp = ? AND tool_call_id = ? AND session_file <> ?
		)
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const c of calls) {
			const result = stmt.run(
				c.sessionFile,
				c.entryId,
				c.toolCallId,
				c.folder,
				c.toolName,
				c.model,
				c.provider,
				c.timestamp,
				c.agentType,
				c.callsInTurn,
				c.argsChars,
				// `WHERE NOT EXISTS` binds: skip when a different session_file
				// already holds this (entry_id, timestamp, tool_call_id).
				c.entryId,
				c.timestamp,
				c.toolCallId,
				c.sessionFile,
			);
			if (result.changes > 0) inserted++;
		}
	});
	insert();
	return inserted;
}

/** Attach result size / error flag to persisted tool-call rows. Results can */
export function updateToolResults(links: ToolResultLink[]): number {
	if (!db || links.length === 0) return 0;

	const stmt = db.prepare(`
		UPDATE tool_calls
		SET result_chars = ?, is_error = ?
		WHERE session_file = ? AND tool_call_id = ? AND result_chars IS NULL
	`);

	let updated = 0;
	const apply = db.transaction(() => {
		for (const link of links) {
			const result = stmt.run(link.resultChars, link.isError ? 1 : 0, link.sessionFile, link.toolCallId);
			updated += result.changes;
		}
	});
	apply();
	return updated;
}

/** Shared SELECT list for tool aggregates. Real provider usage comes from the */
const TOOL_AGGREGATE_COLUMNS = `
	COUNT(*) as calls,
	SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) as errors,
	SUM(t.args_chars) as args_chars,
	SUM(COALESCE(t.result_chars, 0)) as result_chars,
	SUM(COALESCE(m.total_tokens, 0) * 1.0 / t.calls_in_turn) as total_tokens_share,
	SUM(COALESCE(m.output_tokens, 0) * 1.0 / t.calls_in_turn) as output_tokens_share,
	SUM(COALESCE(m.cost_total, 0) / t.calls_in_turn) as cost_share,
	MAX(t.timestamp) as last_used
`;

interface ToolAggregateRow {
	tool_name: string;
	model?: string;
	provider?: string;
	calls: number;
	errors: number;
	args_chars: number | null;
	result_chars: number | null;
	total_tokens_share: number | null;
	output_tokens_share: number | null;
	cost_share: number | null;
	last_used: number;
}

function rowToToolUsage(row: ToolAggregateRow): ToolUsageStats {
	return {
		tool: row.tool_name,
		calls: row.calls,
		errors: row.errors,
		argsChars: row.args_chars ?? 0,
		resultChars: row.result_chars ?? 0,
		totalTokensShare: row.total_tokens_share ?? 0,
		outputTokensShare: row.output_tokens_share ?? 0,
		costShare: row.cost_share ?? 0,
		lastUsed: row.last_used,
	};
}

/**
 * Get tool usage aggregated by tool name.
 */
export function getToolStats(cutoff?: number): ToolUsageStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT t.tool_name, ${TOOL_AGGREGATE_COLUMNS}
		FROM tool_calls t
		LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id
		${hasCutoff ? "WHERE t.timestamp >= ?" : ""}
		GROUP BY t.tool_name
		ORDER BY calls DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as ToolAggregateRow[];
	return rows.map(rowToToolUsage);
}

/**
 * Get tool usage aggregated by (tool, model, provider).
 */
export function getToolStatsByModel(cutoff?: number): ToolModelStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT t.tool_name, t.model, t.provider, ${TOOL_AGGREGATE_COLUMNS}
		FROM tool_calls t
		LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id
		${hasCutoff ? "WHERE t.timestamp >= ?" : ""}
		GROUP BY t.tool_name, t.model, t.provider
		ORDER BY calls DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as ToolAggregateRow[];
	return rows.map(row => ({
		...rowToToolUsage(row),
		model: row.model ?? "",
		provider: row.provider ?? "",
	}));
}

/**
 * Get tool-call time series (one point per bucket per tool).
 */
export function getToolTimeSeries(days = 14, cutoff?: number | null, bucketMs = DAY_MS): ToolTimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * DAY_MS) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			tool_name,
			COUNT(*) as calls,
			SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors
		FROM tool_calls
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, tool_name
		ORDER BY bucket ASC
	`);

	const rowsRaw = hasCutoff ? stmt.all(bucketMs, bucketMs, seriesCutoff) : stmt.all(bucketMs, bucketMs);
	const rows = rowsRaw as Array<{ bucket: number; tool_name: string; calls: number; errors: number }>;
	return rows.map(row => ({
		timestamp: row.bucket,
		tool: row.tool_name,
		calls: row.calls,
		errors: row.errors,
	}));
}
