/**
 * Stand up a real {@link TtsrRuntime} against a recording host.
 *
 * The runtime's host is eight names wide, so the production object under test is the
 * runtime itself and the double is only the seam it was designed against. Nothing here
 * fakes TTSR: the manager is a real `TtsrManager`, the rules are real `Rule`s, and every
 * delivery decision is the shipped one.
 *
 * This exists because the delivery paths used to be private methods on a 19 000-line
 * `AgentSession`, unreachable from a test, and the contracts around them were pinned by
 * reading the source file and asserting on its text. Those locks broke on any move and
 * stayed green through a behavioural break. Every one of them is a real assertion now.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessageEvent } from "@veyyon/ai";
import type { TtsrSettings } from "@veyyon/coding-agent/config/settings";
import type { Rule } from "@veyyon/coding-agent/discovery/capability/rule";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import type {
	AgentSessionEvent,
	ScheduledAgentContinueOptions,
} from "@veyyon/coding-agent/session/agent-session-types";
import { TtsrRuntime } from "@veyyon/coding-agent/session/runtime/ttsr-runtime";

export const HARNESS_CWD = "/work/project";

export interface TtsrHarnessOptions {
	settings?: Partial<TtsrSettings>;
	argotEnabled?: boolean;
	argotLoaded?: boolean;
	/** Tools the agent reports, for `matcherPaths`/`matcherDigest` resolution. */
	tools?: readonly { name: string }[];
}

/** Everything the runtime did to its host, in the order it did it. */
export interface TtsrRecorder {
	events: { event: AgentSessionEvent; context: string }[];
	aborts: unknown[];
	followUps: AgentMessage[];
	appended: AgentMessage[];
	injectionLog: string[][];
	continues: number;
}

export interface TtsrHarness {
	runtime: TtsrRuntime;
	manager: TtsrManager;
	recorded: TtsrRecorder;
	messages: AgentMessage[];
	/** The generation a deferred retry re-checks. Bump it to make that retry stale. */
	generation: number;
	/** Feed one prose delta through the runtime; true when it aborted the turn. */
	delta(text: string, event?: Partial<AssistantMessageEvent>): Promise<boolean>;
	/** Feed one tool-argument delta, so a match buckets against `toolCallId`. */
	toolDelta(text: string, toolCallId: string, toolName?: string): Promise<boolean>;
	/** Run whatever the runtime deferred to a post-prompt task, if anything. */
	drain(): Promise<void>;
}

const DEFAULT_SETTINGS: TtsrSettings = {
	enabled: true,
	contextMode: "keep",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
};

export function ttsrHarness(rules: readonly Rule[], options: TtsrHarnessOptions = {}): TtsrHarness {
	const manager = new TtsrManager({ ...DEFAULT_SETTINGS, ...options.settings }, { getCwd: () => HARNESS_CWD });
	for (const rule of rules) {
		if (!manager.addRule(rule)) throw new Error(`rule ${rule.name} was refused by the manager`);
	}

	const recorded: TtsrRecorder = {
		events: [],
		aborts: [],
		followUps: [],
		appended: [],
		injectionLog: [],
		continues: 0,
	};
	const messages: AgentMessage[] = [];
	let deferred: ((signal: AbortSignal) => Promise<void>) | undefined;

	const runtime = new TtsrRuntime(
		{
			agent: {
				state: { messages, tools: (options.tools ?? []) as never, isStreaming: false },
				abort: reason => recorded.aborts.push(reason),
				followUp: message => recorded.followUps.push(message),
				appendMessage: message => {
					recorded.appended.push(message);
					messages.push(message);
				},
				replaceMessages: next => messages.splice(0, messages.length, ...next),
				hasQueuedMessages: () => recorded.followUps.length > 0,
				continue: async () => {
					recorded.continues += 1;
				},
			},
			sessionStore: {
				getCwd: () => HARNESS_CWD,
				appendTtsrInjection: names => {
					recorded.injectionLog.push([...names]);
					return "entry";
				},
				appendCustomMessageEntry: () => "entry",
			},
			argotEnabled: () => options.argotEnabled ?? false,
			argotLoaded: () => options.argotLoaded ?? false,
			promptGeneration: () => harness.generation,
			emitSessionEventDetached: (event, context) => recorded.events.push({ event, context }),
			scheduleAgentContinue: (continueOptions: ScheduledAgentContinueOptions) => {
				continueOptions.onSkip?.("aborted");
			},
			schedulePostPromptTask: task => {
				deferred = task;
			},
		},
		manager,
	);

	const harness: TtsrHarness = {
		runtime,
		manager,
		recorded,
		messages,
		generation: 1,
		delta: (text, event) => {
			const assistantEvent = { type: "text_delta", delta: text, contentIndex: 0, ...event } as AssistantMessageEvent;
			return runtime.observeStreamDelta(pushAssistantMessage(messages), assistantEvent);
		},
		toolDelta: (text, toolCallId, toolName = "read") => {
			const message = pushAssistantMessage(messages, [
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} },
			]);
			const assistantEvent = { type: "toolcall_delta", delta: text, contentIndex: 0 } as AssistantMessageEvent;
			return runtime.observeStreamDelta(message, assistantEvent);
		},
		drain: async () => {
			const task = deferred;
			deferred = undefined;
			await task?.(new AbortController().signal);
		},
	};
	return harness;
}

/** Append an assistant turn the runtime can find by timestamp, and hand it back. */
function pushAssistantMessage(messages: AgentMessage[], content: unknown[] = []): AgentMessage {
	const message = {
		role: "assistant",
		content,
		timestamp: messages.length + 1,
		stopReason: "stop",
	} as unknown as AgentMessage;
	messages.push(message);
	return message;
}

/**
 * The text a delivered TTSR message carries, or `""` when there is none.
 *
 * `AgentMessage` is a union whose other arms have no `content`, and every assertion
 * about what the model was handed reads this one field, so the narrowing lives here
 * rather than at each call site.
 */
export function deliveredText(message: AgentMessage | null | undefined): string {
	if (!message || !("content" in message)) return "";
	return typeof message.content === "string" ? message.content : "";
}
