/**
 * `AgentRegistry.descendantsOf` — the one owner of the spawn-tree walk.
 *
 * WHY THIS SUITE EXISTS: the registry has always recorded `parentId`, and nothing
 * used it to answer "what did this agent spawn". Teardown paths therefore scoped
 * themselves to a single `ownerId`, so a subagent that had itself delegated left a
 * grandchild running background work after the session that could collect it was
 * gone — an agent spending tokens for a delivery address that no longer exists
 * (BACKLOG SUB-2). The walk lives here, once, because every caller that needs it is
 * on a teardown path where re-deriving parentage from the flat list is how the two
 * copies drift.
 *
 * The tests pin structure, not just counts: which ids come back, in what order, and
 * that the walk cannot be made to hang.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";

describe("AgentRegistry.descendantsOf", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	/** Register a ref with no live session; the walk reads ids and parentage only. */
	function add(id: string, parentId?: string): void {
		registry.register({ id, displayName: id, kind: parentId ? "sub" : "main", parentId, session: null });
	}

	it("returns nothing for an agent that spawned nothing", () => {
		add("Main");
		expect(registry.descendantsOf("Main")).toEqual([]);
	});

	it("returns nothing for an id that is not registered at all", () => {
		add("Main");
		expect(registry.descendantsOf("ghost")).toEqual([]);
	});

	it("returns direct children", () => {
		add("Main");
		add("scout-1", "Main");
		add("scout-2", "Main");
		expect(registry.descendantsOf("Main").sort()).toEqual(["scout-1", "scout-2"]);
	});

	/**
	 * The case that motivated the walk: the orphan is a GRANDCHILD, so a one-level
	 * lookup finds nothing to clean up and the deepest agent is the one left running.
	 */
	it("reaches a grandchild, nearest generation first", () => {
		add("Main");
		add("worker", "Main");
		add("helper", "worker");
		add("deep-helper", "helper");
		expect(registry.descendantsOf("Main")).toEqual(["worker", "helper", "deep-helper"]);
	});

	/** A subtree walk starts where it is asked to, not at the root. */
	it("walks only the requested subtree", () => {
		add("Main");
		add("worker", "Main");
		add("helper", "worker");
		add("other", "Main");
		expect(registry.descendantsOf("worker")).toEqual(["helper"]);
		expect(registry.descendantsOf("other")).toEqual([]);
	});

	/** Never up, never sideways: a parent and a sibling are not descendants. */
	it("excludes the agent itself, its parent and its siblings", () => {
		add("Main");
		add("worker", "Main");
		add("sibling", "Main");
		const found = registry.descendantsOf("worker");
		expect(found).not.toContain("worker");
		expect(found).not.toContain("Main");
		expect(found).not.toContain("sibling");
	});

	/**
	 * A parked or aborted agent is still in the tree, and its own children may still
	 * be live. Filtering by status here would hide exactly the orphan the walk is
	 * for, so status is the caller's business.
	 */
	it("includes descendants whatever their status", () => {
		add("Main");
		registry.register({
			id: "parked-worker",
			displayName: "parked-worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		registry.register({
			id: "live-helper",
			displayName: "live-helper",
			kind: "sub",
			parentId: "parked-worker",
			session: null,
			status: "running",
		});
		expect(registry.descendantsOf("Main")).toEqual(["parked-worker", "live-helper"]);
	});

	/**
	 * A cycle should be impossible — `parentId` is written once at registration —
	 * but this runs on teardown paths, and a teardown that hangs is worse than one
	 * that reports an odd tree. Each agent is visited once.
	 */
	it("terminates on a parentage cycle and visits each agent once", () => {
		add("a", "c");
		add("b", "a");
		add("c", "b");
		const found = registry.descendantsOf("a");
		expect(found).toEqual(["b", "c"]);
		expect(new Set(found).size).toBe(found.length);
	});

	/** A self-parenting ref must not loop, and is not its own descendant. */
	it("terminates when an agent is its own parent", () => {
		add("loop", "loop");
		expect(registry.descendantsOf("loop")).toEqual([]);
	});

	/** Unregistering a middle agent detaches its subtree from the walk above it. */
	it("stops at a gap left by an unregistered parent", () => {
		add("Main");
		add("worker", "Main");
		add("helper", "worker");
		registry.unregister("worker");
		expect(registry.descendantsOf("Main")).toEqual([]);
		expect(registry.descendantsOf("worker")).toEqual(["helper"]);
	});
});
