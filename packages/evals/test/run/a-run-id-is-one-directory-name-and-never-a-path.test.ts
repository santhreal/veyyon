/**
 * WHY THIS SUITE EXISTS. A run id becomes a directory name: the journal lives at
 * `<runsDir>/<runId>/trials.jsonl`, and the manager's jobs directory is keyed by job name.
 * The CLI accepted any string. `--run-id ../../etc` resolved the journal to
 * `packages/etc/trials.jsonl` — outside the runs directory entirely — and a real run
 * created it there, while `--resume` reported the escaped path back as if it were a run
 * that had not started. The manager had its own second rule for the same question, a regex
 * that admitted a name of only spaces and one holding a NUL byte.
 *
 * THE CLASS: a caller-supplied string joined into a path without being a single path
 * segment. One owner answers it now (`requirePathSegment`), and every seam that turns an id
 * into a directory is swept here: the CLI flag, `buildRunPlan`, `journalPathFor`, and every
 * mutating server route carrying a `:name`, enumerated out of `SERVER_ROUTES` at run time so
 * a new one arrives red rather than unguarded. The accepting case is asserted beside each
 * refusal, so a rule that refuses everything cannot pass either.
 *
 * WHAT IT DOES NOT CATCH: what a backend does with an id it has already accepted (harbor
 * and pier sanitize their own job names), and the wording of the shared refusal, which
 * belongs to `src/paths.ts`.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManagerServer } from "../../api/main";
import { RunnerManager } from "../../api/runner";
import type { EvalSuite, PreflightVerdict, TaskDescriptor, TrialScore } from "../../engine/contracts";
import { harnesses } from "../../engine/loaded-members";
import { UnsafePathSegmentError } from "../../engine/package-paths";
import { journalPathFor } from "../../engine/run-journal";
import { buildRunPlan } from "../../engine/run-plan";
import { FREE_FORM_PARAMS, PATH_SEGMENT_PARAMS, SERVER_ROUTES } from "../../engine/store-shapes";
import { main, parseEvalsArgs } from "../../evals";
import { assertSafeJobName, RunStore } from "../../store/sqlite";

/** Every shape of id that is not a single directory name. */
const NOT_ONE_SEGMENT: string[] = [
	"../escaped",
	"../../etc/passwd",
	"nested/run/name",
	"a\\b",
	"/absolute",
	".",
	"..",
	" ",
	"trailing ",
	"nul\u0000byte",
];

/** An id that is a single directory name, so a refusal of everything cannot pass. */
const GOOD_ID = "run-2026-04-01";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	spyOn(process.stdout, "write").mockRestore();
	spyOn(process.stderr, "write").mockRestore();
});

/** Captures what the CLI wrote to a stream, without letting it reach the terminal. */
function capture(stream: "stdout" | "stderr"): { text: () => string } {
	const chunks: string[] = [];
	const spy = spyOn(process[stream], "write").mockImplementation(chunk => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	return { text: () => (spy.mock.calls.length === 0 ? "" : chunks.join("")) };
}

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A suite with one task, so a plan can be built without a corpus. */
function oneTaskSuite(): EvalSuite {
	return {
		id: "probe",
		version: "1.0.0",
		displayName: "Probe",
		description: "one task, no corpus",
		backend: "in-process",
		async discoverTasks(): Promise<readonly string[]> {
			return ["only-task"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return { id: taskId, path: null, timeBudgetSec: 1, instructionPath: null, metadata: {} };
		},
		async provenance() {
			return { suite: "probe", version: "1.0.0" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: null, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight(): Promise<PreflightVerdict> {
			return { ok: true };
		},
	};
}

describe("the --run-id flag", () => {
	it.each(NOT_ONE_SEGMENT)("refuses %j before anything is planned", badId => {
		expect(() => parseEvalsArgs(["--suite", "typescript-edit", "--run-id", badId])).toThrow(UnsafePathSegmentError);
	});

	it("accepts an id that is one directory name", () => {
		expect(parseEvalsArgs(["--suite", "typescript-edit", "--run-id", GOOD_ID]).runId).toBe(GOOD_ID);
	});

	it("earns the usage exit code and states the rule", async () => {
		const stderr = capture("stderr");

		const code = await main(["--suite", "typescript-edit", "--model", "x/y", "--run-id", "../escaped", "--dry-run"]);

		expect(code).toBe(2);
		expect(stderr.text()).toContain("Unsafe --run-id value");
		expect(stderr.text()).toContain("a path segment must be a single name");
	});
});

describe("buildRunPlan", () => {
	it.each(NOT_ONE_SEGMENT)("refuses the caller-supplied id %j", async badId => {
		await expect(
			buildRunPlan({
				suite: oneTaskSuite(),
				harnesses,
				selection: { harnesses: ["veyyon"], models: ["anthropic/claude-sonnet-4-6"] },
				runId: badId,
			}),
		).rejects.toThrow(UnsafePathSegmentError);
	});

	it("keeps an id that is one directory name, and generates one otherwise", async () => {
		const selection = { harnesses: ["veyyon"], models: ["anthropic/claude-sonnet-4-6"] };
		const named = await buildRunPlan({ suite: oneTaskSuite(), harnesses, selection, runId: GOOD_ID });
		const generated = await buildRunPlan({ suite: oneTaskSuite(), harnesses, selection });

		expect(named.runId).toBe(GOOD_ID);
		expect(generated.runId.startsWith("probe-")).toBe(true);
		expect(path.basename(generated.runId)).toBe(generated.runId);
	});
});

describe("journalPathFor", () => {
	it.each(NOT_ONE_SEGMENT)("refuses to build a journal path for %j", badId => {
		expect(() => journalPathFor("/runs", badId)).toThrow(UnsafePathSegmentError);
	});

	it("joins an id that is one directory name under the runs directory", () => {
		expect(journalPathFor("/runs", GOOD_ID)).toBe(path.join("/runs", GOOD_ID, "trials.jsonl"));
	});
});

describe("assertSafeJobName", () => {
	it.each(NOT_ONE_SEGMENT)("refuses %j", badName => {
		expect(() => assertSafeJobName(badName)).toThrow(UnsafePathSegmentError);
	});

	it("accepts a name that is one directory name", () => {
		expect(() => assertSafeJobName(GOOD_ID)).not.toThrow();
	});
});

describe("the store and the runner, reached as libraries rather than over HTTP", () => {
	it.each(NOT_ONE_SEGMENT)("refuses to mirror a job dir for %j", badName => {
		const store = new RunStore(tempDir("evals-run-id-store-"));
		try {
			expect(() => store.syncRun(badName)).toThrow(UnsafePathSegmentError);
		} finally {
			store.close();
		}
	});

	it.each(NOT_ONE_SEGMENT)("refuses to cancel, resume or delete %j", badName => {
		const jobsDir = tempDir("evals-run-id-runner-");
		const store = new RunStore(jobsDir);
		try {
			const runner = new RunnerManager(jobsDir, store, () => {});
			expect(() => runner.cancel(badName)).toThrow(UnsafePathSegmentError);
			expect(() => runner.resume(badName)).toThrow(UnsafePathSegmentError);
			expect(() => runner.deleteRun(badName)).toThrow(UnsafePathSegmentError);
			expect(() => runner.destroyRun(badName)).toThrow(UnsafePathSegmentError);
		} finally {
			store.close();
		}
	});

	it("reports a name that is one directory name as absent rather than refusing it", () => {
		const jobsDir = tempDir("evals-run-id-runner-ok-");
		const store = new RunStore(jobsDir);
		try {
			const runner = new RunnerManager(jobsDir, store, () => {});
			expect(store.syncRun(GOOD_ID)).toBeNull();
			expect(runner.cancel(GOOD_ID)).toEqual({ jobName: GOOD_ID, cancelled: false });
			expect(runner.deleteRun(GOOD_ID)).toBe(false);
		} finally {
			store.close();
		}
	});
});

/** Every route parameter the server declares, read out of the route table at run time. */
const DECLARED_PARAMS: string[] = [
	...new Set(
		SERVER_ROUTES.flatMap(route => [...route.path.matchAll(/:([a-zA-Z0-9_]+)/g)].map(match => match[1] as string)),
	),
].sort();

/** Every route that carries a run name, mutating or not: a GET joins the name too. */
const NAME_ROUTES = SERVER_ROUTES.filter(route => route.path.includes(":name"));

describe("the route parameters a server declares", () => {
	it("records every parameter as a path segment or as free-form, so a new one arrives red", () => {
		expect(DECLARED_PARAMS).toEqual([...PATH_SEGMENT_PARAMS, ...FREE_FORM_PARAMS].sort());
	});
});

describe("a server route carrying a run name", () => {
	it("has routes to sweep, so an empty filter cannot pass", () => {
		expect(NAME_ROUTES.length).toBeGreaterThan(0);
	});

	it.each(NAME_ROUTES)("refuses a traversal name on $method $path", async route => {
		const manager = new ManagerServer(tempDir("evals-run-id-route-"));
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://127.0.0.1:${server.port}`;
		let reachedTheRouter = 0;

		for (const badName of NOT_ONE_SEGMENT) {
			const target = route.path.replace(":name", encodeURIComponent(badName)).replace(":trace", "any");
			const res = await fetch(`${base}${target}`, {
				method: route.method,
				headers: { "content-type": "application/json", "x-evals-token": manager.token },
				body: route.method === "GET" || route.method === "DELETE" ? undefined : "{}",
			});
			const body = (await res.json()) as { error?: string };

			// A name the URL layer collapses (`.`, `..`) never reaches a route at all, which is a
			// 404 rather than a refusal. Anything that survives encoding reaches the router and is
			// refused there by name, so the two outcomes are asserted apart instead of as "not 200".
			if (new URL(`${base}${target}`).pathname === target) {
				reachedTheRouter += 1;
				expect(res.status).toBe(400);
				expect(body.error).toContain("name parameter");
			} else {
				expect(res.status).toBe(404);
			}
			expect(body.error).not.toContain(os.tmpdir());
		}

		expect(reachedTheRouter).toBeGreaterThan(0);
	});

	it("reports a run name that is one directory name as missing rather than refusing it", async () => {
		const manager = new ManagerServer(tempDir("evals-run-id-route-ok-"));
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});

		const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/${GOOD_ID}`, {
			method: "DELETE",
			headers: { "x-evals-token": manager.token },
		});

		expect(res.status).toBe(404);
		expect((await res.json()) as { error: string }).toEqual({ error: "run not found" });
	});
});
