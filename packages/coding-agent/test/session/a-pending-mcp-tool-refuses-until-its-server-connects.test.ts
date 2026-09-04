/**
 * WHY: MCP discovery is deferred, so a session can restore a tool selection that
 * names tools no server has connected for yet. A placeholder stands in for each
 * one. If the placeholder answers as a success the model believes it ran the
 * tool; if it is registered under a name that does not match the selection, the
 * model calls a tool that does not exist. Both fail as a wrong answer rather
 * than as an error.
 *
 * Closes the class: the placeholder is asserted to be an error result that names
 * its server, the name collection is asserted to normalize case and to admit
 * only MCP tool names, and the prompt commands are asserted to be built per
 * connected server with arguments parsed from `k=v`.
 *
 * Does NOT catch: the real activation that replaces a placeholder — that is the
 * MCP manager's lifecycle, driven by the MCP runtime suites.
 */

import { describe, expect, it } from "bun:test";
import type { HookCommandContext } from "../../src/extensibility/custom-commands";
import type { MCPManager } from "../../src/mcp";
import {
	applyMCPEnvironment,
	buildMCPPromptCommands,
	collectPendingMCPToolNames,
	createPendingMCPTool,
	MAX_MCP_INSTRUCTIONS_LENGTH,
} from "../../src/session/factory-mcp";

describe("a pending MCP tool refuses until its server connects", () => {
	it("answers as an error naming the server that is still connecting", async () => {
		const tool = createPendingMCPTool("mcp__docs_search");

		expect(tool.name).toBe("mcp__docs_search");
		expect(tool.label).toBe("docs/search");
		const result = await tool.execute("call-1", {});
		expect(result.isError).toBe(true);
		const text = JSON.stringify(result.content);
		expect(text).toContain("docs");
		expect(text).toContain("still connecting");
	});

	it("stays out of the model's tool list and asks for write approval, so it cannot run silently", () => {
		const tool = createPendingMCPTool("mcp__docs_search");

		expect(tool.intent).toBe("omit");
		expect(tool.approval).toBe("write");
	});

	it("still refuses when the name carries no server, instead of claiming one", async () => {
		const tool = createPendingMCPTool("not-an-mcp-name");

		expect(tool.label).toBe("not-an-mcp-name");
		const result = await tool.execute("call-1", {});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("MCP discovery is still in progress");
	});

	it("collects only MCP names, lowercased, from both the explicit list and the restored selection", () => {
		const names = collectPendingMCPToolNames(
			["MCP__DOCS_SEARCH", "read", "bash"],
			["mcp__docs_search", "mcp__other_fetch", "edit"],
		);

		expect(names).toEqual(["mcp__docs_search", "mcp__other_fetch"]);
	});

	it("collects nothing when no side names an MCP tool", () => {
		expect(collectPendingMCPToolNames(undefined, [])).toEqual([]);
		expect(collectPendingMCPToolNames(["read", "edit"], ["bash"])).toEqual([]);
	});

	it("builds one prompt command per prompt of every connected server", () => {
		const manager = {
			getConnectedServers: () => ["docs", "quiet"],
			getServerPrompts: (server: string) =>
				server === "docs" ? [{ name: "summarize", description: "Summarize a page" }, { name: "cite" }] : [],
			executePrompt: async () => undefined,
		} as unknown as MCPManager;

		const commands = buildMCPPromptCommands(manager);

		expect(commands.map(entry => entry.command.name)).toEqual(["docs:summarize", "docs:cite"]);
		expect(commands.map(entry => entry.path)).toEqual(["mcp:docs:summarize", "mcp:docs:cite"]);
		expect(commands[0].command.description).toBe("Summarize a page");
		expect(commands[1].command.description).toBe("MCP prompt from docs");
	});

	it("parses k=v arguments and joins the text of a prompt's reply", async () => {
		const calls: Array<{ server: string; prompt: string; args: Record<string, string> }> = [];
		const manager = {
			getConnectedServers: () => ["docs"],
			getServerPrompts: () => [{ name: "summarize" }],
			executePrompt: async (server: string, prompt: string, args: Record<string, string>) => {
				calls.push({ server, prompt, args });
				return {
					messages: [
						{ content: [{ type: "text", text: "first" }] },
						{ content: { type: "resource", resource: { text: "second" } } },
						{ content: [{ type: "image", data: "AAAA" }] },
					],
				};
			},
		} as unknown as MCPManager;

		const commands = buildMCPPromptCommands(manager);
		const output = await commands[0].command.execute(
			["page=intro", "depth=2", "bare", "=novalue"],
			{} as HookCommandContext,
		);

		expect(calls).toEqual([{ server: "docs", prompt: "summarize", args: { page: "intro", depth: "2" } }]);
		expect(output).toBe("first\n\nsecond");
	});

	it("returns nothing when a prompt yields no reply at all", async () => {
		const manager = {
			getConnectedServers: () => ["docs"],
			getServerPrompts: () => [{ name: "summarize" }],
			executePrompt: async () => undefined,
		} as unknown as MCPManager;

		const commands = buildMCPPromptCommands(manager);

		expect(await commands[0].command.execute([], {} as HookCommandContext)).toBe("");
	});

	it("bounds per-server instructions, so one server cannot flood the system prompt", () => {
		expect(MAX_MCP_INSTRUCTIONS_LENGTH).toBeGreaterThan(0);
		expect(MAX_MCP_INSTRUCTIONS_LENGTH).toBeLessThanOrEqual(8000);
	});

	it("adopts a discovered Exa key only when the environment has none", () => {
		const exaKey = (): string | undefined => Bun.env.EXA_API_KEY;
		const previous = exaKey();
		try {
			delete Bun.env.EXA_API_KEY;
			applyMCPEnvironment({ exaApiKeys: ["from-mcp", "second"] });
			expect(exaKey()).toBe("from-mcp");

			applyMCPEnvironment({ exaApiKeys: ["replacement"] });
			expect(exaKey()).toBe("from-mcp");

			delete Bun.env.EXA_API_KEY;
			applyMCPEnvironment({ exaApiKeys: [] });
			expect(exaKey()).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.EXA_API_KEY;
			else Bun.env.EXA_API_KEY = previous;
		}
	});
});
