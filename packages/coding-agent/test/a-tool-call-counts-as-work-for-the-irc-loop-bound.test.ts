/**
 * WHY: the IRC bus bounds two agents that trade messages with no work in between, and it reads
 * "work" from `AgentRegistry.workCount`. That count is fed by the session's `tool_execution_end`
 * events. If the session stops reporting, every pair looks idle and the bound refuses real
 * collaboration; if it reports coordination calls, an ack loop padded with `todo` updates looks
 * busy and is never bounded. Both are driven here through a real session and a scripted model.
 *
 * Not caught here: the bus's chain arithmetic, which `task/irc/irc-bus-ping-pong-cap.test.ts` owns.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { unregisterCustomApis } from "@veyyon/ai/api-registry";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockResponse, registerMockApi } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const MOCK_API_SOURCE = "a-tool-call-counts-as-work-for-the-irc-loop-bound";
const AGENT_ID = "Worker";

let tempDir: TempDir | undefined;
let authStorage: AuthStorage | undefined;
let session: AgentSession | undefined;

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	unregisterCustomApis(MOCK_API_SOURCE);
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

/** Run one prompt whose model makes `calls` in order, one per turn, then stops. Returns the agent's work count. */
async function workAfter(calls: MockResponse[]): Promise<number> {
	tempDir = TempDir.createSync("@veyyon-irc-work-count-");
	const cwd = tempDir.join("project");
	const agentDir = tempDir.join("agent");
	for (const dir of [cwd, agentDir]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(tempDir.join("project", "notes.txt"), "hello\n");
	authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("mock", "mock-key");
	registerMockApi(MOCK_API_SOURCE);

	const registry = new AgentRegistry();
	({ session } = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		agentId: AGENT_ID,
		agentRegistry: registry,
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "yolo" }),
		model: createMockModel({ responses: calls, handler: { content: ["done"] } }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	}));
	await session.prompt("go");
	return registry.workCount(AGENT_ID);
}

const read: MockResponse = { content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] };
const todo: MockResponse = { content: [{ type: "toolCall", name: "todo", arguments: { op: "view" } }] };

describe("a session's tool calls and the IRC loop bound", () => {
	it("counts a finished non-coordination tool call as work", async () => {
		expect(await workAfter([read, read])).toBe(2);
	});

	it("does not count a coordination tool call as work", async () => {
		expect(await workAfter([todo, read, todo])).toBe(1);
	});
});
