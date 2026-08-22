/**
 * WHY: `VEYYON_EVAL_PROMPTS` exists so a bench arm can vary one registered prompt while
 * both arms run one built binary. Two ways for it to be worthless, and both had shipped:
 *
 * 1. IT REACHED NOTHING. A module that sends a prompt imports its row table directly
 *    (`toolsPrompts["tools/bash"].text`), and only the aggregate registry applied the
 *    override, so the variable announced itself loudly and changed no text a model was
 *    ever sent: `prompt --tools` reported the bash description at its shipped 971 tokens
 *    with the override active. An arm built on that measures its own control and the
 *    results table calls it a treatment — a zero-IV comparison wearing a name, which the
 *    fingerprint guard cannot see because the arm files really do differ.
 * 2. IT REFUSED A VALID ID. The unknown-id check used to live inside each registry,
 *    which cannot know whether an unclaimed id belongs to a sibling. `@veyyon/ai`'s
 *    registry is constructed first and holds no tool descriptions, so a valid
 *    `tools/bash` override killed the agent at startup and every trial of the arm
 *    hard-errored at zero output tokens.
 *
 * This suite drives the real CLI in a real child process, which is the only way to
 * observe either: the variable has to be set BEFORE the process starts, exactly as the
 * bench sets it around a container, because every registry is constructed at import.
 *
 * What it does not catch: delivery of the variable into a Docker container (deepswe-bench
 * stages the JSON, records it in `attachments.json`, and `pier_agent/arm_attachments.py`
 * turns that into the command prefix), and the per-accessor agreement inside one registry
 * (`@veyyon/utils` `eval-prompts-override-replaces-registry-text.test.ts`).
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PROMPT_ID_SHAPE_HINT } from "@veyyon/utils";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

/** A full CLI run is seconds, not milliseconds, and four of them is the price of the proof. */
const SPAWN_TIMEOUT_MS = 120_000;

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runPrompt(args: readonly string[], overrides?: Record<string, string>): Promise<RunResult> {
	const { env, cleanup } = hermeticSpawnEnv(
		overrides === undefined ? undefined : { VEYYON_EVAL_PROMPTS: JSON.stringify(overrides) },
	);
	try {
		const child = Bun.spawn(["bun", cliPath, "prompt", ...args], { env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stdout, stderr };
	} finally {
		cleanup();
	}
}

/** The `desc` column of one row of `prompt --tools`, which is what a description costs a request. */
function descriptionTokens(table: string, tool: string): number {
	const row = table.split("\n").find(line => line.startsWith(`${tool} `));
	if (row === undefined) throw new Error(`no ${tool} row in:\n${table}`);
	const columns = row.trim().split(/\s+/);
	// tool, bytes, desc, schema, tokens, share
	const desc = Number(columns[2]);
	if (!Number.isFinite(desc)) throw new Error(`unparsable ${tool} row: ${row}`);
	return desc;
}

describe("an override of a prompt this package owns", () => {
	it(
		"changes what the tool description costs a request, not just what the registry reports",
		async () => {
			const shipped = await runPrompt(["--tools"]);
			expect(shipped.exitCode).toBe(0);
			const shippedBash = descriptionTokens(shipped.stdout, "bash");
			// The floor is what makes the delta mean something: a bash description that had
			// already collapsed to nothing would pass a "smaller than shipped" check forever.
			expect(shippedBash).toBeGreaterThan(500);

			const overridden = await runPrompt(["--tools"], { "tools/bash": "run a command" });

			expect(overridden.exitCode).toBe(0);
			expect(descriptionTokens(overridden.stdout, "bash")).toBeLessThan(20);
			// Only the named prompt moves. `read` is the neighbouring tool description and
			// the one that would drift if the override leaked across rows.
			expect(descriptionTokens(overridden.stdout, "read")).toBe(descriptionTokens(shipped.stdout, "read"));
			expect(overridden.stderr).toContain("EVAL-ONLY prompt override is ACTIVE");
		},
		SPAWN_TIMEOUT_MS,
	);

	it(
		"says nothing and changes nothing when the variable is not set",
		async () => {
			const shipped = await runPrompt(["--tools"]);

			expect(shipped.exitCode).toBe(0);
			expect(shipped.stderr).not.toContain("EVAL-ONLY");
		},
		SPAWN_TIMEOUT_MS,
	);
});

describe("an override of a prompt another package owns", () => {
	// One id per sibling registry, so a package whose prompts stop being reachable turns
	// this red rather than passing on the strength of its neighbour.
	const siblingIds = ["dialect/anthropic", "compaction/summarization-system", "prompt"];

	it.each(siblingIds)(
		"is accepted, because %s belongs to a registry this one cannot see",
		async (id: string) => {
			const result = await runPrompt(["--tools"], { [id]: "REPLACED BY THE SUITE" });

			expect(result.stderr).not.toContain("no registry holds");
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("EVAL-ONLY prompt override is ACTIVE");
		},
		SPAWN_TIMEOUT_MS,
	);
});

describe("an override no registry can claim", () => {
	it(
		"refuses the run, names the id, and suggests the id that exists",
		async () => {
			const result = await runPrompt([], { "tools/bsh": "TYPO" });

			expect(result.exitCode).not.toBe(0);
			const message = `${result.stdout}${result.stderr}`;
			expect(message).toContain("tools/bsh");
			expect(message).toContain("did you mean tools/bash");
			expect(message).toContain("no registry holds");
			// The same sentence the bench runner prints for the same mistake, from one owner:
			// an operator who hits this before a run and again inside one reads one rule.
			expect(message).toContain(PROMPT_ID_SHAPE_HINT);
		},
		SPAWN_TIMEOUT_MS,
	);
});
