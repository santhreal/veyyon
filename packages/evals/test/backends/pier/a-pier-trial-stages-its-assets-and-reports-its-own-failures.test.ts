import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pierBackend } from "../../../backends/pier/main";
import {
	checkPierPreflight,
	cleanupPierContainers,
	trialArtifactsFromExecution,
	writePierJobConfig,
} from "../../../backends/pier/runner";
import type { EvalSuite, RunContext, SuiteProvenance, TaskDescriptor, TrialScore } from "../../../engine/contracts";
import { backends, harnesses } from "../../../engine/loaded-members";
import { boundRawOutput } from "../../../engine/trial-deadline";
import { terminateProcessTree } from "../../../engine/trial-process";

function createMockSuite(): EvalSuite {
	return {
		id: "mock-pier-suite",
		version: "1.0.0",
		displayName: "Mock Pier Suite",
		description: "Mock Pier Suite Description",
		backend: "pier",
		async discoverTasks(): Promise<readonly string[]> {
			return ["task-1"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: `/tmp/mock-tasks/${taskId}`,
				timeBudgetSec: 300,
				instructionPath: null,
				metadata: {},
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "mock-pier-suite", version: "1.0.0" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: 1, partial: 1, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

describe("Pier ExecutionBackend", () => {
	it("satisfies ExecutionBackend contract with id 'pier'", () => {
		expect(pierBackend.id).toBe("pier");
		expect(typeof pierBackend.preflight).toBe("function");
		expect(typeof pierBackend.prepare).toBe("function");
		expect(typeof pierBackend.runTrial).toBe("function");
		expect(typeof pierBackend.cleanup).toBe("function");
	});

	it("resolves from backend registry via require('pier')", () => {
		expect(backends.has("pier")).toBe(true);
		const backend = backends.require("pier");
		expect(backend).toBe(pierBackend);
	});

	it("writes valid pier job yaml configuration", () => {
		const tmpDir = path.join(os.tmpdir() === "/tmp" ? "packages/evals/runs" : os.tmpdir(), `pier-test-${Date.now()}`);
		const configDir = path.join(tmpDir, "configs");

		const configPath = writePierJobConfig({
			jobName: "test-arm__test-task__r1",
			jobsDir: path.join(tmpDir, "jobs"),
			taskPath: "/path/to/task",
			agentImportPath: "veyyon_agent:VeyyonAgent",
			modelName: "test-model",
			kwargs: {
				arm_name: "test-arm",
				assets_dir: "/path/to/assets",
			},
			configDir,
		});

		expect(fs.existsSync(configPath)).toBe(true);
		const content = fs.readFileSync(configPath, "utf8");
		expect(content).toContain('job_name: "test-arm__test-task__r1"');
		expect(content).toContain("import_path: veyyon_agent:VeyyonAgent");
		expect(content).toContain('model_name: "test-model"');

		// Clean up
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("extracts trial artifacts from execution result", () => {
		const artifacts = trialArtifactsFromExecution(null, {
			exitCode: 0,
			stdout: "success log",
			stderr: "",
			trialDirPath: null,
			durationMs: 1234,
			timedOut: false,
			error: null,
		});

		expect(artifacts.trialDir).toBeNull();
		expect(artifacts.rawOutput).toBe("success log");
		expect(artifacts.extra?.durationMs).toBe(1234);
	});
	it("checkPierPreflight returns PreflightVerdict", () => {
		const verdict = checkPierPreflight({});
		expect(typeof verdict.ok).toBe("boolean");
	});

	it("cleanupPierContainers scopes cleanup to exact jobName without pruning or substring match", async () => {
		const commandsIssued: Array<{ file: string; args: readonly string[] }> = [];
		const fakeExec = async (file: string, args: readonly string[]) => {
			commandsIssued.push({ file, args });
			if (file === "docker" && args[0] === "ps") {
				return {
					stdout: [
						"c_target\trun1__var1__task1__r0-agent-1\trun1__var1__task1__r0",
						"c_sibling\trun1__var1__task2__r0-agent-1\trun1__var1__task2__r0",
						"c_substring\tprefix-run1__var1__task1__r0-other\tother_proj",
					].join("\n"),
					stderr: "",
				};
			}
			if (file === "docker" && args[0] === "network" && args[1] === "ls") {
				return {
					stdout: [
						"net_target\trun1__var1__task1__r0_default\trun1__var1__task1__r0",
						"net_sibling\trun1__var1__task2__r0_default\trun1__var1__task2__r0",
					].join("\n"),
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		};

		await cleanupPierContainers("run1__var1__task1__r0", fakeExec);

		// Verify prune was never called
		for (const cmd of commandsIssued) {
			expect(cmd.args).not.toContain("prune");
		}

		// Verify target container was removed, but not sibling or substring container
		const rmCmd = commandsIssued.find(c => c.args[0] === "rm");
		expect(rmCmd).toBeDefined();
		expect(rmCmd?.args).toEqual(["rm", "-f", "c_target"]);

		// Verify target network was removed, but not sibling network
		const netRmCmd = commandsIssued.find(c => c.args[0] === "network" && c.args[1] === "rm");
		expect(netRmCmd).toBeDefined();
		expect(netRmCmd?.args).toEqual(["network", "rm", "net_target"]);
	});

	it("terminateProcessTree escalates to SIGKILL after grace period", async () => {
		const signals: string[] = [];
		const { promise: exited, resolve } = Promise.withResolvers<number>();

		const fakeProc = {
			pid: 888888,
			kill(sig?: "SIGTERM" | "SIGKILL" | number) {
				signals.push(String(sig));
				if (sig === "SIGKILL") {
					resolve(137);
				}
			},
			exited,
		};

		const start = Date.now();
		await terminateProcessTree(fakeProc, 40);
		const elapsed = Date.now() - start;

		expect(signals).toContain("SIGTERM");
		expect(signals).toContain("SIGKILL");
		expect(elapsed).toBeGreaterThanOrEqual(30);
	});

	it("prepare and run names/directories include runId to prevent concurrent run collisions", async () => {
		const tmpRoot = path.join(
			os.tmpdir() === "/tmp" ? "packages/evals/runs" : os.tmpdir(),
			`pier-runid-${Date.now()}`,
		);
		// Distinct directories, because the run's output belongs under the one it names: with
		// both set to the same root, a backend deriving the path from either passed.
		const outRoot = path.join(tmpRoot, "out");
		const checkout = path.join(tmpRoot, "checkout");
		try {
			const contextA: RunContext = {
				runId: "run_alpha",
				suite: createMockSuite(),
				workDir: checkout,
				runsDir: outRoot,
				harnesses,
			};
			const contextB: RunContext = {
				runId: "run_beta",
				suite: createMockSuite(),
				workDir: checkout,
				runsDir: outRoot,
				harnesses,
			};

			await pierBackend.prepare(contextA);
			await pierBackend.prepare(contextB);

			expect(fs.existsSync(path.join(outRoot, "run_alpha", "jobs"))).toBe(true);
			expect(fs.existsSync(path.join(outRoot, "run_beta", "jobs"))).toBe(true);
			expect(fs.existsSync(path.join(checkout, "runs"))).toBe(false);
		} finally {
			try {
				fs.rmSync(tmpRoot, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("rawOutput tail is bounded by boundRawOutput", () => {
		const huge = "A".repeat(100000);
		expect(boundRawOutput(huge, 65536)?.length).toBe(65536);
	});
});
