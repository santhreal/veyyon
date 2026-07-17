import { describe, expect, it } from "bun:test";
import { Settings } from "../config/settings";
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
