/**
 * Differential bench for the Auto QA grievance uploader.
 *
 * Seeds one grievance row in an in-memory database and flushes it twice: once
 * with `dev.autoqaPush.enabled` off, once on, against a stub fetch that counts
 * requests. Off must send nothing and leave the row queued. On must send one
 * request and mark the row pushed. Both arms must leave the stored report text
 * unchanged, because the upload is a copy and not a move, and a queue that
 * loses its own rows to the uploader is the failure worth catching. Any other
 * shape throws instead of printing, so the JSON it emits is only ever a passing
 * result.
 *
 * Takes no arguments.
 *
 * Run:
 *     bun scripts/demos/autoqa-upload-bench.ts
 */
import { Database } from "bun:sqlite";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { __resetAutoQaFlushStateForTests, flushGrievances } from "@veyyon/coding-agent/tools/report-tool-issue";

interface ArmResult {
	requests: number;
	queuedRows: number;
	pushedRows: number;
	localRowPreserved: boolean;
}

export interface AutoQaUploadBenchResult {
	inputRows: 1;
	off: ArmResult;
	on: ArmResult;
}

function openBenchDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE grievances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			version TEXT NOT NULL,
			tool TEXT NOT NULL,
			report TEXT NOT NULL,
			pushed INTEGER NOT NULL DEFAULT 0
		)
	`);
	db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)").run(
		"anthropic/claude-opus-5",
		"1.0.37",
		"set_cwd",
		"The resolved path did not match the tool contract.",
	);
	return db;
}

async function runArm(autoUpload: boolean): Promise<ArmResult> {
	__resetAutoQaFlushStateForTests();
	const db = openBenchDb();
	try {
		const before = JSON.stringify(db.query("SELECT model, version, tool, report FROM grievances").get());
		let requests = 0;
		await flushGrievances(
			db,
			Settings.isolated({
				"dev.autoqa": true,
				"dev.autoqaPush.enabled": autoUpload,
			}),
			{
				fetch: async () => {
					requests += 1;
					return new Response("", { status: 202 });
				},
			},
		);
		const counts = db
			.query<{ queued: number; pushed: number }, []>(
				"SELECT SUM(pushed = 0) AS queued, SUM(pushed = 1) AS pushed FROM grievances",
			)
			.get();
		const after = JSON.stringify(db.query("SELECT model, version, tool, report FROM grievances").get());
		return {
			requests,
			queuedRows: counts?.queued ?? 0,
			pushedRows: counts?.pushed ?? 0,
			localRowPreserved: before === after,
		};
	} finally {
		db.close();
	}
}

export async function runAutoQaUploadBench(): Promise<AutoQaUploadBenchResult> {
	const off = await runArm(false);
	const on = await runArm(true);
	const result: AutoQaUploadBenchResult = { inputRows: 1, off, on };
	const expected: AutoQaUploadBenchResult = {
		inputRows: 1,
		off: { requests: 0, queuedRows: 1, pushedRows: 0, localRowPreserved: true },
		on: { requests: 1, queuedRows: 0, pushedRows: 1, localRowPreserved: true },
	};
	if (JSON.stringify(result) !== JSON.stringify(expected)) {
		throw new Error(`Auto QA upload differential changed: ${JSON.stringify(result)}`);
	}
	return result;
}

if (import.meta.main) {
	console.log(JSON.stringify(await runAutoQaUploadBench(), null, 2));
}
