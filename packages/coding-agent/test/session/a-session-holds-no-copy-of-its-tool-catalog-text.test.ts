/**
 * A session that has applied its tool set holds each input to the system prompt rebuild once: the
 * tool or the map that owns it holds the text, and the session holds nothing built from it.
 *
 * WHY THIS SUITE EXISTS. `AgentSession` skips a system prompt rebuild when the inputs the rebuild
 * reads are unchanged, and it detected that by joining every input into one string and keeping the
 * joined string to compare against the next apply. The inputs include every tool description, so
 * the kept string was the size of the tool catalog: 87,568 bytes for the default tool set, on the heap
 * for the life of the session and of every live subagent. The session now keeps a digest.
 *
 * THE CLASS, NOT THE INCIDENT. Every kind of text the rebuild reads is present at once, each as a
 * distinct flat string larger than anything else the session allocates: an active built-in tool's
 * description, an active MCP tool's description, a description of an MCP tool that is only in the
 * discovery registry, and an MCP server's instructions. Both entry points that apply a tool set run
 * twice each, the second time with identical inputs, which is the comparison that flattened the
 * joined string. After a full collection, every heap string at least as long as one input is
 * counted by the input it starts with. A join, a per-tool copy, or any other held string built from
 * the inputs shows up as a second count or as an `other` entry. The control is a copy the probe
 * itself holds of the first description, which must count twice: it proves the probe sees a held
 * copy rather than passing because it sees none.
 *
 * WHAT IT DOES NOT CATCH. A held string shorter than one input is not counted, so a retained
 * fragment of a description is not observed. Strings the session builds only when it sends a
 * request (tool schemas, the request body) are outside this probe.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

/** Characters in each input. Larger than any other string a session allocates at construction. */
const INPUT_LENGTH = 256 * 1024;

const HEAP_PROBE = `
const { Agent } = await import("@veyyon/agent-core");
const { buildModel } = await import("@veyyon/catalog/build");
const { Settings } = await import("@veyyon/coding-agent/config/settings");
const { AgentSession } = await import("@veyyon/coding-agent/session/agent-session");
const { SessionManager } = await import("@veyyon/kernel/session/session-manager");
const { type } = await import("arktype");

const length = Number(process.env.INPUT_LENGTH);
const flat = fill => Buffer.alloc(length, fill).toString("latin1");
const tool = (name, fill, mcp) => ({
	name,
	label: name,
	description: flat(fill),
	parameters: type({ q: "string" }),
	strict: true,
	...mcp,
	async execute() {
		return { content: [{ type: "text", text: name }] };
	},
});
const read = tool("read", "a");
const search = tool("mcp__srv_search", "b", { mcpServerName: "srv", mcpToolName: "search" });
const explain = tool("mcp__srv_explain", "c", { mcpServerName: "srv", mcpToolName: "explain" });
const instructions = new Map([["srv", flat("d")]]);
const control = Buffer.from(read.description, "latin1").toString("latin1");

const agent = new Agent({
	initialState: {
		model: buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		}),
		systemPrompt: ["initial"],
		tools: [read, search],
		messages: [],
	},
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(),
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry: {},
	toolRegistry: new Map([[read.name, read], [search.name, search]]),
	rebuildSystemPrompt: async () => ({ systemPrompt: ["rebuilt"] }),
	mcpDiscoveryEnabled: true,
	getMcpServerInstructions: () => instructions,
	getLocalCalendarDate: () => "2026-01-01",
});
await session.refreshMCPTools([search, explain]);
await session.refreshMCPTools([search, explain]);
await session.setActiveToolsByName([read.name, search.name]);
await session.setActiveToolsByName([read.name, search.name]);

globalThis.held = [read, search, explain, instructions, control];
Bun.gc(true);
const snap = JSON.parse(Bun.generateHeapSnapshot("v8"));
const fields = snap.snapshot.meta.node_fields;
const stride = fields.length;
const typeAt = fields.indexOf("type");
const nameAt = fields.indexOf("name");
const sizeAt = fields.indexOf("self_size");
const stringType = snap.snapshot.meta.node_types[0].indexOf("string");
const counts = {};
for (let i = 0; i < snap.nodes.length; i += stride) {
	if (snap.nodes[i + typeAt] !== stringType || snap.nodes[i + sizeAt] < length) continue;
	const value = snap.strings[snap.nodes[i + nameAt]];
	const key = /^([abcd])\\1{63}/.test(value) ? value[0] : "other";
	counts[key] = (counts[key] ?? 0) + 1;
}
process.stdout.write(JSON.stringify(counts));
await session.dispose();
`;

describe("a session holds no copy of its tool catalog text", () => {
	it("leaves each rebuild input held once by its owner after repeated identical applies", () => {
		const probe = spawnSync(process.execPath, ["-e", HEAP_PROBE], {
			cwd: path.join(import.meta.dirname, "..", ".."),
			encoding: "utf8",
			env: { ...process.env, INPUT_LENGTH: String(INPUT_LENGTH) },
		});
		expect(probe.stderr).toBe("");
		expect(JSON.parse(probe.stdout)).toEqual({ a: 2, b: 1, c: 1, d: 1 });
	});
});
