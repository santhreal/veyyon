/**
 * WHY. The pipeline controller runs every agent of a swarm, and no test named it. Its two
 * load-bearing properties are both about what happens when something goes wrong, which is exactly
 * what a swarm that works cannot demonstrate.
 *
 * The first is containment. One agent throwing must become one failed result, carrying the reason,
 * while its wave-mates keep their own results and later waves still run. Without that the whole
 * swarm is lost to a single agent, and the operator gets an exception instead of the eight results
 * that did complete.
 *
 * The second is that the run is bounded by the abort signal. The signal is tested once per iteration
 * and once per wave, so a run that ignored it would keep spawning agents after the operator stopped
 * it, and the only visible symptom would be work continuing.
 *
 * The class this closes: an agent error escaping its wave, a non-zero exit recorded as success, an
 * error message that does not say which agent or which iteration, results dropped for agents that
 * never ran, an iteration count that disagrees with what actually happened, a lost concurrency
 * guarantee inside a wave, and an abort that is noticed late or not at all.
 *
 * The agent executor itself is replaced, because running it spawns real agent processes. Everything
 * else is the production path: the real controller, the real state tracker, and real files under a
 * temporary workspace.
 *
 * What it does not catch: whether an agent's own execution is correct, and how the waves were
 * derived, which is the DAG module's contract.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SingleResult } from "@veyyon/coding-agent";
import * as executor from "../src/swarm/executor";
import { PipelineController } from "../src/swarm/pipeline";
import type { SwarmAgent, SwarmDefinition, SwarmMode } from "../src/swarm/schema";
import { StateTracker } from "../src/swarm/state";

let spy: Mock<typeof executor.executeSwarmAgent> | undefined;
let workspace = "";

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pipeline-"));
});

afterEach(async () => {
	spy?.mockRestore();
	spy = undefined;
	await fs.rm(workspace, { recursive: true, force: true });
});

function succeeded(agent: SwarmAgent, index: number, output = "ok"): SingleResult {
	return {
		index,
		id: `id-${agent.name}-${index}`,
		agent: agent.name,
		agentSource: "project",
		task: agent.task,
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

function definition(names: readonly string[], mode: SwarmMode = "parallel", targetCount = 1): SwarmDefinition {
	const agents = new Map<string, SwarmAgent>();
	for (const name of names) {
		agents.set(name, { name, role: "worker", task: `do ${name}`, reportsTo: [], waitsFor: [] });
	}
	return { name: "swarm", workspace, mode, targetCount, agents, agentOrder: [...names] };
}

async function tracker(names: readonly string[], targetCount = 1): Promise<StateTracker> {
	const state = new StateTracker(workspace, "swarm");
	await state.init([...names], targetCount, "parallel");
	return state;
}

/** Replace the agent executor, which would otherwise spawn real agent processes. */
function runsEachAgent(behavior: (agent: SwarmAgent, index: number) => Promise<SingleResult>): void {
	spy = spyOn(executor, "executeSwarmAgent").mockImplementation((agent, index) => behavior(agent, index));
}

describe("a failing agent", () => {
	it("becomes a failed result carrying the reason, instead of ending the run", async () => {
		runsEachAgent(async (agent, index) => {
			if (agent.name === "b") throw new Error("provider refused");
			return succeeded(agent, index);
		});
		const names = ["a", "b", "c"];

		const result = await new PipelineController(definition(names), [names], await tracker(names)).run({
			workspace,
		});

		expect(result.status).toBe("failed");
		const failed = result.agentResults.get("b")?.[0];
		expect(failed?.exitCode).toBe(1);
		expect(failed?.error).toContain("provider refused");
		expect(failed?.stderr).toContain("provider refused");
	});

	it("leaves its wave-mates with their own results", async () => {
		runsEachAgent(async (agent, index) => {
			if (agent.name === "b") throw new Error("boom");
			return succeeded(agent, index, `${agent.name}-output`);
		});
		const names = ["a", "b", "c"];

		const result = await new PipelineController(definition(names), [names], await tracker(names)).run({
			workspace,
		});

		expect(result.agentResults.get("a")?.[0]?.output).toBe("a-output");
		expect(result.agentResults.get("c")?.[0]?.output).toBe("c-output");
	});

	it("does not stop the waves that come after it", async () => {
		const ran: string[] = [];
		runsEachAgent(async (agent, index) => {
			ran.push(agent.name);
			if (agent.name === "first") throw new Error("boom");
			return succeeded(agent, index);
		});
		const names = ["first", "second"];

		await new PipelineController(definition(names), [["first"], ["second"]], await tracker(names)).run({
			workspace,
		});

		expect(ran).toEqual(["first", "second"]);
	});

	it("says which agent failed and in which iteration", async () => {
		runsEachAgent(async (agent, index) => {
			if (agent.name === "b") throw new Error("provider refused");
			return succeeded(agent, index);
		});
		const names = ["a", "b"];

		const result = await new PipelineController(
			definition(names, "pipeline", 2),
			[names],
			await tracker(names, 2),
		).run({ workspace });

		expect(result.errors).toEqual(["b (iteration 1): provider refused", "b (iteration 2): provider refused"]);
	});

	it("records a non-zero exit as a failure even when nothing threw", async () => {
		runsEachAgent(async (agent, index) => ({ ...succeeded(agent, index), exitCode: 3, error: "" }));

		const result = await new PipelineController(definition(["a"]), [["a"]], await tracker(["a"])).run({ workspace });

		expect(result.status).toBe("failed");
		expect(result.errors).toEqual(["a (iteration 1): exit code 3"]);
	});
});

describe("what a completed run reports", () => {
	it("completes with no errors when every agent succeeds", async () => {
		runsEachAgent(async (agent, index) => succeeded(agent, index));
		const names = ["a", "b"];

		const result = await new PipelineController(definition(names), [names], await tracker(names)).run({ workspace });

		expect(result.status).toBe("completed");
		expect(result.errors).toEqual([]);
		expect(result.iterations).toBe(1);
	});

	it("gives every declared agent an entry, including one no wave contains", async () => {
		runsEachAgent(async (agent, index) => succeeded(agent, index));

		const result = await new PipelineController(definition(["a", "unscheduled"]), [["a"]], await tracker(["a"])).run({
			workspace,
		});

		expect([...result.agentResults.keys()].sort()).toEqual(["a", "unscheduled"]);
		expect(result.agentResults.get("unscheduled")).toEqual([]);
	});

	it("repeats the whole graph once per iteration and keeps every result", async () => {
		runsEachAgent(async (agent, index) => succeeded(agent, index));
		const names = ["a", "b"];

		const result = await new PipelineController(
			definition(names, "pipeline", 3),
			[["a"], ["b"]],
			await tracker(names, 3),
		).run({ workspace });

		expect(result.iterations).toBe(3);
		expect(result.agentResults.get("a")).toHaveLength(3);
		expect(result.agentResults.get("b")).toHaveLength(3);
	});

	it("gives each agent of an iteration its own index", async () => {
		runsEachAgent(async (agent, index) => succeeded(agent, index));
		const names = ["a", "b", "c"];

		const result = await new PipelineController(definition(names), [["a", "b"], ["c"]], await tracker(names)).run({
			workspace,
		});

		const indexes = names.map(name => result.agentResults.get(name)?.[0]?.index);
		expect([...new Set(indexes)]).toHaveLength(3);
	});
});

describe("wave scheduling", () => {
	it("starts every agent of a wave before any of them finishes", async () => {
		// The wave is a parallel unit. Run sequentially it still produces the same results, so
		// only observing the overlap can tell the difference.
		const started: string[] = [];
		const bothStarted = Promise.withResolvers<void>();
		runsEachAgent(async (agent, index) => {
			started.push(agent.name);
			if (started.length === 2) bothStarted.resolve();
			await bothStarted.promise;
			return succeeded(agent, index);
		});
		const names = ["a", "b"];

		const result = await new PipelineController(definition(names), [names], await tracker(names)).run({ workspace });

		expect(started.sort()).toEqual(["a", "b"]);
		expect(result.status).toBe("completed");
	});

	it("does not begin a wave until the one before it has finished", async () => {
		const events: string[] = [];
		runsEachAgent(async (agent, index) => {
			events.push(`start ${agent.name}`);
			await Promise.resolve();
			events.push(`end ${agent.name}`);
			return succeeded(agent, index);
		});
		const names = ["a", "b"];

		await new PipelineController(definition(names), [["a"], ["b"]], await tracker(names)).run({ workspace });

		expect(events).toEqual(["start a", "end a", "start b", "end b"]);
	});

	it("tells the caller which wave is running and how many there are", async () => {
		runsEachAgent(async (agent, index) => succeeded(agent, index));
		const waves: Array<{ currentWave: number; totalWaves: number }> = [];
		const names = ["a", "b"];

		await new PipelineController(definition(names), [["a"], ["b"]], await tracker(names)).run({
			workspace,
			onProgress: state => waves.push({ currentWave: state.currentWave, totalWaves: state.totalWaves }),
		});

		expect(waves.every(entry => entry.totalWaves === 2)).toBe(true);
		expect([...new Set(waves.map(entry => entry.currentWave))]).toEqual([0, 1]);
	});
});

describe("an aborted run", () => {
	it("runs nothing when the signal is already aborted", async () => {
		const ran: string[] = [];
		runsEachAgent(async (agent, index) => {
			ran.push(agent.name);
			return succeeded(agent, index);
		});

		const result = await new PipelineController(definition(["a"]), [["a"]], await tracker(["a"])).run({
			workspace,
			signal: AbortSignal.abort(),
		});

		expect(result.status).toBe("aborted");
		expect(result.iterations).toBe(0);
		expect(ran).toEqual([]);
	});

	it("stops at the next iteration and reports the ones that finished", async () => {
		const controller = new AbortController();
		let iterations = 0;
		runsEachAgent(async (agent, index) => {
			iterations++;
			controller.abort();
			return succeeded(agent, index);
		});

		const result = await new PipelineController(
			definition(["a"], "pipeline", 5),
			[["a"]],
			await tracker(["a"], 5),
		).run({ workspace, signal: controller.signal });

		expect(result.status).toBe("aborted");
		expect(result.iterations).toBe(1);
		expect(iterations).toBe(1);
	});

	it("does not start the next wave once the signal fires mid-iteration", async () => {
		// The signal is tested per wave as well as per iteration. Without the inner test, an abort
		// raised while wave one is running still spawns every later wave of that iteration, and
		// the only symptom is work that keeps happening after the operator stopped it.
		const controller = new AbortController();
		const ran: string[] = [];
		runsEachAgent(async (agent, index) => {
			ran.push(agent.name);
			controller.abort();
			return succeeded(agent, index);
		});
		const names = ["early", "late"];

		await new PipelineController(definition(names), [["early"], ["late"]], await tracker(names)).run({
			workspace,
			signal: controller.signal,
		});

		expect(ran).toEqual(["early"]);
	});
});

describe("a fault in the run itself", () => {
	it("reports failure rather than propagating, when bookkeeping throws", async () => {
		runsEachAgent(async (agent, index) => succeeded(agent, index));
		const state = await tracker(["a"]);
		const updateSpy = spyOn(state, "updateAgent").mockImplementation(async () => {
			throw new Error("state directory vanished");
		});

		try {
			const result = await new PipelineController(definition(["a"]), [["a"]], state).run({ workspace });

			expect(result.status).toBe("failed");
			expect(result.iterations).toBe(0);
			expect(result.errors).toEqual(["state directory vanished"]);
		} finally {
			updateSpy.mockRestore();
		}
	});
});
