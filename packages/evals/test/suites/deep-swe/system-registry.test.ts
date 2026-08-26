import { describe, expect, it } from "bun:test";
import {
	getSystemAdapter,
	hasSystemAdapter,
	listSystemAdapters,
	registerSystemAdapter,
	validateSystemSelection,
} from "../../../src/harnesses/registry";
import type { SystemAdapter } from "../../../src/harnesses/types";

describe("system adapter registry", () => {
	it("lists all default registered adapters", () => {
		const adapters = listSystemAdapters();
		expect(adapters).toContain("veyyon");
		expect(adapters).toContain("factory");
		expect(adapters).toContain("hermes");
		expect(adapters).toContain("omp");
	});

	it("retrieves adapters by name", () => {
		const veyyon = getSystemAdapter("veyyon");
		expect(veyyon).toBeDefined();
		expect(veyyon?.name).toBe("veyyon");

		const omp = getSystemAdapter("omp");
		expect(omp).toBeDefined();
		expect(omp?.name).toBe("omp");
	});

	it("validates valid system selections", () => {
		const result = validateSystemSelection(["veyyon", "omp"]);
		expect(result.valid).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.invalid).toEqual([]);
	});

	it("identifies invalid system selections", () => {
		const result = validateSystemSelection(["veyyon", "unknown-system"]);
		expect(result.valid).toBe(false);
		expect(result.invalid).toEqual(["unknown-system"]);
	});

	it("allows registering custom adapters", () => {
		const customAdapter: SystemAdapter = {
			name: "custom-test",
			displayName: "Custom Test Adapter",
			pierAgentImport: "custom_agent:CustomAgent",
			description: "Custom test adapter for unit test",
			supportsReplay: false,
			supportsCompaction: false,
			supportsArmAttachments: false,
			defaultModel: null,
			containerAssetsDir: "/opt/custom-assets",
			validatePreflight() {
				return { valid: true, errors: [], warnings: [] };
			},
			stageAssets() {},
			buildJobConfigKwargs() {
				return {};
			},
		};

		registerSystemAdapter(customAdapter);
		expect(hasSystemAdapter("custom-test")).toBe(true);
		expect(getSystemAdapter("custom-test")?.displayName).toBe("Custom Test Adapter");
	});
});
