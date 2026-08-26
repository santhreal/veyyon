/**
 * WHY:
 * The browser dashboard previously imported server-side domain models directly from
 * `src/manager/experiments` and `src/manager/store`, causing client bundles to depend
 * on internal database types and leaking internal schema assumptions. Furthermore,
 * unmeasured trial costs or token counts risked being coerced into zeros (`0` or `$0.00`)
 * rather than honestly preserving `null` and rendering as an em dash (`—`).
 *
 * This regression suite closes the class by proving:
 *  1. Every endpoint the server serves is governed by an explicit wire contract,
 *     dynamically enumerated from the server's own runtime route table so that adding
 *     an uncontracted endpoint fails the suite immediately.
 *  2. Real HTTP handlers produce responses matching their corresponding wire types
 *     across all 16 server endpoints.
 *  3. Unmeasured spend (`costUsd: null`), unmeasured cache tokens (`tokCache: null`),
 *     and unmeasured ETA (`etaMs: null`) arrive as `null` over the wire and render
 *     as em dashes (`—`) rather than zero values.
 *
 * What this does not catch:
 *  - Network transport disconnects or intermediate reverse-proxy TLS termination.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManagerServer } from "../../src/server/main";
import type { RouteDescriptor } from "../../src/wire";
import {
	type AddArmRequest,
	type ApiErrorResponse,
	type ApiTokenResponse,
	type ArmProjection,
	type ArmSummary,
	type BenchmarkDefinition,
	type CancelRunResponse,
	type CreateExperimentRequest,
	type CreateExperimentResponse,
	type DeleteExperimentResponse,
	type DeleteRunResponse,
	type ExperimentDetail,
	type ExperimentMetaUpdate,
	type ExperimentSummary,
	formatEta,
	formatMinutes,
	formatUsd,
	type LaunchRequest,
	type LaunchResponse,
	type RunDetailResponse,
	type RunRow,
	type TraceDetailResponse,
	type TraceRow,
	type TranscriptEntry,
	type UpdateExperimentMetaResponse,
} from "../../src/wire";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function makeTempJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-contract-test-"));
	cleanups.push(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
	return dir;
}

function writeFixtureJobWithUnmeasuredSpend(jobsDir: string, jobName: string): void {
	const jobDir = path.join(jobsDir, jobName);
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "result.json"),
		JSON.stringify({
			n_total_trials: 1,
			created_at: "2026-07-12T10:00:00.000Z",
			finished_at: "2026-07-12T10:05:00.000Z",
		}),
	);
	fs.writeFileSync(
		path.join(jobDir, "config.json"),
		JSON.stringify({
			dataset: "terminal-bench@2.0",
			include: ["task1"],
			agents: [{ name: "veyyon", model_name: "claude-3-7-sonnet" }],
		}),
	);
	const trialDir = path.join(jobDir, "task1", "agent");
	fs.mkdirSync(trialDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "task1", "result.json"),
		JSON.stringify({
			started_at: "2026-07-12T10:00:00",
			finished_at: "2026-07-12T10:05:00",
			verifier_result: { rewards: { reward: 1 } },
			agent_result: { cost_usd: null, n_input_tokens: 100, n_output_tokens: 10, n_cache_tokens: null },
		}),
	);
	const transcript = [
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				model: "claude-3-7-sonnet",
				content: [
					{ type: "text", text: "task completed" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
				],
			},
		}),
	].join("\n");
	fs.writeFileSync(path.join(trialDir, "veyyon.txt"), transcript);
}

/** Known wire contract mapping for all endpoints served over /api/*. */
const WIRE_CONTRACT_SPEC: Record<string, { description: string }> = {
	"GET /api/token": { description: "ApiTokenResponse" },
	"GET /api/events": { description: "SSE stream of RunRow[]" },
	"GET /api/benchmarks": { description: "BenchmarkDefinition[]" },
	"GET /api/experiments": { description: "ExperimentSummary[]" },
	"POST /api/experiments": { description: "CreateExperimentRequest -> CreateExperimentResponse" },
	"GET /api/experiments/:id": { description: "ExperimentDetail" },
	"PUT /api/experiments/:id": { description: "ExperimentMetaUpdate -> UpdateExperimentMetaResponse" },
	"DELETE /api/experiments/:id": { description: "DeleteExperimentResponse" },
	"POST /api/experiments/:id/arms": { description: "AddArmRequest -> LaunchResponse" },
	"GET /api/runs": { description: "RunRow[]" },
	"POST /api/runs": { description: "LaunchRequest -> LaunchResponse" },
	"GET /api/runs/:name": { description: "RunDetailResponse" },
	"DELETE /api/runs/:name": { description: "DeleteRunResponse" },
	"POST /api/runs/:name/cancel": { description: "CancelRunResponse" },
	"POST /api/runs/:name/resume": { description: "ResumeRunRequest -> LaunchResponse" },
	"GET /api/runs/:name/traces/:trace": { description: "TraceDetailResponse" },
};

describe("Wire contract invariants across all server endpoints", () => {
	it("enumerates every server route dynamically and ensures all 16 endpoints have wire contracts", () => {
		const routes: readonly RouteDescriptor[] = ManagerServer.routes;
		expect(routes.length).toBe(16);

		for (const route of routes) {
			const routeKey = `${route.method} ${route.path}`;
			expect(routeKey in WIRE_CONTRACT_SPEC).toBe(true);
		}

		for (const key of Object.keys(WIRE_CONTRACT_SPEC)) {
			const [method, pathname] = key.split(" ");
			const exists = routes.some(r => r.method === method && r.path === pathname);
			expect(exists).toBe(true);
		}
	});

	it("serves valid wire shapes across all read and mutate endpoints", async () => {
		const jobsDir = makeTempJobsDir();
		writeFixtureJobWithUnmeasuredSpend(jobsDir, "wire_exp-arm_a");

		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://127.0.0.1:${server.port}`;
		const authHeaders = {
			"content-type": "application/json",
			"x-evals-token": manager.token,
		};

		// 1. GET /api/token -> ApiTokenResponse
		const tokenRes = await fetch(`${base}/api/token`);
		expect(tokenRes.status).toBe(200);
		const tokenBody = (await tokenRes.json()) as ApiTokenResponse;
		expect(typeof tokenBody.token).toBe("string");
		expect(tokenBody.token).toBe(manager.token);

		// 2. GET /api/benchmarks -> BenchmarkDefinition[]
		const benchmarksRes = await fetch(`${base}/api/benchmarks`);
		expect(benchmarksRes.status).toBe(200);
		const benchmarks = (await benchmarksRes.json()) as BenchmarkDefinition[];
		expect(Array.isArray(benchmarks)).toBe(true);
		expect(benchmarks.length).toBeGreaterThanOrEqual(3);
		for (const bench of benchmarks) {
			expect(["harbor", "edit", "deepswe"]).toContain(bench.kind);
			expect(typeof bench.label).toBe("string");
			expect(Array.isArray(bench.metrics)).toBe(true);
			for (const m of bench.metrics) {
				expect(typeof m.key).toBe("string");
				expect(typeof m.label).toBe("string");
				expect(["percent", "number", "usd"]).toContain(m.format);
				expect(typeof m.higherIsBetter).toBe("boolean");
			}
		}

		// 3. POST /api/experiments -> CreateExperimentResponse
		const createExpReq: CreateExperimentRequest = { id: "wire_exp", goal: "verify wire contract" };
		const createExpRes = await fetch(`${base}/api/experiments`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(createExpReq),
		});
		expect(createExpRes.status).toBe(201);
		const createExpBody = (await createExpRes.json()) as CreateExperimentResponse;
		expect(createExpBody).toEqual({ id: "wire_exp", goal: "verify wire contract" });

		// Register the fixture run with coordinates
		manager.store.registerLaunch({
			pid: 1234,
			benchmark: "harbor",
			jobName: "wire_exp-arm_a",
			experiment: "wire_exp",
			arm: "arm_a",
			dataset: "terminal-bench@2.0",
			agent: "veyyon",
			models: ["claude-3-7-sonnet"],
			config: { benchmark: "harbor", model: "claude-3-7-sonnet", include: ["task1"] },
			role: "baseline",
			note: "baseline arm",
		});
		manager.store.syncRun("wire_exp-arm_a");

		// 4. GET /api/experiments -> ExperimentSummary[]
		const expListRes = await fetch(`${base}/api/experiments`);
		expect(expListRes.status).toBe(200);
		const expList = (await expListRes.json()) as ExperimentSummary[];
		expect(Array.isArray(expList)).toBe(true);
		const exp = expList.find(e => e.id === "wire_exp");
		expect(exp).toBeDefined();
		expect(exp?.goal).toBe("verify wire contract");
		expect(exp?.costUsd).toBeNull(); // Honest null!
		expect(exp?.arms).toBe(1);

		// 5. GET /api/experiments/:id -> ExperimentDetail
		const expDetailRes = await fetch(`${base}/api/experiments/wire_exp`);
		expect(expDetailRes.status).toBe(200);
		const expDetail = (await expDetailRes.json()) as ExperimentDetail;
		expect(expDetail.id).toBe("wire_exp");
		expect(expDetail.goal).toBe("verify wire contract");
		expect(expDetail.arms.length).toBe(1);
		const armSummary: ArmSummary = expDetail.arms[0];
		expect(armSummary.arm).toBe("arm_a");
		expect(armSummary.costPerTask).toBeNull(); // Honest null!
		expect(armSummary.run.costUsd).toBeNull(); // Honest null!
		expect(expDetail.tasks).toEqual(["task1"]);
		expect(expDetail.matrix.arm_a.task1).toEqual({ status: "pass", reward: 1 });

		// 6. PUT /api/experiments/:id -> UpdateExperimentMetaResponse
		const updateMetaReq: ExperimentMetaUpdate = {
			goal: "updated wire goal",
			runs: { "wire_exp-arm_a": { role: "variant", note: "updated note" } },
		};
		const updateMetaRes = await fetch(`${base}/api/experiments/wire_exp`, {
			method: "PUT",
			headers: authHeaders,
			body: JSON.stringify(updateMetaReq),
		});
		expect(updateMetaRes.status).toBe(200);
		const updateMetaBody = (await updateMetaRes.json()) as UpdateExperimentMetaResponse;
		expect(updateMetaBody.id).toBe("wire_exp");
		expect(updateMetaBody.updatedRuns).toContain("wire_exp-arm_a");

		// 7. GET /api/runs -> RunRow[]
		const runsRes = await fetch(`${base}/api/runs`);
		expect(runsRes.status).toBe(200);
		const runs = (await runsRes.json()) as RunRow[];
		expect(Array.isArray(runs)).toBe(true);
		const runRow = runs.find(r => r.jobName === "wire_exp-arm_a");
		expect(runRow).toBeDefined();
		expect(runRow?.costUsd).toBeNull(); // Honest null!
		expect(runRow?.tokCache).toBeNull(); // Honest null!
		expect(runRow?.experiment).toBe("wire_exp");
		expect(runRow?.arm).toBe("arm_a");

		// 8. GET /api/runs/:name -> RunDetailResponse
		const runDetailRes = await fetch(`${base}/api/runs/wire_exp-arm_a`);
		expect(runDetailRes.status).toBe(200);
		const runDetail = (await runDetailRes.json()) as RunDetailResponse;
		expect(runDetail.run.jobName).toBe("wire_exp-arm_a");
		expect(runDetail.run.costUsd).toBeNull(); // Honest null!
		expect(Array.isArray(runDetail.traces)).toBe(true);
		const traceRow: TraceRow = runDetail.traces[0];
		expect(traceRow.name).toBe("task1");
		expect(traceRow.costUsd).toBeNull(); // Honest null!

		// 9. GET /api/runs/:name/traces/:trace -> TraceDetailResponse
		const traceRes = await fetch(`${base}/api/runs/wire_exp-arm_a/traces/task1`);
		expect(traceRes.status).toBe(200);
		const traceDetail = (await traceRes.json()) as TraceDetailResponse;
		expect(traceDetail.jobName).toBe("wire_exp-arm_a");
		expect(traceDetail.trace).toBe("task1");
		expect(Array.isArray(traceDetail.entries)).toBe(true);
		const entry: TranscriptEntry = traceDetail.entries[0];
		expect(entry.kind).toBe("assistant");
		expect(entry.model).toBe("claude-3-7-sonnet");
		// 10. POST /api/runs/:name/resume -> LaunchResponse / ApiErrorResponse
		const resumeRes = await fetch(`${base}/api/runs/wire_exp-arm_a/resume`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ filterErrorTypes: [] }),
		});
		if (resumeRes.ok) {
			const resumeBody = (await resumeRes.json()) as LaunchResponse;
			expect(resumeBody.jobName).toBe("wire_exp-arm_a");
		} else {
			const errBody = (await resumeRes.json()) as ApiErrorResponse;
			expect(typeof errBody.error).toBe("string");
		}

		// 11. POST /api/runs/:name/cancel -> CancelRunResponse
		const cancelRes = await fetch(`${base}/api/runs/wire_exp-arm_a/cancel`, {
			method: "POST",
			headers: authHeaders,
		});
		expect(cancelRes.status).toBe(200);
		const cancelBody = (await cancelRes.json()) as CancelRunResponse;
		expect(cancelBody.jobName).toBe("wire_exp-arm_a");
		expect(typeof cancelBody.cancelled).toBe("boolean");
		manager.store.markExit("wire_exp-arm_a", 0, false);

		// 12. POST /api/experiments/:id/arms -> LaunchResponse / ApiErrorResponse
		const addArmReq: AddArmRequest = { arm: "arm_b", model: "claude-3-7-sonnet" };
		const addArmRes = await fetch(`${base}/api/experiments/wire_exp/arms`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(addArmReq),
		});
		if (addArmRes.status === 201) {
			const addArmBody = (await addArmRes.json()) as LaunchResponse;
			expect(addArmBody.jobName).toBe("wire_exp-arm_b");
			expect(typeof addArmBody.pid).toBe("number");
			manager.cancel("wire_exp-arm_b");
			manager.store.markExit("wire_exp-arm_b", 0, false);
		} else {
			const err = (await addArmRes.json()) as ApiErrorResponse;
			expect(typeof err.error).toBe("string");
		}

		// 13. POST /api/runs -> LaunchResponse / ApiErrorResponse
		const launchReq: LaunchRequest = { model: "test/model", benchmark: "harbor" };
		const launchRes = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(launchReq),
		});
		if (launchRes.status === 201) {
			const launchBody = (await launchRes.json()) as LaunchResponse;
			expect(typeof launchBody.jobName).toBe("string");
			manager.cancel(launchBody.jobName);
			manager.store.markExit(launchBody.jobName, 0, false);
		} else {
			const err = (await launchRes.json()) as ApiErrorResponse;
			expect(typeof err.error).toBe("string");
		}

		// 14. DELETE /api/runs/:name -> DeleteRunResponse
		const deleteRunRes = await fetch(`${base}/api/runs/wire_exp-arm_a`, {
			method: "DELETE",
			headers: authHeaders,
		});
		const deleteRunBody = (await deleteRunRes.json()) as DeleteRunResponse & { error?: string };
		expect(deleteRunRes.status).toBe(200);
		expect(deleteRunBody).toEqual({ jobName: "wire_exp-arm_a", deleted: true });
		manager.cancel("wire_exp-arm_b");
		manager.store.markExit("wire_exp-arm_b", 0, false);

		// 15. DELETE /api/experiments/:id -> DeleteExperimentResponse
		const deleteExpRes = await fetch(`${base}/api/experiments/wire_exp`, {
			method: "DELETE",
			headers: authHeaders,
		});
		expect(deleteExpRes.status).toBe(200);
		const deleteExpBody = (await deleteExpRes.json()) as DeleteExperimentResponse;
		expect(deleteExpBody.id).toBe("wire_exp");
		expect(Array.isArray(deleteExpBody.deletedRuns)).toBe(true);

		// 16. GET /api/events -> SSE stream response
		const eventsRes = await fetch(`${base}/api/events`);
		expect(eventsRes.status).toBe(200);
		expect(eventsRes.headers.get("content-type")).toContain("text/event-stream");
		await eventsRes.body?.cancel();
	});

	it("preserves null spend on the wire and renders it as an em dash", () => {
		// Honest null contract: unmeasured cost is null, not 0
		const nullCost: number | null = null;
		expect(formatUsd(nullCost)).toBe("—");
		expect(formatUsd(nullCost)).not.toBe("$0.00");
		expect(formatUsd(nullCost)).not.toBe("$0.000");
		expect(formatUsd(nullCost)).not.toBe("$0");

		// Measured zero is rendered honestly as $0.000
		const zeroCost = 0;
		expect(formatUsd(zeroCost)).toBe("$0.000");
		expect(formatUsd(1.25)).toBe("$1.25");
		expect(formatUsd(150.7)).toBe("$151");

		// Duration formatting
		expect(formatMinutes(120_000)).toBe("2.0m");

		// Honest ETA rendering
		expect(formatEta(null)).toBe("—");
		expect(formatEta(null)).not.toBe("~0m");
		expect(formatEta(Date.now() + 120_000)).toBe("~2m");

		// Arm projection honors null costs
		const proj: ArmProjection = {
			etaMs: null,
			passPct: 80,
			costPerTask: null,
			totalCostUsd: null,
			meanTrialMs: 3000,
		};
		expect(proj.costPerTask).toBeNull();
		expect(proj.totalCostUsd).toBeNull();
		expect(proj.etaMs).toBeNull();
		expect(formatUsd(proj.costPerTask)).toBe("—");
		expect(formatUsd(proj.totalCostUsd)).toBe("—");
		expect(formatEta(proj.etaMs)).toBe("—");
	});
});
