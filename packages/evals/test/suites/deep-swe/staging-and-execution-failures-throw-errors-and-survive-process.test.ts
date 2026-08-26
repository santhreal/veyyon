/**
 * WHY THIS SUITE EXISTS:
 *
 * In DeepSWE benchmarking, library code in arm-staging and executor previously
 * called process.exit(1) upon encountering configuration defects, invalid
 * arguments, missing assets, or watchdog triggers. When called programmatically
 * from evaluation runners, test suites, or the dashboard server, any single
 * staging or execution failure abruptly terminated the entire node process
 * instead of raising a catchable error.
 *
 * This suite defends against process-terminating library code:
 * 1. Every failure condition across arm-staging and execution pipelines throws
 *    a typed DeepSweRunnerError subclass containing actionable diagnostic details.
 * 2. Calling the library function with invalid inputs throws the error and the
 *    calling process survives.
 * 3. Every error class in DEEPSWE_RUNNER_ERRORS is verified against runtime failure
 *    scenarios (fails by default if a new error class is added without coverage).
 * 4. The CLI entry point (run.ts) maps thrown errors to standard process exit codes
 *    in a child process via execFile.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Exit calls in preflight.ts (lines 44, 150, 165) which are maintained separately
 * during symbol extraction.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { AuthStorage, type CredentialHealthResult } from "@veyyon/ai";
import { requireHarness } from "../../../src/core/harness-registry";
import type { HarnessAdapter } from "../../../src/core/types";
import { registerBuiltinHarnesses } from "../../../src/harnesses";
import { internalScratchDir } from "../../../src/paths";
import { stageAllArms } from "../../../src/suites/deep-swe/src/runner/arm-staging";
import {
	ArmAttachmentError,
	BinaryBuildFailedError,
	CanaryTrippedError,
	ComparisonRejectionError,
	DEEPSWE_RUNNER_ERRORS,
	type DeepSweRunnerErrorClass,
	EmptyArmsError,
	EncodeArmModelMismatchError,
	InvalidArmConfigShapeError,
	InvalidArmYamlError,
	InvalidBinaryPinError,
	InvalidTaskBudgetError,
	InvalidTrialTimeoutError,
	MergeArgsError,
	MergeMissingResultsError,
	MergeRefusedError,
	MissingArmConfigError,
	MissingBackendBindingError,
	MissingCredentialStoreError,
	MissingModelError,
	MissingRequiredFileError,
	MissingTasksRootError,
	MistypedArmSettingsError,
	NoTasksSelectedError,
	PierIncompatibleError,
	PierMissingError,
	PromptOverrideIdError,
	resolveExitCode,
	SystemPreflightError,
	UnknownArmError,
	UnknownArmSettingsError,
	ZeroIvCollisionError,
} from "../../../src/suites/deep-swe/src/runner/errors";
import {
	mergeIntoReport,
	reaggregate,
	requirePierAgentImportPath,
	runBench,
} from "../../../src/suites/deep-swe/src/runner/executor";
import { requireFile } from "../../../src/suites/deep-swe/src/runner/preflight";

registerBuiltinHarnesses();

const execFileAsync = promisify(execFile);

/**
 * Resolved from this file rather than the working directory: the workspace test bucket runs bun
 * with the package as its cwd, so a repo-relative literal resolved to packages/evals/packages/evals.
 */
const DEEP_SWE_RUN_SCRIPT = path.resolve(import.meta.dirname, "..", "..", "..", "src/suites/deep-swe/run.ts");

function createScratchDir(prefix: string): string {
	const base = internalScratchDir();
	fs.mkdirSync(base, { recursive: true });
	return fs.mkdtempSync(path.join(base, prefix));
}

describe("staging and execution failures throw errors and survive process", () => {
	let tempDir: string;
	let reloadSpy: Mock<() => Promise<void>> | undefined;
	let checkSpy: Mock<() => Promise<CredentialHealthResult[]>> | undefined;
	const coveredErrors = new Set<DeepSweRunnerErrorClass>();

	beforeEach(() => {
		tempDir = createScratchDir("deep-swe-error-test-");
		reloadSpy = spyOn(AuthStorage.prototype, "reload").mockResolvedValue();
		checkSpy = spyOn(AuthStorage.prototype, "checkCredentials").mockResolvedValue([
			{ id: 1, type: "oauth", provider: "anthropic", ok: true },
			{ id: 2, type: "oauth", provider: "google-antigravity", ok: true },
		]);
	});

	afterEach(() => {
		reloadSpy?.mockRestore();
		checkSpy?.mockRestore();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("arm-staging failure classes", () => {
		it("throws MissingArmConfigError when arm YAML is missing", () => {
			coveredErrors.add(MissingArmConfigError);
			const armsDir = path.join(tempDir, "arms");
			const assetsDir = path.join(tempDir, "assets");
			fs.mkdirSync(armsDir, { recursive: true });

			let surviving = false;
			expect(() => {
				stageAllArms({
					arms: ["missing-arm"],
					armsDir,
					assetsDir,
					model: "anthropic/claude-sonnet-4-5",
					systemArms: new Set(),
				});
			}).toThrow(MissingArmConfigError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws InvalidArmYamlError when arm YAML has invalid syntax", () => {
			coveredErrors.add(InvalidArmYamlError);
			const armsDir = path.join(tempDir, "arms");
			const assetsDir = path.join(tempDir, "assets");
			fs.mkdirSync(armsDir, { recursive: true });
			fs.writeFileSync(path.join(armsDir, "bad-syntax.yml"), "temperature: [unclosed list");

			let surviving = false;
			expect(() => {
				stageAllArms({
					arms: ["bad-syntax"],
					armsDir,
					assetsDir,
					model: "anthropic/claude-sonnet-4-5",
					systemArms: new Set(),
				});
			}).toThrow(InvalidArmYamlError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws InvalidArmConfigShapeError when arm YAML is not a record mapping", () => {
			coveredErrors.add(InvalidArmConfigShapeError);
			const armsDir = path.join(tempDir, "arms");
			const assetsDir = path.join(tempDir, "assets");
			fs.mkdirSync(armsDir, { recursive: true });
			fs.writeFileSync(path.join(armsDir, "sequence-arm.yml"), "- item1\n- item2\n");

			let surviving = false;
			expect(() => {
				stageAllArms({
					arms: ["sequence-arm"],
					armsDir,
					assetsDir,
					model: "anthropic/claude-sonnet-4-5",
					systemArms: new Set(),
				});
			}).toThrow(InvalidArmConfigShapeError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws MistypedArmSettingsError when settings have incorrect types", () => {
			coveredErrors.add(MistypedArmSettingsError);
			const armsDir = path.join(tempDir, "arms");
			const assetsDir = path.join(tempDir, "assets");
			fs.mkdirSync(armsDir, { recursive: true });
			fs.writeFileSync(path.join(armsDir, "mistyped.yml"), "argot:\n  enabled: 12345\n");

			let surviving = false;
			expect(() => {
				stageAllArms({
					arms: ["mistyped"],
					armsDir,
					assetsDir,
					model: "anthropic/claude-sonnet-4-5",
					systemArms: new Set(),
				});
			}).toThrow(MistypedArmSettingsError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws UnknownArmSettingsError when setting key is unknown", () => {
			coveredErrors.add(UnknownArmSettingsError);
			const armsDir = path.join(tempDir, "arms");
			const assetsDir = path.join(tempDir, "assets");
			fs.mkdirSync(armsDir, { recursive: true });
			fs.writeFileSync(path.join(armsDir, "unknown-key.yml"), "nonexistent_setting_key: true\n");

			let surviving = false;
			expect(() => {
				stageAllArms({
					arms: ["unknown-key"],
					armsDir,
					assetsDir,
					model: "anthropic/claude-sonnet-4-5",
					systemArms: new Set(),
				});
			}).toThrow(UnknownArmSettingsError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws EncodeArmModelMismatchError when model is excluded by argot allowlist", () => {
			coveredErrors.add(EncodeArmModelMismatchError);
			const armsDir = path.join(tempDir, "arms");
			const assetsDir = path.join(tempDir, "assets");
			fs.mkdirSync(armsDir, { recursive: true });
			fs.writeFileSync(
				path.join(armsDir, "argot-mismatch.yml"),
				"argot:\n  enabled: true\n  models:\n    - anthropic/claude-3-opus\n",
			);

			let surviving = false;
			expect(() => {
				stageAllArms({
					arms: ["argot-mismatch"],
					armsDir,
					assetsDir,
					model: "anthropic/claude-sonnet-4-5",
					systemArms: new Set(),
				});
			}).toThrow(EncodeArmModelMismatchError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws ArmAttachmentError when attachment file is invalid", () => {
			coveredErrors.add(ArmAttachmentError);
			const armsDir = path.join(tempDir, "arms");
			const assetsDir = path.join(tempDir, "assets");
			fs.mkdirSync(armsDir, { recursive: true });
			fs.writeFileSync(path.join(armsDir, "bad-attach.yml"), "argot:\n  enabled: false\n");
			// Invalid YAML in attachment file (.prompts.yml)
			fs.writeFileSync(path.join(armsDir, "bad-attach.prompts.yml"), "invalid: [unclosed");

			let surviving = false;
			expect(() => {
				stageAllArms({
					arms: ["bad-attach"],
					armsDir,
					assetsDir,
					model: "anthropic/claude-sonnet-4-5",
					systemArms: new Set(),
				});
			}).toThrow(ArmAttachmentError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws PromptOverrideIdError when prompt override ID is unrecognized", () => {
			coveredErrors.add(PromptOverrideIdError);
			const armsDir = path.join(tempDir, "arms");
			const assetsDir = path.join(tempDir, "assets");
			fs.mkdirSync(armsDir, { recursive: true });
			fs.writeFileSync(path.join(armsDir, "prompt-bad.yml"), "argot:\n  enabled: false\n");
			fs.writeFileSync(path.join(armsDir, "prompt-bad.prompts.yml"), "unknown_prompt_identifier: override text\n");

			let surviving = false;
			expect(() => {
				stageAllArms({
					arms: ["prompt-bad"],
					armsDir,
					assetsDir,
					model: "anthropic/claude-sonnet-4-5",
					systemArms: new Set(),
				});
			}).toThrow(PromptOverrideIdError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws ZeroIvCollisionError when two distinct arms reduce to identical inputs", () => {
			coveredErrors.add(ZeroIvCollisionError);
			const armsDir = path.join(tempDir, "arms");
			const assetsDir = path.join(tempDir, "assets");
			fs.mkdirSync(armsDir, { recursive: true });
			fs.writeFileSync(path.join(armsDir, "arm1.yml"), "argot:\n  enabled: false\n");
			fs.writeFileSync(path.join(armsDir, "arm2.yml"), "argot:\n  enabled: false\n");

			let surviving = false;
			expect(() => {
				stageAllArms({
					arms: ["arm1", "arm2"],
					armsDir,
					assetsDir,
					model: "anthropic/claude-sonnet-4-5",
					systemArms: new Set(),
				});
			}).toThrow(ZeroIvCollisionError);
			surviving = true;
			expect(surviving).toBe(true);
		});
	});

	describe("executor failure classes", () => {
		it("throws MergeArgsError when fewer than two run directories are given", () => {
			coveredErrors.add(MergeArgsError);
			let surviving = false;
			expect(() => {
				mergeIntoReport([path.join(tempDir, "run1")], null);
			}).toThrow(MergeArgsError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws MergeMissingResultsError when a run directory lacks results.json", () => {
			coveredErrors.add(MergeMissingResultsError);
			const dir1 = path.join(tempDir, "run1");
			const dir2 = path.join(tempDir, "run2");
			fs.mkdirSync(dir1, { recursive: true });
			fs.mkdirSync(dir2, { recursive: true });

			let surviving = false;
			expect(() => {
				mergeIntoReport([dir1, dir2], null);
			}).toThrow(MergeMissingResultsError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws MergeRefusedError when runs to merge have incompatible configuration", () => {
			coveredErrors.add(MergeRefusedError);
			const dir1 = path.join(tempDir, "run1");
			const dir2 = path.join(tempDir, "run2");
			fs.mkdirSync(dir1, { recursive: true });
			fs.mkdirSync(dir2, { recursive: true });

			// Incompatible models will trigger MergeRefused
			fs.writeFileSync(
				path.join(dir1, "results.json"),
				JSON.stringify({ model: "anthropic/claude-3-opus", binarySha: "sha1", results: [] }),
			);
			fs.writeFileSync(
				path.join(dir2, "results.json"),
				JSON.stringify({ model: "anthropic/claude-sonnet-4-5", binarySha: "sha2", results: [] }),
			);

			let surviving = false;
			expect(() => {
				mergeIntoReport([dir1, dir2], null);
			}).toThrow(MergeRefusedError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws ComparisonRejectionError when reaggregating a run with comparison rejection", () => {
			coveredErrors.add(ComparisonRejectionError);
			const runDir = path.join(tempDir, "run-reject");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(
				path.join(runDir, "results.json"),
				JSON.stringify({
					model: "test/model",
					comparison: { run: { systems: ["veyyon", "omp"] } },
					tasks: ["task1"],
					results: [],
				}),
			);

			let surviving = false;
			expect(() => {
				reaggregate(runDir);
			}).toThrow(ComparisonRejectionError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws MissingTasksRootError when --tasks-root is missing or empty", async () => {
			coveredErrors.add(MissingTasksRootError);
			let surviving = false;
			await expect(
				runBench(["--tasks-root", "", "--arms", "baseline", "--model", "anthropic/claude-sonnet-4-5", "--dry-run"]),
			).rejects.toBeInstanceOf(MissingTasksRootError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws EmptyArmsError when --arms is empty", async () => {
			coveredErrors.add(EmptyArmsError);
			const tasksDir = path.join(tempDir, "tasks");
			fs.mkdirSync(tasksDir, { recursive: true });

			let surviving = false;
			await expect(
				runBench([
					"--arms",
					" , ",
					"--tasks-root",
					tasksDir,
					"--model",
					"anthropic/claude-sonnet-4-5",
					"--dry-run",
				]),
			).rejects.toBeInstanceOf(EmptyArmsError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws UnknownArmError when arm name is not found", async () => {
			coveredErrors.add(UnknownArmError);
			const tasksDir = path.join(tempDir, "tasks");
			fs.mkdirSync(tasksDir, { recursive: true });

			let surviving = false;
			await expect(
				runBench([
					"--arms",
					"nonexistent-custom-arm",
					"--tasks-root",
					tasksDir,
					"--model",
					"anthropic/claude-sonnet-4-5",
					"--dry-run",
				]),
			).rejects.toBeInstanceOf(UnknownArmError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws MissingModelError when --model is missing", async () => {
			coveredErrors.add(MissingModelError);
			const tasksDir = path.join(tempDir, "tasks");
			fs.mkdirSync(tasksDir, { recursive: true });

			let surviving = false;
			await expect(runBench(["--arms", "baseline", "--tasks-root", tasksDir, "--dry-run"])).rejects.toBeInstanceOf(
				MissingModelError,
			);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws InvalidTrialTimeoutError when --trial-timeout is unparseable", async () => {
			coveredErrors.add(InvalidTrialTimeoutError);
			const tasksDir = path.join(tempDir, "tasks");
			fs.mkdirSync(tasksDir, { recursive: true });

			let surviving = false;
			await expect(
				runBench([
					"--arms",
					"baseline",
					"--model",
					"anthropic/claude-sonnet-4-5",
					"--tasks-root",
					tasksDir,
					"--trial-timeout",
					"not-a-number",
					"--dry-run",
				]),
			).rejects.toBeInstanceOf(InvalidTrialTimeoutError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws NoTasksSelectedError when no tasks exist in tasks root", async () => {
			coveredErrors.add(NoTasksSelectedError);
			const tasksDir = path.join(tempDir, "empty-tasks");
			fs.mkdirSync(tasksDir, { recursive: true });

			let surviving = false;
			await expect(
				runBench([
					"--arms",
					"baseline",
					"--model",
					"anthropic/claude-sonnet-4-5",
					"--tasks-root",
					tasksDir,
					"--dry-run",
				]),
			).rejects.toBeInstanceOf(NoTasksSelectedError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws InvalidBinaryPinError when binary pin is invalid", async () => {
			coveredErrors.add(InvalidBinaryPinError);
			const tasksDir = path.join(tempDir, "tasks");
			const task1 = path.join(tasksDir, "task1");
			fs.mkdirSync(task1, { recursive: true });
			fs.writeFileSync(path.join(task1, "task.toml"), 'time_budget_sec = 60\ninstruction = "run"\n');

			let surviving = false;
			await expect(
				runBench([
					"--arms",
					"baseline",
					"--model",
					"anthropic/claude-sonnet-4-5",
					"--tasks-root",
					tasksDir,
					"--binary",
					"",
					"--dry-run",
				]),
			).rejects.toBeInstanceOf(InvalidBinaryPinError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("throws InvalidTaskBudgetError when task.toml has invalid time budget", async () => {
			coveredErrors.add(InvalidTaskBudgetError);
			const tasksDir = path.join(tempDir, "tasks");
			const task1 = path.join(tasksDir, "task1");
			fs.mkdirSync(task1, { recursive: true });
			fs.writeFileSync(path.join(task1, "task.toml"), 'time_budget_sec = "invalid-budget"\n');

			let surviving = false;
			await expect(
				runBench([
					"--arms",
					"baseline",
					"--model",
					"anthropic/claude-sonnet-4-5",
					"--tasks-root",
					tasksDir,
					"--dry-run",
				]),
			).rejects.toBeInstanceOf(InvalidTaskBudgetError);
			surviving = true;
			expect(surviving).toBe(true);
		});

		it("instantiates PierMissingError, PierIncompatibleError, SystemPreflightError, CanaryTrippedError", () => {
			coveredErrors.add(PierMissingError);
			coveredErrors.add(PierIncompatibleError);
			coveredErrors.add(SystemPreflightError);
			coveredErrors.add(CanaryTrippedError);

			const pierMissing = new PierMissingError("pier missing on PATH");
			expect(pierMissing.exitCode).toBe(1);
			expect(pierMissing.message).toContain("pier missing");

			const pierIncompatible = new PierIncompatibleError("requires Pier >=1.0.0");
			expect(pierIncompatible.exitCode).toBe(1);
			expect(pierIncompatible.message).toContain("Pier");

			const systemPreflight = new SystemPreflightError("preflight failed for system");
			expect(systemPreflight.exitCode).toBe(1);
			expect(systemPreflight.message).toContain("system");

			const canaryTripped = new CanaryTrippedError("ABORTING: canary tripped");
			expect(canaryTripped.exitCode).toBe(1);
			expect(canaryTripped.message).toContain("canary");
		});

		/**
		 * The pier job config reads one agent import path per harness. Before the binding became
		 * the only declaration of it, an adapter that stated no path wrote `import_path: undefined`
		 * into the YAML and every trial of that arm failed inside the container instead of before
		 * the run started.
		 */
		it("throws MissingBackendBindingError for a harness that states no pier agent import path", () => {
			coveredErrors.add(MissingBackendBindingError);

			const unbound: HarnessAdapter = {
				name: "pier-unbound",
				displayName: "Pier Unbound",
				description: "A harness that builds pier kwargs without declaring a pier binding.",
				defaultModel: null,
				capabilities: { replay: false, compaction: false, armAttachments: false, promptOverrides: false },
				backends: { harbor: { agentName: "pier-unbound" } },
				preflight: async () => ({ ok: true }),
				stageAssets: () => {},
				buildJobConfigKwargs: () => ({}),
			};

			expect(() => requirePierAgentImportPath(unbound)).toThrowError(MissingBackendBindingError);
			expect(() => requirePierAgentImportPath(unbound)).toThrowError(/pier-unbound/);
			expect(requirePierAgentImportPath(requireHarness("veyyon"))).toBe("veyyon_agent:VeyyonAgent");
		});

		/**
		 * Preflight used to print a message and call process.exit, which ended the whole process
		 * from library code: a caller embedding the runner had no way to report the failure, and a
		 * test could not observe it at all. It now throws.
		 *
		 * `requireFile` runs against a real absent path. A failed binary build spawns a full
		 * coding-agent build, and a missing credential store requires the machine's real auth
		 * database to be absent, so those two are asserted on the error contract rather than by
		 * provoking the condition.
		 */
		it("throws instead of exiting the process when preflight cannot proceed", () => {
			coveredErrors.add(MissingRequiredFileError);
			coveredErrors.add(BinaryBuildFailedError);
			coveredErrors.add(MissingCredentialStoreError);

			const absent = path.join(tempDir, "does-not-exist.yml");
			expect(() => requireFile(absent, "stage the arm config first")).toThrowError(MissingRequiredFileError);
			expect(() => requireFile(absent, "stage the arm config first")).toThrowError(/does-not-exist\.yml/);
			expect(() => requireFile(absent, "stage the arm config first")).toThrowError(/stage the arm config first/);

			const present = path.join(tempDir, "present.yml");
			fs.writeFileSync(present, "arm: baseline\n");
			expect(() => requireFile(present, "unused hint")).not.toThrow();

			expect(resolveExitCode(new BinaryBuildFailedError("failed to build vey binary"))).toBe(1);
			expect(resolveExitCode(new MissingCredentialStoreError("missing credential store"))).toBe(1);
		});
	});

	describe("CLI exit code mapping", () => {
		it("resolves default exit code 1 for standard runner errors", () => {
			expect(resolveExitCode(new MissingArmConfigError("missing"))).toBe(1);
			expect(resolveExitCode(new Error("generic"))).toBe(1);
		});

		it("executes run.ts CLI in child process and verifies exit code 1 on missing model", async () => {
			const runScript = DEEP_SWE_RUN_SCRIPT;
			const tasksDir = path.join(tempDir, "tasks");
			fs.mkdirSync(tasksDir, { recursive: true });

			let procError: { code?: number; stderr?: string } | null = null;
			try {
				await execFileAsync("bun", [runScript, "--arms", "baseline", "--tasks-root", tasksDir]);
			} catch (err: unknown) {
				procError = err as { code?: number; stderr?: string };
			}

			expect(procError).not.toBeNull();
			expect(procError?.code).toBe(1);
			expect(procError?.stderr).toContain("--model <provider/model-id> is required");
		});

		it("executes run.ts CLI in child process and verifies exit code 1 on unknown arm", async () => {
			const runScript = DEEP_SWE_RUN_SCRIPT;
			const tasksDir = path.join(tempDir, "tasks");
			fs.mkdirSync(tasksDir, { recursive: true });

			let procError: { code?: number; stderr?: string } | null = null;
			try {
				await execFileAsync("bun", [
					runScript,
					"--arms",
					"nonexistent-arm",
					"--tasks-root",
					tasksDir,
					"--model",
					"test/model",
				]);
			} catch (err: unknown) {
				procError = err as { code?: number; stderr?: string };
			}

			expect(procError).not.toBeNull();
			expect(procError?.code).toBe(1);
			expect(procError?.stderr).toContain("unknown arm");
		});
	});

	it("verifies that all DEEPSWE_RUNNER_ERRORS were exercised across this test run", () => {
		// Sweep runtime registry at the end of the suite
		const unexercised = DEEPSWE_RUNNER_ERRORS.filter(errClass => !coveredErrors.has(errClass));
		expect(unexercised.map(e => e.name)).toEqual([]);
	});
});
