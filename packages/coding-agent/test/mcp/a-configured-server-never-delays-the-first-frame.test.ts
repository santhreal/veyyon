/**
 * WHY: a configured MCP server used to be able to hold the boot path. `createAgentSession`
 * connects every server before it returns, and the interactive launch cannot paint until it
 * returns, so one slow or hung stdio server delayed the first frame by however long its
 * `initialize` took. The UI path now defers discovery: `deferMCPDiscoveryForUI` builds the manager,
 * hands `startDeferredMCPDiscovery` a live session, and fires it without awaiting it (`sdk.ts`).
 *
 * The class this closes is "boot-path work that waits on an external process". The fence is a
 * server that NEVER answers: if any pre-paint step awaits a connect, session creation cannot
 * resolve and the case fails as a timeout rather than a wrong value. The deferred work is then
 * proved to still land, so a regression cannot pass by simply skipping MCP.
 *
 * Two independent routes deliver the tools once the connect finishes: the explicit
 * `refreshMCPTools` in the deferred closure, and the manager's `setOnToolsChanged` callback wired
 * a few lines later. Cutting either one alone changes nothing observable, so the mutation gate
 * cuts both together; the redundancy is deliberate, because a list restored from the tool cache
 * does not always raise a change event.
 *
 * Writing this suite found a second defect: `discoverAndLoadMCPTools` copied three of its caller's
 * discover options by hand and dropped `agentDir`, so the headless path discovered the
 * process-active profile's servers instead of the caller's. The third case is what holds that
 * fixed.
 *
 * What it does not catch: a server configured through a non-builtin provider (Claude, Cursor,
 * Gemini config files) reaching a different code path into the same connect, and any pre-paint
 * await on something other than MCP. It pins the MCP seam and the flag that governs it, not every
 * possible boot-path wait.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CustomTool } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** A stdio MCP server that answers `initialize` and `tools/list` and nothing else. */
const ANSWERING_SERVER = `
const { createInterface } = require("node:readline");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
	if (!line.trim()) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.id === undefined) return;
	if (msg.method === "initialize") {
		reply(msg.id, {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "probe", version: "0.0.0" },
		});
		return;
	}
	if (msg.method === "tools/list") {
		reply(msg.id, {
			tools: [{
				name: "echo",
				description: "Echoes its input.",
				inputSchema: { type: "object", properties: { text: { type: "string" } } },
			}],
		});
		return;
	}
	reply(msg.id, {});
});
`;

/**
 * A stdio MCP server that reads its input and never writes a byte. It is the fence: a boot path
 * that awaits a connect cannot get past this process.
 */
const SILENT_SERVER = `
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", () => {});
`;

const PROBE_TOOL_NAME = "mcp__probe_echo";

interface Fixture {
	tempDir: TempDir;
	agentDir: string;
	cwd: string;
}

describe("a configured MCP server never delays the first frame", () => {
	const fixtures: Fixture[] = [];
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const fixture of fixtures.splice(0)) await fixture.tempDir.remove();
	});

	async function seed(name: string, source: string): Promise<Fixture> {
		const tempDir = await TempDir.create(`veyyon-mcp-defer-${name}-`);
		const agentDir = tempDir.join("agent");
		const cwd = tempDir.join("project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		const serverPath = path.join(agentDir, "server.cjs");
		await fs.writeFile(serverPath, source, "utf8");
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [serverPath] } } }),
			"utf8",
		);
		const fixture: Fixture = { tempDir, agentDir, cwd };
		fixtures.push(fixture);
		return fixture;
	}

	async function boot(fixture: Fixture, hasUI: boolean): Promise<AgentSession> {
		const authStorage = await AuthStorage.create(fixture.tempDir.join(`auth-${hasUI}.db`));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			hasUI,
			sessionManager: SessionManager.inMemory(fixture.cwd),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({ "async.enabled": false, "startup.quiet": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: fixture.cwd,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: true,
			enableLsp: false,
		});
		sessions.push(session);
		return session;
	}

	/**
	 * Resolves with the tool names of the first non-empty deferred refresh. Installed on the
	 * prototype BEFORE the session exists, because the deferred work is started by
	 * `createAgentSession` itself and a spy installed afterwards races it.
	 */
	function watchDeferredRefresh(): Promise<string[]> {
		const { promise, resolve } = Promise.withResolvers<string[]>();
		const real = AgentSession.prototype.refreshMCPTools;
		vi.spyOn(AgentSession.prototype, "refreshMCPTools").mockImplementation(async function (
			this: AgentSession,
			tools: CustomTool[],
			options?: { activateAll?: boolean },
		) {
			await real.call(this, tools, options);
			if (tools.length > 0) resolve(tools.map(tool => tool.name));
		});
		return promise;
	}

	it("resolves session creation while a server that never answers is still connecting", async () => {
		const fixture = await seed("silent", SILENT_SERVER);

		// No deadline is asserted here on purpose: if any pre-paint step awaits the connect, this
		// await never settles and the case fails as a timeout, which is the failure mode a stalled
		// launch has.
		const session = await boot(fixture, true);

		expect(session.getToolByName(PROBE_TOOL_NAME)).toBeUndefined();
		expect(session.getActiveToolNames()).not.toContain(PROBE_TOOL_NAME);
	});

	it("still delivers the server's tools after creation returns", async () => {
		const fixture = await seed("answering", ANSWERING_SERVER);
		const refreshed = watchDeferredRefresh();

		const session = await boot(fixture, true);
		const delivered = await refreshed;

		expect(delivered).toContain(PROBE_TOOL_NAME);
		expect(session.getToolByName(PROBE_TOOL_NAME)).toBeDefined();
	});

	it("carries the tools through creation itself when there is no UI to paint", async () => {
		// The headless path has no frame to protect and callers expect a fully provisioned session
		// on return, so it keeps the awaited connect. This pins which flag governs the deferral: a
		// change that defers unconditionally, or that stops deferring for the UI, breaks one of
		// these two cases.
		const fixture = await seed("headless", ANSWERING_SERVER);

		const session = await boot(fixture, false);

		expect(session.getToolByName(PROBE_TOOL_NAME)).toBeDefined();
	});
});
