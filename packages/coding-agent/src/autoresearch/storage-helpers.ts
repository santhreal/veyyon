import type { ASIData, ExperimentStatus, MetricDirection, NumericMetricMap } from "./types";

export function encodeProjectKey(repoRoot: string): string {
	return `--${repoRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface SessionRow {
	id: number;
	name: string;
	goal: string | null;
	primaryMetric: string;
	metricUnit: string;
	direction: MetricDirection;
	preferredCommand: string | null;
	branch: string | null;
	baselineCommit: string | null;
	currentSegment: number;
	maxIterations: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	secondaryMetrics: string[];
	notes: string;
	createdAt: number;
	closedAt: number | null;
}

export interface RunRow {
	id: number;
	sessionId: number;
	segment: number;
	command: string;
	startedAt: number;
	completedAt: number | null;
	durationMs: number | null;
	exitCode: number | null;
	timedOut: boolean;
	parsedPrimary: number | null;
	parsedMetrics: NumericMetricMap | null;
	parsedAsi: ASIData | null;
	preRunDirtyPaths: string[];
	logPath: string;
	status: ExperimentStatus | null;
	description: string | null;
	metric: number | null;
	metrics: NumericMetricMap | null;
	asi: ASIData | null;
	commitHash: string | null;
	confidence: number | null;
	modifiedPaths: string[] | null;
	scopeDeviations: string[] | null;
	justification: string | null;
	flagged: boolean;
	flaggedReason: string | null;
	loggedAt: number | null;
	abandonedAt: number | null;
}

export interface OpenSessionParams {
	name: string;
	goal: string | null;
	primaryMetric: string;
	metricUnit: string;
	direction: MetricDirection;
	preferredCommand: string | null;
	branch: string | null;
	baselineCommit: string | null;
	maxIterations: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	secondaryMetrics: string[];
}

export interface UpdateSessionParams {
	goal?: string | null;
	preferredCommand?: string | null;
	maxIterations?: number | null;
	scopePaths?: string[];
	offLimits?: string[];
	constraints?: string[];
	secondaryMetrics?: string[];
	primaryMetric?: string;
	metricUnit?: string;
	direction?: MetricDirection;
	branch?: string | null;
	baselineCommit?: string | null;
	notes?: string;
}

export interface InsertRunParams {
	sessionId: number;
	segment: number;
	command: string;
	logPath: string;
	preRunDirtyPaths: string[];
	startedAt: number;
}

export interface MarkRunCompletedParams {
	runId: number;
	completedAt: number;
	durationMs: number;
	exitCode: number | null;
	timedOut: boolean;
	parsedPrimary: number | null;
	parsedMetrics: NumericMetricMap | null;
	parsedAsi: ASIData | null;
}

export interface MarkRunLoggedParams {
	runId: number;
	status: ExperimentStatus;
	description: string;
	metric: number;
	metrics: NumericMetricMap;
	asi: ASIData | null;
	commitHash: string | null;
	confidence: number | null;
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	loggedAt: number;
}

export type SessionDbRow = {
	id: number;
	name: string;
	goal: string | null;
	primary_metric: string;
	metric_unit: string;
	direction: string;
	preferred_command: string | null;
	branch: string | null;
	baseline_commit: string | null;
	current_segment: number;
	max_iterations: number | null;
	scope_paths_json: string;
	off_limits_json: string;
	constraints_json: string;
	secondary_metrics_json: string;
	notes: string;
	created_at: number;
	closed_at: number | null;
};

export type RunDbRow = {
	id: number;
	session_id: number;
	segment: number;
	command: string;
	started_at: number;
	completed_at: number | null;
	duration_ms: number | null;
	exit_code: number | null;
	timed_out: number;
	parsed_primary: number | null;
	parsed_metrics_json: string | null;
	parsed_asi_json: string | null;
	pre_run_dirty_paths_json: string;
	log_path: string;
	status: string | null;
	description: string | null;
	metric: number | null;
	metrics_json: string | null;
	asi_json: string | null;
	commit_hash: string | null;
	confidence: number | null;
	modified_paths_json: string | null;
	scope_deviations_json: string | null;
	justification: string | null;
	flagged: number;
	flagged_reason: string | null;
	logged_at: number | null;
	abandoned_at: number | null;
};

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	goal TEXT,
	primary_metric TEXT NOT NULL,
	metric_unit TEXT NOT NULL DEFAULT '',
	direction TEXT NOT NULL DEFAULT 'lower',
	preferred_command TEXT,
	branch TEXT,
	baseline_commit TEXT,
	current_segment INTEGER NOT NULL DEFAULT 0,
	max_iterations INTEGER,
	scope_paths_json TEXT NOT NULL DEFAULT '[]',
	off_limits_json TEXT NOT NULL DEFAULT '[]',
	constraints_json TEXT NOT NULL DEFAULT '[]',
	secondary_metrics_json TEXT NOT NULL DEFAULT '[]',
	notes TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY,
	session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	segment INTEGER NOT NULL,
	command TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	completed_at INTEGER,
	duration_ms INTEGER,
	exit_code INTEGER,
	timed_out INTEGER NOT NULL DEFAULT 0,
	parsed_primary REAL,
	parsed_metrics_json TEXT,
	parsed_asi_json TEXT,
	pre_run_dirty_paths_json TEXT NOT NULL DEFAULT '[]',
	log_path TEXT NOT NULL,
	status TEXT,
	description TEXT,
	metric REAL,
	metrics_json TEXT,
	asi_json TEXT,
	commit_hash TEXT,
	confidence REAL,
	modified_paths_json TEXT,
	scope_deviations_json TEXT,
	justification TEXT,
	flagged INTEGER NOT NULL DEFAULT 0,
	flagged_reason TEXT,
	logged_at INTEGER,
	abandoned_at INTEGER
);

CREATE INDEX IF NOT EXISTS runs_session_segment_idx ON runs(session_id, segment);
CREATE INDEX IF NOT EXISTS runs_pending_idx ON runs(session_id, status, abandoned_at);
`;
