import { describe, expect, it } from "bun:test";
import { hasSuite, requireSuite, SuiteRegistry } from "../../../src/core/suite-registry";
import { registerDeepSweSuite } from "../../../src/suites/deep-swe/register";
import { deepSweSuite } from "../../../src/suites/deep-swe/suite";

describe("DeepSweSuite", () => {
	it("satisfies EvalSuite contract with pier backend", () => {
		expect(deepSweSuite.name).toBe("deep-swe");
		expect(deepSweSuite.displayName).toBe("DeepSWE");
		expect(deepSweSuite.backend).toBe("pier");
		expect(typeof deepSweSuite.version).toBe("string");
		expect(typeof deepSweSuite.description).toBe("string");
	});

	it("resolves from suite registry via requireSuite('deep-swe')", () => {
		expect(hasSuite("deep-swe")).toBe(true);
		const suite = requireSuite("deep-swe");
		expect(suite).toBe(deepSweSuite);
	});

	it("registerDeepSweSuite is idempotent and supports custom registries", () => {
		const custom = new SuiteRegistry();
		expect(custom.has("deep-swe")).toBe(false);

		registerDeepSweSuite(custom);
		expect(custom.has("deep-swe")).toBe(true);
		expect(custom.require("deep-swe")).toBe(deepSweSuite);

		// Calling a second time must not throw DuplicateSuiteRegistrationError
		expect(() => registerDeepSweSuite(custom)).not.toThrow();
		expect(custom.require("deep-swe")).toBe(deepSweSuite);
	});

	it("discovers tasks from explicit options or task file", async () => {
		const tasks = await deepSweSuite.discoverTasks({
			options: {
				tasks: ["task-one", "task-two"],
			},
		});
		expect(tasks).toEqual(["task-one", "task-two"]);
	});

	it("describes a task with time budget and instruction metadata", async () => {
		const desc = await deepSweSuite.describeTask("task-xyz", {});
		expect(desc.id).toBe("task-xyz");
		expect(desc.timeBudgetSec).toBeGreaterThan(0);
		expect(desc.metadata.suite).toBe("deep-swe");
	});

	it("returns dataset provenance", async () => {
		const prov = await deepSweSuite.provenance({});
		expect(prov.suite).toBe("deep-swe");
		expect(prov.version).toBe("1.0.0");
		expect(prov.sourceUrl).toContain("datacurve-ai/deep-swe");
	});

	it("scores trial from artifacts with missing trial dir gracefully", async () => {
		const score = await deepSweSuite.scoreTrial(
			{
				variant: "baseline",
				suite: "deep-swe",
				task: "smoke-task",
				repeat: 1,
			},
			{
				trialDir: "/nonexistent/trial/path",
				extra: { error: "failed to start container" },
			},
		);
		expect(score.reward).toBeNull();
		expect(score.error).toBe("failed to start container");
	});

	it("preflight returns a structured verdict", async () => {
		const verdict = await deepSweSuite.preflight({
			options: { dryRun: true },
		});
		expect(typeof verdict.ok).toBe("boolean");
	});
});
