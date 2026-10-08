/**
 * WHY: plan mode holds five fields that reset at different boundaries: the decision ladder's
 * reminder count and awaiting-progress latch, the plan reference path, and whether the reference
 * already reached the model. Each boundary (a user prompt, a decision tool, leaving plan mode,
 * re-entering it, a new session) resets a different subset, and a missed reset is silent: the
 * ladder stops reminding, a forced tool choice outlives plan mode, the approved plan never reaches
 * the executor, or a retitled plan is deduplicated out of the context.
 *
 * The class this closes is a plan mode field that survives a boundary that owns it, or resets at
 * one that does not. Every case drives a real `AgentSession` through the boundary and observes the
 * consequence at the provider request, in the transcript, or in the history rewrite.
 *
 * What it does not catch: the forced decision dropped when a continuation is skipped before its
 * request is built (the continuation starts in the same tick as the reminder, so only an abort
 * landing in that tick reaches the skip), the ladder reset on a stop whose own message called a
 * decision tool (the tool's completion already reset it), and the compaction re-arm and reminder
 * cap, which `agent-session-plan-reference-compaction` and `agent-session-plan-mode-convergence`
 * pin.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import type { ToolResultMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockHandler, type MockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@veyyon/coding-agent/internal-urls/local-protocol";
import { DEFAULT_PLAN_FILE_URL } from "@veyyon/coding-agent/plan-mode/plan-file-url";
import { PROMPTS } from "@veyyon/coding-agent/prompts/registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const RETITLED_PLAN = "local://auth-plan.md";

/** A literal line of the reminder template, so a reminder is found by its real content. */
const REMINDER_LINE = (() => {
	const line = PROMPTS["plan-mode/tool-decision-reminder"].text
		.split("\n")
		.map(l => l.trim())
		.find(l => l.length > 20 && !l.includes("{{"));
	if (!line) throw new Error("plan-mode reminder template has no literal line");
	return line;
})();

function fakeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function reminders(session: AgentSession): number {
	return session.agent.state.messages.filter(m => m.role === "developer" && messageText(m).includes(REMINDER_LINE))
		.length;
}

function planReferences(session: AgentSession): number {
	return session.agent.state.messages.filter(m => m.role === "custom" && m.customType === "plan-mode-reference")
		.length;
}

const text = (body: string): MockHandler => ({ content: [body] });
const call = (name: string, args: Record<string, unknown>): MockHandler => ({
	content: [{ type: "toolCall", name, arguments: args }],
});

describe("plan mode state across its boundaries", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@plan-mode-boundaries-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage.close();
			await tempDir.remove();
		}
	});

	function start(responses: MockHandler[]): { session: AgentSession; mock: MockModel; store: SessionManager } {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		const tools = [fakeTool("ask"), fakeTool("resolve"), fakeTool("read")];
		const mock = createMockModel({ responses });
		let created: AgentSession | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			// Wired as the SDK wires it, so a forced decision reaches the provider request.
			getToolChoice: () => created?.nextToolChoiceDirective(),
			streamFn: mock.stream,
		});
		const store = SessionManager.inMemory(tempDir.path());
		created = new AgentSession({
			agent,
			sessionManager: store,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: tools.map(tool => tool.name),
		});
		session = created;
		return { session: created, mock, store };
	}

	function writePlan(store: SessionManager, url: string): void {
		const resolved = resolveLocalUrlToPath(url, {
			getArtifactsDir: () => store.getArtifactsDir(),
			getSessionId: () => store.getSessionId(),
		});
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
		fs.writeFileSync(resolved, "# Plan\n\n1. Do the thing.\n");
	}

	/** Two identical `read` results of `readPath`; a dedupe drops the older unless it is protected. */
	function seedDuplicateReads(store: SessionManager, readPath: string): void {
		const model = session?.model;
		if (!model) throw new Error("Expected a session model");
		for (let copy = 0; copy < 2; copy++) {
			const toolCallId = `call_read_${copy}_${readPath}`;
			store.appendMessage({ role: "user", content: [{ type: "text", text: "read it" }], timestamp: Date.now() });
			store.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: readPath } }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
				usage: {
					input: 16,
					output: 8,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 24,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: `${readPath}\n${"BODY LINE\n".repeat(40)}` }],
				isError: false,
				timestamp: Date.now(),
			};
			store.appendMessage(result);
		}
	}

	describe("the decision ladder", () => {
		it("forces a tool call on the continuation a reminder schedules, and only there", async () => {
			const { session, mock } = start([text("planning A"), text("planning B")]);
			session.setPlanModeState({ enabled: true, planFilePath: DEFAULT_PLAN_FILE_URL });

			await session.prompt("make a plan");
			await session.waitForIdle();

			expect(reminders(session)).toBe(1);
			expect(mock.calls.map(c => c.options?.toolChoice)).toEqual([undefined, "required"]);
		});

		it("is re-armed by a user prompt after a reminder left it waiting", async () => {
			const { session, mock } = start([text("A"), text("B"), text("C"), text("D")]);
			session.setPlanModeState({ enabled: true, planFilePath: DEFAULT_PLAN_FILE_URL });

			// A stops without a decision: reminder, forced continuation. B stops while the ladder waits
			// for progress, so the turn yields.
			await session.prompt("make a plan");
			await session.waitForIdle();
			expect(reminders(session)).toBe(1);

			await session.prompt("keep going");
			await session.waitForIdle();

			expect(reminders(session)).toBe(2);
			expect(mock.calls).toHaveLength(4);
		});

		it("gets its full budget back from a decision tool even when the turn ends in text", async () => {
			// A reminder, then a resolve mid-turn, then three text stops separated by reads: with the
			// budget reset by resolve, each of B, C and D earns a reminder and E hits the cap.
			const { session, mock } = start([
				text("A"),
				call("resolve", { action: "discard", reason: "restart" }),
				text("B"),
				call("read", { path: "a" }),
				text("C"),
				call("read", { path: "b" }),
				text("D"),
				call("read", { path: "c" }),
				text("E"),
			]);
			session.setPlanModeState({ enabled: true, planFilePath: DEFAULT_PLAN_FILE_URL });

			await session.prompt("make a plan");
			await session.waitForIdle();

			expect(reminders(session)).toBe(4);
			expect(mock.calls).toHaveLength(9);
		});

		it("is cleared, and its forced decision released, when plan mode ends", async () => {
			let inFlightBeforeExit: boolean | undefined;
			let inFlightAfterExit: boolean | undefined;
			const { session, mock } = start([
				text("A"),
				() => {
					// The reminder's continuation is on the wire with the forced decision in flight.
					inFlightBeforeExit = session.toolChoiceQueue.hasInFlight;
					session.setPlanModeState(undefined);
					inFlightAfterExit = session.toolChoiceQueue.hasInFlight;
					return { content: ["B"] };
				},
				text("C"),
				text("D"),
			]);
			session.setPlanModeState({ enabled: true, planFilePath: DEFAULT_PLAN_FILE_URL });

			await session.prompt("make a plan");
			await session.waitForIdle();
			expect(inFlightBeforeExit).toBe(true);
			expect(inFlightAfterExit).toBe(false);
			expect(reminders(session)).toBe(1);

			// Back in plan mode, an agent-initiated turn that stops without a decision is reminded:
			// the latch the first reminder set did not survive the exit.
			session.setPlanModeState({ enabled: true, planFilePath: DEFAULT_PLAN_FILE_URL });
			await session.prompt("continue", { synthetic: true });
			await session.waitForIdle();

			expect(reminders(session)).toBe(2);
			expect(mock.calls.map(c => c.options?.toolChoice)).toEqual([undefined, "required", undefined, "required"]);
		});

		it("releases its forced decision to a user message sent during the forced continuation", async () => {
			let inFlightBeforeSteer: boolean | undefined;
			let inFlightAfterSteer: boolean | undefined;
			const { session, mock } = start([
				text("A"),
				async () => {
					inFlightBeforeSteer = session.toolChoiceQueue.hasInFlight;
					await session.prompt("ask me before you decide", { streamingBehavior: "steer" });
					inFlightAfterSteer = session.toolChoiceQueue.hasInFlight;
					return { content: ["B"] };
				},
				text("C"),
				text("D"),
			]);
			session.setPlanModeState({ enabled: true, planFilePath: DEFAULT_PLAN_FILE_URL });

			await session.prompt("make a plan");
			await session.waitForIdle();

			expect(inFlightBeforeSteer).toBe(true);
			expect(inFlightAfterSteer).toBe(false);
			// The steered message owns the next decision, so its stop starts a fresh ladder.
			expect(reminders(session)).toBe(2);
			expect(mock.calls.map(c => c.options?.toolChoice)).toEqual([undefined, "required", undefined, "required"]);
		});
	});

	describe("the plan reference", () => {
		it("reaches the first prompt after plan mode, and only that one", async () => {
			const { session, store } = start([text("A"), text("B"), text("C"), text("D")]);
			writePlan(store, RETITLED_PLAN);
			session.setPlanModeState({ enabled: true, planFilePath: RETITLED_PLAN });

			await session.prompt("make a plan");
			await session.waitForIdle();
			expect(planReferences(session)).toBe(0);

			session.setPlanModeState(undefined);
			await session.prompt("execute it");
			await session.waitForIdle();
			expect(planReferences(session)).toBe(1);

			await session.prompt("next step");
			await session.waitForIdle();
			expect(planReferences(session)).toBe(1);
			const reference = session.agent.state.messages.find(
				m => m.role === "custom" && m.customType === "plan-mode-reference",
			);
			expect(reference && messageText(reference)).toContain(RETITLED_PLAN);
		});

		it("is sent again after a second round of plan mode", async () => {
			const { session, store } = start([text("A"), text("B"), text("C"), text("D"), text("E"), text("F")]);
			writePlan(store, RETITLED_PLAN);
			session.setPlanModeState({ enabled: true, planFilePath: RETITLED_PLAN });
			await session.prompt("make a plan");
			await session.waitForIdle();
			session.setPlanModeState(undefined);
			await session.prompt("execute it");
			await session.waitForIdle();
			expect(planReferences(session)).toBe(1);

			session.setPlanModeState({ enabled: true, planFilePath: RETITLED_PLAN });
			await session.prompt("revise the plan");
			await session.waitForIdle();
			session.setPlanModeState(undefined);
			await session.prompt("execute the revision");
			await session.waitForIdle();

			expect(planReferences(session)).toBe(2);
		});

		it("keeps reads of a retitled plan through a dedupe that drops other duplicate reads", async () => {
			const { session, store } = start([]);
			session.setPlanModeState({ enabled: true, planFilePath: RETITLED_PLAN });
			seedDuplicateReads(store, RETITLED_PLAN);
			seedDuplicateReads(store, "src/app.ts");

			const result = await session.dedupeRedundantToolResults();

			expect(result.toolResultsDropped).toBe(1);
			const prunedCalls = store
				.getBranch()
				.filter(entry => entry.type === "message" && (entry.message as { role?: string }).role === "toolResult")
				.map(entry => (entry as { message: ToolResultMessage }).message)
				.filter(message => message.prunedAt !== undefined)
				.map(message => message.toolCallId);
			expect(prunedCalls).toEqual(["call_read_0_src/app.ts"]);
		});

		it("returns to the default plan file in a new session", async () => {
			const { session, store } = start([]);
			session.setPlanModeState({ enabled: true, planFilePath: RETITLED_PLAN });
			session.setPlanModeState(undefined);
			expect(session.getPlanReferencePath()).toBe(RETITLED_PLAN);

			expect(await session.newSession()).toBe(true);

			expect(session.getPlanReferencePath()).toBe(DEFAULT_PLAN_FILE_URL);
			seedDuplicateReads(store, RETITLED_PLAN);
			const result = await session.dedupeRedundantToolResults();
			expect(result.toolResultsDropped).toBe(1);
		});
	});
});
