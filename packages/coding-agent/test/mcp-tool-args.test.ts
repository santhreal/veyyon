import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CustomToolContext } from "@veyyon/coding-agent/extensibility/custom-tools";
import { DeferredMCPTool, MCPTool, type MCPToolDefinition } from "@veyyon/coding-agent/mcp";
import type { MCPServerConnection } from "@veyyon/coding-agent/mcp/types";
import { TempDir } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { createMockConnection, createMockTransport } from "./helpers/mcp-mocks";

type CapturedRequest = {
	method: string;
	params: Record<string, unknown> | undefined;
};

const unusedContext = {} as CustomToolContext;

function createSearchToolDefinition(): MCPToolDefinition {
	return {
		name: "search",
		description: "Search symbols or file locations",
		inputSchema: {
			type: "object",
			properties: {
				symbol: { type: "string" },
				language: { type: "string" },
				file: { type: "string" },
				line: { type: "number" },
				column: { type: "number" },
				filters: { type: "object" },
				exact: { type: "boolean" },
			},
			required: ["symbol", "language"],
		},
	};
}

function createCapturedConnection(calls: CapturedRequest[]): MCPServerConnection {
	const transport = createMockTransport(
		new Map([["tools/call", [{ content: [{ type: "text", text: "ok" }] }]]]),
		(method, params) => calls.push({ method, params }),
	);
	return createMockConnection({ tools: {} }, transport);
}

const imageToolDefinition: MCPToolDefinition = {
	name: "read_image_with_model",
	description: "Read an image from a local filesystem path",
	inputSchema: {
		type: "object",
		properties: {
			image_path: { type: "string" },
		},
		required: ["image_path"],
	},
};

async function createLocalImageContext(
	tempDir: TempDir,
): Promise<{ context: CustomToolContext; expectedPath: string }> {
	const artifactsDir = tempDir.join("artifacts");
	const writtenPath = path.join(artifactsDir, "local", "image-issue.png");
	await Bun.write(writtenPath, "png bytes");
	const expectedPath = await fs.realpath(writtenPath);
	return {
		context: {
			localProtocolOptions: {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-id",
			},
		} as CustomToolContext,
		expectedPath,
	};
}

describe("MCP tool arguments", () => {
	it("omits optional empty placeholders before tools/call", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createSearchToolDefinition());

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "", file: "", line: 0, filters: {}, exact: false },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "", line: 0, exact: false },
				},
			},
		]);
	});

	it("omits optional empty placeholders for deferred MCP tools", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("intellij-index", createSearchToolDefinition(), async () => connection);

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "TypeScript", file: "", column: "", filters: {} },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "TypeScript" },
				},
			},
		]);
	});

	it("strips the harness intent field before tools/call", async () => {
		// Regression: the harness injects `i` into every tool's wire schema and
		// the eval `tool.*` bridge forwards it verbatim. Strict-schema MCP
		// servers (e.g. Linear) reject every such call with
		// `unrecognized_keys: ["i"]`. The MCP boundary owns the contract; `i`
		// must never reach `tools/call`.
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createSearchToolDefinition());

		await tool.execute(
			"call-1",
			{ [INTENT_FIELD]: "looking up Foo", symbol: "Foo", language: "TypeScript", file: "" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "search", arguments: { symbol: "Foo", language: "TypeScript" } },
			},
		]);
	});

	it("strips the harness intent field for deferred MCP tools", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("intellij-index", createSearchToolDefinition(), async () => connection);

		await tool.execute(
			"call-1",
			{ [INTENT_FIELD]: "deferred lookup", symbol: "Bar", language: "TypeScript" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "search", arguments: { symbol: "Bar", language: "TypeScript" } },
			},
		]);
	});

	it("preserves `i` when the server's own schema declares it", async () => {
		// A server that legitimately exposes `i` as one of its parameters
		// must receive the caller-supplied value untouched. The boundary
		// guard checks the server's declared `properties` and steps aside.
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "echo",
			description: "Echo a single token",
			inputSchema: {
				type: "object",
				properties: { i: { type: "string" } },
				required: ["i"],
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);

		await tool.execute("call-1", { i: "hello" }, undefined, unusedContext, undefined);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "echo", arguments: { i: "hello" } } }]);
	});

	it("resolves local image arguments before forwarding tools/call", async () => {
		using tempDir = TempDir.createSync("@pi-mcp-local-image-");
		const calls: CapturedRequest[] = [];
		const { context, expectedPath } = await createLocalImageContext(tempDir);
		const tool = new MCPTool(createCapturedConnection(calls), imageToolDefinition);

		await tool.execute("call-1", { image_path: "local://image-issue.png" }, undefined, context, undefined);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "read_image_with_model", arguments: { image_path: expectedPath } },
			},
		]);
	});

	it("expands local URLs before recursively transforming nested string keys and values", async () => {
		using tempDir = TempDir.createSync("@pi-mcp-provider-boundary-");
		const calls: CapturedRequest[] = [];
		const { context, expectedPath } = await createLocalImageContext(tempDir);
		const transformedInputs: string[] = [];
		context.obfuscateProviderText = text => {
			transformedInputs.push(text);
			return `safe:${text}`;
		};
		const rawArgs = {
			image_path: "local://image-issue.png",
			nested_secret: { hidden_key: "hidden_value" },
			list: ["list_value"],
		};
		const tool = new MCPTool(createCapturedConnection(calls), imageToolDefinition);

		await tool.execute("call-1", rawArgs, undefined, context, undefined);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.params?.arguments).toEqual({
			"safe:image_path": `safe:${expectedPath}`,
			"safe:nested_secret": { "safe:hidden_key": "safe:hidden_value" },
			"safe:list": ["safe:list_value"],
		});
		expect(transformedInputs).toContain(expectedPath);
		expect(transformedInputs).not.toContain("local://image-issue.png");
		expect(rawArgs).toEqual({
			image_path: "local://image-issue.png",
			nested_secret: { hidden_key: "hidden_value" },
			list: ["list_value"],
		});
	});

	it("does not send MCPTool requests or expose raw input when the transform rejects", async () => {
		const rawSecret = "mcp-raw-secret";
		const calls: CapturedRequest[] = [];
		const context = {
			obfuscateProviderText: (text: string) => {
				if (text === rawSecret) throw new Error(`cannot transform ${rawSecret}`);
				return text;
			},
		} as CustomToolContext;
		const tool = new MCPTool(createCapturedConnection(calls), imageToolDefinition);

		const result = await tool.execute("call-1", { image_path: rawSecret }, undefined, context, undefined);

		expect(calls).toHaveLength(0);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "MCP error: MCP tool call confidentiality transform failed.",
		});
		expect(JSON.stringify(result)).not.toContain(rawSecret);
	});
	it("suppresses a remote isError payload that reflects raw nested arguments", async () => {
		const rawSecret = "mcp-reflected-raw-secret";
		const transport = createMockTransport(
			new Map([
				[
					"tools/call",
					[
						{
							content: [{ type: "text", text: `server rejected ${rawSecret}` }],
							isError: true,
						},
					],
				],
			]),
		);
		const tool = new MCPTool(createMockConnection({ tools: {} }, transport), imageToolDefinition);
		const context = {
			obfuscateProviderText: (text: string) => text.replaceAll(rawSecret, "safe-secret"),
		} as CustomToolContext;

		const result = await tool.execute(
			"call-reflected-error",
			{ nested: { image_path: rawSecret } },
			undefined,
			context,
		);

		expect(result.content[0]).toEqual({ type: "text", text: "Error: MCP tool call failed." });
		expect(result.details?.rawContent).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain(rawSecret);
	});

	it("waits for DeferredMCPTool connection resolution before using the live transform", async () => {
		const rawSecret = "deferred-raw-secret";
		const calls: CapturedRequest[] = [];
		const context = {
			obfuscateProviderText: (text: string) => text,
		} as CustomToolContext;
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("test-server", imageToolDefinition, async () => {
			context.obfuscateProviderText = text => text.replaceAll(rawSecret, "deferred-safe");
			return connection;
		});

		await tool.execute("call-1", { image_path: rawSecret }, undefined, context, undefined);

		expect(calls[0]?.params?.arguments).toEqual({ image_path: "deferred-safe" });
	});
});
