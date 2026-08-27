/**
 * WHY: the pier backend derived its output directory as `workDir/runs` while harbor and
 * in-process read `context.runsDir`. A run given `--runs-dir` therefore split in two: the
 * journal and the record landed where the run named, while the configs, the jobs and the
 * staged binary landed under the checkout. On a host that mounts the checkout over the
 * network there was no way to keep staging off that mount, and staging a 280 MB binary
 * from one NFS path to another stalled in the kernel's server-side copy, so the run hung
 * before its first trial with no output and no error.
 *
 * CLASS: a backend writing its run's output somewhere other than the directory the run
 * names. The sweep enumerates the backend registry at run time, so a fourth backend that
 * hardcodes a path turns this suite red without anyone editing it.
 *
 * NOT CAUGHT: where pier's own subprocess writes once it is running. This asserts the
 * directories the backend creates and the config path it writes; the trial's container
 * output is pier's to place, and no container starts here.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerAllBackends } from "../../src/backends/index";
import { PierExecutionBackend } from "../../src/backends/pier/backend";
import * as pierRunner from "../../src/backends/pier/runner";
import { listBackends } from "../../src/core/backend-registry";
import type { EvalSuite, RunContext, TrialCell } from "../../src/core/types";
import { registerBuiltinHarnesses } from "../../src/harnesses/index";

const RUN_ID = "where-the-run-says";

function stubSuite(): EvalSuite {
	return {
		name: "runs-dir-suite",
		version: "1.0.0",
		displayName: "Runs dir",
		description: "Stub suite for the output-directory sweep.",
		backend: "pier",
		async discoverTasks() {
			return ["place-the-output"];
		},
		async describeTask(taskId: string) {
			return {
				id: taskId,
				path: "/dataset/place-the-output",
				timeBudgetSec: 600,
				instructionPath: null,
				metadata: {},
			};
		},
		async provenance() {
			return { suite: "runs-dir-suite", version: "1.0.0", sha: "stub" };
		},
		async scoreTrial() {
			return { reward: 0, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

let runsDir = "";
let workDir = "";

function contextFor(overrides: Partial<RunContext> = {}): RunContext {
	return {
		runId: RUN_ID,
		suite: stubSuite(),
		workDir,
		runsDir,
		// `install: published` keeps harbor's prepare off the source-dependency path, which
		// builds a checkout. The sweep is about where output lands, not about a build.
		options: { variants: [], install: "published", envType: "docker" },
		...overrides,
	};
}

/** Every path under `dir`, relative to it. */
function entriesUnder(dir: string): readonly string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map(entry => entry.replaceAll(path.sep, "/"))
		.sort();
}

describe("a backend writes where the run says", () => {
	beforeAll(() => {
		registerBuiltinHarnesses();
		registerAllBackends();
	});

	beforeEach(() => {
		runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-runsdir-out-"));
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-runsdir-work-"));
	});

	afterEach(() => {
		fs.rmSync(runsDir, { recursive: true, force: true });
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("creates nothing under the working directory, for every registered backend", async () => {
		const backends = listBackends();
		expect(backends.length).toBeGreaterThan(0);

		const offenders: string[] = [];
		for (const backend of backends) {
			// A backend whose preparation cannot complete here — a missing binary, an absent
			// docker daemon — still must not have placed anything under the working directory
			// on the way to failing.
			await backend.prepare(contextFor()).catch(() => {});
			const strays = entriesUnder(workDir);
			if (strays.length > 0) offenders.push(`${backend.id}: ${strays.join(", ")}`);
			fs.rmSync(workDir, { recursive: true, force: true });
			fs.mkdirSync(workDir, { recursive: true });
		}

		expect(offenders).toEqual([]);
	});

	it("puts pier's configs, jobs and assets under the named directory", async () => {
		const backend = new PierExecutionBackend();

		await backend.prepare(contextFor()).catch(() => {});

		const created = entriesUnder(runsDir);
		expect(created).toContain(`${RUN_ID}/configs`);
		expect(created).toContain(`${RUN_ID}/jobs`);
		expect(created).toContain(`${RUN_ID}/assets`);
		expect(entriesUnder(workDir)).toEqual([]);
	});

	it("writes a trial's pier config under the named directory, not the checkout", async () => {
		const cell: TrialCell = {
			variant: "baseline",
			suite: "runs-dir-suite",
			task: "place-the-output",
			repeat: 1,
		};
		const context = contextFor({
			options: {
				variants: [
					{
						name: "baseline",
						harness: "veyyon",
						configPath: null,
						promptVariantPath: null,
						attachments: [],
						model: "vendor/model-x",
					},
				],
				install: "published",
			},
		});

		const runStub = spyOn(pierRunner, "runPierTrial").mockResolvedValue({
			exitCode: 0,
			stdout: "",
			stderr: "",
			trialDirPath: path.join(runsDir, RUN_ID, "jobs", "job"),
			durationMs: 1,
			timedOut: false,
			error: null,
		});
		const artifactsStub = spyOn(pierRunner, "trialArtifactsFromExecution").mockReturnValue({
			logPaths: [],
			trialDir: path.join(runsDir, RUN_ID, "jobs", "job"),
		});
		try {
			const backend = new PierExecutionBackend();
			await backend.runTrial(cell, context).catch(() => {});

			const configs = entriesUnder(path.join(runsDir, RUN_ID, "configs"));
			expect(configs.length).toBe(1);
			expect(configs[0]?.endsWith(".yaml")).toBe(true);
			expect(entriesUnder(workDir)).toEqual([]);
		} finally {
			runStub.mockRestore();
			artifactsStub.mockRestore();
		}
	});

	it("falls back to the package's own runs directory only when the run names none", async () => {
		const backend = new PierExecutionBackend();

		// An empty string is what a caller that forgot the option passes, and it must not
		// resolve to the working directory.
		await backend.prepare(contextFor({ runsDir: "" })).catch(() => {});

		expect(entriesUnder(workDir)).toEqual([]);
	});
});
