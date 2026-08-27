/**
 * WHY THIS SUITE EXISTS. A trial's deadline bounded the trial and nothing bounded what came after
 * it. The in-process backend ended every trial with `await client.dispose().catch(() => {})`, and a
 * client with a socket still open, a provider request still in flight, or an MCP child that ignores
 * SIGTERM never settled that promise. The trial had already produced its score: the worker stopped
 * inside the `finally`, the pool never freed the slot, and the run ended with fewer rows than tasks,
 * no error, and no process left to look at.
 *
 * THE CLASS THIS CLOSES: an unbounded await on a teardown path. `teardownWithin` in
 * `src/core/trial-deadline.ts` is the one place a teardown is bounded, and both per-trial teardown
 * paths call it, so a backend added later inherits the bound by using it. The four outcomes a
 * teardown can have are all asserted: it finishes, it throws, it outlasts its grace, and it throws
 * synchronously before returning a promise. The abandoned case is asserted twice — once on the
 * helper, once through the real backend — because a bound the backend does not call is not a bound.
 *
 * The grace is a real timer in production code, which is exactly what is under test here, so it
 * cannot be faked away: the run states a 10ms grace instead, and the hung teardown is a promise
 * nothing ever resolves rather than a sleep.
 *
 * WHAT IT DOES NOT CATCH: whether an abandoned teardown leaks the resource it was disposing. It
 * does — the promise keeps running, unobserved — and that is the trade this bound makes: a leaked
 * socket costs one file descriptor, a wedged worker costs the rest of the run. The second bounded
 * teardown, in the typescript-edit adapter's session runner, is not driven here: reaching it needs
 * a spawned CLI and a provider. It calls the same owner, and a third teardown path that awaits a
 * dispose directly would pass this file.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { InProcessBackend, type InProcessClientLike } from "../../src/backends/in-process/backend";
import type { EvalSuite, RunContext, SuiteProvenance, TaskDescriptor, TrialCell, Variant } from "../../src/core";
import {
	MAX_TEARDOWN_GRACE_MS,
	MIN_TEARDOWN_GRACE_MS,
	TEARDOWN_GRACE_MS,
	teardownGraceFromOptions,
	teardownWithin,
} from "../../src/core";
import { registerBuiltinHarnesses } from "../../src/harnesses/index";

function probeSuite(): EvalSuite {
	return {
		name: "teardown-probe",
		version: "1.0.0",
		displayName: "Teardown Probe",
		description: "A suite that exists to end a trial and then get out of the way.",
		backend: "in-process",
		async discoverTasks() {
			return ["task-1"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: null,
				timeBudgetSec: 30,
				instructionPath: null,
				metadata: { prompt: "do the thing", files: [] },
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "teardown-probe", version: "1.0.0" };
		},
		async scoreTrial() {
			return { reward: 1, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

/** A client that answers a trial normally and disposes however the case states. */
function probeClient(dispose: () => Promise<void>): InProcessClientLike {
	return {
		async start() {},
		async prompt() {},
		async getSessionStats() {
			return {
				tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
				assistantMessages: 1,
				cost: 0.01,
			};
		},
		async getLastAssistantText() {
			return "done";
		},
		dispose,
	};
}

describe("teardownWithin bounds one teardown", () => {
	it("reports nothing when the teardown finishes", async () => {
		let disposed = false;

		const reason = await teardownWithin(async () => {
			disposed = true;
		});

		expect(disposed).toBe(true);
		expect(reason).toBeNull();
	});

	it("reports the grace period a teardown outlasted, and returns rather than waiting for it", async () => {
		// Nothing ever resolves this: the only way this test ends is the bound.
		const hung = Promise.withResolvers<void>();

		const reason = await teardownWithin(() => hung.promise, MIN_TEARDOWN_GRACE_MS);

		expect(reason).toBe(`teardown did not finish within ${MIN_TEARDOWN_GRACE_MS}ms`);
		hung.resolve();
	});

	it("reports what a teardown threw instead of letting it reach the caller", async () => {
		const reason = await teardownWithin(async () => {
			throw new Error("dispose closed a socket twice");
		});

		expect(reason).toBe("dispose closed a socket twice");
	});

	it("reports a teardown that threw before it returned a promise", async () => {
		const reason = await teardownWithin(() => {
			throw new Error("no session to dispose");
		});

		expect(reason).toBe("no session to dispose");
	});

	it("does not let an abandoned teardown's later rejection escape", async () => {
		const hung = Promise.withResolvers<void>();

		const reason = await teardownWithin(() => hung.promise, MIN_TEARDOWN_GRACE_MS);
		// The teardown fails long after it was abandoned. A promise with no handler would take the
		// process down with an unhandled rejection instead of finishing the run.
		hung.reject(new Error("socket closed after the trial was recorded"));
		await hung.promise.catch(() => {});

		expect(reason).toBe(`teardown did not finish within ${MIN_TEARDOWN_GRACE_MS}ms`);
	});

	it("clamps a stated grace into its bounds and defaults when none is stated", () => {
		expect(teardownGraceFromOptions(undefined)).toBe(TEARDOWN_GRACE_MS);
		expect(teardownGraceFromOptions({})).toBe(TEARDOWN_GRACE_MS);
		expect(teardownGraceFromOptions({ teardownGraceMs: "500" })).toBe(TEARDOWN_GRACE_MS);
		expect(teardownGraceFromOptions({ teardownGraceMs: Number.POSITIVE_INFINITY })).toBe(TEARDOWN_GRACE_MS);
		expect(teardownGraceFromOptions({ teardownGraceMs: 500 })).toBe(500);
		expect(teardownGraceFromOptions({ teardownGraceMs: 0 })).toBe(MIN_TEARDOWN_GRACE_MS);
		expect(teardownGraceFromOptions({ teardownGraceMs: -9 })).toBe(MIN_TEARDOWN_GRACE_MS);
		expect(teardownGraceFromOptions({ teardownGraceMs: 900_000 })).toBe(MAX_TEARDOWN_GRACE_MS);
		// Pinned as literals: every assertion above reads the constants, so a default that drifted
		// to ten minutes would leave this file green while one hung client held a worker that long.
		expect(TEARDOWN_GRACE_MS).toBe(30_000);
		expect(MAX_TEARDOWN_GRACE_MS).toBe(300_000);
	});
});

describe("an in-process trial whose client will not dispose", () => {
	// The backend resolves the trial's model through the harness the variant names, so the registry
	// has to hold the builtin adapters. Registration is idempotent and process-wide.
	beforeAll(() => {
		registerBuiltinHarnesses();
	});

	async function runTrialWith(dispose: () => Promise<void>): Promise<Record<string, unknown>> {
		const tempDir = await TempDir.create("@evals-test-teardown-");
		try {
			const configFile = tempDir.join("arm.yml");
			await fs.writeFile(configFile, "argot:\n  enabled: false\n");
			const backend = new InProcessBackend({ clientFactory: () => probeClient(dispose) });
			const variant: Variant = {
				name: "teardown-arm",
				harness: "veyyon",
				configPath: configFile,
				promptVariantPath: null,
				model: "anthropic/claude-sonnet-4-6",
				attachments: [],
			};
			const context: RunContext = {
				runId: "teardown-run",
				suite: probeSuite(),
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
				options: { variants: [variant], teardownGraceMs: MIN_TEARDOWN_GRACE_MS },
			};
			const cell: TrialCell = { suite: "teardown-probe", variant: "teardown-arm", task: "task-1", repeat: 1 };
			const artifacts = await backend.runTrial(cell, context);
			return (artifacts.extra ?? {}) as Record<string, unknown>;
		} finally {
			await tempDir.remove();
		}
	}

	it("records the trial it already scored instead of waiting for the teardown", async () => {
		const hung = Promise.withResolvers<void>();

		const extra = await runTrialWith(() => hung.promise);

		expect(extra.teardownReason).toBe(`teardown did not finish within ${MIN_TEARDOWN_GRACE_MS}ms`);
		// The trial's own outcome is untouched by its teardown.
		expect(extra.error).toBeNull();
		expect(extra.timedOut).toBe(false);
		hung.resolve();
	});

	it("records what a failing teardown reported, and still scores the trial", async () => {
		const extra = await runTrialWith(async () => {
			throw new Error("mcp child refused to stop");
		});

		expect(extra.teardownReason).toBe("mcp child refused to stop");
		expect(extra.error).toBeNull();
	});

	it("reports no teardown reason when the client disposes", async () => {
		let disposed = false;

		const extra = await runTrialWith(async () => {
			disposed = true;
		});

		expect(disposed).toBe(true);
		expect(extra.teardownReason).toBeNull();
	});
});
