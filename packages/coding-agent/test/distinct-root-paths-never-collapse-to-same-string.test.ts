/**
 * WHY THIS SUITE EXISTS.
 *
 * Outbound wire-path canonicalization (relativize-paths.ts) rewrites absolute paths
 * matching a registered session root so they render relative in prompt context, saving
 * tokens. Previously, `AgentSession` accumulated roots over every `cwd_changed` event
 * in history and on every `set_cwd` / `rescopeToCwd`.
 *
 * When roots accumulated, multiple distinct directories (e.g. the primary repo root and
 * a linked worktree, or a previous cwd and the new cwd) were all treated as roots.
 * As a result, tool result text containing paths from both locations — such as
 * `git worktree list` or shell output referencing both trees — stripped both roots to
 * `.` or to identical relative paths. This made distinct absolute paths indistinguishable
 * to the model and caused relative file reads to resolve against the wrong tree.
 *
 * WHAT THIS SUITE DEFENDS.
 *
 * 1. An active session maintains only its current working directory as the wire path root.
 * 2. Distinct absolute paths from previous roots or sibling checkouts remain absolute
 *    and never collapse to `.` or to identical relative fragments.
 * 3. Paths under the active cwd render relative, preserving the token-saving optimization.
 * 4. Resuming a session with historical `cwd_changed` events uses only the active cwd as root.
 *
 * WHAT THIS DOES NOT CATCH.
 *
 * Internal tool output formatting inside individual tool implementations before results
 * reach the session wire-canonicalization pipeline.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { normalizeRoots, relativizePathsUnderRoots } from "@veyyon/coding-agent/session/relativize-paths";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function createToolCallTurn(
	toolOutput: string,
	callId = "call-1",
	toolName = "bash",
): [AssistantMessage, ToolResultMessage] {
	const assistantMsg: AssistantMessage = {
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id: callId, name: toolName, arguments: {} }],
		stopReason: "toolUse",
	};
	const toolResultMsg: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: toolOutput }],
		isError: false,
		timestamp: Date.now(),
	};
	return [assistantMsg, toolResultMsg];
}

function getTextContent(message: Message | AgentMessage): string {
	if (message.role === "toolResult") {
		const block = message.content[0];
		if (block && block.type === "text") {
			return block.text;
		}
	}
	throw new Error("Expected toolResult message with text content");
}

describe("distinct root paths never collapse to the same string", () => {
	const MAIN_REPO = "/media/data/projects/repo-main";
	const WORKTREE = "/media/data/projects/repo-worktree";

	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-distinct-roots-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
	});

	function createHarness(
		initialCwd: string,
		sessionDir: string = initialCwd,
	): {
		session: AgentSession;
		sessionManager: SessionManager;
		agent: Agent;
		getCapturedContexts: () => Context[];
	} {
		const capturedContexts: Context[] = [];
		const sessionManager = SessionManager.create(initialCwd, sessionDir);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (_model, context) => {
				capturedContexts.push(context);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const response = createAssistantMessage("done");
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(session);

		return {
			session,
			sessionManager,
			agent,
			getCapturedContexts: () => capturedContexts,
		};
	}

	it("keeps non-active root absolute while relativizing active cwd in pure relativize helper", () => {
		const activeRoots = normalizeRoots([WORKTREE]);
		const toolOutput = [`${MAIN_REPO} 1a2b3c4 [main]`, `${WORKTREE} 5d6e7f8 [feature]`].join("\n");

		const messages: Message[] = createToolCallTurn(toolOutput);
		const result = relativizePathsUnderRoots(messages, activeRoots);
		const toolResultMsg = result.messages.find(m => m.role === "toolResult")!;
		const rendered = getTextContent(toolResultMsg);

		// WORKTREE collapses to "." because it matches the active cwd root.
		// MAIN_REPO must stay absolute so the two worktrees are distinguishable.
		expect(rendered).toContain(`${MAIN_REPO} 1a2b3c4 [main]`);
		expect(rendered).toContain(". 5d6e7f8 [feature]");
		expect(rendered).not.toBe([". 1a2b3c4 [main]", ". 5d6e7f8 [feature]"].join("\n"));
	});

	it("keeps file paths under a previous root absolute so they do not resolve against active cwd", () => {
		const activeRoots = normalizeRoots([WORKTREE]);
		const fileOutput = [
			`main config: ${MAIN_REPO}/config/settings.json`,
			`worktree config: ${WORKTREE}/config/settings.json`,
		].join("\n");

		const messages: Message[] = createToolCallTurn(fileOutput);
		const result = relativizePathsUnderRoots(messages, activeRoots);
		const toolResultMsg = result.messages.find(m => m.role === "toolResult")!;
		const rendered = getTextContent(toolResultMsg);

		expect(rendered).toContain(`main config: ${MAIN_REPO}/config/settings.json`);
		expect(rendered).toContain("worktree config: config/settings.json");
	});

	it("keeps previous root paths absolute after a live setCwd in AgentSession", async () => {
		const dirA = TempDir.createSync("@pi-distinct-roots-live-a-");
		const dirB = TempDir.createSync("@pi-distinct-roots-live-b-");
		tempDirs.push(dirA, dirB);

		const pathA = dirA.path();
		const pathB = dirB.path();

		const harness = createHarness(pathA, pathA);
		const { session, agent, sessionManager } = harness;

		const toolOutput = [`root A: ${pathA}`, `root B: ${pathB}`].join("\n");
		for (const msg of createToolCallTurn(toolOutput)) {
			agent.appendMessage(msg);
			sessionManager.appendMessage(msg);
		}

		await session.setCwd(pathB);
		await session.prompt("list paths");

		const contexts = harness.getCapturedContexts();
		expect(contexts.length).toBeGreaterThan(0);
		const lastContext = contexts.at(-1)!;
		const toolResultMsg = lastContext.messages.find(m => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		const rendered = getTextContent(toolResultMsg!);

		// Path A must remain absolute because active cwd is Path B
		expect(rendered).toContain(`root A: ${pathA}`);
		expect(rendered).toContain("root B: .");
		expect(rendered).not.toContain("root A: .");
	});

	it("uses only the active cwd as wire root when resuming an AgentSession with historical cwd_changed entries", async () => {
		const dirA = TempDir.createSync("@pi-distinct-roots-resume-a-");
		const dirB = TempDir.createSync("@pi-distinct-roots-resume-b-");
		const dirC = TempDir.createSync("@pi-distinct-roots-resume-c-");
		tempDirs.push(dirA, dirB, dirC);

		const pathA = dirA.path();
		const pathB = dirB.path();
		const pathC = dirC.path();

		const initialManager = SessionManager.create(pathA, pathA);
		initialManager.appendMessage({ role: "user", content: "initial prompt", timestamp: 1 });
		initialManager.appendCustomEntry("cwd_changed", { previous: pathA, cwd: pathB });
		initialManager.appendCustomEntry("cwd_changed", { previous: pathB, cwd: pathC });
		await initialManager.setCwd(pathC, { validate: false });

		const toolOutput = [`historical: ${pathB}/file.txt`, `active: ${pathC}/file.txt`].join("\n");
		for (const msg of createToolCallTurn(toolOutput)) {
			initialManager.appendMessage(msg);
		}
		await initialManager.flush();
		const sessionFile = initialManager.getSessionFile();
		expect(sessionFile).toBeString();
		await initialManager.close();

		const resumedManager = await SessionManager.open(sessionFile!);
		const capturedContexts: Context[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: resumedManager.buildSessionContext().messages,
			},
			streamFn: (_model, context) => {
				capturedContexts.push(context);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const response = createAssistantMessage("done");
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		const resumedSession = new AgentSession({
			agent,
			sessionManager: resumedManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(resumedSession);

		await resumedSession.prompt("check files");

		expect(capturedContexts.length).toBeGreaterThan(0);
		const lastContext = capturedContexts.at(-1)!;
		const toolResultMsg = lastContext.messages.find(m => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		const rendered = getTextContent(toolResultMsg!);

		// Path B must stay absolute; Path C becomes relative
		expect(rendered).toContain(`historical: ${pathB}/file.txt`);
		expect(rendered).toContain("active: file.txt");
		expect(rendered).not.toContain("historical: file.txt");
	});

	it("keeps previous session root paths absolute after switchSession", async () => {
		const dirA = TempDir.createSync("@pi-distinct-roots-switch-a-");
		const dirB = TempDir.createSync("@pi-distinct-roots-switch-b-");
		tempDirs.push(dirA, dirB);

		const pathA = dirA.path();
		const pathB = dirB.path();

		const harness = createHarness(pathA, pathA);
		const { session } = harness;

		const managerB = SessionManager.create(pathB, pathB);
		managerB.appendMessage({ role: "user", content: "session B init", timestamp: 1 });
		const toolOutput = [`session A root: ${pathA}`, `session B root: ${pathB}`].join("\n");
		for (const msg of createToolCallTurn(toolOutput)) {
			managerB.appendMessage(msg);
		}
		await managerB.flush();
		const sessionBFile = managerB.getSessionFile();
		expect(sessionBFile).toBeString();
		await managerB.close();

		const switched = await session.switchSession(sessionBFile!);
		expect(switched).toBe(true);

		await session.prompt("check roots");

		const contexts = harness.getCapturedContexts();
		expect(contexts.length).toBeGreaterThan(0);
		const lastContext = contexts.at(-1)!;
		const toolResultMsg = lastContext.messages.find(m => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		const rendered = getTextContent(toolResultMsg!);

		// Session A's root must stay absolute; Session B's root becomes relative "."
		expect(rendered).toContain(`session A root: ${pathA}`);
		expect(rendered).toContain("session B root: .");
		expect(rendered).not.toContain("session A root: .");
	});
});
