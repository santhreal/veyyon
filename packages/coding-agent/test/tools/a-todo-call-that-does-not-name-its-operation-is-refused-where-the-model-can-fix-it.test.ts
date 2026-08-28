/**
 * WHY: `op` was optional on the todo schema for one release so a Claude/Cursor
 * `TodoWrite` payload (`todos` and no `op`) would validate. Every other shape
 * became a lie: `{"task":"Scaffold"}` and `{"operation":"start","task":"Scaffold"}`
 * validated CLEAN — a missing optional field is legal, and an undeclared key is
 * not refused for an ArkType-authored tool — and then the executor answered
 * `Missing op; pass op explicitly`, naming a field the call was never told to
 * carry. The repair layer reported `clean` on a payload that could not execute,
 * so all three layers declined to act and the model retried the same call.
 *
 * The class this closes: an operation-bearing tool whose operation field can be
 * absent, or spelled with a name the schema does not declare, and whose refusal
 * therefore arrives from the executor instead of from validation. It is closed
 * at the two choke points every call passes through — the declared schema, and
 * the alias-repair table — rather than at the todo executor.
 *
 * What it does NOT catch: a model that sends a well-formed `op` naming the wrong
 * operation (`done` for work that is not done). That is a judgment error, not a
 * shape error, and no schema can see it.
 */
import { describe, expect, it } from "bun:test";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { GoalTool } from "@veyyon/coding-agent/goals/goal-tool";
import { repairToolCallArguments } from "@veyyon/coding-agent/tools/repair/schema-repair";
import { applyOpsToPhases, TodoTool } from "@veyyon/coding-agent/tools/todo";

const session = {
	getTodoPhases: () => [{ name: "Setup", tasks: [{ content: "Scaffold project structure", status: "pending" }] }],
	setTodoPhases: () => {},
	getSessionFile: () => undefined,
	settings: { get: () => undefined },
} as never;

/** The real chain a provider tool call walks: repair, then validation. */
function admit(
	tool: unknown,
	args: Record<string, unknown>,
): { repair: string; accepted: Record<string, unknown> | null } {
	const repaired = repairToolCallArguments(tool as never, { id: "c1", name: "todo", arguments: args } as never);
	if (repaired.status === "unrepairable") return { repair: repaired.status, accepted: null };
	try {
		return {
			repair: repaired.status,
			accepted: validateToolArguments(
				tool as never,
				{
					id: "c1",
					name: "todo",
					arguments: repaired.arguments,
				} as never,
			) as Record<string, unknown>,
		};
	} catch {
		return { repair: repaired.status, accepted: null };
	}
}

/** The model-facing text of a tool result, which is where a refusal has to land. */
function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("a todo call that does not name its operation", () => {
	const tool = new TodoTool(session);

	it("is refused by validation, not by the executor", () => {
		const { accepted } = admit(tool, { task: "Scaffold project structure" });
		expect(accepted).toBeNull();
	});

	it("names op as the field that is missing", () => {
		let message = "";
		try {
			validateToolArguments(
				tool as never,
				{
					id: "c1",
					name: "todo",
					arguments: { task: "Scaffold project structure" },
				} as never,
			);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("op");
	});

	it("returns a usable board and names the op when one reaches apply anyway", () => {
		// `applyOpsToPhases` is the OTHER door: the `/todo` slash command and any
		// extension build ops themselves and never pass through the tool schema.
		// An op-less entry there used to fall off the switch, return `undefined`
		// phases, and crash the next read of the board.
		const before = [
			{ name: "Setup", tasks: [{ content: "Scaffold project structure", status: "pending" as const }] },
		];
		const result = applyOpsToPhases(before, [{ task: "Scaffold project structure" } as never]);
		expect(result.errors.join(" ")).toContain("Unknown op");
		expect(result.errors.join(" ")).not.toContain("Missing op");
		// A board, not `undefined`, and no task closed or dropped by an op that
		// was never recognized. The in-progress pointer is the documented
		// normalization every apply runs, and the tool discards the whole result
		// when errors are present, so nothing it moved is persisted.
		expect(result.phases.map(phase => phase.tasks.map(task => task.content))).toEqual([
			["Scaffold project structure"],
		]);
		for (const phase of result.phases) {
			for (const task of phase.tasks) expect(["pending", "in_progress"]).toContain(task.status);
		}
	});

	// Every spelling a model reaches for instead of `op`, and the operation it
	// carries, swept from the alias table's own targets rather than listed twice.
	for (const alias of ["operation", "action"] as const) {
		it(`repairs \`${alias}\` onto op and executes the operation it named`, async () => {
			const { repair, accepted } = admit(tool, { [alias]: "start", task: "Scaffold project structure" });
			expect(repair).toBe("repaired");
			expect(accepted?.op).toBe("start");
			const result = await tool.execute("c1", accepted as never);
			expect(result.isError).toBeUndefined();
		});
	}

	it("refuses an operation whose case does not match the declared set", () => {
		expect(admit(tool, { op: "START", task: "Scaffold project structure" }).accepted).toBeNull();
	});

	it("still admits every declared operation", () => {
		for (const op of ["init", "start", "done", "rm", "drop", "append", "view"] as const) {
			expect(admit(tool, { op, task: "Scaffold project structure" }).accepted?.op).toBe(op);
		}
	});

	// The one shape the narrow deliberately exempts, and the reason the fix is a
	// narrow rather than a required property. Making `op` strictly required is the
	// obvious tempting repair and it silently kills the Claude/Cursor `TodoWrite`
	// payload; that repair turns this red.
	it("still admits the whole-board write that carries todos and no op", async () => {
		const args = { todos: [{ content: "Scaffold project structure", status: "completed" }] };
		const { accepted } = admit(tool, args);
		expect(accepted).not.toBeNull();
		const result = await tool.execute("c1", accepted as never);
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("Scaffold project structure");
	});

	it("refuses a whole-board write whose list is empty, rather than reading it as a clear", async () => {
		const { accepted } = admit(tool, { todos: [] });
		if (accepted === null) return; // refused at the schema is also correct
		const result = await tool.execute("c1", accepted as never);
		expect(result.isError).toBe(true);
		// The exact sentence, not merely "some error mentioning rm": every
		// unknown-op message lists `rm` among the valid ops, so a loose match here
		// stays green when this branch is deleted and the call falls through.
		expect(text(result)).toContain(
			'An empty "todos" list cannot initialize or clear todos. Pass op explicitly: op "rm" clears the board',
		);
	});
});

describe("the same repair reaches every tool that declares an op", () => {
	// The alias entry targets a NAME, so it fires on any tool declaring `op`.
	// `goal` is the other one; a third would be covered without a new test.
	it("renames operation onto op for the goal tool", () => {
		const goal = new GoalTool(session);
		const repaired = repairToolCallArguments(
			goal as never,
			{
				id: "c1",
				name: "goal",
				arguments: { operation: "status" },
			} as never,
		);
		expect(repaired.status).toBe("repaired");
		expect(repaired.status !== "unrepairable" ? repaired.arguments.op : undefined).toBe("status");
	});
});
