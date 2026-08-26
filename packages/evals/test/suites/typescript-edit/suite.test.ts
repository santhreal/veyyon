import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { InProcessBackend, inProcessBackend, registerInProcessBackend } from "../../../src/backends/in-process/backend";
import { getBackend, requireBackend } from "../../../src/core/backend-registry";
import { getSuite, requireSuite, SuiteRegistry } from "../../../src/core/suite-registry";
import type { RunContext, TrialArtifacts, TrialCell } from "../../../src/core/types";
import {
	registerTypescriptEditSuite,
	TypescriptEditSuite,
	typescriptEditSuite,
} from "../../../src/suites/typescript-edit/suite";
import { verifyExpectedFiles } from "../../../src/suites/typescript-edit/verify";

describe("TypeScript Edit Benchmark — EvalSuite & ExecutionBackend contracts", () => {
	it("registers with global registries under 'typescript-edit' and 'in-process'", () => {
		registerTypescriptEditSuite();
		registerInProcessBackend();

		const suite = requireSuite("typescript-edit");
		expect(getSuite("typescript-edit")).toBe(typescriptEditSuite);
		expect(typescriptEditSuite).toBeInstanceOf(TypescriptEditSuite);
		expect(suite.name).toBe("typescript-edit");
		expect(suite.backend).toBe("in-process");
		expect(suite.version).toBe("1.0.0");
		expect(suite.displayName).toBe("TypeScript Edit Benchmark");

		const backend = requireBackend("in-process");
		expect(getBackend("in-process")).toBe(inProcessBackend);
		expect(inProcessBackend).toBeInstanceOf(InProcessBackend);
		expect(backend.id).toBe("in-process");
	});

	it("registration is idempotent across calls and custom registries", () => {
		// Calling multiple times should not throw
		expect(() => registerTypescriptEditSuite()).not.toThrow();
		expect(() => registerTypescriptEditSuite()).not.toThrow();
		expect(() => registerInProcessBackend()).not.toThrow();
		expect(() => registerInProcessBackend()).not.toThrow();

		const customSuiteRegistry = new SuiteRegistry();
		registerTypescriptEditSuite(customSuiteRegistry);
		expect(customSuiteRegistry.has("typescript-edit")).toBe(true);
		expect(() => registerTypescriptEditSuite(customSuiteRegistry)).not.toThrow();
	});

	it("discovers tasks from the committed fixtures archive", async () => {
		const tasks = await typescriptEditSuite.discoverTasks();
		expect(Array.isArray(tasks)).toBe(true);
		expect(tasks.length).toBeGreaterThan(0);
		expect(tasks).toContain("access-remove-optional-chain-001");

		// Option filtering by task array
		const filtered = await typescriptEditSuite.discoverTasks({
			options: { tasks: ["access-remove-optional-chain-001", "call-swap-call-args-001"] },
		});
		expect(filtered).toEqual(["access-remove-optional-chain-001", "call-swap-call-args-001"]);

		// Option limit with maxTasks
		const limited = await typescriptEditSuite.discoverTasks({
			options: { maxTasks: 3 },
		});
		expect(limited.length).toBe(3);
	});

	it("describes a fixture task with full metadata and paths", async () => {
		const descriptor = await typescriptEditSuite.describeTask("access-remove-optional-chain-001");
		expect(descriptor.id).toBe("access-remove-optional-chain-001");
		expect(descriptor.timeBudgetSec).toBe(120);
		expect(descriptor.instructionPath).toBeTruthy();
		expect(descriptor.metadata).toBeTruthy();
		expect(descriptor.metadata.name).toBe("Access Remove Optional Chain 001");
		expect(typeof descriptor.metadata.prompt).toBe("string");
		expect(Array.isArray(descriptor.metadata.files)).toBe(true);
		expect(typeof descriptor.metadata.inputDir).toBe("string");
		expect(typeof descriptor.metadata.expectedDir).toBe("string");

		// Throws on unknown task id
		await expect(typescriptEditSuite.describeTask("nonexistent-task-id-999")).rejects.toThrow(
			/TypeScript-edit task "nonexistent-task-id-999" not found/,
		);
	});

	it("computes provenance with archive identity and content hash", async () => {
		const prov = await typescriptEditSuite.provenance();
		expect(prov.suite).toBe("typescript-edit");
		expect(prov.version).toBe("1.0.0");
		expect(typeof prov.sha).toBe("string");
		expect(prov.sha).toMatch(/^[a-f0-9]{64}$/);
		expect(prov.sourceUrl).toBe("datasets/typescript-edit/fixtures.tar.gz");
		expect(prov.metadata?.contentHash).toBe(prov.sha);

		// Provenance is deterministic across repeated calls
		const prov2 = await typescriptEditSuite.provenance();
		expect(prov2.sha).toBe(prov.sha);
	});

	describe("preflight checks", () => {
		it("passes preflight on the valid fixture archive", async () => {
			const verdict = await typescriptEditSuite.preflight();
			expect(verdict.ok).toBe(true);
		});

		it("refuses with actionable message when archive is missing", async () => {
			const suite = new TypescriptEditSuite({
				defaultArchive: "/nonexistent/path/fixtures.tar.gz",
			});
			const verdict = await suite.preflight();
			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain("fixture archive is missing or unreadable");
			expect(verdict.missingRequirements).toContain("fixture-archive");
		});

		it("refuses with actionable message when archive is empty", async () => {
			const tempDir = await TempDir.create("@evals-test-empty-");
			try {
				const emptyFile = tempDir.join("empty.tar.gz");
				await fs.writeFile(emptyFile, Buffer.alloc(0));
				const suite = new TypescriptEditSuite({
					defaultArchive: emptyFile,
				});
				const verdict = await suite.preflight();
				expect(verdict.ok).toBe(false);
				expect(verdict.reason).toContain("empty (0 bytes)");
				expect(verdict.missingRequirements).toContain("fixture-archive");
			} finally {
				await tempDir.remove();
			}
		});
	});

	describe("end-to-end trial execution and scoring with in-process backend", () => {
		it("drives trial through registered backend and scores pass vs fail with verifier parity", async () => {
			const suite = requireSuite("typescript-edit");
			const backend = requireBackend("in-process");

			const taskId = "access-remove-optional-chain-001";
			const descriptor = await suite.describeTask(taskId, {});
			const expectedDir = descriptor.metadata.expectedDir as string;

			const tempRunsDir = await TempDir.create("@evals-test-runs-");

			try {
				const runContext: RunContext = {
					runId: "test-run-e2e",
					suite,
					workDir: tempRunsDir.absolute(),
					runsDir: tempRunsDir.absolute(),
					options: {
						model: "test-model",
						tools: ["read", "edit", "write"],
						variants: [
							{
								name: "veyyon-default",
								harness: "veyyon",
								configPath: null,
								promptVariantPath: null,
								model: "test-model",
								attachments: [],
							},
						],
					},
				};

				const cell: TrialCell = {
					suite: "typescript-edit",
					variant: "veyyon-default",
					task: taskId,
					repeat: 0,
				};

				// 1. Prepare backend
				await backend.prepare(runContext);

				// 2. Test passing trial: simulate model correctly producing the expected files
				const passingBackend = new InProcessBackend({
					clientFactory: options => ({
						async start() {},
						async prompt() {
							// Copy expected files to trial workspace to simulate a perfect solve
							const files = descriptor.metadata.files as string[];
							for (const file of files) {
								const src = path.join(expectedDir, file);
								const dst = path.join(options.cwd, file);
								await fs.mkdir(path.dirname(dst), { recursive: true });
								await fs.copyFile(src, dst);
							}
						},
						async getSessionStats() {
							return {
								tokens: { input: 150, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 200 },
								assistantMessages: 1,
								cost: 0.003,
							};
						},
						async getLastAssistantText() {
							return "Done applying edits.";
						},
						async dispose() {},
					}),
				});

				const passArtifacts = await passingBackend.runTrial(cell, runContext);
				expect(passArtifacts.trialDir).toBeTruthy();

				const passScore = await suite.scoreTrial(cell, passArtifacts);
				expect(passScore.reward).toBe(1);
				expect(passScore.partial).toBe(1);
				expect(passScore.error).toBeNull();
				expect(passScore.extra.success).toBe(true);
				expect(passScore.usage?.inputTokens).toBe(150);
				expect(passScore.usage?.outputTokens).toBe(50);

				// Verify exact parity with direct verifier call
				const directPassVerif = await verifyExpectedFiles(expectedDir, passArtifacts.trialDir!);
				expect(directPassVerif.success).toBe(true);
				expect(passScore.extra.success).toBe(directPassVerif.success);
				expect(passScore.extra.formattedEquivalent).toBe(directPassVerif.formattedEquivalent);

				// 3. Test failing trial with mutated output: model produces wrong content
				const failingBackend = new InProcessBackend({
					clientFactory: options => ({
						async start() {},
						async prompt() {
							// Write mutated content that does not match expected
							const files = descriptor.metadata.files as string[];
							for (const file of files) {
								const dst = path.join(options.cwd, file);
								await fs.mkdir(path.dirname(dst), { recursive: true });
								await fs.writeFile(dst, "// MUTATED WRONG CODE\nexport const broken = -999;\n");
							}
						},
						async getSessionStats() {
							return {
								tokens: { input: 120, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150 },
								assistantMessages: 1,
								cost: 0.002,
							};
						},
						async getLastAssistantText() {
							return "Finished with errors.";
						},
						async dispose() {},
					}),
				});

				const failArtifacts = await failingBackend.runTrial({ ...cell, repeat: 1 }, runContext);
				const failScore = await suite.scoreTrial({ ...cell, repeat: 1 }, failArtifacts);

				// Real 0 reward (distinguishable from execution error)
				expect(failScore.reward).toBe(0);
				expect(failScore.error).toBeNull();
				expect(failScore.extra.success).toBe(false);

				const directFailVerif = await verifyExpectedFiles(expectedDir, failArtifacts.trialDir!);
				expect(directFailVerif.success).toBe(false);
				expect(failScore.extra.success).toBe(directFailVerif.success);
				expect(failScore.extra.error).toBe(directFailVerif.error);

				// 4. Test execution error trial (missing trialDir) -> returns error and null reward
				const errorArtifacts: TrialArtifacts = {
					trialDir: null,
					extra: { cell },
				};
				const errorScore = await suite.scoreTrial(cell, errorArtifacts);
				expect(errorScore.reward).toBeNull();
				expect(errorScore.partial).toBeNull();
				expect(errorScore.error).toContain("Missing trialDir");

				// 5. Runtime dynamic enumeration of score fields from verify.ts output
				// Ensures every field in VerificationResult is mapped into TrialScore.extra
				const allVerifierKeys = new Set([...Object.keys(directPassVerif), ...Object.keys(directFailVerif)]);

				expect(allVerifierKeys.size).toBeGreaterThan(0);
				for (const field of allVerifierKeys) {
					expect(field in passScore.extra).toBe(true);
					expect(field in failScore.extra).toBe(true);
				}

				// Cleanup trial
				await backend.cleanup(cell, runContext);
			} finally {
				await tempRunsDir.remove();
			}
		});
	});
});
