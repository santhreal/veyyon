import { describe, expect, it } from "bun:test";
import { HarnessRegistry, hasHarness, listHarnessNames, requireHarness } from "../../src/core/harness-registry";
import { registerBuiltinHarnesses } from "../../src/harnesses";
import { factoryAdapter } from "../../src/harnesses/adapters/factory";
import { hermesAdapter } from "../../src/harnesses/adapters/hermes";
import { ompAdapter } from "../../src/harnesses/adapters/omp";
import { veyyonAdapter } from "../../src/harnesses/adapters/veyyon";

const builtinHarnesses = [veyyonAdapter, ompAdapter, factoryAdapter, hermesAdapter] as const;

describe("HarnessRegistry & Built-in Harnesses", () => {
	it("dynamically resolves every registered harness from the registry", () => {
		const harnessNames = listHarnessNames();
		expect(harnessNames.length).toBeGreaterThanOrEqual(4);

		// Every registered harness must be resolvable and match its registered name
		for (const name of harnessNames) {
			expect(hasHarness(name)).toBe(true);
			const harness = requireHarness(name);
			expect(harness.name).toBe(name);
			expect(typeof harness.displayName).toBe("string");
			expect(typeof harness.description).toBe("string");
		}
	});

	it("registerBuiltinHarnesses is idempotent and populates custom registries", () => {
		const custom = new HarnessRegistry();
		expect(custom.list().length).toBe(0);

		registerBuiltinHarnesses(custom);
		expect(custom.list().length).toBe(builtinHarnesses.length);

		// Second call must not throw
		expect(() => registerBuiltinHarnesses(custom)).not.toThrow();
		expect(custom.list().length).toBe(builtinHarnesses.length);
	});

	it("each built-in harness implements the HarnessAdapter contract with pier backend binding", () => {
		for (const harness of builtinHarnesses) {
			expect(typeof harness.name).toBe("string");
			expect(typeof harness.displayName).toBe("string");
			expect(typeof harness.description).toBe("string");
			expect(harness.capabilities).toBeDefined();

			// Pier backend binding must be defined
			const pierBinding = harness.backends.pier;
			expect(pierBinding).toBeDefined();
			expect(typeof pierBinding?.agentImportPath).toBe("string");
			expect(pierBinding?.agentImportPath?.length).toBeGreaterThan(0);
			expect(typeof pierBinding?.containerAssetsDir).toBe("string");
			expect(pierBinding?.containerAssetsDir?.startsWith("/")).toBe(true);

			// preflight and stageAssets methods exist
			expect(typeof harness.preflight).toBe("function");
			expect(typeof harness.stageAssets).toBe("function");
		}
	});
	it("veyyon harness explicitly binds pier, harbor, and in-process backends", () => {
		expect(veyyonAdapter.backends.pier).toBeDefined();
		expect(veyyonAdapter.backends.pier?.agentImportPath).toBe("veyyon_agent:VeyyonAgent");
		expect(veyyonAdapter.backends.harbor).toBeDefined();
		expect(veyyonAdapter.backends.harbor?.agentImportPath).toBe("veyyon_local:VeyyonLocal");
		expect(veyyonAdapter.backends["in-process"]).toBeDefined();
	});

	it("preflight returns a valid PreflightVerdict for built-in harnesses", async () => {
		for (const harness of builtinHarnesses) {
			const verdict = await harness.preflight({ backend: "pier" });
			expect(typeof verdict.ok).toBe("boolean");
			if (!verdict.ok) {
				expect(Array.isArray(verdict.missingRequirements)).toBe(true);
			}
		}
	});
});
