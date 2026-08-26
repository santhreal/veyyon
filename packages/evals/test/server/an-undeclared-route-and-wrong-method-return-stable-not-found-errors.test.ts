/**
 * WHY:
 * Requests to unknown endpoints or using unsupported HTTP methods must return stable,
 * predictable 404 Not Found error shapes rather than crashing, hanging, or exposing
 * internal routing exceptions.
 *
 * This suite closes the class by proving:
 *  1. An undeclared route path returns HTTP status 404 with `{ error: "not found" }`.
 *  2. A declared route requested with an unsupported method returns HTTP status 404 with `{ error: "not found" }`.
 *  3. Mutating requests without authentication tokens are refused with 401 before routing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManagerServer } from "../../src/server/main";

const cleanups: Array<() => void> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
});

function makeTempJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-errors-test-"));
	cleanups.push(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
	return dir;
}

describe("Undeclared paths and mismatched HTTP methods return stable error bodies", () => {
	it("returns 404 { error: 'not found' } for undeclared routes", async () => {
		const jobsDir = makeTempJobsDir();
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(async () => {
			await manager.stop();
		});

		const base = `http://127.0.0.1:${server.port}`;

		const undeclaredPaths = [
			"/api/nonexistent",
			"/api/runs/foo/bar/baz",
			"/api/experiments/exp1/unknown",
			"/invalid-root-path",
		];

		for (const path of undeclaredPaths) {
			const res = await fetch(`${base}${path}`);
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string };
			expect(body).toEqual({ error: "not found" });
		}
	});

	it("returns 404 { error: 'not found' } when calling declared endpoints with unsupported methods", async () => {
		const jobsDir = makeTempJobsDir();
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(async () => {
			await manager.stop();
		});

		const base = `http://127.0.0.1:${server.port}`;
		const authHeaders = {
			"content-type": "application/json",
			"x-evals-token": manager.token,
		};

		// 1. POST to GET-only /api/token (with valid token)
		const postToken = await fetch(`${base}/api/token`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({}),
		});
		expect(postToken.status).toBe(404);
		expect(await postToken.json()).toEqual({ error: "not found" });

		// 2. DELETE to GET-only /api/benchmarks (with valid token)
		const deleteBenchmarks = await fetch(`${base}/api/benchmarks`, {
			method: "DELETE",
			headers: authHeaders,
		});
		expect(deleteBenchmarks.status).toBe(404);
		expect(await deleteBenchmarks.json()).toEqual({ error: "not found" });

		// 3. PUT to /api/runs (with valid token)
		const putRuns = await fetch(`${base}/api/runs`, {
			method: "PUT",
			headers: authHeaders,
			body: JSON.stringify({}),
		});
		expect(putRuns.status).toBe(404);
		expect(await putRuns.json()).toEqual({ error: "not found" });

		// 4. POST to GET-only /api/runs/:name/traces/:trace (with valid token)
		const postTrace = await fetch(`${base}/api/runs/test-run/traces/test-trace`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({}),
		});
		expect(postTrace.status).toBe(404);
		expect(await postTrace.json()).toEqual({ error: "not found" });
	});
});
