import { describe, expect, it, spyOn } from "bun:test";
import { AuthStorage } from "@veyyon/ai";
import type { EvalSuite } from "../../../engine/contracts";
import { suites } from "../../../engine/loaded-members";
import { Registry } from "../../../engine/member-registry";
import { deepSweSuite } from "../../../suites/deep-swe/main";

describe("DeepSweSuite", () => {
	it("satisfies EvalSuite contract with pier backend", () => {
		expect(deepSweSuite.id).toBe("deep-swe");
		expect(deepSweSuite.displayName).toBe("DeepSWE");
		expect(deepSweSuite.backend).toBe("pier");
		expect(typeof deepSweSuite.version).toBe("string");
		expect(typeof deepSweSuite.description).toBe("string");
	});

	it("resolves from suite registry via suites.require('deep-swe')", () => {
		expect(suites.has("deep-swe")).toBe(true);
		const suite = suites.require("deep-swe");
		expect(suite).toBe(deepSweSuite);
	});

	it("registers in a custom registry and registerOnce is idempotent", () => {
		const custom = new Registry<EvalSuite>("suite");
		expect(custom.has("deep-swe")).toBe(false);

		custom.register(deepSweSuite);
		expect(custom.has("deep-swe")).toBe(true);
		expect(custom.require("deep-swe")).toBe(deepSweSuite);

		// Calling registerOnce a second time must not throw DuplicateMemberError
		expect(() => custom.registerOnce(deepSweSuite)).not.toThrow();
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
		const reloadSpy = spyOn(AuthStorage.prototype, "reload").mockResolvedValue();
		const checkSpy = spyOn(AuthStorage.prototype, "checkCredentials").mockResolvedValue([
			{ id: 1, type: "oauth", provider: "anthropic", ok: true },
		]);
		try {
			const verdict = await deepSweSuite.preflight({
				options: { dryRun: true },
			});
			expect(typeof verdict.ok).toBe("boolean");
		} finally {
			reloadSpy.mockRestore();
			checkSpy.mockRestore();
		}
	});
});
