import { describe, expect, it } from "bun:test";
import { Settings } from "../../config/settings";
import { loadHindsightConfig } from "./config";

describe("loadHindsightConfig retainContext (SPEC-MEMORY #3)", () => {
	it("defaults to veyyon, not the legacy omp tag", () => {
		const config = loadHindsightConfig(Settings.isolated({}), {});
		expect(config.retainContext).toBe("veyyon");
	});

	it("still honors an explicit legacy omp override persisted in an existing config.yml", () => {
		const config = loadHindsightConfig(Settings.isolated({ "hindsight.retainContext": "omp" }), {});
		expect(config.retainContext).toBe("omp");
	});

	it("honors any explicit custom retainContext override", () => {
		const config = loadHindsightConfig(Settings.isolated({ "hindsight.retainContext": "acme-corp" }), {});
		expect(config.retainContext).toBe("acme-corp");
	});
});

describe("loadHindsightConfig enumerated settings", () => {
	it("accepts a listed value from env or settings and falls back past an unlisted one", () => {
		const settings = Settings.isolated({
			"hindsight.retainMode": "last-turn",
			"hindsight.recallBudget": "high",
			"hindsight.scoping": "global",
		});
		const fromSettings = loadHindsightConfig(settings, {});
		expect([fromSettings.retainMode, fromSettings.recallBudget, fromSettings.scoping]).toEqual([
			"last-turn",
			"high",
			"global",
		]);

		const fromEnv = loadHindsightConfig(settings, {
			HINDSIGHT_RETAIN_MODE: "full-session",
			HINDSIGHT_RECALL_BUDGET: "low",
			HINDSIGHT_SCOPING: "per-project",
		});
		expect([fromEnv.retainMode, fromEnv.recallBudget, fromEnv.scoping]).toEqual([
			"full-session",
			"low",
			"per-project",
		]);

		// A value listed for one setting is not accepted by another: env is skipped, settings hold.
		const crossed = loadHindsightConfig(settings, {
			HINDSIGHT_RETAIN_MODE: "high",
			HINDSIGHT_RECALL_BUDGET: "global",
			HINDSIGHT_SCOPING: "last-turn",
		});
		expect([crossed.retainMode, crossed.recallBudget, crossed.scoping]).toEqual(["last-turn", "high", "global"]);

		const unlisted = loadHindsightConfig(
			Settings.isolated({
				"hindsight.retainMode": "everything",
				"hindsight.recallBudget": "max",
				"hindsight.scoping": "per-user",
			}),
			{},
		);
		expect([unlisted.retainMode, unlisted.recallBudget, unlisted.scoping]).toEqual([
			"full-session",
			"mid",
			"per-project-tagged",
		]);
	});
});
