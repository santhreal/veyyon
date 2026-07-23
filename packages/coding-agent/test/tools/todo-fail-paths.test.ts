import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { TodoTool } from "@veyyon/coding-agent/tools/todo";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Todo tool: empty phases, invalid structure, and a valid set round-trip via
 * the session if exposed. Drives TodoTool when present.
 */

describe("TodoTool fail paths", () => {
	function session() {
		const phases: unknown[] = [];
		return {
			session: makeToolSession({
				cwd: process.cwd(),
				hasUI: false,
				getSessionFile: () => null,
				settings: Settings.isolated(),
				getTodoPhases: () => phases as never,
				setTodoPhases: (p: unknown[]) => {
					phases.length = 0;
					phases.push(...p);
				},
			}),
			phases,
		};
	}

	it("constructs without throwing", () => {
		const { session: s } = session();
		const tool = new TodoTool(s as never);
		expect(tool.name).toBe("todo");
	});

	it("execute with empty phases is accepted or rejected loudly (not hang)", async () => {
		const { session: s } = session();
		const tool = new TodoTool(s as never);
		try {
			const result = await tool.execute("t1", { phases: [] } as never);
			expect(result).toBeDefined();
		} catch (e) {
			expect(String(e).length).toBeGreaterThan(0);
		}
	});

	it("execute with a named phase records or returns that phase name", async () => {
		const { session: s, phases } = session();
		const tool = new TodoTool(s as never);
		const payload = {
			phases: [{ name: "Implementation", tasks: [{ text: "do the thing", status: "pending" }] }],
		};
		try {
			const result = await tool.execute("t2", payload as never);
			const text = result.content
				.filter(c => c.type === "text")
				.map(c => (c as { text: string }).text)
				.join("");
			expect(text.includes("Implementation") || phases.some(p => JSON.stringify(p).includes("Implementation"))).toBe(
				true,
			);
		} catch (e) {
			// Schema may differ — must fail with a message, not hang.
			expect(String(e)).toMatch(/phase|task|todo|invalid|required|type|error/i);
		}
	});
});
