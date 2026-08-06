/**
 * `job cancel` kills a running agent that has no background-job row.
 *
 * WHY IT EXISTS. A spawner could always SEE these agents: `job list` reports
 * them under "Running Agents — not job-backed", which covers anything woken via
 * `irc` and any spawn whose job row already settled while the agent kept
 * running. It could not stop them. The tool said as much, telling the model to
 * coordinate via `irc`, which is the one thing that does not work when the
 * reason you want the agent gone is that it is stuck talking to another agent.
 * The result was a class of agent that was visible, running, burning tokens,
 * and immortal for the life of the process.
 *
 * The kill is bounded by DESCENT rather than by scope, and that is the half
 * worth pinning hardest: everything in one conversation shares a scope, so a
 * scope check would let a child kill its own parent (orphaning the run) or a
 * sibling it does not own. Below: an owned descendant dies, a parent and a
 * stranger do not, the transcript is advertised as surviving, and a real job id
 * still takes the ordinary job path.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { JobTool } from "@veyyon/coding-agent/tools/job";
import { makeToolSession } from "../helpers/tool-session";

interface Spy {
	/** Ordered, because abort-before-dispose is the contract, not just the pair. */
	events: string[];
	aborted: string[];
	disposed: string[];
}

let spy: Spy;

/** A session that records abort/dispose so termination can be observed. */
function trackedSession(id: string): AgentSession {
	return {
		abort: async () => {
			spy.events.push(`abort:${id}`);
			spy.aborted.push(id);
		},
		dispose: async () => {
			spy.events.push(`dispose:${id}`);
			spy.disposed.push(id);
		},
	} as unknown as AgentSession;
}

function register(id: string, parentId?: string): void {
	AgentRegistry.global().register({
		id,
		displayName: "worker",
		kind: "sub",
		session: trackedSession(id),
		status: "running",
		...(parentId ? { parentId } : {}),
	});
}

/** An empty job manager, so every cancel falls through to the registry path. */
function emptyJobManager() {
	return {
		getJob: () => undefined,
		getAllJobs: () => [],
		getRunningJobs: () => [],
		cancel: () => false,
		acknowledgeDeliveries: () => {},
		watchJobs: () => {},
		unwatchJobs: () => {},
	};
}

/** The job tool as seen by `caller`. */
function toolFor(caller: string): JobTool {
	return new JobTool(
		makeToolSession({
			getAgentId: () => caller,
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: emptyJobManager(),
		} as never),
	);
}

const toolForParent = () => toolFor("Parent");

async function cancel(tool: JobTool, id: string): Promise<string> {
	const result = await tool.execute("tc", { cancel: [id] });
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

beforeEach(() => {
	spy = { events: [], aborted: [], disposed: [] };
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

describe("job cancel on an agent with no job row", () => {
	/**
	 * The capability itself, asserted on the side effect rather than the wording:
	 * a running agent is aborted BEFORE it is disposed, because disposing a
	 * session mid-turn leaves the provider request in flight with nothing to
	 * receive it.
	 */
	test("kills a direct child and aborts before disposing", async () => {
		register("Parent");
		register("Child", "Parent");

		const text = await cancel(toolForParent(), "Child");

		expect(spy.events).toEqual(["abort:Child", "dispose:Child"]);
		expect(text).toContain("Killed agent Child");
		expect(AgentRegistry.global().get("Child")).toBeUndefined();
	});

	/**
	 * A session whose abort throws cannot have its provider request stopped, so
	 * terminate refuses to dispose it and the agent stays registered. The report
	 * has to say so: an earlier draft swallowed the abort failure and reported a
	 * kill, which leaves the spawner believing a still-running agent is gone and
	 * is strictly worse than refusing.
	 */
	test("reports an agent it could not stop as still running", async () => {
		register("Parent");
		AgentRegistry.global().register({
			id: "Wedged",
			displayName: "worker",
			kind: "sub",
			parentId: "Parent",
			status: "running",
			session: {
				abort: async () => {
					throw new Error("the session is already gone");
				},
				dispose: async () => {
					spy.events.push("dispose:Wedged");
				},
			} as unknown as AgentSession,
		});

		const text = await cancel(toolForParent(), "Wedged");

		expect(text).toContain("still running");
		expect(text).toContain("the session is already gone");
		expect(spy.events).toEqual([]);
		expect(AgentRegistry.global().get("Wedged")).toBeDefined();
	});

	/**
	 * Descent is transitive: the loop the operator hits is usually two agents a
	 * layer or more below whoever notices, so a parent-only check would leave the
	 * exact case unreachable.
	 */
	test("kills a grandchild", async () => {
		register("Parent");
		register("Child", "Parent");
		register("Grandchild", "Child");

		await cancel(toolForParent(), "Grandchild");

		expect(spy.disposed).toEqual(["Grandchild"]);
	});

	/**
	 * The containment that scope alone would not give. A child killing its parent
	 * destroys the run that is waiting on it.
	 */
	test("refuses to kill its own parent", async () => {
		register("Root");
		register("Parent", "Root");

		await cancel(toolForParent(), "Root");

		expect(spy.aborted).toEqual([]);
		expect(AgentRegistry.global().get("Root")).toBeDefined();
	});

	/** A sibling is in scope and is still not the caller's to kill. */
	test("refuses to kill an agent it did not spawn", async () => {
		register("Parent");
		register("Stranger");

		await cancel(toolForParent(), "Stranger");

		expect(spy.aborted).toEqual([]);
		expect(AgentRegistry.global().get("Stranger")).toBeDefined();
	});

	/**
	 * Killing the agent must not read as destroying the record of what it did,
	 * or a spawner will hesitate to use it on a loop that has already produced
	 * work worth reading.
	 */
	test("points at the surviving transcript", async () => {
		register("Parent");
		register("Child", "Parent");

		expect(await cancel(toolForParent(), "Child")).toContain("history://Child");
	});
});
