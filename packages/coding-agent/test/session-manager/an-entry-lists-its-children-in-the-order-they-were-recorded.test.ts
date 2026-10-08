/**
 * WHY: `SessionManager.getChildren` used to answer from a parent-to-children map
 * kept beside the id index, one array per entry, for a method no product path
 * calls. It now filters the entry list, so these rows pin what the map used to
 * guarantee: every direct child, in the order it was recorded, for a branch point,
 * a leaf, an unknown id and a file loaded by a second manager, with the answer
 * a copy the caller may edit.
 *
 * MEASURED (each mutant applied alone to `getChildren`, rows in file order):
 * children returned newest first, rows 1 and 2 red; only the first child, rows 1
 * and 2 red; entries matched on their own id instead of their parent's, rows 1
 * to 4 red; grandchildren listed with children, rows 2 and 3 red; one held list
 * handed out per parent instead of a copy, row 4 red.
 *
 * Not caught: the speed of the scan. It is linear in the entry count, which is
 * the cost of keeping no per-entry adjacency for a method only tests call.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function childIds(manager: SessionManager, parentId: string): string[] {
	return manager.getChildren(parentId).map(entry => entry.id);
}

describe("an entry lists its children in the order they were recorded", () => {
	it("lists every child of a branch point in record order, and none for a leaf or an unknown id", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage(userMessage("root"));
		const first = manager.appendMessage(userMessage("first answer"));
		manager.branch(root);
		const second = manager.appendMessage(userMessage("second answer"));
		const summary = manager.branchWithSummary(root, "the abandoned branch");
		manager.branch(root);
		const label = manager.appendLabelChange(first, "kept");

		expect(childIds(manager, root)).toEqual([first, second, summary, label]);
		expect(childIds(manager, second)).toEqual([]);
		expect(childIds(manager, "no-such-entry")).toEqual([]);
	});

	it("lists the same children from a manager that loaded the file", async () => {
		using tempDir = TempDir.createSync("@veyyon-children-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const writer = await SessionManager.open(file, dir);
		const root = writer.appendMessage(userMessage("root"));
		const first = writer.appendMessage(userMessage("first answer"));
		writer.branch(root);
		const second = writer.appendMessage(userMessage("second answer"));
		writer.appendMessage(userMessage("under the second answer"));
		await writer.flush();

		const reader = await SessionManager.open(file, dir);
		expect(childIds(reader, root)).toEqual([first, second]);
		expect(childIds(reader, root)).toEqual(childIds(writer, root));

		await reader.close();
		await writer.close();
	});

	it("does not list a grandchild as a child", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage(userMessage("root"));
		const child = manager.appendMessage(userMessage("child"));
		const grandchild = manager.appendMessage(userMessage("grandchild"));

		expect(childIds(manager, root)).toEqual([child]);
		expect(childIds(manager, child)).toEqual([grandchild]);
	});

	it("returns a list the caller may edit without changing the next answer", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage(userMessage("root"));
		const child = manager.appendMessage(userMessage("child"));

		const handed = manager.getChildren(root);
		handed.length = 0;

		expect(childIds(manager, root)).toEqual([child]);
	});
});
