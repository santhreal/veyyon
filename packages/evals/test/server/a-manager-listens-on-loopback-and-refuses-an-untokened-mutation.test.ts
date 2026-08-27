/**
 * WHY:
 * The manager server previously bound 0.0.0.0 with no auth and no CSRF protection,
 * exposing endpoints that launch processes and delete runs. Furthermore, job names were
 * not validated as one path segment (allowing directory traversal), and server error
 * bodies leaked raw host filesystem paths to clients.
 *
 * This suite closes the class by proving:
 *  1. The server binds loopback (127.0.0.1) by default.
 *  2. Mutating requests (POST, PUT, DELETE) are refused (401) without the auth token.
 *  3. A job name that is not one directory name is rejected with a 400 naming the name.
 *  4. Error responses return a stable { error } shape with absolute host paths redacted.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManagerServer } from "../../src/server/main";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeTempJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-security-test-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("ManagerServer loopback binding, auth token, and input safety", () => {
	it("binds to loopback 127.0.0.1 by default", async () => {
		const jobsDir = makeTempJobsDir();
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});

		expect(server.hostname).toBe("127.0.0.1");
	});

	it("refuses mutating requests without the token and accepts valid token formats", async () => {
		const jobsDir = makeTempJobsDir();
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://127.0.0.1:${server.port}`;

		// 1. Read-only GET requests do not require a token
		const getRuns = await fetch(`${base}/api/runs`);
		expect(getRuns.status).toBe(200);

		// 2. Mutating POST without token -> 401 Unauthorized
		const unauthPost = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "test/model", jobName: "unauth-job" }),
		});
		expect(unauthPost.status).toBe(401);
		const unauthBody = (await unauthPost.json()) as { error: string };
		expect(unauthBody.error).toMatch(/unauthorized/i);

		// 3. Mutating DELETE without token -> 401 Unauthorized
		const unauthDelete = await fetch(`${base}/api/runs/some-job`, {
			method: "DELETE",
		});
		expect(unauthDelete.status).toBe(401);

		// 4. Mutating PUT without token -> 401 Unauthorized
		const unauthPut = await fetch(`${base}/api/experiments/some-exp`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "test" }),
		});
		expect(unauthPut.status).toBe(401);

		// 5. POST with invalid token -> 401 Unauthorized
		const wrongToken = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-evals-token": "wrong-token" },
			body: JSON.stringify({ model: "test/model" }),
		});
		expect(wrongToken.status).toBe(401);

		// 6. Valid token via x-evals-token header
		const tokenHeaderPost = await fetch(`${base}/api/experiments`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-evals-token": manager.token },
			body: JSON.stringify({ id: "header_exp", goal: "test goal" }),
		});
		expect(tokenHeaderPost.status).toBe(201);

		// 7. Valid token via Authorization: Bearer <token>
		const bearerPost = await fetch(`${base}/api/experiments`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${manager.token}`,
			},
			body: JSON.stringify({ id: "bearer_exp", goal: "bearer test" }),
		});
		expect(bearerPost.status).toBe(201);

		// 8. Valid token via ?token=<token> query parameter
		const queryPost = await fetch(`${base}/api/experiments?token=${manager.token}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "query_exp", goal: "query test" }),
		});
		expect(queryPost.status).toBe(201);
	});

	it("refuses path traversal job names and names the rejection", async () => {
		const jobsDir = makeTempJobsDir();
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://127.0.0.1:${server.port}`;

		const traversalNames = [
			"../evil",
			"../../etc/passwd",
			"/tmp/absolute-path",
			"nested/job/name",
			"a\\b",
			".",
			"..",
			// Admitted by the manager's own regex before one rule answered the question: a name of
			// only spaces, a trailing space, and a NUL byte all became directory names.
			" ",
			"trailing ",
			"nul\u0000byte",
		];

		for (const badName of traversalNames) {
			const res = await fetch(`${base}/api/runs`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-evals-token": manager.token,
				},
				body: JSON.stringify({
					model: "test/model",
					jobName: badName,
				}),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("Unsafe job name");
		}
	});

	it("returns a stable error shape without exposing raw host filesystem paths", async () => {
		const jobsDir = makeTempJobsDir();
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://127.0.0.1:${server.port}`;

		// Trigger an error (e.g. invalid JSON, missing model, bad launch params)
		const res = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-evals-token": manager.token,
			},
			body: JSON.stringify({
				// Missing required model
				jobName: "valid-name",
			}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(typeof body.error).toBe("string");

		// Error body must not contain the jobs directory path or home paths
		expect(body.error).not.toContain(jobsDir);
		expect(body.error).not.toMatch(/\/home\//);
		expect(body.error).not.toMatch(/\/media\//);
		expect(body.error).not.toMatch(/\/Users\//);
	});
});
