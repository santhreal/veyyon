/**
 * WHY: PierExecutionBackend.prepare() created <runDir>/assets and staged nothing into
 * it. When veyyon_agent.py ran in the container setup phase, it looked on the host for
 * vey, auth-agent.db, arms/<variant>.yml, attachments.json, and the staged attachment
 * files, failing every trial with "ValueError: veyyon asset missing on host" before
 * the agent ever launched. Because the error occurred inside the agent runner rather
 * than during preflight, it was scored as a task failure (reward 0) rather than an
 * infrastructure refusal.
 *
 * The class this closes: execution backends launching containerized trials without
 * staging all assets required by the container agent contract, including executable
 * permissions, configuration overlays, binary digests, and attachment manifests.
 *
 * What it does not catch: whether the binary itself executes cleanly inside the
 * Linux container environment (no Docker container is spawned in unit tests), and
 * whether provider credentials in auth-agent.db are valid against upstream APIs.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { stagePierAssets } from "../../src/backends/pier/asset-staging";
import { PierExecutionBackend } from "../../src/backends/pier/backend";
import { registerPierBackend } from "../../src/backends/pier/register";
import * as pierRunner from "../../src/backends/pier/runner";
import type {
	EvalSuite,
	PreflightVerdict,
	RunContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialCell,
	TrialScore,
	Variant,
} from "../../src/core/types";
import { registerBuiltinHarnesses } from "../../src/harnesses/index";
import { evalsPackageDir } from "../../src/paths";
import {
	ARM_ATTACHMENT_KINDS,
	ARM_ATTACHMENT_MANIFEST_VERSION,
	type ArmAttachmentManifest,
} from "../../src/suites/deep-swe/arm-attachments";

const SCRATCH_BASE = path.join(evalsPackageDir(), ".internal", "test-pier-assets");

function createStubSuite(): EvalSuite {
	return {
		name: "stub-pier-suite",
		version: "1.0.0",
		displayName: "Stub Pier Suite",
		description: "Suite for testing asset staging",
		backend: "pier",
		async discoverTasks(): Promise<readonly string[]> {
			return ["task-1"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: path.join(SCRATCH_BASE, "tasks", taskId),
				timeBudgetSec: 60,
				instructionPath: null,
				metadata: {},
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "stub-pier-suite", version: "1.0.0" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: 1, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight(): Promise<PreflightVerdict> {
			return { ok: true };
		},
	};
}

describe("PierExecutionBackend asset staging", () => {
	let testDir: string;
	let fakeVeyBinary: string;
	let fakeAuthDb: string;
	let veySha: string;
	let origPath: string | undefined;

	beforeEach(() => {
		registerBuiltinHarnesses();
		registerPierBackend();

		testDir = path.join(SCRATCH_BASE, `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
		fs.mkdirSync(testDir, { recursive: true });

		const binDir = path.join(testDir, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		const fakePier = path.join(binDir, "pier");
		fs.writeFileSync(fakePier, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(fakePier, 0o755);
		origPath = process.env.PATH;
		process.env.PATH = `${binDir}:${origPath ?? ""}`;

		fakeVeyBinary = path.join(testDir, "source-vey");
		fs.writeFileSync(fakeVeyBinary, "#!/bin/sh\necho fake-vey\n");
		fs.chmodSync(fakeVeyBinary, 0o755);
		veySha = createHash("sha256").update(fs.readFileSync(fakeVeyBinary)).digest("hex");

		fakeAuthDb = path.join(testDir, "source-auth.db");
		fs.writeFileSync(fakeAuthDb, "sqlite-db-content-placeholder");
	});

	afterEach(() => {
		if (origPath !== undefined) {
			process.env.PATH = origPath;
		}
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("stages binary (with 0o755 mode), auth DB, per-variant arms, attachments manifest, and writes job config with real SHA", async () => {
		const suite = createStubSuite();
		const workDir = path.join(testDir, "workspace");
		fs.mkdirSync(workDir, { recursive: true });

		const fixturesDir = path.join(testDir, "fixtures");
		fs.mkdirSync(fixturesDir, { recursive: true });

		// Variant 1: default (no configPath, no attachments)
		const variantDefault: Variant = {
			name: "baseline",
			harness: "veyyon",
			configPath: null,
			promptVariantPath: null,
			model: "mock/model-a",
			attachments: [],
		};

		// Variant 2: with config overlay
		const overlayConfigPath = path.join(fixturesDir, "overlay.yml");
		fs.writeFileSync(overlayConfigPath, YAML.stringify({ settings: { auto_approve: true, budget: 42 } }));
		const variantOverlay: Variant = {
			name: "with_overlay",
			harness: "veyyon",
			configPath: overlayConfigPath,
			promptVariantPath: null,
			model: "mock/model-b",
			attachments: [],
		};

		// Variant 3: with derived implicit attachments from configPath
		const derivedConfigPath = path.join(fixturesDir, "derived_arm.yml");
		fs.writeFileSync(derivedConfigPath, YAML.stringify({ settings: { temperature: 0.2 } }));
		const derivedSectionsPath = path.join(fixturesDir, "derived_arm.sections.yml");
		fs.writeFileSync(derivedSectionsPath, YAML.stringify({ system_prompt_main: "custom-section-body" }));
		const derivedRulePath = path.join(fixturesDir, "derived_arm.rule.md");
		fs.writeFileSync(derivedRulePath, "# Custom Guidelines\nAlways write tests.");

		const variantDerived: Variant = {
			name: "with_derived",
			harness: "veyyon",
			configPath: derivedConfigPath,
			promptVariantPath: null,
			model: "mock/model-c",
			attachments: [],
		};

		// Variant 4: with explicit attachments
		const explicitPromptsPath = path.join(fixturesDir, "custom_prompts.prompts.yml");
		fs.writeFileSync(explicitPromptsPath, YAML.stringify({ test_prompt_id: "override-text" }));
		const explicitRulePath = path.join(fixturesDir, "special.rule.md");
		fs.writeFileSync(explicitRulePath, "# Special Rules\nAdhere strictly.");

		const variantExplicit: Variant = {
			name: "with_explicit",
			harness: "veyyon",
			configPath: null,
			promptVariantPath: null,
			model: "mock/model-d",
			attachments: [explicitPromptsPath, explicitRulePath],
		};

		const variants: readonly Variant[] = [variantDefault, variantOverlay, variantDerived, variantExplicit];

		const context: RunContext = {
			runId: "smoke-run-1",
			suite,
			workDir,
			runsDir: path.join(workDir, "runs"),
			options: {
				variants,
				model: "mock/model-a",
			},
		};

		const backend = new PierExecutionBackend({
			veyBinary: fakeVeyBinary,
			authDb: fakeAuthDb,
			checkPreflight: () => ({ ok: true }),
			exec: async () => ({ stdout: "execution success", stderr: "" }),
		});

		// 1. Prepare backend assets
		await backend.prepare(context);

		const assetsDir = path.join(workDir, "runs", "smoke-run-1", "assets");
		expect(fs.existsSync(assetsDir)).toBe(true);

		// Assert vey binary
		const stagedVey = path.join(assetsDir, "vey");
		expect(fs.existsSync(stagedVey)).toBe(true);
		const veyStat = fs.statSync(stagedVey);
		expect(veyStat.isFile()).toBe(true);
		expect((veyStat.mode & 0o777) === 0o755).toBe(true);
		expect(createHash("sha256").update(fs.readFileSync(stagedVey)).digest("hex")).toBe(veySha);

		// Assert auth-agent.db
		const stagedAuth = path.join(assetsDir, "auth-agent.db");
		expect(fs.existsSync(stagedAuth)).toBe(true);
		expect(fs.readFileSync(stagedAuth, "utf8")).toBe("sqlite-db-content-placeholder");

		// Assert arms directory and per-variant configs for every variant in plan
		const stagedArmsDir = path.join(assetsDir, "arms");
		expect(fs.existsSync(stagedArmsDir)).toBe(true);

		for (const variant of variants) {
			const armFilePath = path.join(stagedArmsDir, `${variant.name}.yml`);
			expect(fs.existsSync(armFilePath)).toBe(true);
			const parsed = YAML.parse(fs.readFileSync(armFilePath, "utf8"));
			if (variant.configPath === null) {
				expect(parsed).toEqual({});
			} else {
				const expectedOriginal = YAML.parse(fs.readFileSync(variant.configPath, "utf8"));
				expect(parsed).toEqual(expectedOriginal);
			}
		}

		// Assert attachments.json manifest
		const manifestPath = path.join(assetsDir, "attachments.json");
		expect(fs.existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ArmAttachmentManifest;
		expect(manifest.version).toBe(ARM_ATTACHMENT_MANIFEST_VERSION);

		// Sweep all variants in the plan against the manifest
		for (const variant of variants) {
			const entries = manifest.arms[variant.name];
			expect(Array.isArray(entries)).toBe(true);

			if (variant.name === "baseline" || variant.name === "with_overlay") {
				expect(entries.length).toBe(0);
			} else if (variant.name === "with_derived") {
				expect(entries.length).toBe(2);
				const sectionsEntry = entries.find(e => e.kind === "sections");
				expect(sectionsEntry).toBeDefined();
				expect(sectionsEntry?.delivery).toBe("env-json");
				expect(sectionsEntry?.envVar).toBe("VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS");
				expect(fs.existsSync(path.join(assetsDir, sectionsEntry!.file))).toBe(true);

				const ruleEntry = entries.find(e => e.kind === "rule");
				expect(ruleEntry).toBeDefined();
				expect(ruleEntry?.delivery).toBe("rules-dir");
				expect(fs.existsSync(path.join(assetsDir, ruleEntry!.file))).toBe(true);
			} else if (variant.name === "with_explicit") {
				expect(entries.length).toBe(2);
				const promptsEntry = entries.find(e => e.kind === "prompts");
				expect(promptsEntry).toBeDefined();
				expect(promptsEntry?.delivery).toBe("env-json");
				expect(promptsEntry?.envVar).toBe("VEYYON_EVAL_PROMPTS");
				expect(fs.existsSync(path.join(assetsDir, promptsEntry!.file))).toBe(true);

				const ruleEntry = entries.find(e => e.kind === "rule");
				expect(ruleEntry).toBeDefined();
				expect(ruleEntry?.delivery).toBe("rules-dir");
				expect(fs.existsSync(path.join(assetsDir, ruleEntry!.file))).toBe(true);
			}

			for (const entry of entries) {
				const filePath = path.join(assetsDir, entry.file);
				expect(fs.existsSync(filePath)).toBe(true);
			}
		}

		// 2. Run trial and verify that the backend passes the real binary_sha in job config
		const cell: TrialCell = {
			variant: "baseline",
			suite: suite.name,
			task: "task-1",
			repeat: 0,
		};

		const runSpy = spyOn(pierRunner, "runPierTrial").mockImplementation(async () => ({
			exitCode: 0,
			stdout: "stub execution",
			stderr: "",
			trialDirPath: null,
			durationMs: 10,
			timedOut: false,
			error: null,
		}));

		try {
			await backend.runTrial(cell, context);
		} finally {
			runSpy.mockRestore();
		}

		const configsDir = path.join(workDir, "runs", "smoke-run-1", "configs");
		const jobConfigPath = path.join(configsDir, "smoke-run-1__baseline__task-1__r0.yaml");
		expect(fs.existsSync(jobConfigPath)).toBe(true);

		const jobConfigContent = fs.readFileSync(jobConfigPath, "utf8");
		expect(jobConfigContent).toContain(`binary_sha: "${veySha}"`);
		expect(jobConfigContent).not.toContain('binary_sha: "nosha"');
		expect(jobConfigContent).toContain(`assets_dir: "${assetsDir}"`);
		expect(jobConfigContent).toContain('arm_name: "baseline"');
	});

	it("fails preparation when variant configPath does not exist, naming path and variant", async () => {
		const suite = createStubSuite();
		const workDir = path.join(testDir, "workspace");

		const nonExistentPath = path.join(testDir, "non-existent-config.yml");
		const variant: Variant = {
			name: "broken_config_arm",
			harness: "veyyon",
			configPath: nonExistentPath,
			promptVariantPath: null,
			model: "mock/model-a",
			attachments: [],
		};

		const context: RunContext = {
			runId: "fail-run-1",
			suite,
			workDir,
			runsDir: path.join(workDir, "runs"),
			options: {
				variants: [variant],
			},
		};

		const backend = new PierExecutionBackend({
			veyBinary: fakeVeyBinary,
			authDb: fakeAuthDb,
			checkPreflight: () => ({ ok: true }),
		});

		expect(backend.prepare(context)).rejects.toThrow(
			`Variant "broken_config_arm" configPath does not exist: ${nonExistentPath}`,
		);
	});

	it("fails preparation when variant attachment has an unknown suffix, naming path and understood suffixes", async () => {
		const suite = createStubSuite();
		const workDir = path.join(testDir, "workspace");

		const badAttachmentPath = path.join(testDir, "invalid-suffix.txt");
		fs.writeFileSync(badAttachmentPath, "hello");

		const variant: Variant = {
			name: "bad_attachment_arm",
			harness: "veyyon",
			configPath: null,
			promptVariantPath: null,
			model: "mock/model-a",
			attachments: [badAttachmentPath],
		};

		const context: RunContext = {
			runId: "fail-run-2",
			suite,
			workDir,
			runsDir: path.join(workDir, "runs"),
			options: {
				variants: [variant],
			},
		};

		const backend = new PierExecutionBackend({
			veyBinary: fakeVeyBinary,
			authDb: fakeAuthDb,
			checkPreflight: () => ({ ok: true }),
		});

		const understood = ARM_ATTACHMENT_KINDS.map(k => k.suffix).join(", ");
		expect(backend.prepare(context)).rejects.toThrow(
			`Variant "bad_attachment_arm" attachment "${badAttachmentPath}" has unknown suffix. Understood suffixes: ${understood}`,
		);
	});

	it("preflight refuses when vey binary is missing, naming the missing file", async () => {
		const suite = createStubSuite();
		const workDir = path.join(testDir, "workspace");
		const missingBinary = path.join(testDir, "missing-vey");

		const context: RunContext = {
			runId: "preflight-run-1",
			suite,
			workDir,
			runsDir: path.join(workDir, "runs"),
		};

		const backend = new PierExecutionBackend({
			veyBinary: missingBinary,
			authDb: fakeAuthDb,
			checkPreflight: () => ({ ok: true }),
		});

		const verdict = await backend.preflight(context);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain(`vey binary not found at ${missingBinary}`);
		expect(verdict.missingRequirements).toContain(missingBinary);
	});

	it("preflight refuses when auth database is missing, naming the missing file", async () => {
		const suite = createStubSuite();
		const workDir = path.join(testDir, "workspace");
		const missingAuth = path.join(testDir, "missing-auth.db");

		const context: RunContext = {
			runId: "preflight-run-2",
			suite,
			workDir,
			runsDir: path.join(workDir, "runs"),
		};

		const backend = new PierExecutionBackend({
			veyBinary: fakeVeyBinary,
			authDb: missingAuth,
			checkPreflight: () => ({ ok: true }),
		});

		const verdict = await backend.preflight(context);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain(`auth database not found at ${missingAuth}`);
		expect(verdict.missingRequirements).toContain(missingAuth);
	});

	it("preflight passes when both vey binary and auth database exist and pier preflight succeeds", async () => {
		const suite = createStubSuite();
		const workDir = path.join(testDir, "workspace");

		const context: RunContext = {
			runId: "preflight-run-3",
			suite,
			workDir,
			runsDir: path.join(workDir, "runs"),
		};

		const backend = new PierExecutionBackend({
			veyBinary: fakeVeyBinary,
			authDb: fakeAuthDb,
			checkPreflight: () => ({ ok: true }),
		});

		const verdict = await backend.preflight(context);
		expect(verdict.ok).toBe(true);
	});

	it("reports the digest of the staged copy and one arm file per variant", () => {
		const assetsDir = path.join(testDir, "direct-assets");
		const variants: Variant[] = [
			{
				name: "baseline",
				harness: "veyyon",
				configPath: null,
				promptVariantPath: null,
				model: "mock/model-a",
				attachments: [],
			},
			{
				name: "candidate",
				harness: "veyyon",
				configPath: null,
				promptVariantPath: null,
				model: "mock/model-a",
				attachments: [],
			},
		];

		const staged = stagePierAssets({ assetsDir, variants, veyBinary: fakeVeyBinary, authDb: fakeAuthDb });

		// The digest has to describe the binary the container will execute, not the one
		// on the host at some earlier moment: pier records it as `binary_sha`, and a
		// digest of a different file makes a run unattributable to a build.
		const stagedBinary = path.join(assetsDir, "vey");
		const stagedSha = createHash("sha256").update(fs.readFileSync(stagedBinary)).digest("hex");
		expect(staged.binarySha).toBe(stagedSha);
		expect(staged.binarySha).toBe(veySha);

		// One arm file per variant, each on disk: a variant with no file is an arm the
		// container agent cannot load, and it fails inside the trial rather than here.
		expect([...staged.armFiles.keys()].sort()).toEqual(["baseline", "candidate"]);
		for (const armFile of staged.armFiles.values()) {
			expect(fs.existsSync(armFile)).toBe(true);
		}
	});
});
