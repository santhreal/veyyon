import { beforeAll, describe, expect, it } from "bun:test";
import {
	getHarness,
	hasHarness,
	listHarnessNames,
	registerHarness,
	validateSystemsSelection,
} from "../../../src/core/harness-registry";
import type { HarnessAdapter } from "../../../src/core/types";
import { registerBuiltinHarnesses } from "../../../src/harnesses";

describe("system adapter registry", () => {
	beforeAll(() => {
		registerBuiltinHarnesses();
	});

	it("lists all default registered adapters", () => {
		const adapters = listHarnessNames();
		expect(adapters).toContain("veyyon");
		expect(adapters).toContain("factory");
		expect(adapters).toContain("hermes");
		expect(adapters).toContain("omp");
	});

	it("retrieves adapters by name", () => {
		const veyyon = getHarness("veyyon");
		expect(veyyon).toBeDefined();
		expect(veyyon?.name).toBe("veyyon");

		const omp = getHarness("omp");
		expect(omp).toBeDefined();
		expect(omp?.name).toBe("omp");
	});

	it("validates valid system selections", () => {
		const result = validateSystemsSelection(["veyyon", "omp"]);
		expect(result.valid).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.invalid).toEqual([]);
	});

	it("identifies invalid system selections", () => {
		const result = validateSystemsSelection(["veyyon", "unknown-system"]);
		expect(result.valid).toBe(false);
		expect(result.invalid).toEqual(["unknown-system"]);
	});

	it("allows registering custom adapters", () => {
		const customAdapter: HarnessAdapter = {
			name: "custom-test",
			displayName: "Custom Test Adapter",
			description: "Custom test adapter for unit test",
			defaultModel: null,
			capabilities: {
				replay: false,
				compaction: false,
				armAttachments: false,
				promptOverrides: false,
			},
			backends: {
				pier: {
					agentImportPath: "custom_agent:CustomAgent",
					containerAssetsDir: "/opt/custom-assets",
				},
			},
			preflight: async () => ({ ok: true }),
			stageAssets: async () => {},
			validatePreflight() {
				return { valid: true, errors: [], warnings: [] };
			},
			buildJobConfigKwargs() {
				return {};
			},
		};

		registerHarness(customAdapter);
		expect(hasHarness("custom-test")).toBe(true);
		expect(getHarness("custom-test")?.displayName).toBe("Custom Test Adapter");
	});
});
