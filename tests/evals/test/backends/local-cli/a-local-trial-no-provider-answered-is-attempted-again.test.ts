/**
 * WHY: a local-cli trial whose agent measured nothing is infrastructure and is attempted again; one
 * that took turns is an outcome and is graded. The backend told them apart by counting assistant
 * messages, but a request the provider fails (a refused sign-in, an exhausted rate limit, a dropped
 * connection) still ends in an assistant message, with `stopReason: "error"`. A trial whose every
 * request failed therefore counted a turn, was graded as the agent failing the task, and was never
 * attempted again. Its error text also quoted the agent's stderr, and a stderr saying "Request timed
 * out." read to the retry rule as the trial's own deadline.
 *
 * The cases run the real backend with a harness whose command prints a scripted event stream and
 * exits, and ask the run's own retry rule about what the backend threw: a trial that no request
 * reached is retried whatever its stderr says, and a trial that took a turn before a request failed
 * is graded with that one turn.
 *
 * Not caught: a provider that answers with a message and a zero-token usage, which reads as a turn.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { LocalCliBackend } from "../../../backends/local-cli/main";
import { isRetryableTrialFailure } from "../../../engine/trial/retry";
import { oneTrialRun, probeHarness } from "./probe-fixtures";

/** The message a failed provider request ends in, as the agent loop emits it. */
const FAILED_REQUEST = {
	type: "message_end",
	message: {
		role: "assistant",
		stopReason: "error",
		errorMessage: "Request timed out.",
		content: [{ type: "text", text: "" }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	},
};

const ANSWERED_REQUEST = {
	type: "message_end",
	message: {
		role: "assistant",
		stopReason: "toolUse",
		content: [
			{ type: "text", text: "looking" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
		],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	},
};

/** An agent that prints `events`, says why it stopped on stderr, and exits 1, as print mode does on an error. */
function agentPrinting(events: readonly unknown[]): string {
	return `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
process.stderr.write("Request timed out.\\n");
process.exit(1);
`;
}

async function runAgent(root: string, events: readonly unknown[]) {
	const tree = path.join(root, "tree");
	await fs.mkdir(tree, { recursive: true });
	await fs.writeFile(path.join(tree, "agent.ts"), agentPrinting(events));
	const { context, cell } = oneTrialRun({
		root,
		suite: "no-answer-probe",
		harness: probeHarness(tree, "agent.ts"),
		build: tree,
	});
	return await new LocalCliBackend().runTrial(cell, context);
}

describe("a local trial", () => {
	it("that no request reached is thrown as infrastructure and attempted again", async () => {
		await using dir = await TempDir.create("@evals-local-cli-no-answer-");

		const failure = await runAgent(dir.path(), [FAILED_REQUEST, FAILED_REQUEST]).then(
			() => null,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("exited with code 1");
		expect(isRetryableTrialFailure(failure)).toBe(true);
	});

	it("that took a turn before a request failed is graded, with that one turn", async () => {
		await using dir = await TempDir.create("@evals-local-cli-one-answer-");

		const artifacts = await runAgent(dir.path(), [ANSWERED_REQUEST, FAILED_REQUEST]);

		expect(artifacts.extra?.exitCode).toBe(1);
		expect(artifacts.usage?.extra).toEqual({ turns: 1, toolCalls: 1 });
		expect(artifacts.usage?.inputTokens).toBe(10);
	});
});
