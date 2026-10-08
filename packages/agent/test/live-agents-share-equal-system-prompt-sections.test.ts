/**
 * Agents holding equal system prompt sections share one copy of each, whichever way the prompt
 * arrives: the constructor's initial state, `setSystemPrompt` with parts, or with one string.
 *
 * WHY: a spawned agent stays live after it finishes, and forty of them each held their own copy of
 * the same conventions, project-context and role sections, about 120 KiB apiece. The sections are
 * built by concatenating rendered pieces, so interning the render alone does not share them.
 *
 * String bytes are read in a fresh process (`fixtures/agent-system-prompt-growth.ts`), since in the
 * test runner garbage other files left behind is freed inside the measured window. The plain arm holds
 * the same number of separately built sections with no agent, which proves the measurement sees them.
 * Every way in `WAYS` is measured, and a way added there without a maker fails the fixture's types.
 *
 * NOT CAUGHT: a caller that later replaces an element of `agent.state.systemPrompt` in place
 * bypasses the setter, and that part stays its own copy.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { AGENTS, CHARS, type PromptGrowth, WAYS } from "./fixtures/agent-system-prompt-growth";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "fixtures", "agent-system-prompt-growth.ts");

/** Twenty-four heap snapshots of a process that loads the agent package. */
const MEASURED_TIMEOUT_MS = 60_000;

let growth: PromptGrowth;

beforeAll(async () => {
	const { stdout, stderr } = await run(process.execPath, [FIXTURE], {
		timeout: MEASURED_TIMEOUT_MS - 5_000,
		killSignal: "SIGKILL",
	});
	expect(stderr).toBe("");
	growth = JSON.parse(stdout) as PromptGrowth;
}, MEASURED_TIMEOUT_MS);

describe("live agents share equal system prompt sections", () => {
	it("sees every separately built section in the plain arm", () => {
		expect(growth.plain).toBeGreaterThan((AGENTS / 2) * CHARS);
	});

	for (const way of WAYS) {
		it(`holds one copy when the prompt arrives through ${way}`, () => {
			expect(growth[way]).toBeLessThan(growth.plain / 10);
		});
	}
});
