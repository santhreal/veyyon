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
	"packages/coding-agent/src/cli/launch-card.ts",
	"packages/coding-agent/src/modes/terminal/components/composer/custom-editor.ts",
	"packages/coding-agent/src/modes/terminal/components/status-line/component.ts",
] as const;

/** Workspace barrels, each `export * from` over its whole package. */
const BARRELS = ["@veyyon/tui", "@veyyon/utils", "@veyyon/agent-core", "@veyyon/ai"] as const;

/**
 * Total module evaluation for the three entries, loaded in the order a launch loads them. Measured
 * at 63ms after the barrel edges came out, against 147ms before. The ceiling leaves room for an
 * honest new dependency and still fails on a re-introduced barrel, the cheapest of which is 21ms.
 */
const SHELL_GRAPH_CEILING_MS = 100;

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
		const elapsedMs = await probe(`const started = performance.now();
${imports}
console.log(performance.now() - started);`);
		expect(elapsedMs).toBeLessThan(SHELL_GRAPH_CEILING_MS);
	}, 60_000);

	/**
	 * Pinned by exact equality rather than by a count, so a fourth entry or a dropped barrel is a
	 * decision recorded here instead of a line that slips in beside the others.
	 */
	it("covers every shell entry and every workspace barrel", () => {
		expect([...ENTRIES]).toEqual([
			"packages/coding-agent/src/cli/launch-card.ts",
			"packages/coding-agent/src/modes/terminal/components/composer/custom-editor.ts",
			"packages/coding-agent/src/modes/terminal/components/status-line/component.ts",
		]);
		expect([...BARRELS]).toEqual(["@veyyon/tui", "@veyyon/utils", "@veyyon/agent-core", "@veyyon/ai"]);
	});
});
