/**
 * WHY: `CustomMessages.send` picks where a custom message an extension, a tool or the session builds
 * goes from what it reads the moment the message arrives: whether a turn is streaming, the queue the
 * caller named, whether the caller asked for a turn, and whether the client defers the turns the
 * agent starts on its own. Each wrong pick has its own cost. A message steered when the caller asked
 * for the next turn interrupts a turn it was meant to follow; a message appended without the turn
 * the caller asked for is never answered; a turn started on a client that defers them runs where
 * that client cannot show it; a message delivered by two routes is read twice. `send` also reports
 * whether it ran a turn, and a caller that mirrors the turn's `agent_end` acts on a turn that never
 * ran when the report is wrong.
 *
 * The class this closes is a route, a report or a queue-chip decision that is wrong for any
 * combination of those inputs. The suite sweeps their full product against one oracle and requires
 * exactly one route per message, and that the routed message is the copy the image normalization
 * returned. `CustomMessages.prompt` is covered for the same inputs it reads: a streaming turn, a
 * queue-only request, and a skill a person invoked with a magic keyword in its arguments.
 *
 * What it does not catch: whether `AgentSession` builds the host so these reads reflect the live
 * session, which `agent-session-concurrent` drives through a real session on a client that defers
 * agent-initiated turns, and what a started turn does, which the session's prompt suites cover.
 */
import { describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentBusyError, type AgentMessage } from "@veyyon/agent-core";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE } from "@veyyon/coding-agent/session/messages";
import { CustomMessages, type CustomMessagesHost } from "@veyyon/coding-agent/session/runtime/custom-messages";

const CHIP = "Review the parser";
const DETAILS = { source: "lint" };
const KEYWORD_ARGS = "ultrathink about the parser";

type DeliverAs = "steer" | "followUp" | "nextTurn";

type Delivery =
	| { route: "steer" | "followUp"; message: AgentMessage }
	| { route: "next-turn"; message: CustomMessage; startTurn: boolean }
	| { route: "turn"; message: CustomMessage; acceptTerminalEmptyStop: boolean }
	| { route: "context"; message: AgentMessage }
	| { route: "prompt"; message: AgentMessage; text: string; prepend: AgentMessage[] | undefined };

interface StoredEntry {
	customType: string | undefined;
	details: unknown;
	attribution: string | undefined;
}

/** The session surfaces a custom message reaches, recording what arrived at each. */
class RecordingHost implements CustomMessagesHost {
	streaming = false;
	defers = false;
	hydration: Promise<void> = Promise.resolve();
	readonly deliveries: Delivery[] = [];
	readonly entries: StoredEntry[] = [];
	readonly normalized = new Set<AgentMessage>();
	readonly keywordReads: string[] = [];
	drains = 0;

	readonly images = {
		normalizeMessage: async <T extends AgentMessage>(message: T): Promise<T> => {
			const copy = { ...message };
			this.normalized.add(copy);
			return copy;
		},
	};
	readonly nextTurn = {
		queue: (message: CustomMessage, startTurn: boolean): void => {
			this.deliveries.push({ route: "next-turn", message, startTurn });
		},
	};
	readonly queue = {
		enqueue: (message: AgentMessage, mode: "steer" | "followUp"): void => {
			this.deliveries.push({ route: mode, message });
		},
		scheduleDrain: (): void => {
			this.drains++;
		},
		// One message at a time here; the order across messages is the session suites' subject.
		deliverInOrder: async <T, R>(prepared: Promise<T>, deliver: (value: T) => R): Promise<R> =>
			deliver(await prepared),
	};
	readonly agent = {
		appendMessage: (message: AgentMessage): void => {
			this.deliveries.push({ route: "context", message });
		},
	};
	readonly sessionStore = {
		appendCustomMessageEntry: <T>(
			customType: string | undefined,
			_content: unknown,
			_display: boolean | undefined,
			details?: T,
			attribution?: string,
		): string => {
			this.entries.push({ customType, details, attribution });
			return `entry-${this.entries.length}`;
		},
	};

	startupHydration(): Promise<void> {
		return this.hydration;
	}
	isStreaming(): boolean {
		return this.streaming;
	}
	defersAgentInitiatedTurns(): boolean {
		return this.defers;
	}
	async promptAgentInitiated(message: CustomMessage, options?: { acceptTerminalEmptyStop?: boolean }): Promise<void> {
		this.deliveries.push({
			route: "turn",
			message,
			acceptTerminalEmptyStop: options?.acceptTerminalEmptyStop === true,
		});
	}
	async promptWithMessage(
		message: AgentMessage,
		text: string,
		options: { prependMessages?: AgentMessage[] },
	): Promise<void> {
		this.deliveries.push({ route: "prompt", message, text, prepend: options.prependMessages });
	}
	keywordNotices(text: string): CustomMessage[] {
		this.keywordReads.push(text);
		if (!text.includes("ultrathink")) return [];
		return [
			{
				role: "custom",
				customType: "keyword-notice",
				content: `Think hard: ${text}`,
				display: false,
				attribution: "agent",
				timestamp: 0,
			},
		];
	}
}

function detailsOf(message: AgentMessage): unknown {
	return message.role === "custom" ? message.details : undefined;
}

interface Arrival {
	streaming: boolean;
	deliverAs: DeliverAs | undefined;
	triggerTurn: boolean;
	defers: boolean;
	chip: boolean;
}

type Route = Delivery["route"];

/**
 * Where the message must go. A streaming turn queues it on the queue the caller named, holding a
 * next-turn message for the next turn; an idle session starts the turn the caller asked for unless
 * the client defers it, which holds the message for the next turn, and appends it otherwise.
 */
function expectedRoute(arrival: Arrival): { route: Route; startTurn?: boolean } {
	if (arrival.streaming) {
		if (arrival.deliverAs === "nextTurn") return { route: "next-turn", startTurn: arrival.triggerTurn };
		return { route: arrival.deliverAs === "followUp" ? "followUp" : "steer" };
	}
	if (arrival.triggerTurn) return arrival.defers ? { route: "next-turn", startTurn: false } : { route: "turn" };
	return { route: "context" };
}

const ARRIVALS: Arrival[] = [];
for (const streaming of [false, true]) {
	for (const deliverAs of [undefined, "steer", "followUp", "nextTurn"] as const) {
		for (const triggerTurn of [false, true]) {
			for (const defers of [false, true]) {
				for (const chip of [false, true]) {
					ARRIVALS.push({ streaming, deliverAs, triggerTurn, defers, chip });
				}
			}
		}
	}
}

function label(arrival: Arrival): string {
	return [
		arrival.streaming ? "mid-turn" : "idle",
		`deliverAs ${arrival.deliverAs ?? "unset"}`,
		arrival.triggerTurn ? "turn asked" : "no turn asked",
		arrival.defers ? "client defers turns" : "client runs turns",
		arrival.chip ? "chip text" : "no chip text",
	].join(", ");
}

describe("a custom message goes where its arrival state sends it", () => {
	it.each(ARRIVALS.map(arrival => [label(arrival), arrival] as const))("%s", async (_name, arrival) => {
		const host = new RecordingHost();
		host.streaming = arrival.streaming;
		host.defers = arrival.defers;
		const messages = new CustomMessages(host);

		const ranTurn = await messages.send(
			{ customType: "lint-report", content: "Two warnings", display: true, details: DETAILS },
			{
				triggerTurn: arrival.triggerTurn,
				deliverAs: arrival.deliverAs,
				queueChipText: arrival.chip ? CHIP : undefined,
			},
		);

		const expected = expectedRoute(arrival);
		expect(host.deliveries.map(delivery => delivery.route)).toEqual([expected.route]);
		const delivery = host.deliveries[0];
		if (delivery.route === "next-turn") expect(delivery.startTurn).toBe(expected.startTurn ?? false);
		expect(ranTurn).toBe(expected.route === "turn");
		expect(host.drains).toBe(expected.route === "steer" || expected.route === "followUp" ? 1 : 0);

		// The routed message is the copy normalized for the model, not the one built before it.
		expect(host.normalized.has(delivery.message)).toBe(true);
		const chipShown = arrival.chip && arrival.deliverAs !== "nextTurn";
		expect(detailsOf(delivery.message)).toEqual(chipShown ? { ...DETAILS, __queueChipText: CHIP } : DETAILS);

		// A message that joins the context without a turn is also recorded in the session file.
		expect(host.entries).toEqual(
			expected.route === "context"
				? [{ customType: "lint-report", details: detailsOf(delivery.message), attribution: "agent" }]
				: [],
		);
	});

	it("starts a turn the caller asked for only once startup hydration ends, and appends without waiting", async () => {
		const host = new RecordingHost();
		const hydration = Promise.withResolvers<void>();
		host.hydration = hydration.promise;
		const messages = new CustomMessages(host);

		await messages.send({ customType: "note", content: "appended" });
		expect(host.deliveries.map(delivery => delivery.route)).toEqual(["context"]);

		const sent = messages.send({ customType: "note", content: "turn" }, { triggerTurn: true });
		await delay(5);
		expect(host.deliveries.map(delivery => delivery.route)).toEqual(["context"]);

		hydration.resolve();
		expect(await sent).toBe(true);
		expect(host.deliveries.map(delivery => delivery.route)).toEqual(["context", "turn"]);
	});

	it("lets a next-turn message that starts a turn accept a terminal empty stop", async () => {
		const host = new RecordingHost();
		const messages = new CustomMessages(host);

		await messages.send(
			{ customType: "lesson", content: "Recorded" },
			{ deliverAs: "nextTurn", triggerTurn: true, acceptTerminalEmptyStop: true },
		);
		await messages.send({ customType: "lesson", content: "Recorded" }, { deliverAs: "nextTurn", triggerTurn: true });

		expect(
			host.deliveries.map(delivery => (delivery.route === "turn" ? delivery.acceptTerminalEmptyStop : undefined)),
		).toEqual([true, false]);
	});
});

describe("a custom message runs as a prompt", () => {
	const SOURCES = [
		{ customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "user" as const, notices: true },
		{ customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "agent" as const, notices: false },
		{ customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: undefined, notices: false },
		{ customType: "extension-note", attribution: "user" as const, notices: false },
	];

	it.each(
		SOURCES.map(source => [`${source.customType} from ${source.attribution ?? "an unset author"}`, source] as const),
	)("an idle %s runs a turn carrying keyword notices only for a skill a person invoked", async (_name, source) => {
		const host = new RecordingHost();
		const messages = new CustomMessages(host);

		await messages.prompt({
			customType: source.customType,
			content: [
				{ type: "text", text: "Run the " },
				{ type: "text", text: "parser skill" },
			],
			display: true,
			details: { args: KEYWORD_ARGS },
			attribution: source.attribution,
		});

		expect(host.deliveries.map(delivery => delivery.route)).toEqual(["prompt"]);
		const delivery = host.deliveries[0];
		if (delivery.route !== "prompt") throw new Error("the prompt route was checked above");
		expect(delivery.text).toBe("Run the parser skill");
		expect(delivery.message).toMatchObject({ role: "custom", attribution: source.attribution ?? "agent" });
		expect(host.keywordReads).toEqual(source.notices ? [KEYWORD_ARGS] : []);
		expect(delivery.prepend?.map(notice => (notice.role === "custom" ? notice.content : undefined))).toEqual(
			source.notices ? [`Think hard: ${KEYWORD_ARGS}`] : undefined,
		);
	});

	for (const streaming of [false, true]) {
		it(`queues a queue-only prompt ${streaming ? "mid-turn" : "while idle"} without a turn, notices first`, async () => {
			const host = new RecordingHost();
			host.streaming = streaming;
			const messages = new CustomMessages(host);
			const skill = {
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "Run the parser skill",
				display: true,
				details: { args: KEYWORD_ARGS },
				attribution: "user" as const,
			};

			await expect(messages.prompt(skill, { queueOnly: true })).rejects.toBeInstanceOf(AgentBusyError);
			expect(host.deliveries).toEqual([]);

			await messages.prompt(skill, { queueOnly: true, streamingBehavior: "followUp", queueChipText: CHIP });
			expect(host.deliveries.map(delivery => delivery.route)).toEqual(["followUp", "followUp"]);
			const [notice, message] = host.deliveries;
			expect(notice.message).toMatchObject({ customType: "keyword-notice" });
			expect(host.normalized.has(message.message)).toBe(true);
			expect(detailsOf(message.message)).toEqual({ args: KEYWORD_ARGS, __queueChipText: CHIP });
			expect(host.drains).toBe(0);
		});
	}

	it("sends a prompt that arrives mid-turn as the queued kind the caller named, and refuses one with none", async () => {
		const host = new RecordingHost();
		host.streaming = true;
		const messages = new CustomMessages(host);
		const skill = {
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Run the parser skill",
			display: true,
			details: { args: KEYWORD_ARGS },
			attribution: "user" as const,
		};

		await expect(messages.prompt(skill)).rejects.toBeInstanceOf(AgentBusyError);
		expect(host.deliveries).toEqual([]);

		await messages.prompt(skill, { streamingBehavior: "steer", queueChipText: CHIP });
		expect(host.deliveries.map(delivery => delivery.route)).toEqual(["steer", "steer"]);
		const [notice, message] = host.deliveries;
		expect(notice.message).toMatchObject({ customType: "keyword-notice" });
		expect(detailsOf(notice.message)).toBeUndefined();
		expect(detailsOf(message.message)).toEqual({ args: KEYWORD_ARGS, __queueChipText: CHIP });
		expect(host.drains).toBe(2);
	});
});
