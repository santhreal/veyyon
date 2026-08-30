import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import type { TextContent } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TodoTool } from "@veyyon/coding-agent/tools/todo";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ObservedPromptCall = {
	toolChoice: string | undefined;
	toolNames: string[];
	messageRoles: AgentMessage["role"][];
	messageTexts: string[];
	systemPrompt: string;
	lastMessageRole: AgentMessage["role"];
	lastMessageText: string;
};

type Harness = {
	session: AgentSession;
	observedCalls: ObservedPromptCall[];
	authStorage: AuthStorage;
	settings: Settings;
};

function isTextContentBlock(value: unknown): value is TextContent {
	if (!value || typeof value !== "object") return false;
	return (value as TextContent).type === "text" && typeof (value as TextContent).text === "string";
}

function getToolChoiceName(choice: unknown): string | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	if (typeof choice !== "object" || !("type" in choice)) return undefined;
	const toolChoice = choice as { type?: string; name?: string; function?: { name?: string } };
	if (toolChoice.type === "tool") return toolChoice.name;
	if (toolChoice.type === "function") return toolChoice.name ?? toolChoice.function?.name;
	return undefined;
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter(isTextContentBlock)
		.map(content => content.text)
		.join("\n");
}

/**
 * One observed call, read from after the hidden `session-state` block.
 *
 * WHAT FLIPPED. The date and the working directory left the cached system prompt and now arrive as
 * a hidden `session-state` developer message at the head of the transcript, so every turn observed
 * here opens with one. It is not this suite's subject — the subject is what the eager preludes put
 * next to the user message — so a turn is read from after that block, and the block is asserted on
 * the way past, which is what keeps its disappearance visible from here.
 */
function turn(call: ObservedPromptCall | undefined): { roles: AgentMessage["role"][]; texts: string[] } {
	const roles = call?.messageRoles ?? [];
	const texts = call?.messageTexts ?? [];
	expect(roles[0], "a turn opens with the hidden session-state block").toBe("developer");
	expect(texts[0], "the leading developer message is the session-state block").toContain("<session-state>");
	return { roles: roles.slice(1), texts: texts.slice(1) };
}

describe("AgentSession eager task prelude", () => {
	let tempDir: TempDir;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-eager-task-");
		harnesses.length = 0;
	});

	afterEach(async () => {
		for (const harness of harnesses) {
			await harness.session.dispose();
			harness.authStorage.close();
		}
		harnesses.length = 0;
		tempDir.removeSync();
	});

	/**
	 * The agent types the mock task tool will accept.
	 *
	 * Not decoration. Delegation strength is resolved against the agents a session can ACTUALLY
	 * spawn (`enabledSubagentNames` reads `enabledAgentNames` off the live task tool), so a mock
	 * without this models a session whose task tool refuses everything, and `subagent.delegation:
	 * "required"` correctly resolves to no delegation at all. Every prelude case in this file was
	 * asserting against that mock and passing only because the resolution used to ignore the tool.
	 */
	const SPAWNABLE_AGENTS = ["general", "scout"];

	async function createHarness(
		settingsOverride: Record<string, unknown> = {},
		agentId?: string,
		taskWireName?: string,
		agentKind?: "main" | "sub",
		enabledAgentNames: string[] = SPAWNABLE_AGENTS,
		promptRefreshGate?: Promise<void>,
	): Promise<Harness> {
		const observedCalls: ObservedPromptCall[] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${harnesses.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${harnesses.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"subagent.delegation": "required",
			"todo.enabled": false,
			"todo.eager": "default",
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockTaskTool: AgentTool = {
			name: "task",
			label: "Task",
			description: "Mock task tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
			enabledAgentNames,
			...(taskWireName !== undefined ? { customWireName: taskWireName } : {}),
		} as AgentTool;
		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const todoEnabled = settings.get("todo.enabled") === true;
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};
		const todoTool = todoEnabled ? new TodoTool(toolSession) : undefined;
		const tools: AgentTool[] = todoTool
			? [todoTool as unknown as AgentTool, mockTaskTool, mockBashTool]
			: [mockTaskTool, mockBashTool];

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: [],
			},
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context, options) => {
				const lastMessage = context.messages.at(-1);
				if (!lastMessage) {
					throw new Error("Expected prompt context to include a message");
				}
				observedCalls.push({
					toolChoice: getToolChoiceName(options?.toolChoice),
					toolNames: (context.tools ?? []).map(tool => tool.name),
					messageRoles: context.messages.map(message => message.role),
					messageTexts: context.messages.map(message => getMessageText(message)),
					systemPrompt: context.systemPrompt?.join("\n\n") ?? "",
					lastMessageRole: lastMessage.role,
					lastMessageText: getMessageText(lastMessage),
				});
				const response = createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		const toolRegistry = new Map<string, AgentTool>([
			[mockTaskTool.name, mockTaskTool],
			[mockBashTool.name, mockBashTool],
		]);
		if (todoTool) toolRegistry.set(todoTool.name, todoTool as unknown as AgentTool);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			agentId,
			agentKind,
			rebuildSystemPrompt: async () => {
				if (promptRefreshGate) await promptRefreshGate;
				return { systemPrompt: [`subagent.batch:${settings.get("subagent.batch")}`] };
			},
		});

		const harness = { session, observedCalls, authStorage, settings };
		harnesses.push(harness);
		return harness;
	}

	it("prepends a hidden eager task reminder without forcing task or repeating the prompt text", async () => {
		const { session, observedCalls } = await createHarness();

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.toolChoice).toBeUndefined();
		const { roles, texts } = turn(observedCalls[0]);
		expect(roles).toEqual(["developer", "user"]);
		expect(texts[0]).toContain("delegation is enabled");
		expect(texts[0]).toContain("Batch independent slices");
		expect(texts[0]).toContain("`task`");
		expect(texts.filter(text => text.includes("refactor the parser across modules"))).toHaveLength(1);
		expect(texts[0]).not.toContain("refactor the parser across modules");
	});

	/**
	 * A prompt started immediately after a task-prompt setting write must wait for
	 * the queued rebuild rather than sending stale system-prompt bytes.
	 */
	it("applies a subagent setting change before the immediately following turn", async () => {
		const refresh = Promise.withResolvers<void>();
		const { session, settings, observedCalls } = await createHarness(
			{ "subagent.delegation": "off" },
			undefined,
			undefined,
			undefined,
			SPAWNABLE_AGENTS,
			refresh.promise,
		);

		settings.set("subagent.batch", false);
		const pendingPrompt = session.prompt("continue the work");
		await Promise.resolve();
		expect(observedCalls).toHaveLength(0);

		refresh.resolve();
		await pendingPrompt;
		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.systemPrompt).toBe("subagent.batch:false");
	});

	it("skips eager task prelude for prompts ending with a question mark", async () => {
		const { session, observedCalls } = await createHarness();

		await session.prompt("should I refactor the parser?");

		expect(observedCalls).toHaveLength(1);
		expect(turn(observedCalls[0]).roles).toEqual(["user"]);
		expect(turn(observedCalls[0]).texts).toEqual(["should I refactor the parser?"]);
	});

	it("skips eager task prelude for prompts ending with an exclamation mark", async () => {
		const { session, observedCalls } = await createHarness();

		await session.prompt("refactor the parser now!");

		expect(observedCalls).toHaveLength(1);
		expect(turn(observedCalls[0]).roles).toEqual(["user"]);
		expect(turn(observedCalls[0]).texts).toEqual(["refactor the parser now!"]);
	});

	it("skips eager task prelude for subsequent user messages", async () => {
		const { session, observedCalls } = await createHarness();

		await session.prompt("refactor the parser across modules");
		expect(observedCalls).toHaveLength(1);
		expect(turn(observedCalls[0]).roles).toEqual(["developer", "user"]);

		observedCalls.length = 0;
		await session.prompt("now update the serializer too");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.toolChoice).toBeUndefined();
		const second = turn(observedCalls[0]);
		expect(second.roles.at(-1)).toBe("user");
		// The turn-1 prelude persists in history; the contract is that NO fresh prelude is
		// prepended adjacent to the new user message on a subsequent turn.
		expect(second.roles.at(-2)).not.toBe("developer");
		expect(second.texts.at(-1)).toBe("now update the serializer too");
	});

	it("skips the delegation reminder when delegation is merely allowed", async () => {
		const { session, observedCalls } = await createHarness({ "subagent.delegation": "allowed" });

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(turn(observedCalls[0]).roles).toEqual(["user"]);
		expect(turn(observedCalls[0]).texts).toEqual(["refactor the parser across modules"]);
	});

	it("skips the delegation reminder when delegation is preferred (prompt section only)", async () => {
		const { session, observedCalls } = await createHarness({ "subagent.delegation": "preferred" });

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(turn(observedCalls[0]).roles).toEqual(["user"]);
		expect(turn(observedCalls[0]).texts).toEqual(["refactor the parser across modules"]);
	});

	it("skips eager task prelude for subagent sessions", async () => {
		const { session, observedCalls } = await createHarness({}, "SubAgent", undefined, "sub");

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(turn(observedCalls[0]).roles).toEqual(["user"]);
		expect(turn(observedCalls[0]).texts).toEqual(["refactor the parser across modules"]);
	});

	it("prepends eager task prelude for a main session with a custom agent id", async () => {
		const { session, observedCalls } = await createHarness({}, "Alice", undefined, "main");

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(turn(observedCalls[0]).roles).toEqual(["developer", "user"]);
		expect(turn(observedCalls[0]).texts[0]).toContain("delegation is enabled");
	});

	it("prepends both todo and task preludes when both are eager, keeping the forced todo choice", async () => {
		const { session, observedCalls } = await createHarness({
			"todo.enabled": true,
			"todo.eager": "always",
			"todo.reminders": false,
		});

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		// eager-todo still forces the todo tool choice on the first turn
		expect(observedCalls[0]?.toolChoice).toBe("todo");
		// both hidden preludes precede the user message: todo first, then task
		expect(turn(observedCalls[0]).roles).toEqual(["developer", "developer", "user"]);
		const texts = turn(observedCalls[0]).texts;
		expect(texts.at(-1)).toBe("refactor the parser across modules");
		// the task reminder is the second prelude (after the todo reminder)
		expect(texts.findIndex(text => text.includes("delegation is enabled"))).toBe(1);
	});

	it("omits batch-call guidance from the eager task reminder when task.batch is disabled", async () => {
		const { session, observedCalls } = await createHarness({ "subagent.batch": false });

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		const reminder = turn(observedCalls[0]).texts[0] ?? "";
		expect(reminder).toContain("delegation is enabled");
		expect(reminder).not.toContain("Batch independent slices");
	});

	it("renders the task tool's wire name in the eager reminder", async () => {
		const { session, observedCalls } = await createHarness({}, undefined, "delegate");

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		const reminder = turn(observedCalls[0]).texts[0] ?? "";
		expect(reminder).toContain("`delegate`");
		expect(reminder).not.toContain("`task`");
	});

	/**
	 * The negative twin every case above was missing, and the reason they all broke at once.
	 *
	 * Delegation strength is resolved against the agents the task tool will actually accept, so a
	 * session with `subagent.delegation: "required"` and NOTHING to delegate to must send no
	 * reminder at all. Telling a model it MUST fan work out to subagents, in a session where every
	 * `task` call will be refused, is worse than saying nothing: it spends context asking for the
	 * one action guaranteed to fail.
	 *
	 * This suite could not see that. Its mock task tool carried no `enabledAgentNames`, so it was
	 * describing exactly this session and asserting the prelude appeared anyway; the cases passed
	 * only while the resolution ignored the tool. The fix was to give the mock spawnable agents,
	 * which makes it the session the other cases mean, and this case holds the other end.
	 */
	it("sends no eager reminder when the task tool can spawn nothing", async () => {
		const { session, observedCalls } = await createHarness({}, undefined, undefined, undefined, []);

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(turn(observedCalls[0]).roles).toEqual(["user"]);
		expect(turn(observedCalls[0]).texts).toEqual(["refactor the parser across modules"]);
	});

	/**
	 * One spawnable agent is enough. The gate is "is there anywhere to send this", not "are there
	 * several", and an off-by-one in that check would silence the reminder for every project that
	 * enables a single custom agent.
	 */
	it("sends the eager reminder when exactly one agent can be spawned", async () => {
		const { session, observedCalls } = await createHarness({}, undefined, undefined, undefined, ["general"]);

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(turn(observedCalls[0]).roles).toEqual(["developer", "user"]);
		expect(turn(observedCalls[0]).texts[0]).toContain("delegation is enabled");
	});
});
