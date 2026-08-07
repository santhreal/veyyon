/**
 * A TTSR rule must never speak over the tool call it matched, on any path, in any mode.
 *
 * Reported from a screenshot. A tool card read:
 *
 *   x Error: <system-reminder reason="rule_violation" rule="cwd-reroot" path="builtin-...
 *
 * next to the separate, correct `! Injecting rule: cwd-reroot` banner. The tool-scoped
 * delivery path PREPENDED the rendered reminder into the tool result's content, so on a
 * call that also errored the reminder became the first text block, and the first line of
 * the first text block is what the TUI prints as the error headline. The user lost the
 * real failure, saw internal model-directed markup instead, and saw the rule announced
 * twice. The model lost it too: the reminder led its result as well. The same path also
 * asserted "The tool ran because the rule is configured not to interrupt" unconditionally,
 * which is false on exactly the call that produced the screenshot.
 *
 * ## The class, not the reproduction
 *
 * Measured over 778 local session transcripts, 41 tool results lead with the reminder XML
 * across six rules (cwd-reroot 16, commit-drift 13, ts-no-tiny-functions 5, bash-tool-nudge
 * 3, ts-set-map 3, ts-no-test-timers 1). So the tests below fix nothing to a rule name, and
 * close three variant spaces instead of the one case that was reported:
 *
 *   1. `ttsr.interruptMode`, enumerated FROM the settings schema at run time. A tool-stream
 *      match takes one of two delivery paths depending on the mode, and both must keep
 *      internal markup off every surface the user reads. A fifth mode turns the suite red
 *      until someone records what it does with a tool match.
 *   2. The TTSR prompt registry, enumerated FROM `rulesPrompts` at run time. Every template
 *      in it renders internal `<system-*>` markup, so every one must ride a `display: false`
 *      channel. A third template turns the suite red until it is classified.
 *   3. The outcomes `afterToolCall` can observe: a success, a thrown error, a returned
 *      `isError` result, and a skip-shaped result. Every member is covered, because the
 *      reminder's wording makes a claim about what just happened and must be true for all
 *      four.
 *
 * Nothing here changed a persisted, cached or serialized shape: the `ttsr_injection` and
 * `custom_message` entries carry the same fields they always did, and the reminder text is
 * compiled from the bundled template on every render rather than cached, so there is no
 * schema version to bump and no stale entry to reject.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult } from "@veyyon/agent-core";
import type { AssistantMessage, ToolCall } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { AsyncJobManager } from "@veyyon/coding-agent/async";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings, type TtsrSettings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import { rulesPrompts } from "@veyyon/coding-agent/prompts/rules/rows";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { type } from "arktype";

type TtsrInterruptMode = TtsrSettings["interruptMode"];

const RULE_BODY = "Never leave a TODO marker behind.";
const TOOL_ERROR = "EACCES: permission denied, open '/etc/hosts'";
const SKIP_HEADLINE = "Skipped due to pending steering message.";
const TOOL_CALL_ID = "call_matched_001";
const MATCHING_DELTA = '{"snippet":"// TODO: finish"}';

/** Deliberately none of the six rules seen leaking in the transcripts. */
const RULE: Rule = {
	name: "no-todo-marker",
	path: "/tmp/no-todo-marker.md",
	content: RULE_BODY,
	condition: ["TODO"],
	_source: { provider: "test", providerName: "test", path: "/tmp/no-todo-marker.md", level: "project" },
};

/** Every outcome `afterToolCall` can observe from a tool it just ran. */
const TOOL_OUTCOMES = {
	succeeds: {
		result: (): AgentToolResult<unknown> => ({ content: [{ type: "text", text: "edit applied" }] }),
		firstLine: "edit applied",
		ran: true,
	},
	throws: { result: undefined, firstLine: TOOL_ERROR, ran: false },
	returnsError: {
		result: (): AgentToolResult<unknown> => ({ content: [{ type: "text", text: TOOL_ERROR }], isError: true }),
		firstLine: TOOL_ERROR,
		ran: false,
	},
	reportsSkipped: {
		result: (): AgentToolResult<unknown> => ({
			content: [{ type: "text", text: SKIP_HEADLINE }],
			details: { __skipped: true, source: "steering", entered: false },
		}),
		firstLine: SKIP_HEADLINE,
		ran: false,
	},
} as const;

type ToolOutcome = keyof typeof TOOL_OUTCOMES;

/**
 * Which modes abort a TOOL-stream match, per `#shouldInterruptForTtsrMatch`. Keyed by every
 * value the settings schema declares; the first test below fails if the two ever diverge.
 */
const INTERRUPTS_ON_TOOL_MATCH: Record<string, boolean> = {
	never: false,
	"prose-only": false,
	"tool-only": true,
	always: true,
};

const interruptModeSetting = SETTINGS_SCHEMA["ttsr.interruptMode"];
/** Every mode the schema declares, typed as the union the manager accepts. */
const INTERRUPT_MODES: readonly TtsrInterruptMode[] = interruptModeSetting.values;

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: usage(),
		stopReason,
		timestamp: Date.now(),
	};
}

/** Text of a `custom` message, whose content may be a plain string or content blocks. */
function customMessageText(message: AgentMessage | undefined): string {
	if (message?.role !== "custom") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
}

function toolResultText(agent: Agent): string {
	const result = agent.state.messages.find(m => m.role === "toolResult" && m.toolCallId === TOOL_CALL_ID);
	return result?.role === "toolResult" ? blockText(result.content) : "";
}

function ttsrInjections(agent: Agent): AgentMessage[] {
	return agent.state.messages.filter(m => m.role === "custom" && m.customType === "ttsr-injection");
}

/**
 * Every byte of the conversation a user could be shown. `display: false` is the one thing
 * that takes a message out of this set, which is exactly why it is the reminder's channel.
 */
function userVisibleText(agent: Agent): string {
	const parts: string[] = [];
	for (const message of agent.state.messages) {
		if ((message.role === "custom" || message.role === "hookMessage") && message.display === false) continue;
		parts.push(blockText("content" in message ? message.content : undefined));
	}
	return parts.join("\n");
}

interface TurnOptions {
	outcome?: ToolOutcome;
	interruptMode?: TtsrInterruptMode;
}

describe("a TTSR rule that matches a tool call", () => {
	let session: AgentSession | undefined;
	let tempDir: string;
	let sessionCount = 0;
	const authStorages: AuthStorage[] = [];
	const originalSchedulerWait = scheduler.wait.bind(scheduler);

	beforeEach(() => {
		// An interrupting mode aborts and schedules its retry through `scheduler.wait`, with a
		// blind 50ms settle. Collapse it so the continuation is a macrotask hop, not wall clock.
		vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => originalSchedulerWait(0, options));
		tempDir = path.join(os.tmpdir(), `pi-ttsr-reminder-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	/**
	 * One turn: the model emits a single tool call whose streamed arguments trip the rule,
	 * the tool produces `outcome`, then the model finishes. In an interrupting mode the rule
	 * aborts the stream before the tool runs, and the session drives its own continuation.
	 */
	async function runTurn(options: TurnOptions = {}): Promise<{ agent: Agent; streamCalls: () => number }> {
		const outcome = TOOL_OUTCOMES[options.outcome ?? "succeeds"];
		const interruptMode = options.interruptMode ?? "never";
		const interrupts = INTERRUPTS_ON_TOOL_MATCH[interruptMode] === true;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "keep",
			interruptMode,
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(RULE);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: type({ snippet: "string?" }),
			execute: async () => {
				if (!outcome.result) throw new Error(TOOL_ERROR);
				return outcome.result();
			},
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_ID,
			name: "mock_edit",
			arguments: { snippet: "// TODO: finish" },
		};
		const toolCallMessage = assistantMessage([toolCall], "toolUse");

		let streamCallCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
				systemPrompt: ["Test"],
				tools: [mockTool],
			},
			streamFn: (_model, _context, streamOptions) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount > 1) {
					queueMicrotask(() => {
						const done = assistantMessage([{ type: "text", text: "ok" }], "stop");
						stream.push({ type: "start", partial: done });
						stream.push({ type: "done", reason: "stop", message: done });
					});
					return stream;
				}
				queueMicrotask(() => {
					if (interrupts) {
						streamOptions?.signal?.addEventListener(
							"abort",
							() => {
								stream.push({
									type: "error",
									reason: "aborted",
									error: assistantMessage([toolCall], "aborted"),
								});
							},
							{ once: true },
						);
					}
					stream.push({ type: "start", partial: toolCallMessage });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: toolCallMessage });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: MATCHING_DELTA,
						partial: toolCallMessage,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: toolCallMessage });
					if (!interrupts) stream.push({ type: "done", reason: "toolUse", message: toolCallMessage });
				});
				return stream;
			},
		});

		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${sessionCount++}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			ttsrManager,
		});

		await session.prompt("Write some code");
		return { agent, streamCalls: () => streamCallCount };
	}

	describe("the reported defect", () => {
		/**
		 * The headline the TUI prints is the first line of the first text block of the tool
		 * result, so this asserts on that exact byte position rather than "contains it somewhere".
		 */
		it("surfaces the tool's own error, not the reminder, when the matched call fails", async () => {
			const { agent } = await runTurn({ outcome: "throws" });
			const text = toolResultText(agent);

			expect(text.split("\n")[0]).toBe(TOOL_ERROR);
			expect(text).not.toContain("<system-reminder");
			expect(text).not.toContain("rule_violation");
		});

		/**
		 * The guard that must survive the display fix: the model still receives the rule body.
		 * Suppress delivery and this goes red.
		 */
		it("still delivers the rule body to the model on the hidden channel after a failed call", async () => {
			const { agent } = await runTurn({ outcome: "throws" });
			const injections = ttsrInjections(agent);

			expect(injections).toHaveLength(1);
			expect(injections[0]?.role === "custom" ? injections[0].display : undefined).toBe(false);
			expect(customMessageText(injections[0])).toContain('rule="no-todo-marker"');
			expect(customMessageText(injections[0])).toContain(RULE_BODY);
		});
		/**
		 * Bounds. The aside queue must EMPTY when it is drained. A provider that reads without
		 * clearing re-delivers the same reminder at every later step boundary for the rest of the
		 * session, and the model cannot tell a repeat from a fresh match.
		 */
		it("does not re-deliver the reminder on any later turn", async () => {
			const { agent } = await runTurn({ outcome: "succeeds" });
			expect(ttsrInjections(agent)).toHaveLength(1);

			await session?.prompt("And now finish up");

			expect(ttsrInjections(agent)).toHaveLength(1);
		});

		/**
		 * Termination and bounds. The reminder rides the step boundary the tool results already
		 * take, so it must cost no extra model turn, and it must drain: a queue that is read
		 * without being emptied re-delivers the same reminder on every later boundary.
		 */
		it("costs one extra turn for the tool results and no more, and delivers exactly once", async () => {
			const { agent, streamCalls } = await runTurn({ outcome: "succeeds" });

			expect(streamCalls()).toBe(2);
			expect(ttsrInjections(agent)).toHaveLength(1);
			const toolResultIndex = agent.state.messages.findIndex(
				m => m.role === "toolResult" && m.toolCallId === TOOL_CALL_ID,
			);
			const injectionIndex = agent.state.messages.findIndex(
				m => m.role === "custom" && m.customType === "ttsr-injection",
			);
			expect(injectionIndex).toBeGreaterThan(toolResultIndex);
		});

		/**
		 * Delivery is what retires the rule. Recording at render time instead would claim a
		 * delivery a dying turn never makes; recording in both places counts it twice, and the
		 * count is what a resumed session replays.
		 */
		it("marks and records the rule exactly once, at delivery", async () => {
			const { agent } = await runTurn({ outcome: "throws" });

			expect(ttsrInjections(agent)).toHaveLength(1);
			const entries = session?.sessionManager.getEntries() ?? [];
			const retirements = entries.filter(entry => entry.type === "ttsr_injection");
			expect(retirements).toHaveLength(1);
			expect(retirements[0]?.type === "ttsr_injection" ? retirements[0].injectedRules : []).toEqual([
				"no-todo-marker",
			]);
			expect(
				entries.filter(entry => entry.type === "custom_message" && entry.customType === "ttsr-injection"),
			).toHaveLength(1);
		});
	});

	describe("closed over every interrupt mode the settings schema declares", () => {
		it("classifies exactly the modes the schema declares, so a new mode is a red test", () => {
			expect(INTERRUPT_MODES.length).toBeGreaterThan(0);
			// Widened to string[] on the way in: both sides are compared as plain names, and the
			// literal-union element type made the matcher reject the schema's own string keys.
			const declared: string[] = [...INTERRUPT_MODES];
			expect(declared.sort()).toEqual(Object.keys(INTERRUPTS_ON_TOOL_MATCH).sort());
		});

		it("covers every TTSR delivery template the prompt registry holds", () => {
			// Both render internal `<system-*>` markup, so both must ride a hidden channel.
			// A third `rules/ttsr-*` template is a new member of the class and must be classified.
			expect(Object.keys(rulesPrompts).sort()).toEqual(["rules/ttsr-interrupt", "rules/ttsr-tool-reminder"]);
		});

		for (const mode of INTERRUPT_MODES) {
			it(`keeps rule markup off every user-visible message in mode "${mode}"`, async () => {
				const { agent } = await runTurn({ outcome: "throws", interruptMode: mode });

				// The invariant, stated once for the whole class: internal markup never reaches a
				// message the user can be shown, whichever delivery path the mode chose.
				expect(userVisibleText(agent)).not.toContain("<system-reminder");
				expect(userVisibleText(agent)).not.toContain("<system-interrupt");
				expect(userVisibleText(agent)).not.toContain('reason="rule_violation"');
			});

			it(`still reaches the model on a hidden channel in mode "${mode}"`, async () => {
				const { agent } = await runTurn({ outcome: "throws", interruptMode: mode });
				const injections = ttsrInjections(agent);

				expect(injections.length).toBeGreaterThanOrEqual(1);
				for (const injection of injections) {
					expect(injection.role === "custom" ? injection.display : undefined).toBe(false);
				}
				const text = customMessageText(injections[0]);
				expect(text).toContain(RULE_BODY);
				// And it used the template its path owns, so neither path can quietly adopt the other's.
				expect(text).toContain(INTERRUPTS_ON_TOOL_MATCH[mode] ? "<system-interrupt" : "<system-reminder");
			});
		}
	});

	describe("closed over every outcome the after-tool hook can observe", () => {
		for (const [name, outcome] of Object.entries(TOOL_OUTCOMES)) {
			it(`leads the tool result with the tool's own output when it ${name}`, async () => {
				const { agent } = await runTurn({ outcome: name as ToolOutcome });
				const text = toolResultText(agent);

				expect(text.split("\n")[0]).toBe(outcome.firstLine);
				expect(text).not.toContain("<system-");
			});

			/**
			 * The reminder is model-facing prose making a claim about what just happened. A false
			 * claim is worse than no reminder: it tells the model an edit landed that did not.
			 */
			it(`tells the model the truth about whether the tool ran when it ${name}`, async () => {
				const { agent } = await runTurn({ outcome: name as ToolOutcome });
				const text = customMessageText(ttsrInjections(agent)[0]);

				expect(text).toContain(RULE_BODY);
				if (outcome.ran) {
					expect(text).toContain("The tool ran because the rule is configured not to interrupt.");
					expect(text).not.toContain("did not return a successful result");
				} else {
					expect(text).toContain("The tool did not return a successful result");
					expect(text).not.toContain("The tool ran because the rule is configured not to interrupt.");
				}
			});
		}
	});
});
