import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { adaptTodoWriteBatch, type TodoPhase, TodoTool } from "@veyyon/coding-agent/tools/todo";

/**
 * Models trained on the Claude/Cursor `TodoWrite` tool send a whole-board write
 * (`{ merge, todos: [{ id, content, status }] }`). Before the adapter that call
 * validated clean against veyyon's all-optional schema, resolved to `view`, and
 * silently discarded the board update: eight completed items stayed pending.
 */

function createSession(initialPhases: TodoPhase[] = []): { session: ToolSession; phases: () => TodoPhase[] } {
	let phases = initialPhases;
	return {
		session: {
			cwd: "/tmp/test",
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

/** Verbatim from section 1 of the operator's failure log. */
const VERBATIM_CONTENTS = [
	"Install from GitHub releases path",
	"Run real-world usage scenarios",
	"Catalog speed reliability robustness flaws",
	"Fix blocking real-world flaws",
	"Rewrite multi-OS install docs",
	"Verify install copy-paste paths",
	"Encode fixes in tests",
	"Smoke test release readiness",
];
const VERBATIM_PAYLOAD = {
	merge: true,
	todos: VERBATIM_CONTENTS.map((content, index) => ({
		id: String(index + 4),
		content,
		status: "completed" as const,
	})),
};

beforeAll(async () => {
	await initTheme();
});

describe("TodoWrite compatibility shape", () => {
	it("lands the verbatim eight-item completion write against an existing board", async () => {
		const { session, phases } = createSession([
			{ name: "Exercise", tasks: VERBATIM_CONTENTS.slice(0, 3).map(content => ({ content, status: "pending" })) },
			{ name: "Fix", tasks: VERBATIM_CONTENTS.slice(3, 6).map(content => ({ content, status: "pending" })) },
			{ name: "Release prep", tasks: VERBATIM_CONTENTS.slice(6).map(content => ({ content, status: "pending" })) },
		]);
		const tool = new TodoTool(session);

		const result = await tool.execute("call-1", VERBATIM_PAYLOAD);

		expect(result.isError).toBeUndefined();
		expect(
			phases()
				.flatMap(phase => phase.tasks)
				.every(task => task.status === "completed"),
		).toBe(true);
		// The phase grouping the model never sent must survive a merge write.
		expect(phases().map(phase => phase.name)).toEqual(["Exercise", "Fix", "Release prep"]);
	});

	it("creates the board when a merge write names tasks the session has never seen", async () => {
		const { session, phases } = createSession();
		const tool = new TodoTool(session);

		const result = await tool.execute("call-2", VERBATIM_PAYLOAD);

		expect(result.isError).toBeUndefined();
		expect(
			phases()
				.flatMap(phase => phase.tasks)
				.map(task => task.content),
		).toEqual(VERBATIM_CONTENTS);
		expect(result.details?.op).toBe("append");
	});

	it("replaces the board when merge is false", async () => {
		const { session, phases } = createSession([{ name: "Old", tasks: [{ content: "stale", status: "pending" }] }]);
		const tool = new TodoTool(session);

		const result = await tool.execute("call-3", {
			merge: false,
			todos: [
				{ content: "alpha", status: "in_progress" },
				{ content: "beta", status: "pending" },
			],
		});

		expect(result.isError).toBeUndefined();
		expect(result.details?.op).toBe("init");
		expect(phases().flatMap(phase => phase.tasks)).toEqual([
			{ content: "alpha", status: "in_progress" },
			{ content: "beta", status: "pending" },
		]);
	});

	it("maps each incoming status onto the op that produces it", () => {
		const { ops } = adaptTodoWriteBatch(
			{
				merge: true,
				todos: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "in_progress" },
					{ content: "c", status: "cancelled" },
					{ content: "d", status: "pending" },
				],
			},
			[{ name: "P", tasks: ["a", "b", "c", "d"].map(content => ({ content, status: "pending" as const })) }],
		);

		// `pending` contributes no status op: append/init already created it there.
		expect(ops).toEqual([
			{ op: "done", task: "a" },
			{ op: "start", task: "b" },
			{ op: "drop", task: "c" },
		]);
	});

	it("keeps a batch atomic when one op does not resolve", async () => {
		// Two board phases that normalize alike, and an incoming phase name that
		// matches neither exactly: the append cannot pick one, so nothing lands.
		const { session, phases } = createSession([
			{ name: "Setup", tasks: [{ content: "known", status: "pending" }] },
			{ name: "setup.", tasks: [{ content: "other", status: "pending" }] },
		]);
		const tool = new TodoTool(session);

		const result = await tool.execute("call-4", {
			merge: true,
			phase: "SETUP!",
			todos: [{ content: "fresh", status: "completed" }],
		});

		expect(result.isError).toBe(true);
		expect(phases()).toEqual([
			{ name: "Setup", tasks: [{ content: "known", status: "pending" }] },
			{ name: "setup.", tasks: [{ content: "other", status: "pending" }] },
		]);
	});

	describe("items differing only in case or punctuation", () => {
		// Live repro. Task identity is normalized text everywhere else, so an
		// undeduped near-duplicate made `init` report `Duplicate task` and
		// `append` report `already exists`, and either error discarded the
		// operator's entire board write.
		const NEAR_DUPLICATES = [
			{ content: "Fix the bug.", status: "in_progress" as const },
			{ content: "fix the bug", status: "pending" as const },
		];

		it("lands the write under merge:false, keeping the first spelling", async () => {
			const { session, phases } = createSession([{ name: "Old", tasks: [{ content: "stale", status: "pending" }] }]);
			const tool = new TodoTool(session);

			const result = await tool.execute("dup-replace", { merge: false, todos: NEAR_DUPLICATES });

			expect(result.isError).toBeUndefined();
			expect(phases()).toEqual([{ name: "Tasks", tasks: [{ content: "Fix the bug.", status: "in_progress" }] }]);
			expect(result.details?.notes).toEqual([
				'Collapsed 2 items differing only in case or punctuation into "Fix the bug."; task targeting cannot tell them apart.',
			]);
		});

		it("lands the write under merge:true, keeping the first spelling", async () => {
			const { session, phases } = createSession([{ name: "Work", tasks: [{ content: "kept", status: "pending" }] }]);
			const tool = new TodoTool(session);

			const result = await tool.execute("dup-merge", { merge: true, todos: NEAR_DUPLICATES });

			expect(result.isError).toBeUndefined();
			expect(phases()).toEqual([
				{
					name: "Work",
					tasks: [
						{ content: "kept", status: "pending" },
						{ content: "Fix the bug.", status: "in_progress" },
					],
				},
			]);
			expect(result.details?.notes).toEqual([
				'Collapsed 2 items differing only in case or punctuation into "Fix the bug."; task targeting cannot tell them apart.',
			]);
		});

		it("collapses the status too, so the first occurrence decides it", () => {
			// "fix the bug" arrives `completed`, but "Fix the bug." came first and
			// is `in_progress`; only the first occurrence's status op is emitted.
			const { ops } = adaptTodoWriteBatch(
				{
					merge: false,
					todos: [
						{ content: "Fix the bug.", status: "in_progress" },
						{ content: "fix the bug", status: "completed" },
					],
				},
				[],
			);

			expect(ops).toEqual([
				{ op: "init", list: [{ phase: "Tasks", items: ["Fix the bug."] }] },
				{ op: "start", task: "Fix the bug." },
			]);
		});
	});
});
