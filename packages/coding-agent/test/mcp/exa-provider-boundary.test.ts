import { afterEach, describe, expect, it, vi } from "bun:test";
import type { TSchema } from "@veyyon/ai";
import { MCPWrappedTool } from "@veyyon/coding-agent/exa/mcp-client";
import type { CustomToolContext } from "@veyyon/coding-agent/extensibility/custom-tools/types";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const originalExaApiKey = Bun.env.EXA_API_KEY;

describe("Exa MCP provider boundary", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		if (originalExaApiKey === undefined) delete Bun.env.EXA_API_KEY;
		else Bun.env.EXA_API_KEY = originalExaApiKey;
	});

	it("transforms nested Exa and Websets argument keys and values at every physical call", async () => {
		Bun.env.EXA_API_KEY = "test-api-key";
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetchStub = Object.assign(
			async (input: FetchInput, init?: FetchInit) => {
				requests.push({
					url: String(input),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				return Response.json({
					jsonrpc: "2.0",
					id: "response",
					result: { content: [{ type: "text", text: "ok" }] },
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const rawArgs = {
			"outer-secret": "value-secret",
			nested: [{ "inner-secret": "deep-secret" }],
		};
		const ctx = {
			obfuscateProviderText: (text: string) => `one:${text}`,
		} as CustomToolContext;
		const exaTool = new MCPWrappedTool(
			{ name: "exa_search", label: "Exa", mcpToolName: "web_search_exa" },
			{} as TSchema,
			"",
		);
		const websetsTool = new MCPWrappedTool(
			{ name: "websets_search", label: "Websets", mcpToolName: "websets_search", isWebsetsTool: true },
			{} as TSchema,
			"",
		);

		await exaTool.execute("first", rawArgs, undefined, ctx);
		ctx.obfuscateProviderText = (text: string) => `two:${text}`;
		await exaTool.execute("second", rawArgs, undefined, ctx);
		ctx.obfuscateProviderText = (text: string) => `three:${text}`;
		await websetsTool.execute("third", rawArgs, undefined, ctx);

		expect(requests).toHaveLength(3);
		expect((requests[0]!.body.params as Record<string, unknown>).arguments).toEqual({
			"one:outer-secret": "one:value-secret",
			"one:nested": [{ "one:inner-secret": "one:deep-secret" }],
		});
		expect((requests[1]!.body.params as Record<string, unknown>).arguments).toEqual({
			"two:outer-secret": "two:value-secret",
			"two:nested": [{ "two:inner-secret": "two:deep-secret" }],
		});
		expect((requests[2]!.body.params as Record<string, unknown>).arguments).toEqual({
			"three:outer-secret": "three:value-secret",
			"three:nested": [{ "three:inner-secret": "three:deep-secret" }],
		});
		expect(requests[0]?.url).toContain("mcp.exa.ai/mcp");
		expect(requests[2]?.url).toContain("websetsmcp.exa.ai/mcp");
		expect(rawArgs).toEqual({
			"outer-secret": "value-secret",
			nested: [{ "inner-secret": "deep-secret" }],
		});
	});

	it("does not send or expose raw arguments when the transform rejects", async () => {
		const rawSecret = "never-send-this-argument";
		let fetchCalls = 0;
		const fetchStub = Object.assign(
			async () => {
				fetchCalls++;
				return Response.json({ jsonrpc: "2.0", id: "response", result: {} });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		const tool = new MCPWrappedTool(
			{ name: "exa_search", label: "Exa", mcpToolName: "web_search_exa" },
			{} as TSchema,
			"",
		);
		const ctx = {
			obfuscateProviderText: () => {
				throw new Error(rawSecret);
			},
		} as unknown as CustomToolContext;

		const result = await tool.execute("rejected", { secret: rawSecret }, undefined, ctx);

		expect(fetchCalls).toBe(0);
		expect(JSON.stringify(result)).toContain("Exa MCP tools/call confidentiality transform failed.");
		expect(JSON.stringify(result)).not.toContain(rawSecret);
	});
});
