/**
 * ONE budget group per session TREE, not one per agent.
 *
 * The defect this closes: a subagent opens its own `SessionManager`, so its
 * `AgentSession` used to register a SEPARATE budget group under its own
 * session id. The operator's one limit was then multiplied by the number of
 * live subagents, which is the opposite of a limit. The fix is an inherited
 * budget-group id pinned around subagent session creation and read inside
 * `initSessionCpuLimit`, so a child registers as an ALIAS of the root group.
 *
 * These tests drive the real registry through `initSessionCpuLimit` and the
 * real owned-resource disposer, against a tmpdir cgroup tree. They defend the
 * whole class rather than the reported case: the alias must survive depth,
 * must not be torn down when one subagent finishes, must move with the root
 * on `/new`, and must never be mistaken for a group owner. What they do NOT
 * prove is that the kernel enforces the shared quota; that lives in
 * cpu-limit-real-cgroup.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	initSessionCpuLimit,
	primarySessionCpuLimit,
	rekeySessionCpuLimit,
	resetSessionCpuLimitsForTests,
	rootBudgetGroupOwnerId,
	type SessionCpuLimit,
	sessionCpuBudgetName,
	sessionCpuLimit,
	withInheritedBudgetGroup,
} from "../src/session/cpu-limit";
import { disposeOwnedResources } from "../src/session/owned-resources";
import {
	type FakeHost,
	makeCgroupRoot,
	makeDelegatedParent,
	makeFakeHost,
	removeCgroupRoots,
} from "./helpers/fake-cgroup";

afterEach(async () => {
	resetSessionCpuLimitsForTests();
	await removeCgroupRoots();
});

interface Tree {
	host: FakeHost;
	parent: string;
	notices: string[];
}

async function makeTree(): Promise<Tree> {
	const root = await makeCgroupRoot();
	const parent = await makeDelegatedParent(root);
	const notices: string[] = [];
	return { host: makeFakeHost(root), parent, notices };
}

/** Register a root session, the way `AgentSession` does for the top-level conversation. */
function registerRoot(tree: Tree, sessionId: string, cores = 1): Promise<SessionCpuLimit> {
	return initSessionCpuLimit({
		sessionId,
		cores,
		kill: false,
		onNotice: text => tree.notices.push(text),
		env: tree.host.env,
	});
}

/**
 * Register a session the way the task executor does for a subagent: inside a
 * scope pinned to the spawner's session id.
 */
function registerSubagent(tree: Tree, parentSessionId: string, sessionId: string, cores = 1): Promise<SessionCpuLimit> {
	return withInheritedBudgetGroup(parentSessionId, () =>
		initSessionCpuLimit({
			sessionId,
			cores,
			kill: false,
			onNotice: text => tree.notices.push(text),
			env: tree.host.env,
		}),
	);
}

/** Every budget group directory the native backend created under the delegated parent. */
async function budgetDirs(parent: string): Promise<string[]> {
	const entries = await fs.readdir(parent);
	return entries.filter(name => name.startsWith("veyyon-cpu-")).sort();
}

describe("a subagent joins the session tree's budget group", () => {
	it("resolves every subagent to the root limiter and creates exactly one group", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root");
		await root.ensureGroup();

		for (const child of ["sub-a", "sub-b", "sub-c"]) {
			const limiter = await registerSubagent(tree, "root", child);
			expect(limiter).toBe(root);
			expect(sessionCpuLimit(child)).toBe(root);
			// A spawn from the subagent goes through its own limiter lookup, which
			// must land in the root's group rather than minting a second one.
			await sessionCpuLimit(child)?.ensureGroup();
		}

		expect(await budgetDirs(tree.parent)).toEqual([sessionCpuBudgetName("root")]);
	});

	it("keeps depth-2 subagents in the ROOT group, not in their parent's copy of it", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root");
		await registerSubagent(tree, "root", "child");
		// The depth-2 spawn pins the id it knows: its own session, which is
		// itself an alias. Resolving through the alias chain is what keeps the
		// group single at any depth.
		const grandchild = await registerSubagent(tree, "child", "grandchild");

		expect(grandchild).toBe(root);
		expect(sessionCpuLimit("grandchild")).toBe(root);
		await sessionCpuLimit("grandchild")?.ensureGroup();
		expect(await budgetDirs(tree.parent)).toEqual([sessionCpuBudgetName("root")]);
	});

	it("does not let a subagent's own settings override the budget the operator set for the tree", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root", 1);
		const child = await registerSubagent(tree, "root", "child", 8);

		expect(child).toBe(root);
		expect(root.cores).toBe(1);
	});

	it("gives an UNPINNED session its own group, so the alias is caused by the pin and not by order", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root");
		const other = await initSessionCpuLimit({
			sessionId: "other",
			cores: 2,
			kill: false,
			onNotice: text => tree.notices.push(text),
			env: tree.host.env,
		});

		expect(other).not.toBe(root);
		await root.ensureGroup();
		await other.ensureGroup();
		expect(await budgetDirs(tree.parent)).toEqual(
			[sessionCpuBudgetName("root"), sessionCpuBudgetName("other")].sort(),
		);
	});

	it("ignores a pin naming a session that owns no live group", async () => {
		const tree = await makeTree();
		const limiter = await registerSubagent(tree, "no-such-session", "orphan");

		expect(sessionCpuLimit("orphan")).toBe(limiter);
		expect(limiter.budgetName).toBe(sessionCpuBudgetName("orphan"));
	});
});

describe("the tree's group outlives one subagent", () => {
	it("drops only the alias when a subagent finishes", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root");
		await registerSubagent(tree, "root", "child-a");
		await registerSubagent(tree, "root", "child-b");
		await root.ensureGroup();
		const dir = path.join(tree.parent, sessionCpuBudgetName("root"));

		await disposeOwnedResources("session", "child-a");

		expect(sessionCpuLimit("child-a")).toBeUndefined();
		expect(sessionCpuLimit("child-b")).toBe(root);
		expect(sessionCpuLimit("root")).toBe(root);
		expect(root.disposed).toBe(false);
		expect(await fs.stat(dir).catch(() => null)).not.toBeNull();
	});

	it("retires every borrower when the owner's session ends", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root");
		await registerSubagent(tree, "root", "child");
		await registerSubagent(tree, "child", "grandchild");
		await root.ensureGroup();
		const dir = path.join(tree.parent, sessionCpuBudgetName("root"));

		await disposeOwnedResources("session", "root");

		expect(sessionCpuLimit("root")).toBeUndefined();
		expect(sessionCpuLimit("child")).toBeUndefined();
		expect(sessionCpuLimit("grandchild")).toBeUndefined();
		expect(root.disposed).toBe(true);
		expect(await fs.stat(dir).catch(() => null)).toBeNull();
	});
});

describe("an alias is never an owner", () => {
	it("keeps the root session as the owner of shared spawns while subagents come and go", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root");
		await registerSubagent(tree, "root", "child");

		expect(rootBudgetGroupOwnerId()).toBe("root");
		expect(primarySessionCpuLimit()).toBe(root);

		// The root's session ends while a subagent alias is still registered: no
		// owner remains, so nothing may answer as one.
		await disposeOwnedResources("session", "root");
		expect(rootBudgetGroupOwnerId()).toBeUndefined();
		expect(primarySessionCpuLimit()).toBeUndefined();
	});

	it("carries the aliases when the root session's id changes", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root");
		await registerSubagent(tree, "root", "child");
		await root.ensureGroup();

		expect(rekeySessionCpuLimit("root", "root-2")).toBe(root);

		expect(sessionCpuLimit("root-2")).toBe(root);
		expect(sessionCpuLimit("child")).toBe(root);
		expect(sessionCpuLimit("root")).toBeUndefined();
		expect(root.disposed).toBe(false);
		expect(rootBudgetGroupOwnerId()).toBe("root-2");
	});

	it("moves an alias rather than the group when a BORROWER's id changes", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root");
		await registerSubagent(tree, "root", "child");
		await root.ensureGroup();

		expect(rekeySessionCpuLimit("child", "child-2")).toBe(root);

		expect(sessionCpuLimit("child")).toBeUndefined();
		expect(sessionCpuLimit("child-2")).toBe(root);
		expect(sessionCpuLimit("root")).toBe(root);
		expect(root.disposed).toBe(false);
		expect(rootBudgetGroupOwnerId()).toBe("root");
	});

	it("lets a real registration take over an id that was an alias", async () => {
		const tree = await makeTree();
		const root = await registerRoot(tree, "root");
		const other = await initSessionCpuLimit({
			sessionId: "other",
			cores: 2,
			kill: false,
			onNotice: text => tree.notices.push(text),
			env: tree.host.env,
		});
		await registerSubagent(tree, "root", "contested");

		expect(rekeySessionCpuLimit("other", "contested")).toBe(other);

		expect(sessionCpuLimit("contested")).toBe(other);
		expect(root.disposed).toBe(false);
		expect(other.disposed).toBe(false);
	});
});
