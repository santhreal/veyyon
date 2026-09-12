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

const SRC = path.join(import.meta.dirname, "..", "..", "..", "src");
const REPO_ROOT = path.resolve(SRC, "..", "..", "..");
const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

/** The CLI entry a launch runs, and the assembler that used to hold the edge. */
const LAUNCH = path.join(SRC, "main.ts");
const ASSEMBLER = path.join(SRC, "system-prompt.ts");
const AGGREGATE = path.join(SRC, "prompts", "all-registries.ts");

/**
 * Measured at 1624 against the merge base's 1581. Two of the extra modules are the
 * catalog OpenCode discovery header leaf this branch absorbed with origin/main;
 * six are `contracts/model`, whose leaves (`effort`, `instrumentation`,
 * `message`, `model`, `service-tier`, `stream-block`) sit on the graph beside the
 * `ai` and `catalog` modules that re-export them; two are the shell domain's
 * message kinds, which ride on its manifest so a transcript with a `!` command
 * converts wherever the tool table loads: `tools/shell/execution-messages` and the
 * kernel's `session/message-kinds` table. One is `export/html/tool-views.generated.js`,
 * the gitignored bundle the HTML export imports as text: the walker counts a file
 * that exists and skips one that does not, so a tree where the bundle has been built
 * measures one higher than a fresh checkout. One is the kernel's settings registry,
 * `kernel/settings/schema`, which the product composer `config/settings-schema`
 * registers its domain tables into: the queries moved out of the composer into the
 * registry, so the same code is two modules where it was one. Two more are the kernel's
 * settings store, `kernel/settings/store`, and the setting signal, `kernel/settings/signal`,
 * which the product store `config/settings` subclasses and re-exports: the layered file
 * store moved out of the product module, so again the same code is two modules where it
 * was one. `contracts/host`, `contracts/session` and `contracts/tool` are reached by type
 * only and do not count. The number is modules, so a split raises it while the code the
 * launch runs is the same, and re-pinning here is the decision that growth is supposed to
 * force.
 *
 * RE-MEASURED 2026-09-11 at 1637, up from 1624: 93 modules arrived and 79 left. What left is
 * the eval kernels and their bridges (`eval/*`, 41 modules, no longer on the launch path), the
 * `@veyyon/ai` barrel and the twelve provider and auth modules only it reached, the vibe tool and
 * its runtime, `catalog/registry-snapshot`, `kernel/session/auth-storage` and `utils/html-markdown`.
 * What arrived, by group: every tool card as a view the host draws (`tools/<domain>/<tool>-view.ts`,
 * `tools/view-registry.ts`, `presentation/{read-group,tool-call-preview,tool-execution,web-tool-display}.ts`,
 * `edit/edit-view.ts`, `goals/goal-view.ts`, `task/task-view.ts`, `tools/core/{json-tree-render,list-limit}.ts`,
 * `tools/search/search-card-limits.ts`, `tools/web/read-url-target.ts`), each a sibling of a tool module
 * that was already reached; the subagent surfaces renamed to agent (`prompts/agent/*`,
 * `settings-domains/agents.ts`, the two agent tool-policy statements) plus the task modules split out
 * beside them (`task/{agent-settings,agent-stats,model-selector,outcome,repair-args,task-id}.ts`);
 * six engine leaves (`components/form.ts`, `utils/{border,hover-controller,scroll-layout,search-filter,text-layout}.ts`)
 * and three `contracts/wire` leaves (`collab-link`, `presentation/theme`, `task-result`); the hashline
 * operations table and the edit modules that read it (`plugins/hashline/src/operations.ts`,
 * `edit/hashline/{block-resolver,diff}.ts`, `edit/streaming.ts`); the product's own tool-event input
 * (`extensibility/tool-event-input.ts`, replacing the kernel's); the utils leaves the launch now reads
 * (`cli-usage-error`, `fs-tool-args`, `github-check-run`, `json-snapshot`, `tab-width`, `terminal-emulator`);
 * and the staged compaction absorbed from origin/main (`agent/compaction/staged-summary.ts` and its two
 * prompt bodies) with `ai/providers/initial-message.ts` and `catalog/discovery/failure.ts`. The rest are
 * one-file terminal and session helpers (`config/settings-signals`, `debug/session-snapshot`,
 * `internal-urls/resolve-sync`, `modes/terminal/{launch-formatting,draw/utils,utils/async-tool-state}`,
 * `components/{dialogs/plan-toc,selectors/select-list-mouse-routing,status-line/location-context}`,
 * `session/account-format`, `slash-commands/helpers/mcp-args`, `subprocess/worker-request-client`,
 * `thinking/constants`).
 *
 * RE-MEASURED 2026-09-11 at 1639, up from 1637: `@veyyon/view` grew its first value export,
 * `UNICODE_SYMBOLS`, the glyph table the terminal, the GUI host and the HTML export draw from,
 * so the walker now counts `contracts/view/src/index.ts` and `contracts/view/src/symbols.ts`,
 * which it skipped while the package was reached by type only.
 *
 * A ratchet, not a target: nothing breaks when it grows, which is exactly why it is pinned. There
 * is no margin left on purpose — the next module on this graph is a barrel someone reached for
 * and owes a line here.
 */
const LAUNCH_REACH_CEILING = 1639;

/**
 * Measured at 498, down from 538 at the merge base and 718 before the aggregate edge was cut. The
 * assembler is the module the edge was on, so this is the number that moved, and a subprocess that
 * imports it alone pays it directly.
 */
const ASSEMBLER_REACH_CEILING = 520;

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
