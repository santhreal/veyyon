import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { type TodoPhase, TodoTool } from "@veyyon/coding-agent/tools/todo";

/**
 * THE BUG THIS LOCKS OUT.
 *
 * `{ merge: true, todos: [...] }` (the Claude/Cursor `TodoWrite` shape) validated clean
 * against veyyon's all-optional todo schema, reached `normalizeTodoParams` with no `op`,
 * fell through every branch to `return { ...params, op: "view" }`, and resolved to a
 * READ. The operator's eight-item board write was discarded, `isError` was undefined,
 * and the result text was a rendering of the OLD board. Nothing anywhere said the write
 * had been dropped, so the model read a plausible-looking todo list back and moved on.
 *
 * THE GENERAL CONTRACT, which is what this file asserts rather than that one shape.
 * A todo call carrying items must end in exactly one of two states:
 *   APPLIES  - the board changes and the result describes the change, or
 *   REPORTS  - the board is unchanged and the result says why, as an error or a note.
 * "Silently reads" is the third state and must be unreachable. It is the dangerous one
 * precisely because it is indistinguishable from success at a glance.
 *
 * WHY THE SHAPE-SPECIFIC TEST IS NOT ENOUGH. The `todos` shape was fixed with a branch
 * at the top of `execute` that checks `params.todos`. That branch fixes `todos` and
 * nothing else. `normalizeTodoParams` still resolves to `view` on any item-carrying
 * shape it does not recognize, and the schema carries THREE item-bearing fields
 * (`list`, `items`, `todos`) plus `merge`. Every combination below is a payload a model
 * can legally emit today, and each one is a fresh chance to reintroduce the same
 * silent discard through a different door. A second silent-discard door has already
 * been found in this code once.
 *
 * IF IT REGRESSES: an operator watches the agent report progress against a todo board
 * that never received the write, and no error is ever surfaced to either of them.
 */

beforeAll(() => {
	initTheme();
});

function createSession(initialPhases: TodoPhase[] = []): {
	session: ToolSession;
	phases: () => TodoPhase[];
} {
	let phases = initialPhases;
	return {
		session: {
			cwd: "/tmp/todo-silent-read",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
		},
		phases: () => phases,
	};
}

const EXISTING: TodoPhase[] = [{ name: "Old", tasks: [{ content: "stale", status: "pending" }] }];

/**
 * Every legal item-carrying payload a model can emit WITHOUT an explicit `op`.
 *
 * No-op is the whole point: an explicit `op` never reaches the silent-`view` fallback,
 * so a suite that always passes `op` cannot fail on this bug at all. The near-duplicate
 * entry is included because content is the tool's only task identity and a
 * punctuation-only difference is the case that most recently lost a board write.
 */
const ITEM_CARRYING_PAYLOADS: Array<[label: string, params: Record<string, unknown>]> = [
	["todos with merge:true", { merge: true, todos: [{ id: "1", content: "Write the parser", status: "pending" }] }],
	["todos with merge:false", { merge: false, todos: [{ id: "1", content: "Write the parser", status: "pending" }] }],
	["todos with no merge flag", { todos: [{ id: "1", content: "Write the parser", status: "pending" }] }],
	[
		"todos carrying near-duplicate content",
		{
			merge: false,
			todos: [
				{ id: "1", content: "Fix the bug.", status: "pending" },
				{ id: "2", content: "fix the bug", status: "pending" },
			],
		},
	],
	["bare items", { items: ["Write the parser"] }],
	["items with a phase", { phase: "Work", items: ["Write the parser"] }],
	["a phased list", { list: [{ phase: "Work", items: ["Write the parser"] }] }],
	["list and items together", { list: [{ phase: "Work", items: ["A"] }], items: ["B"] }],
	["todos alongside items", { todos: [{ id: "1", content: "A", status: "pending" }], items: ["B"] }],
];

describe("a todo payload carrying items never silently reads", () => {
	for (const [label, params] of ITEM_CARRYING_PAYLOADS) {
		it(`applies or reports for ${label}, and never resolves to a bare view`, async () => {
			const { session, phases } = createSession(structuredClone(EXISTING));
			const result = await new TodoTool(session).execute("call", params as never);

			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			const boardChanged = JSON.stringify(phases()) !== JSON.stringify(EXISTING);
			// A report is a non-empty error flag or a note the result actually renders.
			// `details.notes` alone is not enough: notes are dropped from `details` on a
			// failed batch, and the operator reads the text.
			const reported = result.isError === true || (result.details?.notes?.length ?? 0) > 0;

			// The headline. `op: "view"` on an item-carrying payload IS the defect: it is
			// the value `normalizeTodoParams` fell through to, and it is recorded in the
			// transcript, so it is the single most direct observable of the bug.
			expect(`${label} op`).toBe(`${label} op`);
			expect(result.details?.op).not.toBe("view");

			// And the state assertion, which holds even if someone relabels the op.
			expect(`${label}: applied=${boardChanged} reported=${reported}`).not.toBe(
				`${label}: applied=false reported=false`,
			);

			// A silent read renders the OLD board verbatim with no mention of the write.
			// If the call neither applied nor reported, the text is the giveaway.
			if (!boardChanged) {
				expect(`${label} text mentions why: ${text.trim().length > 0}`).toBe(`${label} text mentions why: true`);
			}
		});
	}

	/**
	 * The strongest single case, stated with exact values instead of predicates.
	 * This is the failing payload: a whole-board write that must LAND.
	 */
	it("lands the whole-board write rather than echoing the previous board", async () => {
		const { session, phases } = createSession(structuredClone(EXISTING));
		const result = await new TodoTool(session).execute("call", {
			merge: false,
			todos: [
				{ id: "a", content: "Write the parser", status: "completed" },
				{ id: "b", content: "Wire the CLI", status: "in_progress" },
			],
		} as never);

		expect(result.isError).toBeUndefined();
		expect(phases().flatMap(phase => phase.tasks.map(task => `${task.content}=${task.status}`))).toEqual([
			"Write the parser=completed",
			"Wire the CLI=in_progress",
		]);
		// The replaced board is gone, which is what `merge: false` means.
		expect(phases().flatMap(phase => phase.tasks.map(task => task.content))).not.toContain("stale");
		expect(result.details?.op).toBe("init");
	});

	/**
	 * The punctuation-sensitive case, called out separately because it lost a board
	 * write through the SECOND door: `merge:false` had no normalized dedupe while
	 * `merge:true` did, so "Fix the bug." plus "fix the bug" was rejected wholesale.
	 * Either resolution satisfies the contract, but a silent read does not: the write
	 * must land with the collapse named, or be refused with the conflict named.
	 */
	it("either collapses or refuses near-duplicate content, and says which", async () => {
		const { session, phases } = createSession(structuredClone(EXISTING));
		const result = await new TodoTool(session).execute("call", {
			merge: false,
			todos: [
				{ id: "1", content: "Fix the bug.", status: "pending" },
				{ id: "2", content: "fix the bug", status: "pending" },
			],
		} as never);

		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		const contents = phases().flatMap(phase => phase.tasks.map(task => task.content));

		if (result.isError === true) {
			// Refused: the board is untouched AND the reason names the collision.
			expect(contents).toEqual(["stale"]);
			expect(text.toLowerCase()).toContain("duplicate");
		} else {
			// Applied: the write landed, one of the two survived, and the adjustment is
			// stated. A silent collapse would be the same class of bug in miniature.
			expect(contents).toEqual(["Fix the bug."]);
			expect(result.details?.notes?.length ?? 0).toBeGreaterThan(0);
		}
	});

	/**
	 * The discriminator. Without a payload that legitimately IS a read, every assertion
	 * above could be satisfied by a tool that never returns `view` at all, and the suite
	 * would be pinning nothing about item-carrying calls specifically.
	 */
	it("still resolves a genuinely empty payload to a read", async () => {
		const { session, phases } = createSession(structuredClone(EXISTING));
		const result = await new TodoTool(session).execute("call", {} as never);

		expect(result.details?.op).toBe("view");
		expect(result.isError).toBeUndefined();
		expect(phases()).toEqual(EXISTING);
	});

	/**
	 * An EMPTY item container is not the same as no container: the caller named a field
	 * and sent nothing in it, which is either "clear the board" or a mistake, never a
	 * read. `list: []` is already refused by name; the sibling containers must not
	 * quietly resolve to `view` behind it.
	 */
	it("refuses an empty item container instead of treating it as a read", async () => {
		for (const params of [{ list: [] }, { items: [] }, { merge: false, todos: [] }]) {
			const { session, phases } = createSession(structuredClone(EXISTING));
			const result = await new TodoTool(session).execute("call", params as never);
			const key = Object.keys(params).filter(k => k !== "merge")[0];
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			const changed = JSON.stringify(phases()) !== JSON.stringify(EXISTING);
			const reported = result.isError === true;
			expect(`${key}: applied=${changed} reported=${reported}`).not.toBe(`${key}: applied=false reported=false`);
			if (reported) expect(text.trim().length).toBeGreaterThan(0);
		}
	});
});
