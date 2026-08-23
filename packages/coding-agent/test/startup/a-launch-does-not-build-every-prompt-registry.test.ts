/**
 * WHY THIS EXISTS. Prompt assembly refused an unknown `VEYYON_EVAL_PROMPTS` id by reading
 * `prompts/all-registries.ts`, the aggregate of every prompt registry in four packages,
 * whose own graph is 250 modules. `system-prompt.ts` is on the launch path, so every
 * session constructed all four registries and 197 prompt rows to validate an environment
 * variable almost no session sets: the assembler reached 718 modules with that edge and
 * 528 without it, and `main.ts` 1605 against 1576, on a bundled binary that spends about
 * 290ms initializing modules before it draws anything.
 *
 * The refusal now reads `prompts/ids.generated.ts` — the id space and no prompt text.
 *
 * THE CLASS THIS CLOSES. Not "one import was removed" but "the launch path reaches an
 * aggregate it needs at most one field of". The reach numbers below are measured on the
 * real graph, so any new edge from a launch module into the registries, the prompt-listing
 * CLI or a sibling aggregate turns this red, whoever adds it and wherever it sits.
 *
 * WHAT IT DOES NOT CATCH. A launch module that imports one directory's rows module
 * directly is invisible here and is meant to be: a module that sends a prompt has to carry
 * that prompt's text, which is most of why removing this edge cost the launch 29 modules
 * and the assembler 190. This gate is about the whole-registry aggregate, and about the
 * two totals, which is why the ceilings are here as well as the named file.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReach,
	moduleReachCount,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dirname, "..", "..", "src");
const REPO_ROOT = path.resolve(SRC, "..", "..", "..");
const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

/** The CLI entry a launch runs, and the assembler that used to hold the edge. */
const LAUNCH = path.join(SRC, "main.ts");
const ASSEMBLER = path.join(SRC, "system-prompt.ts");
const AGGREGATE = path.join(SRC, "prompts", "all-registries.ts");

/**
 * Measured at 1576, down from 1605. A ratchet, not a target: nothing breaks when it grows,
 * which is exactly why it is pinned. The margin is small on purpose — 24 modules is a
 * barrel someone reached for, not a feature.
 */
const LAUNCH_REACH_CEILING = 1600;

/**
 * Measured at 528, down from 718. The assembler is the module the edge was on, so this is
 * the number that moved, and a subprocess that imports it alone pays it directly.
 */
const ASSEMBLER_REACH_CEILING = 560;

function reached(entry: string): string[] {
	return [...moduleReach(entry, RESOLUTION, CACHE)].map(file => path.relative(REPO_ROOT, file)).sort();
}

describe("a launch does not build every prompt registry", () => {
	it("never reaches the registry aggregate", () => {
		const files = reached(LAUNCH);
		const aggregate = path.relative(REPO_ROOT, AGGREGATE);

		expect(files, `${aggregate} is on the launch graph again`).not.toContain(aggregate);
	});

	it("never reaches it from prompt assembly either, which is where the edge was", () => {
		const files = reached(ASSEMBLER);

		expect(files).not.toContain(path.relative(REPO_ROOT, AGGREGATE));
	});

	it(`keeps the launch graph at or under ${LAUNCH_REACH_CEILING} modules`, () => {
		const total = moduleReachCount(LAUNCH, RESOLUTION, CACHE);

		expect(total, `modules reachable from main.ts:\n${reached(LAUNCH).join("\n")}`).toBeLessThanOrEqual(
			LAUNCH_REACH_CEILING,
		);
	});

	it(`keeps prompt assembly at or under ${ASSEMBLER_REACH_CEILING} modules`, () => {
		const total = moduleReachCount(ASSEMBLER, RESOLUTION, CACHE);

		expect(total, `modules reachable from system-prompt.ts:\n${reached(ASSEMBLER).join("\n")}`).toBeLessThanOrEqual(
			ASSEMBLER_REACH_CEILING,
		);
	});

	it("still reaches the id list the refusal reads, so the check did not go missing", () => {
		const files = reached(ASSEMBLER);

		expect(files).toContain(path.relative(REPO_ROOT, path.join(SRC, "prompts", "ids.generated.ts")));
	});

	it("leaves the aggregate reachable for the surfaces that want every registry", () => {
		const listing = reached(path.join(SRC, "cli", "prompt-cli.ts"));

		expect(listing).toContain(path.relative(REPO_ROOT, AGGREGATE));
	});
});
