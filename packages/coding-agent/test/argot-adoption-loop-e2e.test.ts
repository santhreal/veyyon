/**
 * The argot agent-driven ADOPTION LOOP, end to end through a real AgentSession:
 *
 *   session starts UNARMED (createArgotSession, the real factory)
 *     → mock model's first scripted turn calls argot_load (the model "decides")
 *       → the REAL ArgotLoadTool resolves the repo, generates the cache entry,
 *         and loads the codec
 *     → the model's second turn writes a §handle it was just taught (adoption),
 *       in a bash command argument
 *       → the REAL expand seam (transformToolCallArguments → expandToolArguments)
 *         turns it back into the full path BEFORE bash runs
 *         → bash executes against the real path and returns the file's content
 *     → the model's final text writes a §handle again
 *       → session.displayAssistantContent (seam 2) expands it for the operator
 *
 * Why this suite exists: every seam is unit-tested and the settings layer is
 * e2e-tested, but the LOOP — unarmed start, agent-driven load, adoption,
 * expansion before execution — was only ever verified piecemeal. The user's
 * design change (the agent, not the launch directory, picks the project) is a
 * wiring contract, and wiring bugs hide exactly between the pieces. If the load
 * tool registration, the codec handoff to the tool session, the expand seam, or
 * the display seam is reverted, a test here fails with the raw `§handle` or a
 * missing file visible in the output.
 *
 * The scripted model stands in for a real frontier model: its "adoption" is
 * scripted (it reads the freshly generated handle table out of the session codec
 * the way a real model would read it from the system prompt), so the test proves
 * the harness, not model recall. Model recall is the live bench's job (ARG-BENCH).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { createArgotSession } from "@veyyon/coding-agent/argot-cache";
import { expandToolArguments } from "@veyyon/coding-agent/argot-wire";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { ArgotLoadTool, ArgotUnloadTool } from "@veyyon/coding-agent/tools/argot";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import {
	__resetDirsFromEnvForTests,
	APP_NAME,
	getArgotCacheDir,
	removeSyncWithRetries,
	setProfile,
	Snowflake,
} from "@veyyon/utils";
import { type ArgotSession, renderPreamble } from "argot";

const CONNECTION = "packages/server/src/database/connection.ts";
const ROUTES = "packages/server/src/server/routes.ts";
const TEST_PROFILE = "argot-loop-test";
const MODEL_ID = "claude-sonnet-4-5";

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

function writeFile(root: string, rel: string, content: string): void {
	fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), content);
}

function toolCall(name: string, args: Record<string, unknown>, callId: string): MockResponse {
	return { content: [{ type: "toolCall", id: callId, name, arguments: args }], stopReason: "toolUse" };
}

function stopReply(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

/** The text of the most recent toolResult for a call id, or undefined (prints what was seen). */
function getToolResultText(messages: AgentMessage[], callId: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "toolResult" || message.toolCallId !== callId) continue;
		const block = message.content.find((c): c is { type: "text"; text: string } => c.type === "text");
		return block?.text;
	}
	return undefined;
}

describe("argot agent-driven adoption loop (e2e)", () => {
	let repoDir = "";
	let cacheRoot = "";
	let tempDir = "";
	let originalXdgCache: string | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let argot: ArgotSession;
	let scripted: MockResponse[];

	beforeEach(async () => {
		cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argot-loop-xdg-"));
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-loop-repo-"));
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-loop-home-"));

		// XDG cache isolation, proven before any test runs (see argot-cache.test.ts).
		originalXdgCache = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = path.join(cacheRoot, "cache");
		fs.mkdirSync(path.join(process.env.XDG_CACHE_HOME, APP_NAME, "profiles", TEST_PROFILE), { recursive: true });
		setProfile(TEST_PROFILE);
		if (!getArgotCacheDir().startsWith(cacheRoot)) {
			throw new Error(`cache root not isolated: ${getArgotCacheDir()}`);
		}

		writeFile(repoDir, CONNECTION, "export const url = 'x';\n");
		writeFile(repoDir, ROUTES, `import '../database/connection.ts';\n// see ${CONNECTION}\n`);
		git(repoDir, "init", "-q");
		git(repoDir, "config", "user.email", "t@example.com");
		git(repoDir, "config", "user.name", "Test");
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "init");

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", MODEL_ID);
		if (!model) throw new Error(`expected ${MODEL_ID} to be bundled`);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const settings = Settings.isolated({
			"argot.enabled": true,
			"argot.models": [MODEL_ID],
			"argot.subagents": "off",
			"compaction.enabled": false,
			"todo.enabled": false,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir);

		// The REAL session factory: enabled, top-level, so it returns a codec that
		// has NEVER been armed — agent-driven loading means nothing is loaded until
		// the model calls argot_load.
		const codec = createArgotSession({ enabled: true, isSubagent: false, subagentMode: "off" });
		if (codec === undefined) throw new Error("expected a codec for an enabled top-level session");
		argot = codec;

		const toolSession: ToolSession = {
			cwd: repoDir,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getSessionSpawns: () => "*",
			getArgotSession: () => argot,
		};
		const loadTool = new ArgotLoadTool(toolSession);
		const unloadTool = new ArgotUnloadTool(toolSession);
		const bashTool = new BashTool(toolSession);
		const tools = [loadTool, unloadTool, bashTool] as unknown as AgentTool[];

		const mock = createMockModel({
			handler: () => scripted.shift() ?? stopReply("done"),
		});

		scripted = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				// The REAL SDK notation block, exactly as sdk.ts injects it when the
				// encode gate fires (argot.enabled + allowlisted model + under cutoff).
				systemPrompt: [renderPreamble({ tools: true })],
				tools,
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
			// The REAL seam 1, one line mirroring sdk.ts's transformToolCallArguments:
			// expansion runs before the tool executes, identity until a dict loads.
			transformToolCallArguments: args => (argot.loaded ? expandToolArguments(argot, args) : args),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			argot,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = originalXdgCache;
		__resetDirsFromEnvForTests();
		for (const dir of [repoDir, cacheRoot, tempDir]) if (dir) removeSyncWithRetries(dir);
		resetSettingsForTest();
	});

	it("unarmed start → agent loads → adoption expands before execution and on display", async () => {
		// The factory contract: nothing is armed until the model decides.
		expect(argot.loaded).toBe(false);
		expect(argot.promptFragment()).toBe("");

		// Turn 1: the model "decides" to load the project it is working in.
		scripted.push(toolCall("argot_load", { folder_path: repoDir }, "call_load"));
		await session!.prompt("work on this repo");
		await session!.waitForIdle();

		const loadResult = getToolResultText(session!.agent.state.messages, "call_load");
		expect(loadResult, "expected an argot_load toolResult").toBeDefined();
		expect(loadResult).toContain("Loaded Argot shorthand for");
		expect(argot.loaded).toBe(true);

		const fragment = argot.promptFragment();
		expect(fragment).toContain(CONNECTION);
		const match = fragment.match(/`§([a-z0-9_]+)`\s*→\s*`([^`]+)`/);
		expect(match, "expected at least one taught handle in the fragment").not.toBeNull();
		const [, name, expansion] = match!;

		// Turn 2 (adoption): the model writes the handle where it would have
		// written the expansion — inside a bash command argument.
		// Turn 3: the model writes the handle in its final user-visible text.
		scripted.push(toolCall("bash", { command: `cat §${name}`, timeout: 10 }, "call_cat"));
		scripted.push(stopReply(`The connection pool lives in §${name}.`));
		await session!.prompt("continue");
		await session!.waitForIdle();

		// Seam 1: bash received the EXPANDED path — the file content came back,
		// which is impossible if the raw `§name` reached the shell.
		const catResult = getToolResultText(session!.agent.state.messages, "call_cat");
		expect(catResult, "expected a bash toolResult for the cat").toBeDefined();
		expect(catResult).toContain("export const url = 'x';");
		expect(catResult).not.toContain("cat: §");

		// Seam 2: the operator-visible form of the final message is expanded.
		const lastMessage = session!.state.messages[session!.state.messages.length - 1];
		if (lastMessage?.role !== "assistant") throw new Error("expected a final assistant message");
		const display = session!.displayAssistantContent(lastMessage.content);
		const text = display.find(c => c.type === "text");
		expect(text).toMatchObject({ type: "text", text: `The connection pool lives in ${expansion}.` });

		// The cache entry exists on disk under the isolated root (nothing in the repo).
		expect(fs.existsSync(getArgotCacheDir())).toBe(true);
		expect(fs.existsSync(path.join(repoDir, "AGENTS.dict"))).toBe(false);
	});

	it("an argot_load of a folder with no project marker is a loud no-op, not an error", async () => {
		const markerFree = fs.mkdtempSync(path.join(os.tmpdir(), "argot-loop-none-"));
		try {
			scripted.push(toolCall("argot_load", { folder_path: markerFree }, "call_load_none"));
			scripted.push(stopReply("nothing to load"));
			await session!.prompt("load that folder");
			await session!.waitForIdle();

			const result = getToolResultText(session!.agent.state.messages, "call_load_none");
			expect(result).toBeDefined();
			expect(result).toContain("No project marker (.git or .argot) found");
			expect(argot.loaded).toBe(false);
		} finally {
			removeSyncWithRetries(markerFree);
		}
	});

	it("the notation preamble the model is taught names the argot_load tool it actually has", async () => {
		scripted.push(stopReply("ok"));
		await session!.prompt("hello");
		await session!.waitForIdle();
		const prompt = session!.agent.state.systemPrompt.join("\n");
		expect(prompt).toContain("argot_load(folder_path)");
		expect(prompt).toContain("argot_unload(folder_path)");
		// The tool set handed to the model carries both tools under those names.
		const toolNames = session!.agent.state.tools.map(tool => tool.name).sort();
		expect(toolNames).toEqual(["argot_load", "argot_unload", "bash"]);
	});
});
