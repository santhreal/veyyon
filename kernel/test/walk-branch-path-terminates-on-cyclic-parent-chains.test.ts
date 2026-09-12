import { describe, expect, test } from "bun:test";
import type { SessionEntry, ThinkingLevelChangeEntry } from "@veyyon/session";
import { walkBranchPath } from "../src/session/session-context";

/**
 * WHY THIS SUITE EXISTS:
 * SessionManager.pathTo carried a `seen.has(cursor.id)` guard. When the walk was extracted into
 * walkBranchPath in session-context.ts the guard was dropped, so a session file whose parent
 * pointers form a cycle — corruption, a concurrent writer, a hand-edited file — sent the walk into
 * an infinite loop and hung the process rather than failing.
 *
 * The class this closes is "the extracted copy of a walk lost its termination guard", so every case
 * asserts the walk RETURNS and that its length is bounded by the number of distinct entries. A test
 * that only compares the returned path cannot tell termination from a hang; it just never reports.
 *
 * WHAT IT DOES NOT CATCH: cycles reached through any other traversal in the session spine. This
 * pins walkBranchPath only. It also says nothing about whether a cyclic file should be rejected at
 * load time rather than walked — that is a separate decision nobody has recorded.
 */

// A thinking-level entry carries nothing but the base fields, so a parent chain can be built
// without inventing an AgentMessage the walk never reads.
function link(id: string, parentId: string | null): ThinkingLevelChangeEntry {
	return { type: "thinking_level_change", id, parentId, timestamp: "2026-09-07T00:00:00.000Z", thinkingLevel: "off" };
}

function index(...entries: SessionEntry[]): Map<string, SessionEntry> {
	return new Map(entries.map(entry => [entry.id, entry]));
}

describe("walkBranchPath terminates on cyclic parent chains", () => {
	test("returns a bounded path when two entries point at each other", () => {
		const a = link("entry_a", "entry_b");
		const b = link("entry_b", "entry_a");

		const path = walkBranchPath(index(a, b), b);

		expect(path.length).toBeLessThanOrEqual(2);
		expect(path.map(entry => entry.id)).toEqual(["entry_a", "entry_b"]);
	});

	test("returns a bounded path when an entry is its own parent", () => {
		const self = link("entry_self", "entry_self");

		const path = walkBranchPath(index(self), self);

		expect(path.map(entry => entry.id)).toEqual(["entry_self"]);
	});

	test("returns a bounded path when three entries form a ring", () => {
		const a = link("a", "c");
		const b = link("b", "a");
		const c = link("c", "b");

		const path = walkBranchPath(index(a, b, c), c);

		expect(path.length).toBeLessThanOrEqual(3);
		expect(path.map(entry => entry.id)).toEqual(["a", "b", "c"]);
	});

	test("returns a bounded path when an acyclic tail runs into a cycle", () => {
		// The leaf is outside the ring, so a guard that only checks the starting id still loops.
		const ringOne = link("ring_one", "ring_two");
		const ringTwo = link("ring_two", "ring_one");
		const leaf = link("leaf", "ring_one");

		const path = walkBranchPath(index(ringOne, ringTwo, leaf), leaf);

		expect(path.length).toBeLessThanOrEqual(3);
		expect(path.at(-1)?.id).toBe("leaf");
		expect(new Set(path.map(entry => entry.id)).size).toBe(path.length);
	});

	test("still walks an ordinary acyclic chain to its root", () => {
		const root = link("root", null);
		const middle = link("middle", "root");
		const leaf = link("leaf", "middle");

		const path = walkBranchPath(index(root, middle, leaf), leaf);

		expect(path.map(entry => entry.id)).toEqual(["root", "middle", "leaf"]);
	});
});
