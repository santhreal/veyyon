/**
 * WHY: the entrypoint parsed every run option into one bag, handed that bag to the
 * dry-run preflight, and then handed `executeRun` a fresh object holding only
 * `datasetDir`. So on a real run a backend saw none of it. `--vey-binary` fell back to
 * the checkout's own build, which made a run comparing two builds measure one build
 * twice under two arm names; `--trial-timeout`, `--agent-timeout`,
 * `--timeout-multiplier` and `--attempts` changed nothing. A dry run reported `ok` for
 * the same invocation, because that path built its own context correctly.
 *
 * CLASS: an option parsed at the entrypoint never reaches the party that reads it. The
 * parity assertion below derives its key set from `suiteContext` at run time, so a new
 * option added to the bag and not forwarded to the run turns this suite red without
 * anyone editing it.
 *
 * NOT CAUGHT: whether a backend then honors a value it received. Pier's own handling of
 * `override_timeout_sec` runs out of process and is not exercised here, and neither is
 * the real pier or harbor backend: this drives a probe backend so the assertion is about
 * the entrypoint's plumbing and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, parseEvalsArgs, suiteContext } from "../../src/cli";
import { registerBackend, unregisterBackend } from "../../src/core/backend-registry";
import { registerHarness, unregisterHarness } from "../../src/core/harness-registry";
import { registerSuite, unregisterSuite } from "../../src/core/suite-registry";
import type { EvalSuite, ExecutionBackend, HarnessAdapter, RunContext } from "../../src/core/types";

const SUITE = "option-parity-suite";
const BACKEND = "option-parity-backend";
const HARNESS = "option-parity-harness";

/** Every `context.options` bag the probe backend was handed, in call order. */
const seen: { prepare: Record<string, unknown>[]; runTrial: Record<string, unknown>[] } = {
	prepare: [],
	runTrial: [],
};

function probeSuite(): EvalSuite {
	return {
		name: SUITE,
		version: "1.0.0",
		displayName: "Option parity",
		description: "Probe suite that runs one scored cell against a probe backend.",
		backend: BACKEND,
		async discoverTasks() {
			return ["task-1"];
		},
		async describeTask(taskId: string) {
			return { id: taskId, path: null, timeBudgetSec: 60, instructionPath: null, metadata: {} };
		},
		async provenance() {
			return { suite: SUITE, version: "1.0.0", sha: "probe" };
		},
		async scoreTrial() {
			return { reward: 1, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

function probeHarness(): HarnessAdapter {
	return {
		name: HARNESS,
		displayName: "Option parity harness",
		description: "Probe harness bound to the probe backend.",
		flags: ["vey-binary"],
		defaultModel: null,
		capabilities: { replay: false, compaction: false, armAttachments: false, promptOverrides: false },
		backends: { [BACKEND]: { agentImportPath: "probe_agent:ProbeAgent" } },
		async preflight() {
			return { ok: true };
		},
		async stageAssets() {},
	};
}

function probeBackend(): ExecutionBackend {
	return {
		id: BACKEND,
		appliesVariantAxes: [],
		async preflight() {
			return { ok: true };
		},
		async prepare(context: RunContext) {
			seen.prepare.push({ ...context.options });
		},
		async runTrial(cell, context: RunContext) {
			seen.runTrial.push({ ...context.options });
			return { logPaths: [], trialDir: path.join(context.runsDir, "probe", cell.task) };
		},
		async cleanup() {},
	};
}

let runsDir = "";

/** The invocation under test, minus the runs directory, which is per-test. */
function argvFor(extra: readonly string[]): readonly string[] {
	return [
		"--suite",
		SUITE,
		"--harness",
		HARNESS,
		"--model",
		"vendor/model-x",
		"--tasks",
		"task-1",
		"--runs-dir",
		runsDir,
		...extra,
	];
}

describe("every option the CLI parses reaches the running trial", () => {
	beforeEach(() => {
		seen.prepare.length = 0;
		seen.runTrial.length = 0;
		runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-option-parity-"));
		registerSuite(probeSuite());
		registerHarness(probeHarness());
		registerBackend(probeBackend());
	});

	afterEach(() => {
		unregisterSuite(SUITE);
		unregisterHarness(HARNESS);
		unregisterBackend(BACKEND);
		fs.rmSync(runsDir, { recursive: true, force: true });
	});

	it("hands the trial every key the entrypoint put in the run's option bag", async () => {
		const extra = [
			"--vey-binary",
			"/probe/bin/vey",
			"--trial-timeout",
			"777",
			"--agent-timeout",
			"1080",
			"--timeout-multiplier",
			"1.5",
			"--attempts",
			"3",
		];
		const argv = argvFor(extra);
		const args = parseEvalsArgs(argv);
		const expected = suiteContext(args, probeSuite()).options ?? {};
		// A bag that came back empty would make every assertion below vacuous.
		expect(Object.keys(expected).length).toBeGreaterThan(5);

		const code = await main(argv);
		expect(code).toBe(0);
		expect(seen.runTrial.length).toBe(1);

		const delivered = seen.runTrial[0] ?? {};
		// Derived from the bag at run time: a key the entrypoint parses and does not forward
		// fails here by default.
		const missing = Object.keys(expected).filter(key => !(key in delivered));
		expect(missing).toEqual([]);
		for (const [key, value] of Object.entries(expected)) {
			expect(delivered[key]).toEqual(value);
		}
		// `prepare` stages assets off the same bag, so it reads the same keys.
		expect(Object.keys(expected).filter(key => !(key in (seen.prepare[0] ?? {})))).toEqual([]);
	});

	it("delivers the named build, not the checkout's own, to a run comparing two builds", async () => {
		const code = await main(argvFor(["--vey-binary", "/probe/bin/vey-unified-search"]));

		expect(code).toBe(0);
		expect(seen.runTrial[0]?.["vey-binary"]).toBe("/probe/bin/vey-unified-search");
	});

	it("delivers the agent bound under the name the pier backend reads", async () => {
		const code = await main(argvFor(["--agent-timeout", "1080"]));

		expect(code).toBe(0);
		expect(seen.runTrial[0]?.agentTimeoutSec).toBe(1080);
	});

	it("omits an option nobody asked for rather than delivering it empty", async () => {
		const code = await main(argvFor([]));

		expect(code).toBe(0);
		const delivered = seen.runTrial[0] ?? {};
		expect("agentTimeoutSec" in delivered).toBe(false);
		expect("trialTimeoutSec" in delivered).toBe(false);
		expect("trialAttempts" in delivered).toBe(false);
		expect("datasetDir" in delivered).toBe(false);
	});

	it("still delivers the dataset directory the run's own validation reads", async () => {
		const datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-option-parity-ds-"));
		try {
			const code = await main(argvFor(["--dataset-dir", datasetDir]));

			expect(code).toBe(0);
			expect(seen.runTrial[0]?.datasetDir).toBe(datasetDir);
		} finally {
			fs.rmSync(datasetDir, { recursive: true, force: true });
		}
	});

	it("names the variants the plan built alongside the parsed options", async () => {
		const code = await main(argvFor(["--agent-timeout", "1080"]));

		expect(code).toBe(0);
		const variants = seen.runTrial[0]?.variants;
		expect(Array.isArray(variants)).toBe(true);
		expect((variants as readonly { harness: string }[])[0]?.harness).toBe(HARNESS);
	});
});
