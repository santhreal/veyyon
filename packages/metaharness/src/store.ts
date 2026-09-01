import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { isProcessAlive } from "@veyyon/utils";
import { sqlPlaceholders } from "@veyyon/utils/sqlite";
import { readBenchmarkSnapshot } from "./benchmarks";
import { readJobResult } from "./runner";
import type {
	BenchmarkKind,
	ExperimentMeta,
	LaunchRecord,
	RunRole,
	RunRow,
	RunStatus,
	TraceRow,
} from "./store-helpers";
import { enableWal, NON_JOB_DIRS, SCHEMA } from "./store-helpers";

export type { BenchmarkKind, LaunchRecord, RunRole, RunRow, TraceRow };

export class RunStore {
	#db: Database;
	readonly jobsDir: string;

	constructor(jobsDir: string, dbPath?: string) {
		this.jobsDir = jobsDir;
		fs.mkdirSync(path.join(jobsDir, "_manager"), { recursive: true });
		this.#db = new Database(dbPath ?? path.join(jobsDir, "_manager", "metaharness.sqlite"));
		this.#db.run("PRAGMA busy_timeout = 5000");
		enableWal(this.#db);
		this.#db.run(SCHEMA);
		const runColumns = new Set(
			(this.#db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(c => c.name),
		);
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
	}

	close(): void {
		this.#db.close();
	}

	registerLaunch(launch: LaunchRecord): void {
		this.#db.query("DELETE FROM trials WHERE job_name = ?").run(launch.jobName);
		this.#db
			.query(
				`INSERT INTO runs
				 (job_name, benchmark, dataset, agent, models, prewalk, role, note, config_json, status, pid, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
				 ON CONFLICT(job_name) DO UPDATE SET
					benchmark = excluded.benchmark, pid = excluded.pid, status = 'running',
					config_json = excluded.config_json,
					role = CASE WHEN excluded.role != '' THEN excluded.role ELSE runs.role END,
					note = CASE WHEN excluded.note != '' THEN excluded.note ELSE runs.note END`,
			)
			.run(
				launch.jobName,
				launch.benchmark,
				launch.dataset,
				launch.agent,
				launch.models.join(","),
				launch.prewalk ? JSON.stringify(launch.prewalk) : null,
				launch.role ?? "",
				launch.note ?? "",
				JSON.stringify(launch.config ?? {}),
				launch.pid,
				Date.now(),
			);
		const jobDir = path.join(this.jobsDir, launch.jobName);
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(path.join(jobDir, "manager.json"), JSON.stringify(launch, null, 2));
	}

	setExperimentGoal(id: string, goal: string): void {
		this.#db
			.query(
				`INSERT INTO experiments (id, goal, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET goal = excluded.goal, updated_at = excluded.updated_at`,
			)
			.run(id, goal, Date.now());
	}

	getExperimentMeta(id: string): ExperimentMeta | null {
		const row = this.#db.query("SELECT id, goal, updated_at FROM experiments WHERE id = ?").get(id) as {
			id: string;
			goal: string;
			updated_at: number;
		} | null;
		return row ? { id: row.id, goal: row.goal, updatedAt: row.updated_at } : null;
	}

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

	deleteExperimentMeta(id: string): void {
		this.#db.query("DELETE FROM experiments WHERE id = ?").run(id);
	}

	deleteRun(jobName: string): boolean {
		if (!this.getRun(jobName)) return false;
		this.#db.query("DELETE FROM trials WHERE job_name = ?").run(jobName);
		this.#db.query("DELETE FROM runs WHERE job_name = ?").run(jobName);
		return true;
	}

	setRunMeta(jobName: string, meta: { role?: RunRole; note?: string; label?: string }): boolean {
		const existing = this.getRun(jobName);
		if (!existing) return false;
		this.#db
			.query("UPDATE runs SET role = ?, note = ?, label = ? WHERE job_name = ?")
			.run(meta.role ?? existing.role, meta.note ?? existing.note, meta.label ?? existing.label, jobName);
		return true;
	}

	markExit(jobName: string, exitCode: number | null, cancelled = false): void {
		const status: RunStatus = cancelled ? "cancelled" : exitCode === 0 ? "complete" : "failed";
		this.#db
			.query("UPDATE runs SET status = ?, exit_code = ?, finished_at = ?, pid = NULL WHERE job_name = ?")
			.run(status, exitCode, Date.now(), jobName);
	}

	discover(): number {
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
			this.#db
				.query(
					`INSERT INTO runs (job_name, dataset, agent, models, status, created_at)
					 VALUES (?, ?, ?, ?, 'running', ?)`,
				)
				.run(e.name, meta.dataset, meta.agent, meta.models, createdAt);
			this.syncRun(e.name);
			added++;
		}
		return added;
	}

	syncRun(jobName: string): RunRow | null {
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
			if (snapshot.traces.length > 0) {
				const names = snapshot.traces.map(t => t.name);
				this.#db
					.query(`DELETE FROM trials WHERE job_name = ? AND name NOT IN (${sqlPlaceholders(names.length)})`)
					.run(jobName, ...names);
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

	syncActive(): RunRow[] {
		const active = this.#db.query("SELECT job_name FROM runs WHERE status = 'running'").all() as Array<{
			job_name: string;
		}>;
		const out: RunRow[] = [];
		for (const { job_name } of active) {
			const row = this.getRun(job_name);
			if (row?.pid != null && !isProcessAlive(row.pid)) {
				this.#db.query("UPDATE runs SET pid = NULL WHERE job_name = ?").run(job_name);
			}
			const synced = this.syncRun(job_name);
			if (synced) out.push(synced);
		}
		return out;
	}

	syncAll(): void {
		const rows = this.#db.query("SELECT job_name FROM runs").all() as Array<{ job_name: string }>;
		for (const { job_name } of rows) this.syncRun(job_name);
	}

	getRun(jobName: string): RunRow | null {
		const r = this.#db.query("SELECT * FROM runs WHERE job_name = ?").get(jobName) as Record<string, unknown> | null;
		return r ? rowToRun(r) : null;
	}

	listRuns(): RunRow[] {
		const rows = this.#db.query("SELECT * FROM runs ORDER BY created_at DESC").all() as Array<
			Record<string, unknown>
		>;
		return rows.map(rowToRun);
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
			costUsd: Number(r.cost_usd),
			durationMs: Number(r.duration_ms),
			detail: String(r.detail),
			updatedAt: Number(r.updated_at),
			tracePath: r.trace_path === null ? null : String(r.trace_path),
		}));
	}
}

function rowToRun(r: Record<string, unknown>): RunRow {
	return {
		benchmark: String(r.benchmark ?? "harbor") as BenchmarkKind,
		jobName: String(r.job_name),
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
		costUsd: Number(r.cost_usd),
		tokIn: Number(r.tok_in),
		tokOut: Number(r.tok_out),
		tokCache: Number(r.tok_cache),
		score: r.score === null ? null : Number(r.score),
		metrics: JSON.parse(String(r.metrics_json ?? "{}")),
	};
}

function readHarborConfig(jobDir: string): { dataset: string; agent: string; models: string } {
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

const JOB_DIR_STALE_MS = 30 * 60 * 1000;

function jobDirMtime(dir: string): number {
	let newest = 0;
	for (const p of [dir, path.join(dir, "result.json")]) {
		try {
			newest = Math.max(newest, fs.statSync(p).mtimeMs);
		} catch {}
	}
	return Math.round(newest) || Date.now();
}

function jobDirFresh(dir: string): boolean {
	return Date.now() - jobDirMtime(dir) < JOB_DIR_STALE_MS;
}
