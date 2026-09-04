/**
 * WHY THIS EXISTS. The launch shell is the three modules a user waits on before the composer
 * accepts a keystroke: the launch card, the editor and the status row. Each one imported a
 * workspace barrel for two or three symbols, and a barrel is `export * from` over its whole
 * package -- `@veyyon/tui` is every component in the library, `@veyyon/utils` is 73 leaves,
 * `@veyyon/agent-core` is the agent runtime. Together those three edges cost 83ms of module
 * evaluation on this workspace, against a 63ms shell graph, so a launch spent more time
 * evaluating code the first frame does not draw than code it does.
 *
 * The individual offenders were `segments.ts` importing `ThinkingLevel` from the agent barrel
 * (69ms for one enum), `theme-class.ts` importing `colorEnabled` from the tui barrel, and a dozen
 * files importing `errorMessage` or `clamp01` from the utils barrel.
 *
 * THE CLASS THIS CLOSES. Not "three files imported a barrel" but "a launch pays a package's whole
 * evaluation for a symbol its own leaf owns". Each case imports one shell entry in a fresh process
 * and then times `import("<barrel>")`: an already-evaluated barrel answers in microseconds, an
 * unevaluated one costs its evaluation. So a new barrel edge ANYWHERE under the three shell graphs
 * turns this suite RED, including one added to a module ten edges deep that nobody thinks of as
 * startup code.
 *
 * WHAT IT DOES NOT CATCH. A leaf that grows expensive on its own -- importing `@veyyon/tui/utils`
 * is legal here however heavy that file becomes. It also says nothing about a fourth shell entry:
 * a module that joins the launch path has to be added to ENTRIES by hand, which is why the budget
 * case below measures the graph as a whole rather than trusting the list to stay complete.
 */

import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../../..");

/**
 * Milliseconds under which a second import means the module was already evaluated. Every barrel
 * below evaluates in tens of milliseconds cold and a cached import is a map lookup, so the band
 * between them is two orders of magnitude wide. Load makes an unevaluated import slower, never
 * faster, so a busy machine cannot turn this green.
 */
const CACHED_IMPORT_CEILING_MS = 3;

/** The modules a user waits on before the composer takes a keystroke. */
const ENTRIES = [
	"packages/coding-agent/src/startup/launch-card.ts",
	"packages/coding-agent/src/modes/components/custom-editor.ts",
	"packages/coding-agent/src/modes/components/status-line/component.ts",
] as const;

/** Workspace barrels, each `export * from` over its whole package. */
const BARRELS = ["@veyyon/tui", "@veyyon/utils", "@veyyon/agent-core", "@veyyon/ai"] as const;

/**
 * First-party modules the three entries evaluate, counted from `require.cache` in a fresh process.
 * A count and not a millisecond budget: the same graph evaluates in 63ms on a workstation and in
 * 478ms on a shared runner reading the tree over NFS, so a wall-clock ceiling failed on machine
 * speed instead of on a regression, while the module set is byte-identical on both. Measured at 333
 * with the barrel edges out. The cheapest barrel edge that could return, `@veyyon/tui`, adds 16
 * modules on top of the leaves the shell already evaluates, so the ceiling sits under that and
 * still leaves room for a handful of honest new leaves.
 */
const SHELL_GRAPH_MODULE_CEILING = 350;

async function probe(code: string): Promise<number> {
	const { stdout } = await run("bun", ["-e", code], { cwd: repoRoot, maxBuffer: 1 << 24 });
	const elapsedMs = Number.parseFloat(stdout.trim().split("\n").at(-1) ?? "");
	if (!Number.isFinite(elapsedMs)) throw new Error(`probe printed no timing: ${stdout}`);
	return elapsedMs;
}

function barrelIsEvaluatedAfter(entry: string, barrel: string): Promise<number> {
	return probe(`await import(${JSON.stringify(`./${entry}`)});
const started = performance.now();
await import(${JSON.stringify(barrel)});
console.log(performance.now() - started);`);
}

describe("the launch shell does not evaluate a package barrel", () => {
	for (const entry of ENTRIES) {
		for (const barrel of BARRELS) {
			it(`loads ${entry.replace("packages/coding-agent/src/", "")} without evaluating ${barrel}`, async () => {
				expect(await barrelIsEvaluatedAfter(entry, barrel)).toBeGreaterThan(CACHED_IMPORT_CEILING_MS);
			}, 60_000);
		}
	}

	/**
	 * The whole-graph number, so a cost that arrives through a leaf rather than a barrel is still
	 * visible. This is the figure the shell is actually budgeted against; the per-barrel cases above
	 * name the usual cause when it moves.
	 */
	it("evaluates the whole shell graph within its budget", async () => {
		const imports = ENTRIES.map(entry => `await import(${JSON.stringify(`./${entry}`)});`).join("\n");
		const modules = await probe(`${imports}
console.log(Object.keys(require.cache).filter(p => !p.includes("node_modules")).length);`);
		expect(modules).toBeLessThan(SHELL_GRAPH_MODULE_CEILING);
	}, 60_000);

	/**
	 * Pinned by exact equality rather than by a count, so a fourth entry or a dropped barrel is a
	 * decision recorded here instead of a line that slips in beside the others.
	 */
	it("covers every shell entry and every workspace barrel", () => {
		expect([...ENTRIES]).toEqual([
			"packages/coding-agent/src/startup/launch-card.ts",
			"packages/coding-agent/src/modes/components/custom-editor.ts",
			"packages/coding-agent/src/modes/components/status-line/component.ts",
		]);
		expect([...BARRELS]).toEqual(["@veyyon/tui", "@veyyon/utils", "@veyyon/agent-core", "@veyyon/ai"]);
	});
});
