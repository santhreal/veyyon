/**
 * What a cancellation does to the two memory tools that WRITE.
 *
 * WHY THIS SUITE EXISTS. The memory family had its cancellation handling exactly backwards.
 * `memory_recall` and `memory_reflect`, which only read, were wrapped in `untilAborted` and
 * stopped when asked. `retain` and `memory_edit`, the two that change what the agent will
 * recall for the rest of the session, took no signal at all: their `execute` signatures ended
 * at `params`, so a call issued before the operator pressed Escape wrote to the store
 * afterwards regardless, and nothing in the tool could have known.
 *
 * `retain` is worse than a missing entry check, because with the mnemopi backend it is a
 * SEQUENCE: one `rememberScoped` per item. A cancellation halfway leaves some memories stored
 * and the rest not, with no rollback -- a stored memory is a fact that comes back in later
 * recalls. So it needs the same treatment the multi-file edit needed: check between steps, and
 * report which items landed.
 *
 * Neither is wrapped in `untilAborted`, and that is the deliberate part. Racing a mutation
 * against the signal rejects the caller while the writes go on, which tells the operator the
 * retain was cancelled and stores the memories anyway. That is the bug this pass removed from
 * the github tool, and it must not be introduced here to look consistent with the readers.
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { MnemopiSessionState } from "@veyyon/coding-agent/mnemopi/state";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { MemoryEditTool } from "@veyyon/coding-agent/tools/memory-edit";
import { MemoryRetainTool } from "@veyyon/coding-agent/tools/memory-retain";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";
import { makeToolSession } from "../helpers/tool-session";

/** A recording stand-in for the mnemopi session state the two tools reach for. */
function fakeMnemopiState(options: { abortAfter?: number; controller?: AbortController } = {}) {
	const remembered: string[] = [];
	const edits: Array<{ op: string; id: string }> = [];
	return {
		remembered,
		edits,
		sessionId: "session-1",
		session: { sessionManager: { getCwd: () => "/srv/project" } },
		rememberScoped(content: string) {
			remembered.push(content);
			// Cancel from inside the sequence, which is where Escape actually lands: between
			// two writes, with the first already committed to the store.
			if (options.abortAfter !== undefined && remembered.length === options.abortAfter) {
				options.controller?.abort();
			}
		},
		editScopedMemory(op: string, id: string) {
			edits.push({ op, id });
			return { status: "updated", bank: "project", store: "bank.db" };
		},
	};
}

type FakeState = ReturnType<typeof fakeMnemopiState>;

function session(state: FakeState): ToolSession {
	return makeToolSession({
		cwd: "/srv/project",
		getArtifactsDir: () => null,
		getSessionSpawns: () => null,
		// The cast is on THIS MEMBER only, not on the session. `MnemopiSessionState` has 26 members and
		// this test exercises the four the write path touches, so a faithful stub is not buildable; the
		// same bridge the helper makes for `Settings`. Scoping it here is the point: every other member
		// above stays type checked, which is what the whole-session `as unknown as ToolSession` cast
		// switched off, and it was hiding that this stub does not satisfy the interface it claimed.
		getMnemopiSessionState: () => state as unknown as MnemopiSessionState,
		settings: Settings.isolated({ "memory.backend": "mnemopi" }),
	});
}

function items(...contents: string[]) {
	return { items: contents.map(content => ({ content })) };
}

describe("retain when the operator cancels", () => {
	/**
	 * THE ENTRY CHECK. An already-aborted signal means the operator cancelled before this tool
	 * ran, and a retain is not a read: nothing may be written. Asserted on the store rather than
	 * on the thrown error, because "it threw" and "it wrote nothing" are different claims and
	 * only the second one is the point.
	 */
	it("stores nothing at all when the signal has already fired", async () => {
		const state = fakeMnemopiState();
		const controller = new AbortController();
		controller.abort();

		const error = await new MemoryRetainTool(session(state))
			.execute("call-1", items("a", "b") as never, controller.signal)
			.then(
				() => undefined,
				(err: unknown) => err,
			);

		expect(error).toBeInstanceOf(ToolAbortError);
		expect(state.remembered).toEqual([]);
	});

	/**
	 * THE SEQUENCE. Cancelled after the first of three items: the first is in the store and
	 * cannot be taken back, the other two were never written, and the message has to say so.
	 * The item labels come from the content's first line, since these items carry no context.
	 */
	it("stops at the next item and names what is already stored", async () => {
		const controller = new AbortController();
		const state = fakeMnemopiState({ abortAfter: 1, controller });

		const error = await new MemoryRetainTool(session(state))
			.execute("call-2", items("the relay caps frames at 1 MB", "b", "c") as never, controller.signal)
			.then(
				() => undefined,
				(err: unknown) => err,
			);

		expect(error).toBeInstanceOf(ToolAbortError);
		expect((error as Error).message).toBe(
			"Retain cancelled after 1 of 3 memories; already stored: the relay caps frames at 1 MB; NOT stored: b, c; the memories above are in the store and were not rolled back",
		);
		expect(state.remembered).toEqual(["the relay caps frames at 1 MB"]);
	});

	/**
	 * An item's `context` is what a human recognises it by, so it is preferred over the content
	 * when naming it. Without this the message quotes memory text back at the reader, which is
	 * the least identifying thing available.
	 */
	it("names items by their context when they have one", async () => {
		const controller = new AbortController();
		const state = fakeMnemopiState({ abortAfter: 1, controller });
		const withContext = {
			items: [
				{ content: "first fact", context: "relay limits" },
				{ content: "second fact", context: "worktree layout" },
			],
		};

		const error = await new MemoryRetainTool(session(state))
			.execute("call-3", withContext as never, controller.signal)
			.then(
				() => undefined,
				(err: unknown) => err,
			);

		expect((error as Error).message).toContain("already stored: relay limits");
		expect((error as Error).message).toContain("NOT stored: worktree layout");
	});

	/**
	 * Long content is truncated rather than pasted whole. A memory can be paragraphs; a message
	 * built from three of them is not read at all, which defeats the reason it names them.
	 */
	it("truncates a long item label instead of quoting the whole memory", async () => {
		const controller = new AbortController();
		const state = fakeMnemopiState({ abortAfter: 1, controller });
		const long = "x".repeat(200);

		const error = await new MemoryRetainTool(session(state))
			.execute("call-4", items(long, "b") as never, controller.signal)
			.then(
				() => undefined,
				(err: unknown) => err,
			);

		expect((error as Error).message).toContain(`already stored: ${"x".repeat(45)}...`);
		expect((error as Error).message).not.toContain("x".repeat(60));
	});

	/**
	 * Non-vacuity: with no cancellation every item is stored and the tool reports the count. A
	 * suite of rejections would pass against a tool that always rejects.
	 */
	it("still stores every item when nothing is cancelled", async () => {
		const state = fakeMnemopiState();

		const result = await new MemoryRetainTool(session(state)).execute(
			"call-5",
			items("a", "b", "c") as never,
			new AbortController().signal,
		);

		expect(state.remembered).toEqual(["a", "b", "c"]);
		expect(result.content.map(block => (block.type === "text" ? block.text : "")).join()).toBe("3 memories stored.");
	});
});

describe("memory_edit when the operator cancels", () => {
	/**
	 * A memory edit has nothing to interrupt once it starts -- `editScopedMemory` is a single
	 * synchronous store call, so there is no partway state and no resource to release -- but it
	 * must not START after a cancellation. It changes what the agent recalls in every later
	 * turn, which is the opposite of the read this tool's `approval: "read"` classification
	 * suggests.
	 */
	it("does not touch the store when the signal has already fired", async () => {
		const state = fakeMnemopiState();
		const controller = new AbortController();
		controller.abort();

		const error = await new MemoryEditTool(session(state))
			.execute("call-6", { op: "forget", id: "mem-1" } as never, controller.signal)
			.then(
				() => undefined,
				(err: unknown) => err,
			);

		expect(error).toBeInstanceOf(ToolAbortError);
		expect(state.edits).toEqual([]);
	});

	/**
	 * And it still applies the edit exactly once when nothing was cancelled, reporting the bank
	 * it landed in. Pinned so the entry check above cannot be widened into refusing real work.
	 */
	it("applies the edit once with a live signal", async () => {
		const state = fakeMnemopiState();

		const result = await new MemoryEditTool(session(state)).execute(
			"call-7",
			{ op: "update", id: "mem-1", content: "revised" } as never,
			new AbortController().signal,
		);

		expect(state.edits).toEqual([{ op: "update", id: "mem-1" }]);
		expect(result.content.map(block => (block.type === "text" ? block.text : "")).join()).toBe(
			"Memory mem-1 updated in bank project (bank.db).",
		);
	});

	/**
	 * No signal at all is the ordinary case for a tool invoked outside a turn, and it must not
	 * be mistaken for a cancellation. `throwIfAborted(undefined)` returning quietly is the
	 * contract that makes the check above safe to add everywhere.
	 */
	it("works with no signal at all", async () => {
		const state = fakeMnemopiState();

		await new MemoryEditTool(session(state)).execute("call-8", { op: "forget", id: "mem-2" } as never);

		expect(state.edits).toEqual([{ op: "forget", id: "mem-2" }]);
	});
});
