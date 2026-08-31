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
 * case below measures the graph as a whole rather than trusting the list to stay complete. And the
 * budget is a comparison, so a barrel that grows buys the graph room: the four barrels growing by
 * as much as the graph does leaves the ratio where it was. The per-barrel cases are what catch the
 * launch paying for a barrel at all, and this one catches the graph outgrowing what it declined.
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
 * The whole shell graph, and the barrel set it must not touch, measured in ONE child process so
 * both numbers come off the same host under the same load.
 *
 * The budget was an absolute 100ms, which is a claim about the machine as much as about the code:
 * the graph reads 63ms on an idle workstation and 137ms on a contended runner sharing its cores
 * with the rest of a test bucket, so the cell failed while every per-barrel case above passed --
 * no barrel edge existed and the overage was the host. Contention only ever ADDS time, and it adds
 * it to both readings, so the RATIO between them survives a busy machine that the difference does
 * not.
 *
 * The ratio is also the sentence this file opens with: the barrel edges cost 83ms against a 63ms
 * shell graph, so a launch paid more for code the first frame does not draw than for code it does.
 * A shell graph that stays cheaper than the barrels it declined to evaluate is that defect being
 * absent, stated without a number anybody has to recalibrate.
 *
 * A barrel edge re-introduced anywhere under the graph moves its cost from the denominator into
 * the numerator -- the shell pays it, and the later import is then a cached map lookup -- so the
 * ratio moves twice as far as the cost itself.
 */
const SHELL_GRAPH_BARREL_RATIO = 1;

async function probe(code: string): Promise<number> {
	const { stdout } = await run("bun", ["-e", code], { cwd: repoRoot, maxBuffer: 1 << 24 });
	const elapsedMs = Number.parseFloat(stdout.trim().split("\n").at(-1) ?? "");
	if (!Number.isFinite(elapsedMs)) throw new Error(`probe printed no timing: ${stdout}`);
	return elapsedMs;
}

/** One paired reading: the shell graph, and the barrel set it declined to evaluate. */
interface GraphReading {
	shellMs: number;
	barrelMs: number;
}

/**
 * How many child processes the paired reading takes. The cleanest of them is the estimate of what
 * the code costs: a single sample measures the code AND whatever else the machine was doing, and a
 * shared CI runner supplies plenty of the second. Noise only ever ADDS time, so the run with the
 * cheapest shell graph is the run that had the most of the host to itself, and both halves of that
 * run's pair are taken together rather than best-of each — a numerator and a denominator from
 * different processes are not a ratio of anything.
 */
const GRAPH_SAMPLES = 3;

/**
 * Evaluate the shell graph, then the barrels, in one child process, and report both costs.
 *
 * The barrels are imported AFTER the graph on purpose: what that measures is the evaluation the
 * launch declined to pay, net of everything the graph already loaded, which is the figure the
 * budget is about. It is a lower bound on the barrels' full cost, so it makes the comparison
 * stricter rather than kinder.
 */
async function readGraphAgainstBarrels(): Promise<GraphReading> {
	const imports = ENTRIES.map(entry => `await import(${JSON.stringify(`./${entry}`)});`).join("\n");
	const barrels = BARRELS.map(barrel => `await import(${JSON.stringify(barrel)});`).join("\n");
	const { stdout } = await run(
		"bun",
		[
			"-e",
			`const shellStarted = performance.now();
${imports}
const shellMs = performance.now() - shellStarted;
const barrelStarted = performance.now();
${barrels}
const barrelMs = performance.now() - barrelStarted;
console.log(JSON.stringify({ shellMs, barrelMs }));`,
		],
		{ cwd: repoRoot, maxBuffer: 1 << 24 },
	);
	const printed: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
	const reading = printed as GraphReading | null;
	if (!reading || !Number.isFinite(reading.shellMs) || !Number.isFinite(reading.barrelMs)) {
		throw new Error(`probe printed no timings: ${stdout}`);
	}
	return reading;
}

async function cleanestOf(samples: number): Promise<GraphReading> {
	let best: GraphReading | null = null;
	for (let taken = 0; taken < samples; taken++) {
		const reading = await readGraphAgainstBarrels();
		if (!best || reading.shellMs < best.shellMs) best = reading;
	}
	if (!best) throw new Error("no sample was taken");
	return best;
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
	 *
	 * Both halves are asserted. The barrels have to cost something, or the comparison is between a
	 * measured graph and a rounding error: a denominator at zero would mean the graph had already
	 * evaluated all four, which is the defect this file exists for, and a ratio test that reads
	 * `Infinity < 1` as false catches it only by accident. Asserted directly instead.
	 */
	it("evaluates the whole shell graph for less than the barrels it skipped", async () => {
		const { shellMs, barrelMs } = await cleanestOf(GRAPH_SAMPLES);

		expect(barrelMs).toBeGreaterThan(CACHED_IMPORT_CEILING_MS * BARRELS.length);
		expect(shellMs).toBeLessThan(barrelMs * SHELL_GRAPH_BARREL_RATIO);
	}, 120_000);

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
