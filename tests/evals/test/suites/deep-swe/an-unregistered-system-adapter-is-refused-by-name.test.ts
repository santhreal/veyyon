import { describe, expect, it } from "bun:test";
import type { HarnessAdapter } from "../../../engine/contracts";
import { harnesses, validateHarnessSelection } from "../../../engine/loaded-members";

describe("system adapter registry", () => {
	it("lists all default registered adapters", () => {
		const adapters = harnesses.ids();
		expect(adapters).toContain("veyyon");
		expect(adapters).toContain("factory");
		expect(adapters).toContain("hermes");
		expect(adapters).toContain("omp");
	});

	it("retrieves adapters by name", () => {
		const veyyon = harnesses.get("veyyon");
		expect(veyyon).toBeDefined();
		expect(veyyon?.id).toBe("veyyon");

		const omp = harnesses.get("omp");
		expect(omp).toBeDefined();
		expect(omp?.id).toBe("omp");
	});

	it("validates valid system selections", () => {
		const result = validateHarnessSelection(["veyyon", "omp"]);
		expect(result.valid).toBe(true);
		expect(result.unknown).toEqual([]);
	});

	it("identifies invalid system selections", () => {
		const result = validateHarnessSelection(["veyyon", "unknown-system"]);
		expect(result.valid).toBe(false);
		expect(result.unknown).toEqual(["unknown-system"]);
	});

	it("allows registering custom adapters", () => {
		const customAdapter: HarnessAdapter = {
			id: "custom-test",
			displayName: "Custom Test Adapter",
			description: "Custom test adapter for unit test",
			flags: [],
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

		harnesses.register(customAdapter);
		expect(harnesses.has("custom-test")).toBe(true);
		expect(harnesses.get("custom-test")?.displayName).toBe("Custom Test Adapter");
	});
});
