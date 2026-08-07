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

	/**
	 * Killing an agent kills everything it spawned, deepest first.
	 *
	 * The kill used to stop at the named agent, and the shape of the registry
	 * turned that into a permanent leak rather than a tidiness problem. Descent is
	 * resolved by walking `parentId` through the registry, so unregistering the
	 * middle agent detaches its whole subtree: the grandchild keeps running and
	 * spending tokens, `job list` still shows it because that listing is scoped
	 * rather than descended, and every attempt to kill it is refused because its
	 * parent chain now dead-ends at an id the registry no longer holds. Visible,
	 * running, immortal, which is the exact condition `cancel` was given this
	 * capability to abolish.
	 *
	 * Order is asserted, not just membership. A parent released before its
	 * children is the same detachment happening inside the teardown.
	 */
	test("kills the whole subtree below the agent it was given, deepest first", async () => {
		register("Parent");
		register("Child", "Parent");
		register("GrandChild", "Child");
		register("GreatGrandChild", "GrandChild");

		const text = await cancel(toolForParent(), "Child");

		expect(spy.events).toEqual([
			"abort:GreatGrandChild",
			"dispose:GreatGrandChild",
			"abort:GrandChild",
			"dispose:GrandChild",
			"abort:Child",
			"dispose:Child",
		]);
		expect(text).toContain("Killed agent Child");
		for (const id of ["Child", "GrandChild", "GreatGrandChild"]) {
			expect(AgentRegistry.global().get(id)).toBeUndefined();
		}
	});

	/**
	 * A sibling subtree is not swept up. The walk goes down from the named agent
	 * and nowhere else, so the other half of the fan-out keeps running.
	 */
	test("leaves a sibling subtree alone", async () => {
		register("Parent");
		register("Child", "Parent");
		register("GrandChild", "Child");
		register("Sibling", "Parent");
		register("SiblingChild", "Sibling");

		await cancel(toolForParent(), "Child");

		expect(spy.aborted).toEqual(["GrandChild", "Child"]);
		expect(AgentRegistry.global().get("Sibling")).toBeDefined();
		expect(AgentRegistry.global().get("SiblingChild")).toBeDefined();
	});

	/**
	 * A descendant that will not abort stops the whole kill, and the named agent
	 * stays registered.
	 *
	 * That is the point rather than a limitation. The wedged grandchild is only
	 * reachable for a later retry while its parent chain is intact, so releasing
	 * the agent above it would trade a failed kill for an unkillable one. The
	 * report already refuses to claim a kill it did not perform; this keeps the
	 * subtree in a state where the claim can become true.
	 */
	test("refuses the kill and keeps the parent when a descendant cannot be aborted", async () => {
		register("Parent");
		register("Child", "Parent");
		AgentRegistry.global().register({
			id: "WedgedGrandChild",
			displayName: "worker",
			kind: "sub",
			parentId: "Child",
			status: "running",
			session: {
				abort: async () => {
					throw new Error("stream will not stop");
				},
				dispose: async () => {
					spy.events.push("dispose:WedgedGrandChild");
				},
			} as unknown as AgentSession,
		});

		const text = await cancel(toolForParent(), "Child");

		expect(text).toContain("Could not kill agent Child");
		expect(text).toContain("stream will not stop");
		expect(spy.disposed).toEqual([]);
		expect(AgentRegistry.global().get("Child")).toBeDefined();
		expect(AgentRegistry.global().get("WedgedGrandChild")).toBeDefined();
	});

	/**
	 * A descendant that finished on its own between the walk and the kill is not
	 * an error, and does not strand its live siblings.
	 *
	 * The window is real: the subtree is snapshotted before anything is
	 * unregistered, and every abort in between is awaited, so an agent can leave
	 * `running` after it appears in the snapshot and before its turn comes.
	 * Treating that as a failure would be the worst possible reading of it, since
	 * the sweep stops at the first throw: one child that beat the kill to the exit
	 * would leave every sibling below the same parent running and detached, which
	 * is the orphan this walk exists to prevent, produced by a child doing the
	 * right thing.
	 */
	test("keeps sweeping past a descendant that exited on its own", async () => {
		register("Parent");
		register("Child", "Parent");
		register("Finished", "Child");
		register("StillRunning", "Child");
		AgentRegistry.global().setStatus("Finished", "idle");

		const text = await cancel(toolForParent(), "Child");

		// The finished one is released without an abort it has no turn to receive.
		expect(spy.aborted).toEqual(["StillRunning", "Child"]);
		expect(text).toContain("Killed agent Child");
		for (const id of ["Child", "Finished", "StillRunning"]) {
			expect(AgentRegistry.global().get(id)).toBeUndefined();
		}
	});

	/**
	 * A parentage cycle terminates, and kills each agent exactly once.
	 *
	 * `parentId` is written at registration and never rewritten, so a cycle should
	 * not be constructible, but the graph is assembled from runtime registrations
	 * and nothing in the type forbids one. A teardown is the worst place to
	 * discover otherwise: the walk would not return and the kill would never
	 * start. `descendantsOf` seeds its visited set with the agent it was asked
	 * about and skips anything already seen, so the snapshot the sweep iterates is
	 * finite and repeat-free whatever the links say.
	 *
	 * Driven through the lifecycle manager rather than the `cancel` tool on
	 * purpose. A cycle that the walk can actually enter has to run through the
	 * agent the walk starts at, which puts that agent outside its own spawner's
	 * subtree, so the tool would refuse on the descent bound before terminate ever
	 * ran and the test would prove only that the bound works.
	 */
	test("terminates once per agent when the spawn tree has a cycle", async () => {
		register("Cyclic");
		register("Below", "Cyclic");
		AgentRegistry.global().register({
			id: "Cyclic",
			displayName: "worker",
			kind: "sub",
			parentId: "Below",
			status: "running",
			session: trackedSession("Cyclic"),
		});

		await AgentLifecycleManager.global().terminate("Cyclic", "test");

		expect(spy.aborted).toEqual(["Below", "Cyclic"]);
		expect(spy.disposed).toEqual(["Below", "Cyclic"]);
		expect(AgentRegistry.global().get("Cyclic")).toBeUndefined();
		expect(AgentRegistry.global().get("Below")).toBeUndefined();
	});
});
