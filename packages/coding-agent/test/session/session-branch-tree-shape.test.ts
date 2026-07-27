import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeBranchShapeDir = useTrackedTempDirs("veyyon-branch-shape-");

/**
 * SESS-3: branching must never orphan or duplicate a message.
 *
 * Branching is append-only by design: rewinding moves the LEAF back to an
 * earlier entry, and the next message hangs off that entry as a sibling of the
 * abandoned one. Nothing is edited and nothing is deleted. Two failures follow
 * directly from that design if the links are ever wrong, and neither announces
 * itself:
 *
 *  - an ORPHAN, an entry whose `parentId` names something absent, drops out of
 *    every path walk. The message is still in the file, so the session looks
 *    intact on disk while the conversation has a hole in it.
 *  - a DUPLICATE, the same entry reachable twice along one path, feeds the model
 *    the same turn twice and inflates every token count downstream.
 *
 * The existing rewind tests cover STATE rehydration (does the session remember
 * it rewound). None of them assert the resulting SHAPE, which is what this file
 * does: exact parent links, exact active path, and the abandoned branch present
 * in the file but absent from the active conversation.
 *
 * Shape is asserted by ids, not counts. A count is satisfied by the wrong entries
 * in the right number, which is precisely what an orphan-plus-duplicate looks
 * like.
 */
describe("branch and rewind produce an exact message tree", () => {
	let root = "";
	let cwd = "";
	let sessionDir = "";

	beforeEach(() => {
		root = makeBranchShapeDir();
		cwd = path.join(root, "project");
		sessionDir = path.join(root, "sessions");
		for (const dir of [cwd, sessionDir]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(async () => {
		if (root) {
			await removeWithRetries(guardDestructivePath(root, "session-branch-tree-shape"));
			root = "";
		}
	});

	/** Append a user message and return its entry id. */
	function say(manager: SessionManager, text: string): string {
		manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		const leaf = manager.getLeafId();
		if (!leaf) throw new Error("expected a leaf after appending");
		return leaf;
	}

	/** The active path as message texts, so a failure reads as a conversation. */
	function activeTexts(manager: SessionManager): string[] {
		return manager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => {
				const content = (entry as { message?: { content?: unknown } }).message?.content;
				return typeof content === "string" ? content : JSON.stringify(content);
			});
	}

	test("a linear conversation is a single chain, each entry parented to the previous", () => {
		// The baseline every branching assertion is measured against. If plain
		// appends did not chain correctly, nothing below would mean anything.
		const manager = SessionManager.create(cwd, sessionDir);
		const first = say(manager, "one");
		const second = say(manager, "two");
		const third = say(manager, "three");

		const byId = new Map(manager.getEntries().map(entry => [entry.id, entry]));

		expect(byId.get(second)?.parentId).toBe(first);
		expect(byId.get(third)?.parentId).toBe(second);
		expect(activeTexts(manager)).toEqual(["one", "two", "three"]);
	});

	describe("after branching from an earlier entry", () => {
		test("the new message is a SIBLING of the abandoned one, sharing its parent", () => {
			// The structural heart of branching. If the new message were parented to
			// the abandoned entry instead, the rewound turn would still be in the
			// conversation and the rewind would have done nothing.
			const manager = SessionManager.create(cwd, sessionDir);
			const first = say(manager, "one");
			const abandoned = say(manager, "two (abandoned)");

			manager.branch(first);
			const replacement = say(manager, "two (kept)");

			const byId = new Map(manager.getEntries().map(entry => [entry.id, entry]));
			expect(byId.get(abandoned)?.parentId).toBe(first);
			expect(byId.get(replacement)?.parentId).toBe(first);
			expect(replacement).not.toBe(abandoned);
		});

		test("the active path excludes the abandoned message", () => {
			const manager = SessionManager.create(cwd, sessionDir);
			const first = say(manager, "one");
			say(manager, "two (abandoned)");

			manager.branch(first);
			say(manager, "two (kept)");

			expect(activeTexts(manager)).toEqual(["one", "two (kept)"]);
		});

		test("the abandoned message is still IN THE SESSION, not deleted", () => {
			// Append-only is a promise to the user: a rewind must be recoverable, and
			// `/tree` shows the road not taken. Deleting would make rewind destructive.
			const manager = SessionManager.create(cwd, sessionDir);
			const first = say(manager, "one");
			const abandoned = say(manager, "two (abandoned)");

			manager.branch(first);
			say(manager, "two (kept)");

			expect(manager.getEntries().map(entry => entry.id)).toContain(abandoned);
		});

		test("no entry appears twice on the active path", () => {
			// The duplicate failure, stated directly. A repeated entry feeds the model
			// the same turn twice and inflates every token count after it.
			const manager = SessionManager.create(cwd, sessionDir);
			const first = say(manager, "one");
			say(manager, "two (abandoned)");
			manager.branch(first);
			say(manager, "two (kept)");
			say(manager, "three");

			const ids = manager.getBranch().map(entry => entry.id);
			expect(new Set(ids).size).toBe(ids.length);
		});

		test("every entry's parent exists, so nothing is orphaned", () => {
			// The orphan failure. An entry whose parent is absent silently drops out of
			// every path walk while still sitting in the file, so the session looks
			// intact and the conversation has a hole.
			const manager = SessionManager.create(cwd, sessionDir);
			const first = say(manager, "one");
			say(manager, "two (abandoned)");
			manager.branch(first);
			say(manager, "two (kept)");

			const ids = new Set(manager.getEntries().map(entry => entry.id));
			const dangling = manager
				.getEntries()
				.filter(entry => entry.parentId !== null && entry.parentId !== undefined && !ids.has(entry.parentId));

			expect(dangling.map(entry => entry.id)).toEqual([]);
		});

		test("the tree has exactly one root and the branch point has two children", () => {
			// The shape stated as a tree rather than as a walk, because the two can
			// disagree: a path walk terminates at the first broken link and would look
			// clean while the tree shows the damage.
			const manager = SessionManager.create(cwd, sessionDir);
			const first = say(manager, "one");
			say(manager, "two (abandoned)");
			manager.branch(first);
			say(manager, "two (kept)");

			const tree = manager.getTree();
			expect(tree).toHaveLength(1);

			const branchPoint = findNode(tree, first);
			expect(branchPoint?.children).toHaveLength(2);
		});
	});

	describe("branching twice from the same point", () => {
		test("produces three siblings, and only the newest is active", () => {
			// Repeated rewinds to one turn are ordinary (retrying a prompt). Each
			// attempt must hang off the same parent rather than nesting inside the
			// previous attempt, which would silently keep the rejected text in context.
			const manager = SessionManager.create(cwd, sessionDir);
			const first = say(manager, "one");
			say(manager, "attempt A");
			manager.branch(first);
			say(manager, "attempt B");
			manager.branch(first);
			say(manager, "attempt C");

			const branchPoint = findNode(manager.getTree(), first);
			expect(branchPoint?.children).toHaveLength(3);
			expect(activeTexts(manager)).toEqual(["one", "attempt C"]);
		});
	});

	describe("across a reload", () => {
		test("the tree and the active path survive being written and read back", async () => {
			// Everything above is in-memory. The links are persisted as `parentId` on
			// each line, so a reload is where a shape bug actually reaches the user:
			// their next launch is a fresh read of this file.
			const manager = SessionManager.create(cwd, sessionDir);
			const first = say(manager, "one");
			say(manager, "two (abandoned)");
			manager.branch(first);
			say(manager, "two (kept)");
			say(manager, "three");
			await manager.rewriteEntries();

			const file = manager.getSessionFile();
			expect(file).toBeTruthy();

			const reloaded = await SessionManager.open(file as string, undefined, undefined, { initialCwd: cwd });

			expect(activeTexts(reloaded)).toEqual(["one", "two (kept)", "three"]);
			// The abandoned branch came back too: reload must not quietly prune it.
			expect(reloaded.getEntries().length).toBe(manager.getEntries().length);

			const ids = reloaded.getBranch().map(entry => entry.id);
			expect(new Set(ids).size).toBe(ids.length);
		});
	});
});

/** Depth-first lookup of a node by entry id. */
function findNode(
	nodes: readonly { entry: { id: string }; children: readonly unknown[] }[],
	id: string,
): { entry: { id: string }; children: readonly unknown[] } | undefined {
	for (const node of nodes) {
		if (node.entry.id === id) return node;
		const found = findNode(node.children as readonly { entry: { id: string }; children: readonly unknown[] }[], id);
		if (found) return found;
	}
	return undefined;
}
