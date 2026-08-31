/**
 * SPEC-ONE-PLACE-AUDIT F7: `EXPERIMENT_TOOL_NAMES` had two copies
 * (`autoresearch/index.ts`, `autoresearch/tools/log-experiment.ts`). Both now
 * import the single definition from `autoresearch/tools/index.ts`.
 *
 * The list gates which tools attach in autoresearch mode, so a tool missing
 * from it is registered and never reachable. This constructs every factory and
 * compares the names they actually emit, rather than restating the constant:
 * adding a tool without listing it turns this red, and so does listing a name
 * no factory emits.
 *
 * What it does not catch: a factory that exists but is never registered in
 * `autoresearch/index.ts`, and a second hardcoded copy of the list elsewhere.
 * Registration is asserted where the extension is built; the duplicate-copy
 * defect is held off by every consumer importing this module.
 */
import { describe, expect, it } from "bun:test";
import { createDashboardController } from "@veyyon/coding-agent/autoresearch/dashboard";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { createCertifyArmsTool } from "@veyyon/coding-agent/autoresearch/tools/certify-arms";
import { EXPERIMENT_TOOL_NAMES } from "@veyyon/coding-agent/autoresearch/tools/index";
import { createInitExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import { createLogExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/log-experiment";
import { createRunExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/run-experiment";
import { createUpdateNotesTool } from "@veyyon/coding-agent/autoresearch/tools/update-notes";
import type { AutoresearchToolFactoryOptions } from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI } from "@veyyon/coding-agent/extensibility/extensions";

// Every factory reads its options lazily, inside `execute`. Naming a tool needs
// none of them, so an unbuilt API is enough to enumerate the registry.
const options: AutoresearchToolFactoryOptions = {
	dashboard: createDashboardController(),
	getRuntime: () => createSessionRuntime(),
	pi: {} as ExtensionAPI,
};

const FACTORIES = [
	createInitExperimentTool,
	createRunExperimentTool,
	createLogExperimentTool,
	createUpdateNotesTool,
	createCertifyArmsTool,
];

describe("EXPERIMENT_TOOL_NAMES (F7)", () => {
	it("lists exactly the names the experiment tool factories emit", () => {
		const emitted = FACTORIES.map(factory => factory(options).name);
		expect([...EXPERIMENT_TOOL_NAMES].sort()).toEqual([...emitted].sort());
	});

	it("attaches every experiment tool as inactive by default", () => {
		// These tools are attached only in autoresearch mode. One that defaults
		// to active would ship in every ordinary session.
		for (const factory of FACTORIES) {
			const tool = factory(options);
			expect(tool.defaultInactive).toBe(true);
		}
	});
});
