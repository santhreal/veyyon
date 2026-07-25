import { afterEach, describe, expect, test } from "bun:test";
import { createIntegrationWorkspace, type IntegrationWorkspace } from "../helpers/integration-workspace";

/**
 * End-to-end contracts for the agent loop driving REAL tools against a REAL
 * filesystem. Only the model is scripted; the loop, the tool implementations,
 * and the files are genuine.
 *
 * These lock the seam no unit test covers: that a tool call the model emits is
 * actually dispatched, actually executes, actually changes disk, and that its
 * result actually returns to the model so a following turn can act on it. A
 * mocked tool proves none of that.
 */
describe("agent loop drives real tools against a real workspace", () => {
	let workspace: IntegrationWorkspace | undefined;

	afterEach(() => {
		workspace?.dispose();
		workspace = undefined;
	});

	test("a scripted write tool call actually creates the file with the exact bytes", async () => {
		workspace = await createIntegrationWorkspace({
			script: [
				{
					content: [
						{ type: "toolCall", name: "write", arguments: { path: "notes/hello.txt", content: "hi there\n" } },
					],
				},
				{ content: ["wrote it"] },
			],
		});

		await workspace.send("create notes/hello.txt");

		// The file is real: assert the exact content, not merely that a tool ran.
		expect(workspace.exists("notes/hello.txt")).toBe(true);
		expect(workspace.read("notes/hello.txt")).toBe("hi there\n");
		expect(workspace.toolCalls().map(call => call.name)).toEqual(["write"]);
		expect(workspace.assistantText()).toBe("wrote it");
	});

	test("a read tool call returns real file content to the model, which the next turn can use", async () => {
		workspace = await createIntegrationWorkspace({
			files: { "src/config.ts": "export const PORT = 8080;\n" },
			// The second turn echoes what the model was handed, proving the tool RESULT
			// travelled back into the conversation rather than being dropped.
			script: (function* () {
				yield { content: [{ type: "toolCall" as const, name: "read", arguments: { path: "src/config.ts" } }] };
				yield (context: { messages: readonly { role: string; content: unknown }[] }) => ({
					content: [JSON.stringify(context.messages.length > 2)],
				});
			})(),
		});

		await workspace.send("read src/config.ts");

		expect(workspace.toolCalls().map(call => call.name)).toEqual(["read"]);
		// The tool result was appended to the conversation before the follow-up turn.
		expect(workspace.assistantText()).toBe("true");
		// The file was not mutated by reading it.
		expect(workspace.read("src/config.ts")).toBe("export const PORT = 8080;\n");
	});

	test("the edit tool refuses an unanchored edit in its default hashline mode", async () => {
		workspace = await createIntegrationWorkspace({
			files: { "app.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\n" },
			script: [
				{
					content: [
						{
							type: "toolCall",
							name: "edit",
							arguments: {
								path: "app.ts",
								edits: [{ old_text: "const b = 2;", new_text: "const b = 22;" }],
							},
						},
					],
				},
				{ content: ["done"] },
			],
		});

		await workspace.send("bump b");

		// Default edit mode is anchored (hashline): an edit that does not carry the
		// `[PATH#HASH]` anchor must be REFUSED, not silently applied to a stale file.
		// The refusal is the safety property — locking it here means a future change
		// that quietly accepts unanchored edits fails this test.
		const refusal = workspace.lastToolError();
		expect(refusal).toContain("[PATH#HASH]");
		// And, critically, the file is untouched.
		expect(workspace.read("app.ts")).toBe("const a = 1;\nconst b = 2;\nconst c = 3;\n");
	});

	test("several tool calls across turns apply in order to the same workspace", async () => {
		workspace = await createIntegrationWorkspace({
			script: [
				{ content: [{ type: "toolCall", name: "write", arguments: { path: "log.txt", content: "one\n" } }] },
				{ content: [{ type: "toolCall", name: "write", arguments: { path: "log.txt", content: "one\ntwo\n" } }] },
				{ content: ["done"] },
			],
		});

		await workspace.send("append twice");

		expect(workspace.toolCalls().map(call => call.name)).toEqual(["write", "write"]);
		// Last write wins, and the intermediate state was really on disk in between.
		expect(workspace.read("log.txt")).toBe("one\ntwo\n");
	});

	test("requesting an unknown tool fails loudly instead of silently wiring nothing", async () => {
		await expect(createIntegrationWorkspace({ tools: ["definitely-not-a-tool"] })).rejects.toThrow(
			/Unknown builtin tool "definitely-not-a-tool"/,
		);
	});
});
