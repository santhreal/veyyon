#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server that offers one of everything a desktop
 * lists — a tool, a resource, a resource template and a prompt with an
 * argument — and declares list-changed notifications for tools and resources
 * plus resource subscriptions.
 *
 * Speaks newline-delimited JSON-RPC 2.0, the wire format of `StdioTransport`.
 * Only requests get a response; any request it does not model, `ping` and
 * `resources/subscribe` included, answers with an empty result. Arguments are
 * ignored, so a registry deploy that appends `--config <json>` still starts it.
 *
 * The exported constants are the expectations; the server starts only as the
 * entry module, so importing them spawns nothing.
 */
import * as readline from "node:readline";

export const SERVER_INFO = { name: "catalog-fixture", version: "2.0.0" };

export const TOOL = {
	name: "echo_message",
	description: "Echoes the input message",
	inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
};

export const RESOURCE = {
	uri: "file:///readme.md",
	name: "readme",
	description: "The readme",
	mimeType: "text/markdown",
};

export const TEMPLATE = { uriTemplate: "file:///{path}", name: "file", description: "Any file" };

export const PROMPT = {
	name: "greet",
	description: "Greets someone",
	arguments: [{ name: "who", description: "Whom to greet", required: true }],
};

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: SERVER_INFO,
				capabilities: {
					tools: { listChanged: true },
					resources: { subscribe: true, listChanged: true },
					prompts: {},
				},
			};
		case "tools/list":
			return { tools: [TOOL] };
		case "resources/list":
			return { resources: [RESOURCE] };
		case "resources/templates/list":
			return { resourceTemplates: [TEMPLATE] };
		case "prompts/list":
			return { prompts: [PROMPT] };
		default:
			return {};
	}
}

function startServer(): void {
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let msg: unknown;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			return;
		}
		if (typeof msg !== "object" || msg === null || !("id" in msg) || !("method" in msg)) return;
		const { id, method } = msg;
		if ((typeof id !== "string" && typeof id !== "number") || typeof method !== "string") return;
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: buildResult(method) })}\n`);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
