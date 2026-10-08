/**
 * Agents whose tools share a description share one copy of the provider-bound description
 * `normalizeTools` builds from it, whichever way it is built: passed through with no examples
 * dialect, with an examples block appended in each dialect, or pruned.
 *
 * WHY: every spawned agent holds a stable prefix of the tool list normalized for it, and appending
 * the examples block made a new string of every description that has examples. Forty live
 * subagents each held their own copy of the eval, launch, search, irc, debug and ast_edit
 * descriptions, 5 to 9 KiB apiece. `normalizeTools` is the one place the provider-bound description
 * is built, so the suite measures there, through the prefix that holds it.
 *
 * String bytes are read in a fresh process (`fixtures/normalized-tool-description-growth.ts`), since
 * in the test runner garbage other files left behind is freed inside the measured window. The plain
 * arm holds the same number of separately built texts with no agent, which proves the measurement
 * sees them. Every entry of `DIALECTS` is measured, so a dialect added there is swept with no edit
 * here, and each dialect arm must take the appending path.
 *
 * NOT CAUGHT: a transform added to `normalizeTools` that builds a description some other way than
 * these three is not measured until an arm drives it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { DIALECTS } from "@veyyon/catalog/identity";
import { AGENTS, CHARS, type DescriptionGrowth } from "./fixtures/normalized-tool-description-growth";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "fixtures", "normalized-tool-description-growth.ts");

/** Up to forty-five heap snapshots of a process that loads the agent package. */
const MEASURED_TIMEOUT_MS = 90_000;

const DIALECT_WAYS = DIALECTS.map(dialect => `the ${dialect} dialect`);

let growth: DescriptionGrowth;

beforeAll(async () => {
	const { stdout, stderr } = await run(process.execPath, [FIXTURE], {
		timeout: MEASURED_TIMEOUT_MS - 5_000,
		killSignal: "SIGKILL",
	});
	expect(stderr).toBe("");
	growth = JSON.parse(stdout) as DescriptionGrowth;
}, MEASURED_TIMEOUT_MS);

describe("live agents share equal tool descriptions", () => {
	it("sees every separately built text in the plain arm", () => {
		expect(growth.plain).toBeGreaterThan((AGENTS / 2) * CHARS);
	});

	it("measures no dialect, pruning and every dialect", () => {
		expect(Object.keys(growth.ways).sort()).toEqual(["no dialect", "pruned", ...DIALECT_WAYS].sort());
	});

	for (const way of ["no dialect", "pruned"]) {
		it(`holds one copy when the description is built with ${way}`, () => {
			expect(growth.ways[way]?.grown).toBeLessThan(growth.plain / 10);
		});
	}

	for (const way of DIALECT_WAYS) {
		it(`holds one copy when the examples block is appended in ${way}`, () => {
			expect(growth.ways[way]?.appended).toBe(true);
			expect(growth.ways[way]?.grown).toBeLessThan(growth.plain / 10);
		});
	}
});
