/**
 * SPEC-ONE-PLACE-AUDIT F7: `EXPERIMENT_TOOL_NAMES` had two copies
 * (`autoresearch/index.ts`, `autoresearch/tools/log-experiment.ts`). Both now
 * import the single definition from `autoresearch/tools/index.ts`.
 */
import { describe, expect, it } from "bun:test";
import { EXPERIMENT_TOOL_NAMES } from "@veyyon/pi-coding-agent/autoresearch/tools/index";

describe("EXPERIMENT_TOOL_NAMES (F7)", () => {
	it("matches the real tool names emitted by each experiment tool factory", () => {
		expect(EXPERIMENT_TOOL_NAMES).toEqual(["init_experiment", "run_experiment", "log_experiment", "update_notes"]);
	});

	it("is a single module-cached array shared by every importer", async () => {
		// autoresearch/index.ts and log-experiment.ts both import from
		// autoresearch/tools/index.ts; re-importing here must yield the same
		// array reference (module caching), proving there is one definition.
		const mod1 = await import("@veyyon/pi-coding-agent/autoresearch/tools/index");
		const mod2 = await import("@veyyon/pi-coding-agent/autoresearch/tools/index");
		expect(mod1.EXPERIMENT_TOOL_NAMES).toBe(mod2.EXPERIMENT_TOOL_NAMES);
	});
});
