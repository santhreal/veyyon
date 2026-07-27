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
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ArgotLoadTool, ArgotUnloadTool } from "@veyyon/coding-agent/tools/argot";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import {
	__resetDirsFromEnvForTests,
	APP_NAME,
	getAgentDir,
	getArgotCacheDir,
	removeSyncWithRetries,
	setProfile,
} from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { type ArgotSession, renderPreamble } from "argot";

const CONNECTION = "packages/server/src/database/connection.ts";
const ROUTES = "packages/server/src/server/routes.ts";
const TEST_PROFILE = "argot-loop-test";
let dirOverrides: DirOverridesSnapshot;
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
	let originalConfigDir: string | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let argot: ArgotSession;
	let scripted: MockResponse[];
	let refreshCalls: number;

	beforeEach(async () => {
		cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argot-loop-xdg-"));
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-loop-repo-"));
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-loop-home-"));

		// TWO levers are needed, and using only the first is what let this suite
		// create `~/.veyyon/profiles/argot-loop-test/` in the developer's REAL config
		// root. `XDG_CACHE_HOME` moves the CACHE; everything else the session touches
		// (agent storage, gpu_cache.json) resolves from the CONFIG ROOT, which
		// `setProfile` only names a subdirectory of. `VEYYON_CONFIG_DIR` is what moves
		// the root itself: the resolver joins it onto the home directory, so a
		// relative path back out lands the whole root in temp. See
		// docs/internal/testing.md.
		originalXdgCache = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = path.join(cacheRoot, "cache");
		fs.mkdirSync(path.join(process.env.XDG_CACHE_HOME, APP_NAME, "profiles", TEST_PROFILE), { recursive: true });
		originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempDir);
		// Snapshot before the profile switch. Restoring the two variables is not
		// enough: `setProfile` records the active profile in MODULE state and writes
		// `VEYYON_PROFILE` and `VEYYON_CODING_AGENT_DIR`, so this suite left every later
		// file in the process on `argot-loop-test` — `scripts/find-test-leaks.ts`
		// reported `state.activeProfile: work -> argot-loop-test`.
		dirOverrides = captureDirOverrides();
		__resetDirsFromEnvForTests();
		setProfile(TEST_PROFILE);
		// Proof, not intention: BOTH roots are checked, because the cache assertion
		// alone passed for months while the config root stayed real.
		if (!getArgotCacheDir().startsWith(cacheRoot)) {
			throw new Error(`cache root not isolated: ${getArgotCacheDir()}`);
		}
		const resolvedAgentDir = path.resolve(getAgentDir());
		if (path.relative(tempDir, resolvedAgentDir).startsWith("..")) {
			throw new Error(`config root not isolated: ${resolvedAgentDir} is outside ${tempDir}`);
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
			"argot.encode.models": [MODEL_ID],
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

		refreshCalls = 0;
		const toolSession: ToolSession = {
			cwd: repoDir,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getSessionSpawns: () => "*",
			getArgotSession: () => argot,
			refreshBaseSystemPrompt: async () => {
				refreshCalls += 1;
			},
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
			// On, as sdk.ts has it by default, so the intent a model writes is lifted
			// out of the arguments here the same way it is in production. The intent
			// is an operator-visible string that does NOT travel with the arguments,
			// so leaving tracing off would hide the seam this suite checks.
			intentTracing: true,
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
		if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
		restoreDirOverrides(dirOverrides);
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

	it("shows the operator an expanded tool call: arguments and intent, on the events the renderer reconciles from", async () => {
		// The operator-facing half of adoption. A handle the model writes in a tool
		// call reaches the screen down two paths, and both used to carry the raw
		// form:
		//
		//   - `tool_execution_start.args` is what an interactive renderer treats as
		//     final and writes over the live preview with, so a raw value there is
		//     not a flicker, it is what stays on screen for the rest of the session.
		//     The argument transform used to run after this event was emitted.
		//   - `tool_execution_start.intent` is the sentence the model wrote about
		//     what it is doing, and it goes straight into the working line. It is
		//     lifted out of the arguments before the transform runs, so the
		//     expansion applied to every argument never reached it.
		//
		// Asserting on the emitted events rather than on a rendered string is
		// deliberate: the events are the contract every front end shares, so this
		// covers the TUI, `--print`, ACP and collab at once.
		scripted.push(toolCall("argot_load", { folder_path: repoDir }, "call_load_display"));
		await session!.prompt("work on this repo");
		await session!.waitForIdle();

		const match = argot.promptFragment().match(/`§([a-z0-9_]+)`\s*→\s*`([^`]+)`/);
		expect(match, "expected at least one taught handle in the fragment").not.toBeNull();
		const [, name, expansion] = match!;

		const starts: { args: Record<string, unknown>; intent?: string }[] = [];
		const unsubscribe = session!.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolName === "bash") {
				starts.push({ args: event.args as Record<string, unknown>, intent: event.intent });
			}
		});
		// `i` is the wire field the harness injects for intent tracing and strips
		// back off before execution, which is exactly why the intent escapes the
		// argument transform.
		scripted.push(
			toolCall(
				"bash",
				{ command: `cat §${name}`, i: `Reading §${name} for the pool config`, timeout: 10 },
				"call_display",
			),
		);
		scripted.push(stopReply("done"));
		await session!.prompt("continue");
		await session!.waitForIdle();
		unsubscribe();

		expect(starts).toHaveLength(1);
		const start = starts[0]!;
		expect(start.args.command).toBe(`cat ${expansion}`);
		expect(JSON.stringify(start.args)).not.toContain("§");
		expect(start.intent).toBe(`Reading ${expansion} for the pool config`);
	});

	it("emits no session event carrying a raw handle, wherever the model writes one", async () => {
		// The whole-surface contract, as one assertion. Session events are what
		// every front end renders from — the TUI, `--print`, ACP, the collab web
		// client — so "the operator never sees a handle" reduces to "no emitted
		// event carries the sigil".
		//
		// It is written as a sweep rather than as one assertion per seam on
		// purpose. Each seam already has its own focused test, but seams keep being
		// ADDED, and a new event field carrying model-authored text is exactly the
		// kind of thing that ships undecoded and is noticed by a user rather than
		// by the suite. This fails the moment that happens, without anyone having
		// to remember to extend it.
		scripted.push(toolCall("argot_load", { folder_path: repoDir }, "call_load_sweep"));
		await session!.prompt("work on this repo");
		await session!.waitForIdle();

		const match = argot.promptFragment().match(/`§([a-z0-9_]+)`\s*→\s*`([^`]+)`/);
		expect(match, "expected at least one taught handle in the fragment").not.toBeNull();
		const [, name, expansion] = match!;

		const offenders: string[] = [];
		const unsubscribe = session!.subscribe(event => {
			// The event is scanned whole, so a handle in any field counts, including
			// fields that did not exist when this test was written.
			const serialized = JSON.stringify(event, (_key, value) => (value instanceof Error ? value.message : value));
			if (serialized?.includes("§")) offenders.push(`${event.type}: ${serialized.slice(0, 400)}`);
		});
		// A handle in every position a model can put one: prose, thinking, a tool
		// argument, and the intent that rides alongside it.
		scripted.push({
			content: [
				{ type: "thinking", thinking: `The pool is in §${name}.` },
				{ type: "text", text: `Checking §${name} now.` },
				{
					type: "toolCall",
					id: "call_sweep",
					name: "bash",
					arguments: { command: `cat §${name}`, i: `Reading §${name}`, timeout: 10 },
				},
			],
			stopReason: "toolUse",
		});
		scripted.push(stopReply(`Done with §${name}.`));
		await session!.prompt("continue");
		await session!.waitForIdle();
		unsubscribe();

		expect(offenders).toEqual([]);
		// Proof the sweep had something to catch: the model really did write the
		// handle, and the persisted history really does still hold it (keeping the
		// history cheap is the entire point of the codec, so an "expand everything
		// everywhere" fix that also rewrote history would pass the sweep and lose
		// the token win).
		const persisted = JSON.stringify(session!.agent.state.messages);
		expect(persisted).toContain(`§${name}`);
		expect(expansion.length).toBeGreaterThan(`§${name}`.length);
	});

	it("a mid-session load rebuilds the base system prompt so the model is taught the handles", async () => {
		// Production regression (2026-07-23): argot_load told the model "you may
		// now write §handle tokens", but the handle table only enters the system
		// prompt at build time, and nothing rebuilt it — the model was told to
		// write handles it was never shown. The load must trigger exactly one
		// prompt rebuild when the teach set changes, none when it does not.
		expect(refreshCalls).toBe(0);
		scripted.push(toolCall("argot_load", { folder_path: repoDir }, "call_load_refresh"));
		scripted.push(stopReply("loaded"));
		await session!.prompt("load this repo");
		await session!.waitForIdle();
		expect(argot.loaded).toBe(true);
		expect(refreshCalls).toBe(1);

		// A no-marker folder changes nothing and rebuilds nothing.
		const markerFree = fs.mkdtempSync(path.join(os.tmpdir(), "argot-loop-none-"));
		try {
			scripted.push(toolCall("argot_load", { folder_path: markerFree }, "call_load_none2"));
			scripted.push(stopReply("nothing there"));
			await session!.prompt("load that too");
			await session!.waitForIdle();
			expect(refreshCalls).toBe(1);
		} finally {
			removeSyncWithRetries(markerFree);
		}

		// Unload changes the teach set: one more rebuild. A second unload of the
		// same folder changes nothing: no rebuild.
		scripted.push(toolCall("argot_unload", { folder_path: repoDir }, "call_unload_1"));
		scripted.push(toolCall("argot_unload", { folder_path: repoDir }, "call_unload_2"));
		scripted.push(stopReply("done"));
		await session!.prompt("drop it twice");
		await session!.waitForIdle();
		expect(refreshCalls).toBe(2);
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
