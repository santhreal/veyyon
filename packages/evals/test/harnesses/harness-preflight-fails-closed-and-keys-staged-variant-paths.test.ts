/**
 * WHY THIS SUITE EXISTS.
 *
 * A multi-hour, multi-thousand trial evaluation run previously had two critical vulnerabilities:
 * 1. Harness preflight was either unconditional { ok: true } (Veyyon) or skipped credential checks
 *    (OMP), meaning missing binaries or absent API keys would fail hours into container execution
 *    instead of failing closed before the first trial.
 * 2. Harness stageAssets wrote unkeyed filenames (settings.json, models.yml, omp.env) directly into
 *    a shared assets directory, allowing concurrent variants of the same harness to collide and
 *    silently overwrite each other's configurations.
 *
 * This suite enforces:
 * - Every registered harness in the harness registry fails closed when its binary or credentials are missing.
 * - Every registered harness succeeds preflight when valid fixtures are provided.
 * - Staging assets for multiple variants of any registered harness writes to disjoint, variant-keyed paths.
 * - preflightHarnesses() runs across variant lists, de-duplicates probes per (harness, backend) pair,
 *   reports exactly one verdict per variant, and fails closed on unregistered harness names.
 * - Dynamic registry enumeration ensures newly registered harnesses turn this suite RED until
 *   explicit test fixtures and assertions are added for them.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * It does not run live remote LLM provider API token verification or live Docker container spawning.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai";
import { listHarnesses, type Variant } from "../../src/core";
import { preflightHarnesses } from "../../src/core/harness-preflight";
import { registerBuiltinHarnesses, sanitizeVariantName } from "../../src/harnesses";
import { internalScratchDir } from "../../src/paths";

registerBuiltinHarnesses();

interface HarnessFixtureSetup {
	readonly options: Record<string, unknown>;
	readonly expectedFiles: readonly string[];
}

describe("harness preflight fails closed and keys staged variant paths", () => {
	let scratchDir: string;

	beforeEach(() => {
		scratchDir = path.join(
			internalScratchDir(),
			`test-harness-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		fs.mkdirSync(scratchDir, { recursive: true });
	});

	afterEach(() => {
		try {
			if (fs.existsSync(scratchDir)) {
				fs.rmSync(scratchDir, { recursive: true, force: true });
			}
		} catch {
			// ignore cleanup errors in test teardown
		}
	});

	function createExecutable(filePath: string): string {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(filePath, 0o755);
		return filePath;
	}

	function createNonExecutable(filePath: string): string {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "dummy binary");
		fs.chmodSync(filePath, 0o644);
		return filePath;
	}

	function createTextFile(filePath: string, content = "key=value\n"): string {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content);
		return filePath;
	}

	function setupValidHarnessFixture(harnessName: string): HarnessFixtureSetup {
		switch (harnessName) {
			case "veyyon": {
				const binPath = createExecutable(path.join(scratchDir, "veyyon-bin", "vey"));
				const authDbPath = path.join(scratchDir, "veyyon-auth", "agent.db");
				fs.mkdirSync(path.dirname(authDbPath), { recursive: true });
				const db = new Database(authDbPath);
				db.exec("CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY);");
				db.close();
				return {
					options: {
						binary: binPath,
						"auth-db": authDbPath,
						model: "google-antigravity/gemini-3.5-flash",
					},
					expectedFiles: [],
				};
			}
			case "omp": {
				const binPath = createExecutable(path.join(scratchDir, "omp-bin", "omp"));
				return {
					options: {
						"omp-binary": binPath,
						"omp-api-key": "sk-omp-test-key-12345",
						model: "opencode-go/deepseek-v4-flash",
					},
					expectedFiles: ["omp", "omp.env"],
				};
			}
			case "factory": {
				const binPath = createExecutable(path.join(scratchDir, "factory-bin", "droid"));
				const authPath = createTextFile(
					path.join(scratchDir, "factory-auth", "api.key"),
					"factory-test-key-secret",
				);
				const settingsPath = createTextFile(path.join(scratchDir, "factory-conf", "custom.json"), "{}");
				return {
					options: {
						"factory-binary": binPath,
						"factory-auth": authPath,
						"factory-settings": settingsPath,
					},
					expectedFiles: ["droid", "factory-api-key", "settings.json"],
				};
			}
			case "hermes": {
				const authPath = createTextFile(
					path.join(scratchDir, "hermes-auth", "hermes.env"),
					"HERMES_API_KEY=test-token\n",
				);
				return {
					options: {
						"hermes-auth": authPath,
					},
					expectedFiles: ["hermes.env"],
				};
			}
			default:
				throw new Error(`Unrecognized harness in fixture setup: "${harnessName}"`);
		}
	}

	it("verifies all registered harnesses are covered by the test sweep and none are skipped", () => {
		const registeredHarnesses = listHarnesses();
		expect(registeredHarnesses.length).toBeGreaterThan(0);

		const knownFixtureHarnesses = new Set(["veyyon", "omp", "factory", "hermes"]);
		const unexercised: string[] = [];

		for (const harness of registeredHarnesses) {
			if (!knownFixtureHarnesses.has(harness.name)) {
				unexercised.push(harness.name);
			}
		}

		// A new harness added to registry must be added to this suite's fixture configuration
		expect(unexercised).toEqual([]);
	});

	it("refuses preflight for every registered harness when required binaries or credentials are missing", async () => {
		const registeredHarnesses = listHarnesses();

		for (const harness of registeredHarnesses) {
			// Pass options pointing to nonexistent paths or empty configurations
			const emptyOptions: Record<string, unknown> = {
				binary: path.join(scratchDir, "nonexistent", "vey"),
				"auth-db": path.join(scratchDir, "nonexistent", "agent.db"),
				"omp-binary": path.join(scratchDir, "nonexistent", "omp"),
				"omp-api-key": undefined,
				"factory-binary": path.join(scratchDir, "nonexistent", "droid"),
				"factory-auth": path.join(scratchDir, "nonexistent", "factory-key"),
				"hermes-auth": path.join(scratchDir, "nonexistent", "hermes.env"),
			};

			const verdict = await harness.preflight({
				backend: "pier",
				options: emptyOptions,
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toBeDefined();
			expect(typeof verdict.reason).toBe("string");
			expect((verdict.missingRequirements ?? []).length).toBeGreaterThan(0);
		}
	});

	it("refuses preflight when binary exists but is not executable", async () => {
		const nonExecVey = createNonExecutable(path.join(scratchDir, "nonexec-vey", "vey"));
		const nonExecOmp = createNonExecutable(path.join(scratchDir, "nonexec-omp", "omp"));
		const nonExecDroid = createNonExecutable(path.join(scratchDir, "nonexec-droid", "droid"));

		const veyyonHarness = listHarnesses().find(h => h.name === "veyyon");
		if (veyyonHarness) {
			const verdict = await veyyonHarness.preflight({
				backend: "pier",
				options: { binary: nonExecVey },
			});
			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toMatch(/not executable/i);
		}

		const ompHarness = listHarnesses().find(h => h.name === "omp");
		if (ompHarness) {
			const verdict = await ompHarness.preflight({
				backend: "pier",
				options: {
					"omp-binary": nonExecOmp,
					"omp-api-key": "test-key",
				},
			});
			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toMatch(/not executable/i);
		}

		const factoryHarness = listHarnesses().find(h => h.name === "factory");
		if (factoryHarness) {
			const authPath = createTextFile(path.join(scratchDir, "factory-auth-valid", "key.txt"), "valid-secret");
			const verdict = await factoryHarness.preflight({
				backend: "pier",
				options: {
					"factory-binary": nonExecDroid,
					"factory-auth": authPath,
				},
			});
			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toMatch(/not executable/i);
		}
	});

	it("passes preflight for every registered harness when valid fixtures are provided", async () => {
		const reloadSpy = spyOn(AuthStorage.prototype, "reload").mockResolvedValue();
		const checkSpy = spyOn(AuthStorage.prototype, "checkCredentials").mockResolvedValue([
			{ id: 1, type: "oauth", provider: "google-antigravity", ok: true },
			{ id: 2, type: "oauth", provider: "google", ok: true },
		]);

		try {
			const registeredHarnesses = listHarnesses();

			for (const harness of registeredHarnesses) {
				const fixture = setupValidHarnessFixture(harness.name);
				const verdict = await harness.preflight({
					backend: "pier",
					options: fixture.options,
				});

				expect(verdict.ok, `Harness "${harness.name}" failed preflight: ${verdict.reason}`).toBe(true);
				expect(verdict.missingRequirements).toBeUndefined();
			}
		} finally {
			reloadSpy.mockRestore();
			checkSpy.mockRestore();
		}
	});

	it("stageAssets writes to disjoint variant-keyed paths for multiple variants of the same harness", async () => {
		const registeredHarnesses = listHarnesses();
		const targetDir = path.join(scratchDir, "staged-assets");
		fs.mkdirSync(targetDir, { recursive: true });

		for (const harness of registeredHarnesses) {
			const fixture = setupValidHarnessFixture(harness.name);

			const variantA: Variant = {
				name: "arm-baseline-v1",
				harness: harness.name,
				configPath:
					typeof fixture.options["factory-settings"] === "string"
						? (fixture.options["factory-settings"] as string)
						: null,
				promptVariantPath: null,
				model: "vendor/test-model",
				attachments: [],
			};

			const variantB: Variant = {
				name: "arm-candidate-v2",
				harness: harness.name,
				configPath:
					typeof fixture.options["factory-settings"] === "string"
						? (fixture.options["factory-settings"] as string)
						: null,
				promptVariantPath: null,
				model: "vendor/test-model",
				attachments: [],
			};

			await harness.stageAssets({
				variant: variantA,
				targetDir,
				backend: "pier",
				options: fixture.options,
			});

			await harness.stageAssets({
				variant: variantB,
				targetDir,
				backend: "pier",
				options: fixture.options,
			});

			const pathA = path.join(targetDir, sanitizeVariantName(variantA.name));
			const pathB = path.join(targetDir, sanitizeVariantName(variantB.name));

			// Staging directories must exist and be strictly disjoint
			expect(fs.existsSync(pathA)).toBe(true);
			expect(fs.existsSync(pathB)).toBe(true);
			expect(pathA).not.toEqual(pathB);

			// Assert actual file paths within each variant's directory
			for (const file of fixture.expectedFiles) {
				const fileInA = path.join(pathA, file);
				const fileInB = path.join(pathB, file);
				expect(fs.existsSync(fileInA)).toBe(true);
				expect(fs.existsSync(fileInB)).toBe(true);
				expect(fileInA).not.toEqual(fileInB);
			}
		}
	});

	it("preflightHarnesses reports one entry per variant and fails closed on unregistered harnesses", async () => {
		const reloadSpy = spyOn(AuthStorage.prototype, "reload").mockResolvedValue();
		const checkSpy = spyOn(AuthStorage.prototype, "checkCredentials").mockResolvedValue([
			{ id: 1, type: "oauth", provider: "google-antigravity", ok: true },
			{ id: 2, type: "oauth", provider: "google", ok: true },
		]);

		try {
			const veyyonFixture = setupValidHarnessFixture("veyyon");
			const ompFixture = setupValidHarnessFixture("omp");

			const variants: Variant[] = [
				{
					name: "var-veyyon-1",
					harness: "veyyon",
					configPath: null,
					promptVariantPath: null,
					model: "vendor/test-model",
					attachments: [],
				},
				{
					name: "var-veyyon-2",
					harness: "veyyon",
					configPath: null,
					promptVariantPath: null,
					model: "vendor/test-model",
					attachments: [],
				},
				{
					name: "var-omp-1",
					harness: "omp",
					configPath: null,
					promptVariantPath: null,
					model: "vendor/test-model",
					attachments: [],
				},
				{
					name: "var-unregistered",
					harness: "nonexistent-harness-xyz",
					configPath: null,
					promptVariantPath: null,
					model: "vendor/test-model",
					attachments: [],
				},
			];

			const combinedOptions = {
				...veyyonFixture.options,
				...ompFixture.options,
			};

			const reports = await preflightHarnesses(variants, {
				backend: "pier",
				options: combinedOptions,
			});

			// Must return exactly one report per variant in matching order
			expect(reports.length).toBe(variants.length);
			expect(reports[0].variant).toBe("var-veyyon-1");
			expect(reports[0].harness).toBe("veyyon");
			expect(reports[0].verdict.ok).toBe(true);

			expect(reports[1].variant).toBe("var-veyyon-2");
			expect(reports[1].harness).toBe("veyyon");
			expect(reports[1].verdict.ok).toBe(true);

			expect(reports[2].variant).toBe("var-omp-1");
			expect(reports[2].harness).toBe("omp");
			expect(reports[2].verdict.ok).toBe(true);

			// Unregistered harness fails closed with ok: false
			expect(reports[3].variant).toBe("var-unregistered");
			expect(reports[3].harness).toBe("nonexistent-harness-xyz");
			expect(reports[3].verdict.ok).toBe(false);
			expect(reports[3].verdict.reason).toMatch(/unregistered harness/i);
		} finally {
			reloadSpy.mockRestore();
			checkSpy.mockRestore();
		}
	});

	it("preflightHarnesses de-duplicates probes: probes each distinct harness+backend pair only once", async () => {
		const veyyonHarness = listHarnesses().find(h => h.name === "veyyon");
		const ompHarness = listHarnesses().find(h => h.name === "omp");
		expect(veyyonHarness).toBeDefined();
		expect(ompHarness).toBeDefined();

		if (!veyyonHarness || !ompHarness) return;

		let veyyonProbeCalls = 0;
		let ompProbeCalls = 0;

		const veyyonSpy = spyOn(veyyonHarness, "preflight").mockImplementation(async () => {
			veyyonProbeCalls++;
			return { ok: true };
		});

		const ompSpy = spyOn(ompHarness, "preflight").mockImplementation(async () => {
			ompProbeCalls++;
			return { ok: true };
		});

		try {
			// Generate 50 veyyon variants and 50 omp variants (100 total)
			const variants: Variant[] = [];
			for (let i = 0; i < 50; i++) {
				variants.push({
					name: `veyyon-cell-${i}`,
					harness: "veyyon",
					configPath: null,
					promptVariantPath: null,
					model: "vendor/test-model",
					attachments: [],
				});
				variants.push({
					name: `omp-cell-${i}`,
					harness: "omp",
					configPath: null,
					promptVariantPath: null,
					model: "vendor/test-model",
					attachments: [],
				});
			}

			const reports = await preflightHarnesses(variants, {
				backend: "pier",
				options: {},
			});

			expect(reports.length).toBe(100);
			// 100 variants sharing 2 harnesses on the same backend should only probe each harness ONCE
			expect(veyyonProbeCalls).toBe(1);
			expect(ompProbeCalls).toBe(1);
		} finally {
			veyyonSpy.mockRestore();
			ompSpy.mockRestore();
		}
	});
});
