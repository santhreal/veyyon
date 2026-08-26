/**
 * SQLite-backed store for Harbor runs managed by this package.
 *
 * The filesystem stays the source of truth (Harbor writes `result.json`
 * per job and per trial); the store mirrors it into queryable rows and adds
 * manager-owned metadata Harbor has no notion of: launch pid, requested
 * config, lifecycle status. `syncRun` re-reads a job dir and upserts.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync, isProcessAlive, logger } from "@veyyon/utils";
import { readJobResult } from "../backends/harbor/runner/results";
import type { BackendId } from "../core/types";
import { requirePathSegment } from "../paths";
import type { BenchmarkKind, RunRole, RunStatus } from "../wire";
import { getBenchmark, getBenchmarkByBackend, readBenchmarkSnapshot } from "./benchmarks";

/**
 * A job name is one directory name under the jobs directory. The rule is the same rule every
 * dynamic path segment in this package passes, so it is applied by that owner rather than by a
 * second regex here, which admitted a name of only spaces and one holding a NUL byte.
 */
export function assertSafeJobName(jobName: string): void {
	requirePathSegment(jobName, "job name");
}

export const CURRENT_SCHEMA_VERSION = 2;

export class StaleSchemaError extends Error {
	constructor(jobName: string, version: number) {
		super(
			`Rejected stale run record for '${jobName}': schema version ${version} is obsolete (expected ${CURRENT_SCHEMA_VERSION})`,
		);
		this.name = "StaleSchemaError";
	}
}

export interface RunRow {
	schemaVersion: number;
	suite: string;
	backend: BackendId;
	benchmark: BenchmarkKind;
	jobName: string;
	/**
	 * Experiment this run belongs to, as recorded at launch. Empty when the run predates
	 * recorded coordinates; a reader then treats the job name as its own single-arm experiment
	 * rather than parsing an id out of it.
	 */
	experiment: string;
	/** Arm label inside the experiment, as recorded at launch. Empty for an uncoordinated run. */
	arm: string;
	dataset: string;
	agent: string;
	models: string;
	/** JSON prewalk config (`{ into?: string }`); older rows may hold legacy reasoning-slide JSON. */
	prewalk: string | null;
	/** Benchmark-specific launch configuration. */
	config: Record<string, unknown>;
	/** Role inside the experiment (baseline vs treatment); "" when unspecified. */
	role: RunRole;
	/** One-line description of what this arm tests (e.g. "prewalk→flash at first edit/write"). */
	note: string;
	/** Display-name override for the arm; "" falls back to the jobName-derived arm label. */
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
	/** `null` when no trial in the run reported a cost: unmeasured, not free. */
	costUsd: number | null;
	tokIn: number;
	tokOut: number;
	/** `null` when no trial reported a cache-token count. */
	tokCache: number | null;
	/** Benchmark-native aggregate score, when the benchmark exposes one. */
	score: number | null;
	/** Values keyed by the adapter's metric definitions. */
	metrics: Record<string, number | null>;
}

export interface TraceRow {
	jobName: string;
	name: string;
	task: string;
	status: string;
	reward: number | null;
	/** `null` when the trial reported no cost. */
	costUsd: number | null;
	durationMs: number;
	detail: string;
	updatedAt: number;
	/** Adapter-owned locator used by the uniform trace endpoint. */
	tracePath: string | null;
}

/** Row in the `experiments` table: goal metadata keyed by experiment id. */
export interface ExperimentMeta {
	id: string;
	goal: string;
	updatedAt: number;
}

export interface LaunchRecord {
	schemaVersion?: number;
	suite?: string;
	backend?: BackendId;
	benchmark?: BenchmarkKind;
	jobName: string;
	dataset: string;
	agent: string;
	models: string[];
	prewalk?: { into?: string };
	pid: number;
	role?: RunRole;
	note?: string;
	config?: Record<string, unknown>;
	/** Experiment id and arm label; recorded rather than parsed back out of the job name. */
	experiment?: string;
	arm?: string;
}

export function inferSuiteAndBackend(record: {
	suite?: string;
	backend?: BackendId;
	benchmark?: BenchmarkKind | string;
	dataset?: string;
}): { suite: string; backend: BackendId; benchmark: BenchmarkKind } {
	const dataset = record.dataset ?? "";
	let suite = record.suite;
	let backend = record.backend;
	let benchmark = record.benchmark as BenchmarkKind | undefined;

	if (suite && backend) {
		benchmark = benchmark ?? getBenchmarkByBackend(backend)?.kind ?? (backend as unknown as BenchmarkKind);
		return { suite, backend, benchmark };
	}

	if (dataset.startsWith("terminal-bench@3") || dataset === "terminal-bench-3") {
		suite = suite ?? "terminal-bench@3.0";
		backend = backend ?? "harbor";
		benchmark = benchmark ?? getBenchmarkByBackend(backend)?.kind ?? "harbor";
	} else if (
		dataset.startsWith("terminal-bench") ||
		dataset === "terminal-bench-2" ||
		dataset === "terminal-bench@2.0"
	) {
		suite = suite ?? (dataset.includes("@") ? dataset : "terminal-bench@2.0");
		backend = backend ?? "harbor";
		benchmark = benchmark ?? getBenchmarkByBackend(backend)?.kind ?? "harbor";
	} else if (dataset === "deep-swe" || (benchmark && getBenchmark(benchmark)?.backend === "pier")) {
		suite = suite ?? "deep-swe";
		backend = backend ?? "pier";
		benchmark = benchmark ?? getBenchmarkByBackend(backend)?.kind ?? "deepswe";
	} else if (dataset === "typescript-edit" || (benchmark && getBenchmark(benchmark)?.backend === "in-process")) {
		suite = suite ?? "typescript-edit";
		backend = backend ?? "in-process";
		benchmark = benchmark ?? getBenchmarkByBackend(backend)?.kind ?? "edit";
	} else {
		suite = suite ?? (dataset || "terminal-bench@2.0");
		backend = backend ?? (benchmark ? getBenchmark(benchmark)?.backend : undefined) ?? "harbor";
		benchmark = benchmark ?? getBenchmarkByBackend(backend)?.kind ?? (backend as unknown as BenchmarkKind);
	}

	return { suite, backend, benchmark };
}

/**
 * Column bodies of every table, keyed by table name.
 *
 * Split per table because relaxing a NOT NULL constraint in SQLite means rebuilding the
 * table from its declaration; a single concatenated schema string cannot be reused for that.
 */
const TABLE_BODIES: Readonly<Record<string, string>> = {
	runs: `
	job_name TEXT PRIMARY KEY,
	schema_version INTEGER NOT NULL DEFAULT 2,
	suite TEXT NOT NULL DEFAULT '',
	backend TEXT NOT NULL DEFAULT 'harbor',
	benchmark TEXT NOT NULL DEFAULT 'harbor',
	dataset TEXT NOT NULL DEFAULT '',
	experiment TEXT NOT NULL DEFAULT '',
	arm TEXT NOT NULL DEFAULT '',
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
	cost_usd REAL,
	tok_in INTEGER NOT NULL DEFAULT 0,
	tok_out INTEGER NOT NULL DEFAULT 0,
	score REAL,
	metrics_json TEXT NOT NULL DEFAULT '{}',
	tok_cache INTEGER
`,
	trials: `
	job_name TEXT NOT NULL,
	name TEXT NOT NULL,
	task TEXT NOT NULL,
	status TEXT NOT NULL,
	reward REAL,
	cost_usd REAL,
	duration_ms INTEGER NOT NULL DEFAULT 0,
	detail TEXT NOT NULL DEFAULT '',
	trace_path TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (job_name, name)
`,
	experiments: `
	id TEXT PRIMARY KEY,
	goal TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL
`,
};

/** Indexes recreated after any table rebuild drops them along with their table. */
const INDEXES = "CREATE INDEX IF NOT EXISTS idx_trials_job ON trials(job_name);";

const SCHEMA = `${Object.entries(TABLE_BODIES)
	.map(([table, body]) => `CREATE TABLE IF NOT EXISTS ${table} (${body});`)
	.join("\n")}\n${INDEXES}`;

/** Spend columns that must accept NULL: an unmeasured amount is not zero. */
const NULLABLE_SPEND_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	runs: ["cost_usd", "tok_cache"],
	trials: ["cost_usd"],
};

/**
 * Rebuilds a table whose spend columns still carry the `NOT NULL DEFAULT 0` declaration.
 *
 * The first schema forced an unmeasured cost to be stored as 0, which reads back as a
 * genuinely free trial. SQLite cannot drop NOT NULL in place, so the table is recreated from
 * `TABLE_BODIES` and its rows copied across the columns both declarations share. Existing
 * values transfer verbatim: a stored 0 stays 0, because nothing in an old row distinguishes
 * an unmeasured cost from a measured zero, and inventing NULLs would rewrite recorded history.
 */
function relaxSpendColumns(db: Database, table: string): void {
	const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
	const nullable = NULLABLE_SPEND_COLUMNS[table];
	const constrained = columns.filter(c => nullable.includes(c.name) && c.notnull === 1);
	if (constrained.length === 0) return;

	const body = TABLE_BODIES[table];
	const declared = new Set(
		body
			.split("\n")
			.map(line => line.trim().split(/\s+/)[0])
			.filter(name => name.length > 0 && name !== "PRIMARY"),
	);
	const shared = columns.map(c => c.name).filter(name => declared.has(name));
	const list = shared.join(", ");

	db.transaction(() => {
		db.run(`CREATE TABLE ${table}_migrated (${body})`);
		db.run(`INSERT INTO ${table}_migrated (${list}) SELECT ${list} FROM ${table}`);
		db.run(`DROP TABLE ${table}`);
		db.run(`ALTER TABLE ${table}_migrated RENAME TO ${table}`);
	})();
	db.run(INDEXES);
}

/** Directory names inside the jobs root that are not Harbor job dirs. */
const NON_JOB_DIRS = new Set(["_bench", "_manager"]);

/** True when a bun:sqlite error is a transient busy/recovery lock. */
function isBusyLock(err: unknown): boolean {
	if (err && typeof err === "object" && "code" in err) {
		const code = err.code;
		return typeof code === "string" && code.startsWith("SQLITE_BUSY");
	}
	return false;
}

/**
 * Enable WAL journaling, tolerating a briefly locked database.
 *
 * `PRAGMA journal_mode = WAL` needs a momentary exclusive lock. When another
 * connection holds the DB — a restarting manager, or a WAL mid-recovery —
 * SQLite returns `SQLITE_BUSY`/`SQLITE_BUSY_RECOVERY`. The busy handler that
 * `busy_timeout` installs is not invoked for recovery locks, so retry the
 * pragma explicitly before surfacing the failure.
 */
function enableWal(db: Database): void {
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

export class RunStore {
	#db: Database;
	readonly jobsDir: string;

	constructor(jobsDir: string, dbPath?: string) {
		this.jobsDir = jobsDir;
		fs.mkdirSync(path.join(jobsDir, "_manager"), { recursive: true });
		this.#db = new Database(dbPath ?? path.join(jobsDir, "_manager", "evals.sqlite"));
		this.#db.run("PRAGMA busy_timeout = 5000");
		enableWal(this.#db);
		this.#db.run(SCHEMA);
		const runColumns = new Set(
			(this.#db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(c => c.name),
		);
		if (!runColumns.has("schema_version")) {
			this.#db.run("ALTER TABLE runs ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1");
		}
		if (!runColumns.has("suite")) {
			this.#db.run("ALTER TABLE runs ADD COLUMN suite TEXT NOT NULL DEFAULT ''");
		}
		if (!runColumns.has("backend")) {
			this.#db.run("ALTER TABLE runs ADD COLUMN backend TEXT NOT NULL DEFAULT 'harbor'");
		}
		if (!runColumns.has("role")) this.#db.run("ALTER TABLE runs ADD COLUMN role TEXT NOT NULL DEFAULT ''");
		if (!runColumns.has("note")) this.#db.run("ALTER TABLE runs ADD COLUMN note TEXT NOT NULL DEFAULT ''");
		if (!runColumns.has("label")) this.#db.run("ALTER TABLE runs ADD COLUMN label TEXT NOT NULL DEFAULT ''");
		if (!runColumns.has("benchmark")) {
			this.#db.run("ALTER TABLE runs ADD COLUMN benchmark TEXT NOT NULL DEFAULT 'harbor'");
		}
		if (!runColumns.has("config_json")) {
			this.#db.run("ALTER TABLE runs ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'");
		}
		if (!runColumns.has("score")) this.#db.run("ALTER TABLE runs ADD COLUMN score REAL");
		if (!runColumns.has("metrics_json")) {
			this.#db.run("ALTER TABLE runs ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '{}'");
		}
		if (!runColumns.has("experiment")) {
			this.#db.run("ALTER TABLE runs ADD COLUMN experiment TEXT NOT NULL DEFAULT ''");
		}
		if (!runColumns.has("arm")) this.#db.run("ALTER TABLE runs ADD COLUMN arm TEXT NOT NULL DEFAULT ''");
		if (runColumns.has("slide") && !runColumns.has("prewalk")) {
			this.#db.run("ALTER TABLE runs RENAME COLUMN slide TO prewalk");
		}
		if (!runColumns.has("slide") && !runColumns.has("prewalk")) {
			this.#db.run("ALTER TABLE runs ADD COLUMN prewalk TEXT");
		}
		const traceColumns = new Set(
			(this.#db.query("PRAGMA table_info(trials)").all() as Array<{ name: string }>).map(c => c.name),
		);
		if (!traceColumns.has("trace_path")) this.#db.run("ALTER TABLE trials ADD COLUMN trace_path TEXT");
		// Last, because it rebuilds from the current declaration and every ADD COLUMN
		// above must already have run.
		relaxSpendColumns(this.#db, "runs");
		relaxSpendColumns(this.#db, "trials");
	}

	close(): void {
		this.#db.close();
	}

	/** Register a run this manager just launched (pid-owning). */
	registerLaunch(launch: LaunchRecord): void {
		assertSafeJobName(launch.jobName);
		const { suite, backend, benchmark } = inferSuiteAndBackend(launch);
		const tx = this.#db.transaction(() => {
			this.#db.query("DELETE FROM trials WHERE job_name = ?").run(launch.jobName);
			this.#db
				.query(
					`INSERT INTO runs
					 (job_name, schema_version, suite, backend, benchmark, dataset, experiment, arm, agent, models, prewalk, role, note, config_json, status, pid, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
					 ON CONFLICT(job_name) DO UPDATE SET
						schema_version = excluded.schema_version,
						suite = excluded.suite,
						backend = excluded.backend,
						benchmark = excluded.benchmark,
						experiment = CASE WHEN excluded.experiment != '' THEN excluded.experiment ELSE runs.experiment END,
						arm = CASE WHEN excluded.arm != '' THEN excluded.arm ELSE runs.arm END,
						pid = excluded.pid, status = 'running',
						config_json = excluded.config_json,
						role = CASE WHEN excluded.role != '' THEN excluded.role ELSE runs.role END,
						note = CASE WHEN excluded.note != '' THEN excluded.note ELSE runs.note END`,
				)
				.run(
					launch.jobName,
					CURRENT_SCHEMA_VERSION,
					suite,
					backend,
					benchmark,
					launch.dataset,
					launch.experiment ?? "",
					launch.arm ?? "",
					launch.agent,
					launch.models.join(","),
					launch.prewalk ? JSON.stringify(launch.prewalk) : null,
					launch.role ?? "",
					launch.note ?? "",
					JSON.stringify(launch.config ?? {}),
					launch.pid,
					Date.now(),
				);
		});
		tx();
		const jobDir = path.join(this.jobsDir, launch.jobName);
		fs.mkdirSync(jobDir, { recursive: true });
		const targetFile = path.join(jobDir, "manager.json");
		atomicWriteFileSync(
			targetFile,
			JSON.stringify({ ...launch, schemaVersion: CURRENT_SCHEMA_VERSION, suite, backend, benchmark }, null, 2),
			{ mode: 0o644 },
		);
	}
	/** Upsert the experiment's stated goal. */
	setExperimentGoal(id: string, goal: string): void {
		this.#db
			.query(
				`INSERT INTO experiments (id, goal, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET goal = excluded.goal, updated_at = excluded.updated_at`,
			)
			.run(id, goal, Date.now());
	}

	/** Stored experiment metadata, or null when the id was never registered. */
	getExperimentMeta(id: string): ExperimentMeta | null {
		const row = this.#db.query("SELECT id, goal, updated_at FROM experiments WHERE id = ?").get(id) as {
			id: string;
			goal: string;
			updated_at: number;
		} | null;
		return row ? { id: row.id, goal: row.goal, updatedAt: row.updated_at } : null;
	}

	/** Every registered experiment row, newest first. */
	listExperimentMeta(): ExperimentMeta[] {
		const rows = this.#db
			.query("SELECT id, goal, updated_at FROM experiments ORDER BY updated_at DESC")
			.all() as Array<{
			id: string;
			goal: string;
			updated_at: number;
		}>;
		return rows.map(r => ({ id: r.id, goal: r.goal, updatedAt: r.updated_at }));
	}

	/** Drop the experiment metadata row (run rows are deleted separately via deleteRun). */
	deleteExperimentMeta(id: string): void {
		this.#db.query("DELETE FROM experiments WHERE id = ?").run(id);
	}

	/** Delete a run row and its trials; returns false when the run is unknown. */
	deleteRun(jobName: string): boolean {
		if (!this.getRun(jobName)) return false;
		const tx = this.#db.transaction(() => {
			this.#db.query("DELETE FROM trials WHERE job_name = ?").run(jobName);
			this.#db.query("DELETE FROM runs WHERE job_name = ?").run(jobName);
		});
		tx();
		return true;
	}

	/** Set role/note/label metadata on an existing run row. */
	setRunMeta(jobName: string, meta: { role?: RunRole; note?: string; label?: string }): boolean {
		const existing = this.getRun(jobName);
		if (!existing) return false;
		this.#db
			.query("UPDATE runs SET role = ?, note = ?, label = ? WHERE job_name = ?")
			.run(meta.role ?? existing.role, meta.note ?? existing.note, meta.label ?? existing.label, jobName);
		return true;
	}

	/** Mark a launched run's terminal state (called when its child process exits). */
	markExit(jobName: string, exitCode: number | null, cancelled = false): void {
		const status: RunStatus = cancelled ? "cancelled" : exitCode === 0 ? "complete" : "failed";
		this.#db
			.query("UPDATE runs SET status = ?, exit_code = ?, finished_at = ?, pid = NULL WHERE job_name = ?")
			.run(status, exitCode, Date.now(), jobName);
	}

	/**
	 * Discover job dirs on disk that have no run row yet (runs launched by the
	 * CLI or a previous manager instance) and backfill them as historical rows.
	 */
	discover(): number {
		// No jobs dir yet just means no runs; a readdir failure on an existing
		// dir (permissions, I/O) must propagate, not read as "0 discovered".
		if (!fs.existsSync(this.jobsDir)) return 0;
		const entries = fs.readdirSync(this.jobsDir, { withFileTypes: true });
		const known = new Set(
			(this.#db.query("SELECT job_name FROM runs").all() as Array<{ job_name: string }>).map(r => r.job_name),
		);
		let added = 0;
		for (const e of entries) {
			if (!e.isDirectory() || NON_JOB_DIRS.has(e.name) || known.has(e.name)) continue;
			const jobDir = path.join(this.jobsDir, e.name);
			const meta = readHarborConfig(jobDir);
			const createdAt = dirCreatedAt(jobDir);
			const { suite, backend, benchmark } = inferSuiteAndBackend({
				suite: meta.suite,
				backend: meta.backend,
				benchmark: meta.benchmark,
				dataset: meta.dataset,
			});
			this.#db
				.query(
					`INSERT INTO runs (job_name, schema_version, suite, backend, benchmark, dataset, agent, models, status, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
				)
				.run(
					e.name,
					CURRENT_SCHEMA_VERSION,
					suite,
					backend,
					benchmark,
					meta.dataset,
					meta.agent,
					meta.models,
					createdAt,
				);
			this.syncRun(e.name);
			added++;
		}
		return added;
	}

	/** Re-read a job dir from disk and mirror trial + rollup state into the DB. */
	syncRun(jobName: string): RunRow | null {
		// The name is joined into the jobs directory, so it is one directory name or nothing: a
		// GET carrying `../..` otherwise read whatever that path held and mirrored it into the DB.
		assertSafeJobName(jobName);
		const jobDir = path.join(this.jobsDir, jobName);
		if (!fs.existsSync(jobDir)) return this.getRun(jobName);
		const row = this.getRun(jobName);
		if (!row) return null;
		const snapshot = readBenchmarkSnapshot(row.benchmark, jobDir);
		const now = Date.now();
		const upsert = this.#db.query(
			`INSERT INTO trials
			 (job_name, name, task, status, reward, cost_usd, duration_ms, detail, trace_path, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(job_name, name) DO UPDATE SET
				status = excluded.status, reward = excluded.reward, cost_usd = excluded.cost_usd,
				duration_ms = excluded.duration_ms, detail = excluded.detail,
				trace_path = excluded.trace_path, updated_at = excluded.updated_at`,
		);
		const tx = this.#db.transaction(() => {
			// Prune rows whose trial dirs vanished from disk (a resume deletes
			// interrupted trial dirs and re-runs the task under a fresh suffix) —
			// otherwise phantom `running` rows haunt the dashboard forever.
			const existingRows = this.#db.query("SELECT name FROM trials WHERE job_name = ?").all(jobName) as Array<{
				name: string;
			}>;
			const currentNames = new Set(snapshot.traces.map(t => t.name));
			const deleteTrial = this.#db.query("DELETE FROM trials WHERE job_name = ? AND name = ?");
			for (const { name } of existingRows) {
				if (!currentNames.has(name)) {
					deleteTrial.run(jobName, name);
				}
			}
			for (const trace of snapshot.traces) {
				upsert.run(
					jobName,
					trace.name,
					trace.task,
					trace.status,
					trace.reward,
					trace.costUsd,
					trace.durationMs,
					trace.detail,
					trace.tracePath,
					now,
				);
			}
			this.#db
				.query(
					`UPDATE runs SET n_total = ?, done = ?, pass = ?, fail = ?, error = ?, running = ?,
					 cost_usd = ?, tok_in = ?, tok_out = ?, tok_cache = ?, score = ?, metrics_json = ?
					 WHERE job_name = ?`,
				)
				.run(
					snapshot.total,
					snapshot.done,
					snapshot.pass,
					snapshot.fail,
					snapshot.error,
					snapshot.running,
					snapshot.costUsd,
					snapshot.tokIn,
					snapshot.tokOut,
					snapshot.tokCache,
					snapshot.score,
					JSON.stringify(snapshot.metrics),
					jobName,
				);
			// Runs with no owning process (historical dirs, or a runner that died
			// with a previous manager). Infer terminal state from result metadata
			// or directory freshness — an orphaned harbor child may still be
			// running and writing trials, so a fresh dir stays "running".
			if (row.pid === null && row.finishedAt === null && row.status !== "cancelled") {
				const result = row.benchmark === "harbor" ? readJobResult(jobDir) : null;
				let status: RunStatus;
				let finishedAt: number | null = null;
				if (result?.finishedAt != null) {
					status = "complete";
					finishedAt = result.finishedAt;
				} else if (jobDirFresh(jobDir)) {
					status = "running";
				} else {
					status = snapshot.done > 0 && snapshot.done >= snapshot.total ? "complete" : "failed";
					finishedAt = jobDirMtime(jobDir);
				}
				if (status !== row.status) {
					this.#db
						.query("UPDATE runs SET status = ?, finished_at = ? WHERE job_name = ?")
						.run(status, finishedAt, jobName);
				}
			}
		});
		tx();
		return this.getRun(jobName);
	}

	/** Sync every run currently marked running; returns the refreshed rows. */
	syncActive(): RunRow[] {
		const active = this.#db.query("SELECT job_name FROM runs WHERE status = 'running'").all() as Array<{
			job_name: string;
		}>;
		const out: RunRow[] = [];
		for (const { job_name } of active) {
			// A pid-owning run whose runner died without markExit (manager
			// restart) loses its pid here; syncRun's disk inference then decides
			// the real status — the workload may have completed, or may still be
			// running as an orphan.
			const row = this.getRun(job_name);
			if (row?.pid != null && !isProcessAlive(row.pid)) {
				this.#db.query("UPDATE runs SET pid = NULL WHERE job_name = ?").run(job_name);
			}
			const synced = this.syncRun(job_name);
			if (synced) out.push(synced);
		}
		return out;
	}

	/**
	 * Sync every known run once — startup reconciliation. Rows stamped before a
	 * status-inference change (or by an older manager) self-correct here, since
	 * the periodic ticker only revisits rows already marked running.
	 */
	syncAll(): void {
		const rows = this.#db.query("SELECT job_name FROM runs").all() as Array<{ job_name: string }>;
		for (const { job_name } of rows) this.syncRun(job_name);
	}

	getRun(jobName: string): RunRow | null {
		const r = this.#db.query("SELECT * FROM runs WHERE job_name = ?").get(jobName) as Record<string, unknown> | null;
		return r ? rowToRun(r) : null;
	}

	/**
	 * Every run whose record this build can still read.
	 *
	 * A row stamped by an older schema is omitted and named in the log. `getRun` refuses the
	 * same row with `StaleSchemaError` instead: a listing that aborts on one obsolete row shows
	 * nothing, while a request for one run by name must not answer "no such run".
	 */
	listRuns(): RunRow[] {
		const rows = this.#db.query("SELECT * FROM runs ORDER BY created_at DESC").all() as Array<
			Record<string, unknown>
		>;
		const out: RunRow[] = [];
		for (const r of rows) {
			const version = typeof r.schema_version === "number" ? r.schema_version : 1;
			if (version >= CURRENT_SCHEMA_VERSION) {
				out.push(rowToRun(r));
				continue;
			}
			logger.warn("Omitting run recorded by an obsolete schema", {
				jobName: String(r.job_name),
				schemaVersion: version,
				expected: CURRENT_SCHEMA_VERSION,
			});
		}
		return out;
	}

	listTraces(jobName: string): TraceRow[] {
		const rows = this.#db.query("SELECT * FROM trials WHERE job_name = ? ORDER BY name").all(jobName) as Array<
			Record<string, unknown>
		>;
		return rows.map(r => ({
			jobName: String(r.job_name),
			name: String(r.name),
			task: String(r.task),
			status: String(r.status),
			reward: r.reward === null ? null : Number(r.reward),
			costUsd: optionalNumber(r.cost_usd),
			durationMs: Number(r.duration_ms),
			detail: String(r.detail),
			updatedAt: Number(r.updated_at),
			tracePath: r.trace_path === null ? null : String(r.trace_path),
		}));
	}
}

/** Reads a column that may hold NULL, keeping the absence rather than reading it as zero. */
function optionalNumber(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value);
}

function rowToRun(r: Record<string, unknown>): RunRow {
	const version = typeof r.schema_version === "number" ? r.schema_version : 1;
	if (version < CURRENT_SCHEMA_VERSION) {
		throw new StaleSchemaError(String(r.job_name), version);
	}
	const { suite, backend, benchmark } = inferSuiteAndBackend({
		suite: r.suite ? String(r.suite) : undefined,
		backend: r.backend ? (String(r.backend) as BackendId) : undefined,
		benchmark: r.benchmark ? (String(r.benchmark) as BenchmarkKind) : undefined,
		dataset: r.dataset ? String(r.dataset) : undefined,
	});
	return {
		schemaVersion: version,
		suite,
		backend,
		benchmark,
		jobName: String(r.job_name),
		experiment: String(r.experiment ?? ""),
		arm: String(r.arm ?? ""),
		dataset: String(r.dataset),
		agent: String(r.agent),
		models: String(r.models),
		prewalk: r.prewalk === null ? null : String(r.prewalk),
		config: JSON.parse(String(r.config_json ?? "{}")),
		role: String(r.role ?? "") as RunRole,
		note: String(r.note ?? ""),
		label: String(r.label ?? ""),
		status: String(r.status) as RunStatus,
		pid: r.pid === null ? null : Number(r.pid),
		exitCode: r.exit_code === null ? null : Number(r.exit_code),
		createdAt: Number(r.created_at),
		finishedAt: r.finished_at === null ? null : Number(r.finished_at),
		nTotal: Number(r.n_total),
		done: Number(r.done),
		pass: Number(r.pass),
		fail: Number(r.fail),
		error: Number(r.error),
		running: Number(r.running),
		costUsd: optionalNumber(r.cost_usd),
		tokIn: Number(r.tok_in),
		tokOut: Number(r.tok_out),
		tokCache: optionalNumber(r.tok_cache),
		score: r.score === null ? null : Number(r.score),
		metrics: JSON.parse(String(r.metrics_json ?? "{}")),
	};
}

/** Best-effort launch metadata for historical (CLI-launched) job dirs. */
function readHarborConfig(jobDir: string): {
	dataset: string;
	agent: string;
	models: string;
	suite?: string;
	backend?: BackendId;
	benchmark?: BenchmarkKind;
} {
	try {
		const mgrRaw = JSON.parse(fs.readFileSync(path.join(jobDir, "manager.json"), "utf8")) as Record<string, unknown>;
		if (mgrRaw && typeof mgrRaw === "object") {
			return {
				dataset: String(mgrRaw.dataset ?? ""),
				agent: String(mgrRaw.agent ?? "veyyon"),
				models: Array.isArray(mgrRaw.models) ? mgrRaw.models.join(",") : String(mgrRaw.models ?? ""),
				suite: mgrRaw.suite ? String(mgrRaw.suite) : undefined,
				backend: mgrRaw.backend ? (String(mgrRaw.backend) as BackendId) : undefined,
				benchmark: mgrRaw.benchmark ? (String(mgrRaw.benchmark) as BenchmarkKind) : undefined,
			};
		}
	} catch {}
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(jobDir, "config.json"), "utf8")) as Record<string, unknown>;
		const dataset =
			typeof raw.dataset === "string"
				? raw.dataset
				: (((raw.datasets as Array<Record<string, unknown>> | undefined)?.[0]?.name as string | undefined) ?? "");
		const agents = raw.agents as Array<Record<string, unknown>> | undefined;
		const agent = (agents?.[0]?.name as string | undefined) ?? "veyyon";
		const models = (agents?.[0]?.model_name as string | undefined) ?? "";
		return { dataset: String(dataset), agent, models };
	} catch {
		return { dataset: "", agent: "veyyon", models: "" };
	}
}

function dirCreatedAt(dir: string): number {
	try {
		return Math.round(fs.statSync(dir).birthtimeMs || fs.statSync(dir).mtimeMs);
	} catch {
		return Date.now();
	}
}

/** Stale threshold for foreign runs without a terminal marker. */
const JOB_DIR_STALE_MS = 30 * 60 * 1000;

/** Newest mtime across the job dir and its result.json, or null when neither states one. */
function jobDirMtime(dir: string): number | null {
	let newest: number | null = null;
	for (const p of [dir, path.join(dir, "result.json")]) {
		try {
			const ms = fs.statSync(p).mtimeMs;
			newest = newest === null ? ms : Math.max(newest, ms);
		} catch {}
	}
	return newest === null ? null : Math.round(newest);
}

/**
 * Whether the job directory was written recently enough that an orphaned runner may still be at work.
 *
 * A timestamp the probe could not read is not evidence of a live run. Substituting the current time
 * for it — which a truthiness check also did for a directory whose mtime is the epoch — left a run
 * with no owning process marked `running` on every later sync, so it never reached a terminal state
 * and its finish time was recorded as whenever the manager happened to look.
 */
function jobDirFresh(dir: string): boolean {
	const mtime = jobDirMtime(dir);
	return mtime !== null && Date.now() - mtime < JOB_DIR_STALE_MS;
}
