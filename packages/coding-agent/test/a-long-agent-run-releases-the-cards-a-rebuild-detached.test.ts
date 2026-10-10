/**
 * WHY: the terminal event controller anchors each tool call's card, the assistant text that follows
 * the call, and the call's arguments in maps it empties only at agent start and end. One agent run
 * that compacts many times gained an entry per tool call for its whole length, so every card a
 * compaction collapsed out of the transcript stayed reachable with its arguments and result text: a
 * 900-second mock run held 10,690 cards and grew its heap by 190 MB after the transcript held under
 * 200 of them.
 *
 * Class closed: any reference the controller or its projection keeps to a card, a post-tool
 * assistant segment (as a call's anchor, as the last assistant block, or as the block a pending
 * read inlines its images into), or a settled call's arguments after `rebuildChatFromMessages`
 * detached it, on the production path: a real `InteractiveMode`, real events, and the rebuild every
 * compaction, setting change and resync runs.
 *
 * Not caught: retention of strings, which cannot be `WeakRef` targets, held anywhere other than
 * through the objects this suite tracks; and a retainer outside the terminal mode that keeps a
 * card's producer.
 */
import "./helpers/tool-views-preload";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { initTheme, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/theme/theme";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../../hosts/terminal/engine/test/virtual-terminal";

const TURNS = 12;

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Detached {
	cards: WeakRef<object>[];
	segments: WeakRef<object>[];
	args: WeakRef<object>[];
}

/** One assistant message that calls `bash` and then says something after the call. */
function callingMessage(toolCallId: string, args: Record<string, unknown>, turn: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: toolCallId, name: "bash", arguments: args },
			{ type: "text", text: `after call ${turn}` },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage,
		timestamp: turn + 1,
	};
}

/**
 * Drive `TURNS` tool calls inside one agent run, start a read that is still running, then rebuild
 * the transcript from a session that persisted none of it, which detaches every card the way a
 * compaction collapses history. Runs in its own frame so none of the strong references it creates
 * survive on the caller's stack.
 */
async function runAndRebuild(mode: InteractiveMode, terminal: VirtualTerminal): Promise<Detached> {
	const detached: Detached = { cards: [], segments: [], args: [] };
	const send = (event: AgentSessionEvent) => mode.eventController.handleEvent(event);
	await send({ type: "agent_start" });
	for (let turn = 0; turn < TURNS; turn++) {
		const toolCallId = `call_${turn}`;
		const args = { command: `echo ${turn}` };
		detached.args.push(new WeakRef(args));
		const message = callingMessage(toolCallId, args, turn);
		await send({ type: "message_start", message });
		await send({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_end", contentIndex: 1, content: `after call ${turn}`, partial: message },
		});
		await send({ type: "message_end", message });
		await send({ type: "tool_execution_start", toolCallId, toolName: "bash", args });
		await send({
			type: "tool_execution_end",
			toolCallId,
			toolName: "bash",
			result: { content: [{ type: "text", text: `output ${turn}` }] },
		});
	}
	await terminal.waitForRender();
	// A read starting now anchors its images to the last assistant block, the final turn's segment.
	await send({ type: "tool_execution_start", toolCallId: "call_read", toolName: "read", args: { path: "notes.md" } });

	const children = mode.chatContainer.children;
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (!(child instanceof ToolExecutionComponent)) continue;
		detached.cards.push(new WeakRef(child));
		const next = children[i + 1];
		if (next instanceof AssistantMessageComponent) detached.segments.push(new WeakRef(next));
	}
	mode.rebuildChatFromMessages();
	await terminal.waitForRender();
	return detached;
}

async function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

function alive(refs: WeakRef<object>[]): number {
	let count = 0;
	for (const ref of refs) if (ref.deref() !== undefined) count++;
	return count;
}

/**
 * Collect until nothing in `detached` is reachable, at most `MAX_COLLECTIONS` times. A `WeakRef`
 * target stays alive until the job that created or read it ends, so each collection runs on a new
 * turn, and JSC's conservative stack scan can keep one object alive for a few turns. A retention
 * by the controller never clears, so the bound only ends the wait.
 */
const MAX_COLLECTIONS = 16;
async function collect(detached: Detached): Promise<{ cards: number; segments: number; args: number }> {
	let counts = { cards: 0, segments: 0, args: 0 };
	for (let attempt = 0; attempt < MAX_COLLECTIONS; attempt++) {
		await nextTurn();
		Bun.gc(true);
		counts = { cards: alive(detached.cards), segments: alive(detached.segments), args: alive(detached.args) };
		if (counts.cards + counts.segments + counts.args === 0) break;
	}
	return counts;
}

describe("a long agent run releases the cards a rebuild detached", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let terminal: VirtualTerminal | undefined;

	beforeAll(async () => {
		await initTheme();
		await setTheme("dark");
	});

	beforeEach(async () => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-rebuild-releases-cards-");
		const dir = tempDir.path();
		await Settings.init({ inMemory: true, cwd: dir, overrides: { "startup.quiet": true } });

		authStorage = await AuthStorage.create(path.join(dir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Main"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(dir, dir),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});

		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, new EventBus());
		terminal = new VirtualTerminal(120, 40);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
		await terminal.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		terminal = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterAll(() => {
		stopThemeWatcher();
	});

	it("keeps no card, post-tool segment or settled argument the rebuild dropped", async () => {
		if (!mode || !terminal) throw new Error("not booted");
		const detached = await runAndRebuild(mode, terminal);
		// The run mounted what the suite tracks; an empty sweep would pass for the wrong reason.
		expect({
			cards: detached.cards.length,
			segments: detached.segments.length,
			args: detached.args.length,
		}).toEqual({ cards: TURNS, segments: TURNS, args: TURNS });
		expect(mode.chatContainer.children.some(child => child instanceof ToolExecutionComponent)).toBe(false);

		expect(await collect(detached)).toEqual({ cards: 0, segments: 0, args: 0 });
	});
});
