import type { Database } from "bun:sqlite";

export type RunStatus = "running" | "complete" | "failed" | "cancelled";

export type BenchmarkKind = "harbor" | "edit" | "deepswe";

export type RunRole = "baseline" | "variant" | "";

export interface RunRow {
	benchmark: BenchmarkKind;
	jobName: string;
	dataset: string;
	agent: string;
	models: string;
	prewalk: string | null;
	config: Record<string, unknown>;
	role: RunRole;
	note: string;
	label: string;
	status: RunStatus;
	pid: number | null;
	exitCode: number | null;
	createdAt: number;
	finishedAt: number | null;
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	score: number | null;
	metrics: Record<string, number | null>;
}

export interface TraceRow {
	jobName: string;
	name: string;
	task: string;
	status: string;
	reward: number | null;
	costUsd: number;
	durationMs: number;
	detail: string;
	updatedAt: number;
	tracePath: string | null;
}

export interface ExperimentMeta {
	id: string;
	goal: string;
	updatedAt: number;
}

export interface LaunchRecord {
	benchmark: BenchmarkKind;
	jobName: string;
	dataset: string;
	agent: string;
	models: string[];
	prewalk?: { into?: string };
	pid: number;
	role?: RunRole;
	note?: string;
	config?: Record<string, unknown>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
	job_name TEXT PRIMARY KEY,
	benchmark TEXT NOT NULL DEFAULT 'harbor',
	dataset TEXT NOT NULL DEFAULT '',
	agent TEXT NOT NULL DEFAULT 'veyyon',
	models TEXT NOT NULL DEFAULT '',
	prewalk TEXT,
	role TEXT NOT NULL DEFAULT '',
	note TEXT NOT NULL DEFAULT '',
	label TEXT NOT NULL DEFAULT '',
	config_json TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'running',
	pid INTEGER,
	exit_code INTEGER,
	created_at INTEGER NOT NULL,
	finished_at INTEGER,
	n_total INTEGER NOT NULL DEFAULT 0,
	done INTEGER NOT NULL DEFAULT 0,
	pass INTEGER NOT NULL DEFAULT 0,
	fail INTEGER NOT NULL DEFAULT 0,
	error INTEGER NOT NULL DEFAULT 0,
	running INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL NOT NULL DEFAULT 0,
	tok_in INTEGER NOT NULL DEFAULT 0,
	tok_out INTEGER NOT NULL DEFAULT 0,
	score REAL,
	metrics_json TEXT NOT NULL DEFAULT '{}',
	tok_cache INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trials (
	job_name TEXT NOT NULL,
	name TEXT NOT NULL,
	task TEXT NOT NULL,
	status TEXT NOT NULL,
	reward REAL,
	cost_usd REAL NOT NULL DEFAULT 0,
	duration_ms INTEGER NOT NULL DEFAULT 0,
	detail TEXT NOT NULL DEFAULT '',
	trace_path TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (job_name, name)
);
CREATE INDEX IF NOT EXISTS idx_trials_job ON trials(job_name);
CREATE TABLE IF NOT EXISTS experiments (
	id TEXT PRIMARY KEY,
	goal TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL
);
`;

export const NON_JOB_DIRS = new Set(["_bench", "_manager"]);

export function isBusyLock(err: unknown): boolean {
	if (err && typeof err === "object" && "code" in err) {
		const code = err.code;
		return typeof code === "string" && code.startsWith("SQLITE_BUSY");
	}
	return false;
}

export function enableWal(db: Database): void {
	const attempts = 10;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			db.run("PRAGMA journal_mode = WAL");
			return;
		} catch (err) {
			if (attempt < attempts && isBusyLock(err)) {
				Bun.sleepSync(100);
				continue;
			}
			throw err;
		}
	}
}
