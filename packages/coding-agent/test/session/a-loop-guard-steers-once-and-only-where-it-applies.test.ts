/**
 * WHY: two guards interrupt a model that repeats itself. The cross-turn tool-call guard appends a
 * hidden redirect when one tool call repeats past a threshold; the Gemini header guard aborts a
 * reasoning block that emits too many planning titles, drops the stalled turn, appends a hidden
 * reminder and continues. One collaborator, `LoopGuards`, holds both, and the defects at that
 * boundary share one shape: a guard steers where it does not apply, or its steer lands in the wrong
 * place or at the wrong time. A redirect that reaches the model twice, or reaches the model and not
 * the log, replays differently on resume; a guard that keeps its history across a settings change
 * fires on turns counted under the old threshold; a header count that survives the model leaving
 * the reasoning channel interrupts a turn that already acted; a reminder delivered after `/new`,
 * after dispose, or after an abort continues a run nobody asked for.
 *
 * The class this closes is a guard steer that applies to the wrong model, turn, or run, or that
 * reaches the context and the log a different number of times. The model sweep takes every bundled
 * model at run time, and the event sweep is a table keyed by every `AssistantMessageEvent` type, so
 * a new model or a new event type is covered, or fails to type-check, the moment it ships.
 *
 * What it does not catch: whether `AgentSession` calls `onTurnEnd` and `observe` from its turn-end
 * hook and its stream interceptor (the session suites `agent-session-tool-call-loop-guard` and
 * `agent-session-gemini-header-interrupt` drive both through a real `AgentSession`), and the
 * detectors' own counting rules, which the `@veyyon/ai` suites own.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ToolResultMessage } from "@veyyon/ai";
import { GEMINI_HEADER_RUNAWAY_THRESHOLD, isGeminiThinkingModel } from "@veyyon/ai/utils/thinking-loop";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { SETTINGS_SCHEMA, Settings } from "@veyyon/coding-agent/config/settings";
import type { CustomMessage } from "@veyyon/coding-agent/session/messages";
import { GEMINI_TOOL_REMINDER_TYPE, TOOL_CALL_LOOP_REDIRECT_TYPE } from "@veyyon/coding-agent/session/nudges";
import {
	GEMINI_HEADER_INTERRUPT_REASON,
	LoopGuards,
	type LoopGuardsAgent,
	type LoopGuardsTurn,
} from "@veyyon/coding-agent/session/runtime/loop-guards";

const ENV_OFF = "VEYYON_NO_THINKING_LOOP_GUARD";

function bundledModels(): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const provider of getBundledProviders()) models.push(...getBundledModels(provider));
	return models;
}

const ALL_MODELS = bundledModels();

function firstModel(predicate: (model: Model<Api>) => boolean): Model<Api> {
	const model = ALL_MODELS.find(predicate);
	if (!model) throw new Error("the bundled catalog holds no model this suite needs");
	return model;
}

const GEMINI = firstModel(isGeminiThinkingModel);
const OTHER = firstModel(model => !isGeminiThinkingModel(model));

/** An agent slice that records what the guards did to it. */
class RecordingAgent implements LoopGuardsAgent {
	readonly state = { messages: [] as AgentMessage[] };
	readonly appended: AgentMessage[] = [];
	readonly aborts: (string | undefined)[] = [];
	readonly order: string[] = [];
	continues = 0;
	continueError: Error | undefined;
	/** Runs while the guard waits for the aborted stream to unwind. */
	onIdle: (() => void) | undefined;

	appendMessage(message: AgentMessage): void {
		this.state.messages.push(message);
		this.appended.push(message);
		this.order.push("append");
	}
	abort(reason?: string): void {
		this.aborts.push(reason);
	}
	async waitForIdle(): Promise<void> {
		this.order.push("idle");
		this.onIdle?.();
	}
	async continue(): Promise<unknown> {
		this.continues++;
		this.order.push("continue");
		if (this.continueError) throw this.continueError;
		return undefined;
	}
}

interface LoggedEntry {
	customType: string | undefined;
	content: string | undefined;
	display: boolean | undefined;
	details: unknown;
	attribution: "agent" | undefined;
}

interface Harness {
	readonly agent: RecordingAgent;
	readonly logged: LoggedEntry[];
	readonly notices: { level: string; message: string; source: string }[];
	readonly tasks: ((signal: AbortSignal) => Promise<void>)[];
	readonly discarded: AssistantMessage[];
	readonly settings: Settings;
	readonly live: { model: Model<Api> | undefined; generation: number; disposed: boolean };
	readonly guards: LoopGuards;
	/** Run every scheduled task, as the session does once the prompt settles. */
	settle(signal?: AbortSignal): Promise<void>;
}

function harness(overrides: Record<string, unknown> = {}): Harness {
	const agent = new RecordingAgent();
	const logged: LoggedEntry[] = [];
	const notices: { level: string; message: string; source: string }[] = [];
	const tasks: ((signal: AbortSignal) => Promise<void>)[] = [];
	const discarded: AssistantMessage[] = [];
	const settings = Settings.isolated({
		"model.loopGuard.enabled": true,
		"model.loopGuard.toolCallReminder": true,
		"model.toolCallLoopGuard.enabled": true,
		"model.toolCallLoopGuard.threshold": 3,
		"model.toolCallLoopGuard.readSubsumptionThreshold": 3,
		"model.toolCallLoopGuard.exemptTools": ["job"],
		...overrides,
	});
	const live: Harness["live"] = { model: GEMINI, generation: 1, disposed: false };
	const guards = new LoopGuards({
		agent,
		sessionStore: {
			appendCustomMessageEntry<T>(
				customType: string | undefined,
				content: string | undefined,
				display: boolean | undefined,
				details?: T,
				attribution?: "agent",
			): string {
				logged.push({ customType, content, display, details, attribution });
				return `entry-${logged.length}`;
			},
		},
		settings,
		model: () => live.model,
		promptGeneration: () => live.generation,
		isDisposed: () => live.disposed,
		emitNotice: (level, message, source) => notices.push({ level, message, source }),
		schedulePostPromptTask: task => tasks.push(task),
		discardAssistantTurn: message => {
			discarded.push(message);
			const index = agent.state.messages.indexOf(message);
			if (index >= 0) agent.state.messages.splice(index, 1);
		},
	});
	async function settle(signal: AbortSignal = new AbortController().signal): Promise<void> {
		for (const task of tasks.splice(0)) await task(signal);
	}
	return { agent, logged, notices, tasks, discarded, settings, live, guards, settle };
}

function assistant(content: AssistantMessage["content"], timestamp = 1_000): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

let callIds = 0;
function toolTurn(name: string, args: Record<string, unknown> = { command: "pytest -q" }): LoopGuardsTurn {
	const id = `call-${callIds++}`;
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "1263 passed, 4 skipped" }],
		isError: false,
		timestamp: 1_000,
	};
	return { message: assistant([{ type: "toolCall", id, name, arguments: args }]), toolResults: [result] };
}

function redirectsIn(messages: readonly AgentMessage[]): CustomMessage[] {
	return messages.filter(
		(m): m is CustomMessage => m.role === "custom" && m.customType === TOOL_CALL_LOOP_REDIRECT_TYPE,
	);
}

/** Record `count` turns into a context array the guard appends to. */
function record(h: Harness, count: number, messages: AgentMessage[], name = "bash"): void {
	for (let i = 0; i < count; i++) h.guards.onTurnEnd(messages, toolTurn(name));
}

const HEADER = "## Refining the plan\n";

/** Every event type, built against `message`. Keyed by the union so a new event type fails to compile here. */
const EVENTS: Record<AssistantMessageEvent["type"], (message: AssistantMessage) => AssistantMessageEvent> = {
	start: partial => ({ type: "start", partial }),
	text_start: partial => ({ type: "text_start", contentIndex: 1, partial }),
	text_delta: partial => ({ type: "text_delta", contentIndex: 1, delta: "Acting.", partial }),
	text_end: partial => ({ type: "text_end", contentIndex: 1, content: "Acting.", partial }),
	thinking_start: partial => ({ type: "thinking_start", contentIndex: 0, partial }),
	thinking_delta: partial => ({ type: "thinking_delta", contentIndex: 0, delta: HEADER, partial }),
	thinking_end: partial => ({ type: "thinking_end", contentIndex: 0, content: "", partial }),
	toolcall_start: partial => ({ type: "toolcall_start", contentIndex: 1, partial }),
	toolcall_delta: partial => ({ type: "toolcall_delta", contentIndex: 1, delta: "{", partial }),
	toolcall_end: partial => ({
		type: "toolcall_end",
		contentIndex: 1,
		toolCall: { type: "toolCall", id: "t", name: "bash", arguments: {} },
		partial,
	}),
	done: message => ({ type: "done", reason: "stop", message }),
	error: error => ({ type: "error", reason: "aborted", error }),
};

/** The events after which a header run starts over: a new reasoning block, prose, or a tool call. */
const ENDS_THE_RUN: Record<AssistantMessageEvent["type"], boolean> = {
	start: false,
	text_start: true,
	text_delta: false,
	text_end: false,
	thinking_start: true,
	thinking_delta: false,
	thinking_end: false,
	toolcall_start: true,
	toolcall_delta: false,
	toolcall_end: false,
	done: false,
	error: false,
};

function thinking(h: Harness, message: AssistantMessage, headers: number): void {
	h.guards.observe(message, {
		type: "thinking_delta",
		contentIndex: 0,
		delta: HEADER.repeat(headers),
		partial: message,
	});
}

/** Stream a reasoning block of `headers` titles into the guard. */
function runaway(h: Harness, message: AssistantMessage, headers = GEMINI_HEADER_RUNAWAY_THRESHOLD): void {
	h.guards.observe(message, EVENTS.thinking_start(message));
	thinking(h, message, headers);
}

/**
 * Each tuning setting the tool-call guard reads, with a change to it and the threshold in force
 * after the change. Checked against the schema, so a new tuning setting fails until it is listed.
 */
const TUNING_CHANGES: Record<string, { threshold: number; apply(settings: Settings): void }> = {
	"model.toolCallLoopGuard.threshold": {
		threshold: 4,
		apply: settings => settings.override("model.toolCallLoopGuard.threshold", 4),
	},
	"model.toolCallLoopGuard.readSubsumptionThreshold": {
		threshold: 3,
		apply: settings => settings.override("model.toolCallLoopGuard.readSubsumptionThreshold", 5),
	},
	"model.toolCallLoopGuard.exemptTools": {
		threshold: 3,
		apply: settings => settings.override("model.toolCallLoopGuard.exemptTools", ["job", "irc"]),
	},
};

let envBefore: string | undefined;
beforeEach(() => {
	envBefore = process.env[ENV_OFF];
	delete process.env[ENV_OFF];
});
afterEach(() => {
	if (envBefore === undefined) delete process.env[ENV_OFF];
	else process.env[ENV_OFF] = envBefore;
});

describe("the tool-call loop redirect", () => {
	it("reaches the context and the log once, on the threshold turn only", () => {
		const h = harness();
		const messages = h.agent.state.messages;
		record(h, 2, messages);
		expect(redirectsIn(messages)).toHaveLength(0);
		record(h, 1, messages);
		record(h, 4, messages);

		const redirects = redirectsIn(messages);
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
		expect(redirects[0]!.attribution).toBe("agent");
		expect(redirects[0]!.content).toContain("tool_call_loop_detected");
		expect(redirects[0]!.content).toContain("bash");
		expect(redirects[0]!.details).toMatchObject({
			toolName: "bash",
			count: 3,
			resultSummary: "1263 passed, 4 skipped",
		});
		// The context array is the agent's own: a second append would send the redirect twice.
		expect(h.agent.appended).toHaveLength(0);
		expect(h.logged).toEqual([
			{
				customType: TOOL_CALL_LOOP_REDIRECT_TYPE,
				content: redirects[0]!.content as string,
				display: false,
				details: redirects[0]!.details,
				attribution: "agent",
			},
		]);
	});

	it("reaches the agent too when the turn's context is a different array", () => {
		const h = harness();
		const turnContext: AgentMessage[] = [];
		record(h, 3, turnContext);
		expect(redirectsIn(turnContext)).toHaveLength(1);
		expect(redirectsIn(h.agent.appended)).toEqual(redirectsIn(turnContext));
		expect(h.logged).toHaveLength(1);
	});

	it("never fires while off, and counts from zero once turned on", () => {
		const h = harness({ "model.toolCallLoopGuard.enabled": false });
		const messages = h.agent.state.messages;
		record(h, 5, messages);
		expect(redirectsIn(messages)).toHaveLength(0);

		h.settings.override("model.toolCallLoopGuard.enabled", true);
		record(h, 2, messages);
		expect(redirectsIn(messages)).toHaveLength(0);
		record(h, 1, messages);
		expect(redirectsIn(messages)).toHaveLength(1);
	});

	it("forgets the turns it counted when turned off and on again", () => {
		const h = harness();
		const messages = h.agent.state.messages;
		record(h, 2, messages);
		h.settings.override("model.toolCallLoopGuard.enabled", false);
		record(h, 1, messages);
		h.settings.override("model.toolCallLoopGuard.enabled", true);
		record(h, 2, messages);
		expect(redirectsIn(messages)).toHaveLength(0);
		expect(h.logged).toHaveLength(0);
	});

	it("lists every tuning setting the schema declares", () => {
		const declared = Object.keys(SETTINGS_SCHEMA).filter(
			path => path.startsWith("model.toolCallLoopGuard.") && path !== "model.toolCallLoopGuard.enabled",
		);
		expect(Object.keys(TUNING_CHANGES).sort()).toEqual(declared.sort());
	});

	for (const [setting, change] of Object.entries(TUNING_CHANGES)) {
		it(`restarts the count when ${setting} changes`, () => {
			const h = harness();
			const messages = h.agent.state.messages;
			record(h, 2, messages);
			change.apply(h.settings);
			record(h, change.threshold - 1, messages);
			expect(redirectsIn(messages)).toHaveLength(0);
			record(h, 1, messages);
			expect(redirectsIn(messages)).toHaveLength(1);
		});
	}

	it("keeps counting across turns when the settings did not change", () => {
		const h = harness();
		const messages = h.agent.state.messages;
		record(h, 2, messages);
		h.settings.override("model.toolCallLoopGuard.exemptTools", ["job"]);
		record(h, 1, messages);
		expect(redirectsIn(messages)).toHaveLength(1);
	});

	it("never fires for an exempt tool", () => {
		const h = harness();
		const messages = h.agent.state.messages;
		record(h, 6, messages, "job");
		expect(redirectsIn(messages)).toHaveLength(0);
		expect(h.logged).toHaveLength(0);
	});
});

describe("the reasoning-header guard", () => {
	it("arms for exactly the models the Gemini header predicate names", () => {
		const h = harness();
		const armed: string[] = [];
		const expected: string[] = [];
		for (const model of ALL_MODELS) {
			h.live.model = model;
			const before = h.agent.aborts.length;
			runaway(h, assistant([]));
			const key = `${model.provider}/${model.id}`;
			if (h.agent.aborts.length > before) armed.push(key);
			if (isGeminiThinkingModel(model)) expected.push(key);
		}
		expect(expected.length).toBeGreaterThan(0);
		expect(expected.length).toBeLessThan(ALL_MODELS.length);
		expect(armed).toEqual(expected);
	});

	const QUIET: Record<string, (h: Harness) => void> = {
		"the loop guard is off": h => h.settings.override("model.loopGuard.enabled", false),
		"the tool-call reminder is off": h => h.settings.override("model.loopGuard.toolCallReminder", false),
		"no model is selected": h => {
			h.live.model = undefined;
		},
		"the environment turns the guard off": () => {
			process.env[ENV_OFF] = "1";
		},
	};
	for (const [label, arrange] of Object.entries(QUIET)) {
		it(`stays quiet when ${label}`, async () => {
			const h = harness();
			arrange(h);
			runaway(h, assistant([]), GEMINI_HEADER_RUNAWAY_THRESHOLD * 2);
			await h.settle();
			expect(h.agent.aborts).toEqual([]);
			expect(h.notices).toEqual([]);
			expect(h.agent.appended).toEqual([]);
			expect(h.logged).toEqual([]);
		});
	}

	it("counts nothing before a reasoning block starts", () => {
		const h = harness();
		thinking(h, assistant([]), GEMINI_HEADER_RUNAWAY_THRESHOLD * 2);
		expect(h.agent.aborts).toEqual([]);
	});

	it("reads the model when each reasoning block starts", () => {
		const h = harness();
		h.live.model = OTHER;
		runaway(h, assistant([]));
		expect(h.agent.aborts).toEqual([]);
		h.live.model = GEMINI;
		runaway(h, assistant([]));
		expect(h.agent.aborts).toEqual([GEMINI_HEADER_INTERRUPT_REASON]);
	});

	for (const type of Object.keys(ENDS_THE_RUN) as AssistantMessageEvent["type"][]) {
		const ends = ENDS_THE_RUN[type];
		it(`${ends ? "starts the header run over" : "keeps the header run"} after ${type}`, () => {
			const h = harness();
			const message = assistant([]);
			runaway(h, message, GEMINI_HEADER_RUNAWAY_THRESHOLD - 1);
			h.guards.observe(message, EVENTS[type](message));
			if (type !== "thinking_delta") thinking(h, message, 1);
			expect(h.agent.aborts).toEqual(ends ? [] : [GEMINI_HEADER_INTERRUPT_REASON]);
		});
	}

	it("interrupts once per runaway, with a notice and a scheduled reminder", () => {
		const h = harness();
		runaway(h, assistant([]), GEMINI_HEADER_RUNAWAY_THRESHOLD * 3);
		expect(h.agent.aborts).toEqual([GEMINI_HEADER_INTERRUPT_REASON]);
		expect(h.notices).toEqual([
			{
				level: "warning",
				message: `Interrupted ${GEMINI_HEADER_RUNAWAY_THRESHOLD} planning headers with no tool call; reminded the model to issue one.`,
				source: "loop-guard",
			},
		]);
		expect(h.tasks).toHaveLength(1);
		// Nothing reaches the context until the aborted stream unwinds.
		expect(h.agent.appended).toEqual([]);
		expect(h.logged).toEqual([]);
	});

	it("drops the stalled turn, reminds the model once in the context and the log, then continues", async () => {
		const h = harness();
		const earlier = assistant([{ type: "text", text: "earlier" }], 500);
		const stalled = assistant([{ type: "thinking", thinking: HEADER }], 900);
		h.agent.state.messages.push(earlier, stalled);
		runaway(h, stalled);
		await h.settle();

		expect(h.discarded).toEqual([stalled]);
		expect(h.agent.state.messages).not.toContain(stalled);
		expect(h.agent.state.messages).toContain(earlier);
		const reminders = h.agent.appended.filter(
			(m): m is CustomMessage => m.role === "custom" && m.customType === GEMINI_TOOL_REMINDER_TYPE,
		);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]!.display).toBe(false);
		expect(reminders[0]!.content).toContain(String(GEMINI_HEADER_RUNAWAY_THRESHOLD));
		expect(reminders[0]!.details).toEqual({ headers: GEMINI_HEADER_RUNAWAY_THRESHOLD });
		expect(h.logged).toEqual([
			{
				customType: GEMINI_TOOL_REMINDER_TYPE,
				content: reminders[0]!.content as string,
				display: false,
				details: { headers: GEMINI_HEADER_RUNAWAY_THRESHOLD },
				attribution: "agent",
			},
		]);
		// The reminder waits for the aborted stream, and the run continues only after it is appended.
		expect(h.agent.order).toEqual(["idle", "append", "continue"]);
	});

	it("still reminds and continues when the stalled turn never reached the context", async () => {
		const h = harness();
		const other = assistant([{ type: "text", text: "other" }], 500);
		h.agent.state.messages.push(other);
		runaway(h, assistant([], 900));
		await h.settle();
		expect(h.discarded).toEqual([]);
		expect(h.agent.continues).toBe(1);
		expect(h.logged).toHaveLength(1);
	});

	const STALE: Record<string, (h: Harness) => void> = {
		"a newer prompt started": h => {
			h.live.generation++;
		},
		"the session was disposed": h => {
			h.live.disposed = true;
		},
	};
	for (const [label, act] of Object.entries(STALE)) {
		for (const when of ["before the task starts", "while the aborted stream unwinds"] as const) {
			it(`delivers nothing when ${label} ${when}`, async () => {
				const h = harness();
				const stalled = assistant([], 900);
				h.agent.state.messages.push(stalled);
				runaway(h, stalled);
				if (when === "before the task starts") act(h);
				else h.agent.onIdle = () => act(h);
				await h.settle();
				expect(h.discarded).toEqual([]);
				expect(h.agent.appended).toEqual([]);
				expect(h.logged).toEqual([]);
				expect(h.agent.continues).toBe(0);
				// A run already stale does not wait on a stream nobody will continue.
				expect(h.agent.order).toEqual(when === "before the task starts" ? [] : ["idle"]);
			});
		}
	}

	it("delivers nothing once the post-prompt work was cancelled", async () => {
		const h = harness();
		runaway(h, assistant([], 900));
		const cancelled = new AbortController();
		cancelled.abort();
		await h.settle(cancelled.signal);
		expect(h.agent.order).toEqual([]);
		expect(h.logged).toEqual([]);
	});

	it("settles the task when continuing fails", async () => {
		const h = harness();
		h.agent.continueError = new Error("provider down");
		runaway(h, assistant([], 900));
		await h.settle();
		expect(h.agent.continues).toBe(1);
		expect(h.logged).toHaveLength(1);
	});
});
