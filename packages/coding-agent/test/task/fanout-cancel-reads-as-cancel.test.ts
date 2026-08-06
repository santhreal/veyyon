import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { TaskTool } from "@veyyon/coding-agent/task";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@veyyon/coding-agent/task/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

/**
 * A cancelled fan-out reads as cancelled, not as a batch that failed.
 *
 * WHY THIS SUITE EXISTS. `mapWithConcurrencyLimit` does not throw on abort, by
 * design: it stops picking up new work, swallows the abort from the worker
 * function, and hands back a partial results array with holes. The fan-out then
 * merged those payloads and set `isError` from a single "did any child fail"
 * predicate, which counted a cancelled child as a failed one. So a five-agent
 * fan-out that the operator stopped after three finished arrived at the parent
 * model shaped EXACTLY like one where two agents crashed.
 *
 * That shape is worse than unhelpful. A parent reading "some agents failed"
 * re-runs the work that was just cancelled on purpose, and the three transcripts
 * it did receive sit underneath a claim that something went wrong. The tool knew
 * the difference the whole time and threw it away one line later: the async path
 * already wrote `status = "aborted"`, and `classifySubagentOutcome` already had
 * an `aborted` kind.
 *
 * WHY NOT THROW, which is how the sibling cancellation bugs were fixed. For eval
 * and for the tool wrappers, throwing was right because the cancelled work had
 * nothing worth keeping. Here it does: an operator who stops a five-agent
 * fan-out after three completed WANTS those three transcripts, and they are far
 * too large to carry inside an error message. So the result still resolves, and
 * it says what happened instead.
 *
 * The suite drives the real `TaskTool` down to the executor seam rather than
 * testing the summary function, which `subagent-failure-surfaced.test.ts` covers.
 * What is asserted here is the end-to-end tool result: the flag, the headline,
 * and that the completed children's output is still in it.
 */

// Spawning a task writes a session under the ACTIVE PROFILE's agent dir, so
// without this the suite creates them inside the developer's real
// `~/.veyyon/profiles/<profile>/agent`.
useIsolatedAgentDir();

const taskAgent: AgentDefinition = {
	name: "deep",
	description: "End-to-end worker agent",
	systemPrompt: "You are a worker agent.",
	source: "bundled",
};

function createSession(settings: Record<string, unknown> = {}): ToolSession {
	return makeToolSession({
		cwd: "/tmp",
		hasUI: false,
		// Serial spawns, so a fan-out stopped part way through is a state this suite
		// can actually reach. At the default concurrency all five start at once, and
		// then there is no such thing as a spawn cancelled before it started.
		settings: Settings.isolated({
			"async.enabled": false,
			"subagent.batch": true,
			"subagent.maxConcurrency": 1,
			...settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
	});
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "deep",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} finished.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
}

function fiveTasks(): TaskParams {
	return {
		context: "# Goal\nFive agents.",
		tasks: [
			{ name: "One", task: "Do 1." },
			{ name: "Two", task: "Do 2." },
			{ name: "Three", task: "Do 3." },
			{ name: "Four", task: "Do 4." },
			{ name: "Five", task: "Do 5." },
		],
	} as TaskParams;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

/**
 * Run five serial spawns where two finish, the third is cancelled MID-FLIGHT, and
 * the remaining two never start.
 *
 * BOTH KINDS OF CANCELLATION HAVE TO BE PRESENT, and the mid-flight one is the
 * load-bearing half. A spawn cancelled before it starts leaves no `SingleResult`
 * behind, so it was never classified and never reached the old failure predicate;
 * a scenario built only from those would have passed before this fix and proved
 * nothing. The third spawn returns a result carrying `aborted`, which is exactly
 * what the old predicate turned into "some agents failed".
 */
async function runCancelledMidFlight() {
	mockDiscovery();
	const controller = new AbortController();
	const started: string[] = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		const id = options.id ?? "?";
		started.push(id);
		if (started.length < 3) return makeResult(id);
		// The third one is interrupted while running: the signal fires and it comes
		// back settled-but-aborted, with nothing to show for itself.
		controller.abort();
		return makeResult(id, { aborted: true, output: "" });
	});
	const tool = await TaskTool.create(createSession());
	const result = await tool.execute("tc-cancel", fiveTasks(), controller.signal);
	return { result, started };
}

describe("a fan-out cancelled part way through", () => {
	/**
	 * THE HEADLINE FAILURE. `isError` said the batch had failed, which is a claim
	 * about the agents rather than about the operator stopping them.
	 */
	it("does not report a cancelled batch as an error", async () => {
		const { result } = await runCancelledMidFlight();

		expect(result.isError).toBeFalsy();
	});

	/**
	 * The reader has to be told, or three transcripts read as the whole answer
	 * rather than as three fifths of one. The count is the part that carries it:
	 * "cancelled" alone would not say how much is missing.
	 */
	it("says how many of the five agents actually completed", async () => {
		const { result } = await runCancelledMidFlight();

		// Two finished, one was interrupted while running, two never started. All
		// three of those are cancellations and none of them is a failure.
		expect(firstText(result)).toContain("2 of 5 agents completed, 3 cancelled.");
	});

	/**
	 * The completed work is still returned. This is the reason the fix is not the
	 * throw used for the sibling cancellation bugs, so it is asserted rather than
	 * assumed: a fix that turned cancellation into a rejection would satisfy the
	 * two cases above and lose the three transcripts the operator wanted.
	 */
	it("still returns the output of the agents that finished", async () => {
		const { result } = await runCancelledMidFlight();
		const text = firstText(result);

		expect(text).toContain("One finished.");
		expect(text).toContain("Two finished.");
		// Three settled, so it has a result row, and it produced no output because it
		// was interrupted. Both facts have to survive: dropping the row would lose the
		// only record that a third agent was ever running.
		expect(result.details?.results).toHaveLength(3);
		expect(result.details?.results.map(item => item.id)).toEqual(["One", "Two", "Three"]);
	});

	/** The ones that never ran are named, so it is clear which work is outstanding. */
	it("names the spawns that never started", async () => {
		const { result } = await runCancelledMidFlight();
		const text = firstText(result);

		expect(text).toContain("Task Four: cancelled before start.");
		expect(text).toContain("Task Five: cancelled before start.");
	});

	/**
	 * The premise of every case above: the cancellation really did stop the fan-out
	 * early. Without this, a run where all five executed would still satisfy the
	 * "still returns the output" case and quietly weaken the rest.
	 */
	it("stops spawning once the signal aborts", async () => {
		const { started } = await runCancelledMidFlight();

		expect(started).toEqual(["One", "Two", "Three"]);
	});
});

describe("a fan-out that genuinely failed", () => {
	/**
	 * NON-VACUITY, and the case a fix could most easily break: a real failure must
	 * still read as one. Making `isError` false for cancellation is only correct if
	 * it stays true here, otherwise the flag has simply been switched off.
	 */
	it("still reports an error when a child exits non-zero", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			return id === "Two" ? makeResult(id, { exitCode: 1, stderr: "boom" }) : makeResult(id);
		});
		const tool = await TaskTool.create(createSession());

		const result = await tool.execute("tc-fail", {
			context: "# Goal\nTwo agents.",
			tasks: [
				{ name: "One", task: "Do 1." },
				{ name: "Two", task: "Do 2." },
			],
		} as TaskParams);

		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("1 of 2 agents completed, 1 failed.");
	});

	/**
	 * And a clean batch says nothing extra. A headline on every result is one a
	 * reader stops seeing, which would cost the cancelled case its only signal.
	 */
	it("adds no summary line when every agent completed", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));
		const tool = await TaskTool.create(createSession());

		const result = await tool.execute("tc-clean", {
			context: "# Goal\nTwo agents.",
			tasks: [
				{ name: "One", task: "Do 1." },
				{ name: "Two", task: "Do 2." },
			],
		} as TaskParams);

		expect(result.isError).toBeFalsy();
		expect(firstText(result)).not.toContain("agents completed");
		expect(firstText(result)).toContain("One finished.");
	});
});
