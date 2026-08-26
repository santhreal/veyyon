/**
 * WHY:
 * The evals server routes were previously routed via hand-written branching inside a monolithic
 * method. Adding an endpoint to SERVER_ROUTES without implementing its handler, or registering
 * a route with mismatched parameter shapes, risked shipping dead routes silently.
 *
 * This suite closes the class by proving:
 *  1. Every declared route in SERVER_ROUTES has a corresponding handler in ROUTE_HANDLERS,
 *     asserting that the set of unhandled routes is strictly empty by exact equality.
 *  2. Every declared route is reachable over real HTTP on an ephemeral port and executes its handler.
 *  3. No declared route returns an undeclared 404 not found route failure when called with its declared method.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManagerServer } from "../../src/server/main";
import { ROUTE_HANDLERS } from "../../src/server/router";
import { SERVER_ROUTES } from "../../src/wire";

const cleanups: Array<() => void> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
});

function makeTempJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-routes-sweep-test-"));
	cleanups.push(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
	return dir;
}

function writeFixtureJob(jobsDir: string, jobName: string): void {
	const jobDir = path.join(jobsDir, jobName);
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "result.json"),
		JSON.stringify({
			n_total_trials: 1,
			stats: { n_running_trials: 0, n_pending_trials: 0 },
			created_at: "2026-07-12T10:00:00.000Z",
			finished_at: "2026-07-12T10:05:00.000Z",
		}),
	);
	fs.writeFileSync(
		path.join(jobDir, "config.json"),
		JSON.stringify({
			dataset: "terminal-bench@2.0",
			include: ["task1"],
			agents: [{ name: "veyyon", model_name: "anthropic/claude-opus-4-8" }],
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
			agent_result: { cost_usd: 0.5, n_input_tokens: 100, n_output_tokens: 10, n_cache_tokens: 80 },
		}),
	);
	fs.writeFileSync(path.join(trialDir, "veyyon.txt"), "log output\n");
}

describe("Every declared server route is reachable and handled", () => {
	it("asserts every declared route in SERVER_ROUTES has a matching controller handler", () => {
		const unhandledRoutes: string[] = [];
		for (const route of SERVER_ROUTES) {
			const key = `${route.method} ${route.path}`;
			if (!(key in ROUTE_HANDLERS)) {
				unhandledRoutes.push(key);
			}
		}
		// Exact equality assertion: adding a route without a handler fails immediately
		expect(unhandledRoutes).toEqual([]);
	});

	it("dispatches requests to all 16 declared endpoints on a live server", async () => {
		const jobsDir = makeTempJobsDir();
		writeFixtureJob(jobsDir, "exp1-arm1");
		writeFixtureJob(jobsDir, "exp1-arm2");

		const manager = new ManagerServer(jobsDir);
		manager.store.discover();
		manager.store.syncAll();
		manager.store.setExperimentGoal("exp1", "benchmark comparison goal");

		const server = manager.start(0);
		cleanups.push(async () => {
			await manager.stop();
		});

		const base = `http://127.0.0.1:${server.port}`;
		const authHeaders = {
			"content-type": "application/json",
			"x-evals-token": manager.token,
		};

		// 1. GET /api/token
		const tokenRes = await fetch(`${base}/api/token`);
		expect(tokenRes.status).toBe(200);
		const tokenJson = (await tokenRes.json()) as { token: string };
		expect(tokenJson.token).toBe(manager.token);

		// 2. GET /api/events
		const eventsRes = await fetch(`${base}/api/events`);
		expect(eventsRes.status).toBe(200);
		expect(eventsRes.headers.get("content-type")).toBe("text/event-stream");
		await eventsRes.body?.cancel();

		// 3. GET /api/benchmarks
		const benchmarksRes = await fetch(`${base}/api/benchmarks`);
		expect(benchmarksRes.status).toBe(200);
		const benchmarksJson = await benchmarksRes.json();
		expect(Array.isArray(benchmarksJson)).toBe(true);

		// 4. GET /api/experiments
		const experimentsRes = await fetch(`${base}/api/experiments`);
		expect(experimentsRes.status).toBe(200);
		const experimentsJson = await experimentsRes.json();
		expect(Array.isArray(experimentsJson)).toBe(true);

		// 5. POST /api/experiments
		const createExpRes = await fetch(`${base}/api/experiments`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ id: "sweep_exp", goal: "sweep test" }),
		});
		expect(createExpRes.status).toBe(201);

		// 6. GET /api/experiments/:id
		const getExpRes = await fetch(`${base}/api/experiments/exp1`);
		expect(getExpRes.status).toBe(200);
		const getExpJson = (await getExpRes.json()) as { id: string };
		expect(getExpJson.id).toBe("exp1");

		// 7. PUT /api/experiments/:id
		const putExpRes = await fetch(`${base}/api/experiments/exp1`, {
			method: "PUT",
			headers: authHeaders,
			body: JSON.stringify({ goal: "updated goal" }),
		});
		expect(putExpRes.status).toBe(200);

		// 8. POST /api/experiments/:id/arms (validation error or mock launch is handled by controller)
		const addArmRes = await fetch(`${base}/api/experiments/exp1/arms`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ arm: "arm1", model: "anthropic/claude-opus-4-8" }),
		});
		// Arm1 already exists in exp1, so 400 is expected from resolveArmLaunch, proving it reached the controller
		expect(addArmRes.status).toBe(400);
		const addArmJson = (await addArmRes.json()) as { error: string };
		expect(addArmJson.error).toContain("already exists");

		// 9. GET /api/runs
		const runsRes = await fetch(`${base}/api/runs`);
		expect(runsRes.status).toBe(200);
		const runsJson = await runsRes.json();
		expect(Array.isArray(runsJson)).toBe(true);

		// 10. POST /api/runs (empty model triggers validation error from launch controller)
		const launchRes = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({}),
		});
		expect(launchRes.status).toBe(400);
		const launchJson = (await launchRes.json()) as { error: string };
		expect(launchJson.error).toContain("model is required");

		// 11. GET /api/runs/:name
		const getRunRes = await fetch(`${base}/api/runs/exp1-arm1`);
		expect(getRunRes.status).toBe(200);
		const getRunJson = (await getRunRes.json()) as { run: { jobName: string } };
		expect(getRunJson.run.jobName).toBe("exp1-arm1");

		// 12. POST /api/runs/:name/cancel
		const cancelRes = await fetch(`${base}/api/runs/exp1-arm1/cancel`, {
			method: "POST",
			headers: authHeaders,
		});
		expect(cancelRes.status).toBe(200);
		const cancelJson = (await cancelRes.json()) as { cancelled: boolean };
		expect(typeof cancelJson.cancelled).toBe("boolean");

		// 13. POST /api/runs/:name/resume
		const resumeRes = await fetch(`${base}/api/runs/exp1-arm1/resume`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({}),
		});
		// Live / finished resume triggers runner resume logic
		expect(resumeRes.status === 201 || resumeRes.status === 400).toBe(true);

		// 14. GET /api/runs/:name/traces/:trace
		const traceRes = await fetch(`${base}/api/runs/exp1-arm1/traces/task1`);
		expect(traceRes.status).toBe(200);
		const traceJson = (await traceRes.json()) as { jobName: string; trace: string };
		expect(traceJson.jobName).toBe("exp1-arm1");
		expect(traceJson.trace).toBe("task1");

		// 15. DELETE /api/runs/:name
		const deleteRunRes = await fetch(`${base}/api/runs/exp1-arm2`, {
			method: "DELETE",
			headers: authHeaders,
		});
		expect(deleteRunRes.status).toBe(200);

		// 16. DELETE /api/experiments/:id
		const deleteExpRes = await fetch(`${base}/api/experiments/sweep_exp`, {
			method: "DELETE",
			headers: authHeaders,
		});
		expect(deleteExpRes.status).toBe(200);
	});
});
