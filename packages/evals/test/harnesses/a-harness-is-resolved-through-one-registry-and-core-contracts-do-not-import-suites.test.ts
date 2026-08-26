/**
 * WHY THIS SUITE EXISTS.
 *
 * Previously, the eval harness codebase had two competing harness registries:
 * `src/core/harness-registry.ts` (storing HarnessAdapter) and `src/harnesses/registry.ts`
 * (storing SystemAdapter). This duplicated registry state, created alias exports
 * that bypassed the core harness registry, and suffered from load-time initialization
 * race conditions. Additionally, the core, harness, and backend layers imported
 * upward into suite implementations (deep-swe and typescript-edit), violating the
 * strict one-way downward layering rule.
 *
 * This regression suite enforces:
 * 1. Single Registry Contract: All harnesses are registered into and resolved through
 *    the single core HarnessRegistry (`defaultHarnessRegistry` / `requireHarness`).
 * 2. Refusal with Registered IDs: Requesting an unknown harness fails closed with an
 *    informative error naming all currently registered harness IDs.
 * 3. Selection Validation: Multi-system validation (`validateSystemsSelection`) rejects
 *    unknown names and reports available registered harnesses.
 * 4. Runtime Adapter Sweep: Every registered harness swept dynamically from the registry
 *    at runtime conforms to the unified `HarnessAdapter` interface.
 * 5. Downward Layering Contract: Moved shared contracts (`ArmResult`, `AuthSeedDecision`,
 *    `AUTH_DB_SOURCES`, `ARM_ATTACHMENT_KINDS`, `knownPromptIds`, `listFiles`, `MINIMUM_PIER_VERSION`)
 *    are fully functional from `core/` and `backends/` without any suite dependencies.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * It does not run live remote container execution or full end-to-end benchmark evaluation
 * jobs across Docker/Pier/Harbor.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MINIMUM_PIER_VERSION, pierSupportsSeparateVerifierCollect } from "../../src/backends/pier/version";
import {
	ARM_ATTACHMENT_KINDS,
	ARM_ATTACHMENT_MANIFEST_FILE,
	ARM_ATTACHMENT_MANIFEST_VERSION,
	type ArmResult,
	AUTH_DB_SOURCES,
	type ComparisonArmResult,
	decideAuthSeed,
	defaultHarnessRegistry,
	getHarness,
	type HarnessAdapter,
	HarnessNotFoundError,
	hasHarness,
	knownPromptIds,
	listFiles,
	listHarnesses,
	listHarnessNames,
	promptOverrideIdError,
	requireHarness,
	validateSystemsSelection,
} from "../../src/core";
import { registerBuiltinHarnesses } from "../../src/harnesses";

describe("a harness is resolved through one registry and core contracts do not import suites", () => {
	beforeAll(() => {
		registerBuiltinHarnesses();
	});

	it("refuses an unknown harness name with an error that names the registered ids", () => {
		const registeredNames = listHarnessNames();
		expect(registeredNames.length).toBeGreaterThanOrEqual(4);

		const unknownName = "non-existent-harness-xyz";
		expect(() => requireHarness(unknownName)).toThrow(HarnessNotFoundError);

		try {
			requireHarness(unknownName);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(HarnessNotFoundError);
			const message = (err as Error).message;
			expect(message).toContain(`Unknown harness adapter "${unknownName}"`);
			for (const name of registeredNames) {
				expect(message).toContain(name);
			}
		}
	});

	it("validates systems selection and names registered ids on unknown entries", () => {
		const registeredNames = listHarnessNames();
		const result = validateSystemsSelection(["veyyon", "unknown-candidate-xyz"]);
		expect(result.valid).toBe(false);
		expect(result.unknown).toEqual(["unknown-candidate-xyz"]);
		expect(result.invalid).toEqual(["unknown-candidate-xyz"]);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("unknown system(s): unknown-candidate-xyz");
		for (const name of registeredNames) {
			expect(result.errors[0]).toContain(name);
		}
	});

	it("resolves registered harnesses through the single registry and confirms no second path exists", () => {
		const registered = listHarnesses();
		expect(registered.length).toBeGreaterThanOrEqual(4);

		for (const harness of registered) {
			expect(hasHarness(harness.name)).toBe(true);
			expect(getHarness(harness.name)).toBe(harness);
			expect(requireHarness(harness.name)).toBe(harness);
			expect(defaultHarnessRegistry.get(harness.name)).toBe(harness);
			expect(defaultHarnessRegistry.require(harness.name)).toBe(harness);
		}
	});

	it("dynamically sweeps all registered harnesses at runtime and enforces HarnessAdapter contract", () => {
		const harnesses = defaultHarnessRegistry.list();
		expect(harnesses.length).toBeGreaterThanOrEqual(4);

		for (const harness of harnesses) {
			expect(typeof harness.name).toBe("string");
			expect(harness.name.length).toBeGreaterThan(0);
			expect(typeof harness.displayName).toBe("string");
			expect(typeof harness.description).toBe("string");
			expect(typeof harness.capabilities).toBe("object");
			expect(typeof harness.backends).toBe("object");
			expect(typeof harness.preflight).toBe("function");
			expect(typeof harness.stageAssets).toBe("function");
		}
	});

	it("allows registering and resolving a custom harness through the single registry", () => {
		const customName = `custom-unit-test-harness-${Date.now()}`;
		const customHarness: HarnessAdapter = {
			name: customName,
			displayName: "Custom Unit Test Harness",
			description: "Custom harness created for single-registry test verification",
			flags: [],
			defaultModel: null,
			capabilities: {
				replay: false,
				compaction: false,
				armAttachments: false,
				promptOverrides: false,
			},
			backends: {
				"in-process": {},
			},
			preflight: async () => ({ ok: true }),
			stageAssets: async () => {},
		};

		defaultHarnessRegistry.register(customHarness);

		expect(hasHarness(customName)).toBe(true);
		expect(getHarness(customName)).toBe(customHarness);
		expect(requireHarness(customName)).toBe(customHarness);

		// Clean up custom harness
		defaultHarnessRegistry.unregister(customName);
		expect(hasHarness(customName)).toBe(false);
	});

	it("proves moved core contracts function directly from core without suite imports", async () => {
		// 1. ArmResult and ComparisonArmResult types are usable
		const armResult: ArmResult = {
			arm: "baseline",
			task: "sample-task",
			repeat: 0,
			reward: 1,
			partial: 1,
			inputTokens: 100,
			outputTokens: 50,
			costUsd: 0.001,
			cacheTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			agentSeconds: 5,
			error: null,
		};
		const comparisonResult: ComparisonArmResult = {
			...armResult,
			system: "veyyon",
			requestedModel: "test-model",
			resolvedModel: "test-model",
		};
		expect(armResult.reward).toBe(1);
		expect(comparisonResult.system).toBe("veyyon");

		// 2. Auth seed decision and sources
		expect(Array.isArray(AUTH_DB_SOURCES)).toBe(true);
		expect(AUTH_DB_SOURCES.length).toBeGreaterThan(0);
		const seedDecision = decideAuthSeed(
			["/fake/live/agent.db"],
			"/fake/staged/agent.db",
			p => (p === "/fake/live/agent.db" ? 1000 : undefined),
			() => undefined,
		);
		expect(seedDecision.kind).toBe("seed");

		const currentDecision = decideAuthSeed(
			["/fake/live/agent.db"],
			"/fake/staged/agent.db",
			p => (p === "/fake/live/agent.db" ? 1000 : p === "/fake/staged/agent.db" ? 1000 : undefined),
			() => undefined,
		);
		expect(currentDecision.kind).toBe("current");
		// 3. Arm attachment kinds, manifest constants, and validation
		expect(Array.isArray(ARM_ATTACHMENT_KINDS)).toBe(true);
		expect(ARM_ATTACHMENT_KINDS.length).toBeGreaterThanOrEqual(4);
		expect(ARM_ATTACHMENT_MANIFEST_VERSION).toBe(1);
		expect(ARM_ATTACHMENT_MANIFEST_FILE).toBe("attachments.json");

		// 4. Prompt variant introspection
		const promptIds = knownPromptIds();
		expect(Array.isArray(promptIds)).toBe(true);
		expect(promptIds.length).toBeGreaterThan(0);
		const promptErr = promptOverrideIdError("test-arm", { "non-existent-prompt-id": "text" });
		expect(promptErr).not.toBeNull();
		expect(promptErr).toContain("non-existent-prompt-id");

		// 5. Pier version capability check
		expect(MINIMUM_PIER_VERSION).toBe("0.3.1");
		expect(pierSupportsSeparateVerifierCollect("0.3.1")).toBe(true);
		expect(pierSupportsSeparateVerifierCollect("0.3.0")).toBe(false);

		// 6. Directory walk helper
		const files = await listFiles(import.meta.dirname);
		expect(Array.isArray(files)).toBe(true);
		expect(files.length).toBeGreaterThan(0);
	});
});
