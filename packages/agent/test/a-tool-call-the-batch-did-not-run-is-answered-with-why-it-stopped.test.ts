/**
 * Every tool call in a batch is answered, and a call that did not run to completion is answered with the reason it
 * stopped: the repair hook's verdict, the abort that reached it before it started, the cancel that released it from
 * the pause gate, or the cancel that cut it off inside the tool. A call that did run keeps the result it produced.
 *
 * WHY THIS SUITE EXISTS. `executeToolCalls` in `agent-loop.ts` was split into `ToolBatch`, and a mutation sweep of
 * the split left these paths with no test that failed when they broke: a lenient tool refused, a lenient tool handed
 * the parse markers, an unrepairable call run anyway or answered without its hints, a call queued behind the cancel
 * answered as if it had been cut off inside the tool, an `afterToolCall` hook replacing the placeholder of a call the
 * cancel cut off, a thrown call persisted as `useless`, and a call answered before it ran recorded as having run
 * since the batch was dispatched. A cancel during a pause also told the model a steering message was pending when
 * nothing was queued: the call was answered as skipped for "pending steering message" with advice to retry after a
 * queued message that did not exist.
 *
 * CLASS CLOSED. Each stop reason is driven through the real loop with a mock provider, and its answer is compared
 * whole: text, `isError`, and the skip discriminator in `details`.
 *
 * NOT CAUGHT. Interrupts from steering and peer IRC (`a-tool-call-runs-and-stops-by-what-it-and-its-tool-declare`),
 * and the batch ledger's own rendering (`tool-batch-partial-completion-ledger.test.ts`).
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { AgentPauseGate } from "@veyyon/agent-core";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	ToolCallRepairResult,
} from "@veyyon/agent-core/types";
import type { Message, ToolResultMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

interface Call {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface Turn {
	events: AgentEvent[];
	results: Map<string, ToolResultMessage>;
}

/** Runs one assistant turn that makes `calls`, then a closing text turn, and collects each call's result message. */
async function runTurn(
	tools: AgentContext["tools"],
	calls: Call[],
	config: Partial<AgentLoopConfig> = {},
	signal?: AbortSignal,
	onEvent?: (event: AgentEvent) => void,
): Promise<Turn> {
	const mock = createMockModel({
		responses: [
			config.pauseGate
				? () => {
						config.pauseGate?.pause();
						return { content: calls.map(call => ({ type: "toolCall" as const, ...call })) };
					}
				: { content: calls.map(call => ({ type: "toolCall" as const, ...call })) },
			{ content: ["done"] },
		],
	});
	const context: AgentContext = { systemPrompt: [""], messages: [], tools };
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[createUserMessage("run")],
		context,
		{ model: mock.model, convertToLlm: identityConverter, ...config },
		signal,
		mock.stream,
	);
	for await (const event of stream) {
		events.push(event);
		onEvent?.(event);
	}
	const results = new Map<string, ToolResultMessage>();
	for (const event of events) {
		if (event.type === "message_end" && event.message.role === "toolResult") {
			results.set(event.message.toolCallId, event.message);
		}
	}
	return { events, results };
}

function textOf(result: ToolResultMessage | undefined): string {
	return (result?.content ?? []).map(block => (block.type === "text" ? block.text : `[${block.type}]`)).join("");
}

/** Resolves once `signal` aborts, at once when it already has. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (!signal || signal.aborted) resolve();
	else signal.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}

const PATH_SCHEMA = type({ path: "string" });

function recordingTool(
	name: string,
	received: Array<{ name: string; params: unknown }>,
	extra: Partial<AgentTool<typeof PATH_SCHEMA, unknown>> = {},
): AgentTool<typeof PATH_SCHEMA, unknown> {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: PATH_SCHEMA,
		async execute(_id, params) {
			received.push({ name, params });
			return { content: [{ type: "text", text: `ran ${name}` }], details: {} };
		},
		...extra,
	};
}

/** A pause gate that reports when `count` callers have parked on it while it was engaged. */
class ObservedPauseGate extends AgentPauseGate {
	readonly parked = Promise.withResolvers<void>();
	#count = 0;

	constructor(readonly expected: number) {
		super();
	}

	override async waitUntilResumed(signal?: AbortSignal): Promise<void> {
		if (this.paused && ++this.#count === this.expected) this.parked.resolve();
		return super.waitUntilResumed(signal);
	}
}

const CANCELLED_NEVER_STARTED =
	"Skipped due to the run being cancelled. Do not count this skipped result as completed work or verification. It never started, so nothing was applied.";
const CANCELLED_AFTER_START =
	"Skipped due to the run being cancelled. Do not count this skipped result as completed work or verification. This tool had already started running when the run was cancelled, so it may have applied partial side effects. Check state before assuming it did or did not take effect.";

describe("a tool call the batch did not run is answered with why it stopped", () => {
	afterEach(() => {
		setSystemTime();
	});

	it("runs a lenient tool on arguments its schema rejects, without the parse markers, and refuses a strict one", async () => {
		const received: Array<{ name: string; params: unknown }> = [];
		const parseFailure = { __parseError: "Unexpected end of JSON input", __rawJson: '{"path":' };
		const { results } = await runTurn(
			[recordingTool("lenient", received, { lenientArgValidation: true }), recordingTool("strict", received)],
			[
				{ id: "lenient-missing", name: "lenient", arguments: { other: 1 } },
				{ id: "lenient-unparsed", name: "lenient", arguments: parseFailure },
				{ id: "strict-missing", name: "strict", arguments: { other: 1 } },
				{ id: "strict-unparsed", name: "strict", arguments: parseFailure },
			],
		);
		expect(received).toEqual([
			{ name: "lenient", params: { other: 1 } },
			{ name: "lenient", params: {} },
		]);
		expect(results.get("lenient-missing")?.isError).toBe(false);
		expect(results.get("lenient-unparsed")?.isError).toBe(false);
		expect(results.get("strict-missing")?.isError).toBe(true);
		expect(results.get("strict-unparsed")?.isError).toBe(true);
	});

	it("answers a call the repair hook cannot repair with the hook's reason and every hint, and never runs it", async () => {
		const received: Array<{ name: string; params: unknown }> = [];
		const verdicts: Record<string, Omit<ToolCallRepairResult, "arguments">> = {
			"no-hints": { status: "unrepairable", reason: "Arguments were truncated.", hints: [] },
			"one-hint": { status: "unrepairable", reason: "Arguments were truncated.", hints: ["close the string"] },
			"no-reason": { status: "unrepairable", hints: ["close the string", "resend the call"] },
			clean: { status: "clean", hints: [] },
		};
		const { results } = await runTurn(
			[recordingTool("echo", received)],
			Object.keys(verdicts).map(id => ({ id, name: "echo", arguments: { path: id } })),
			{
				repairToolCallArguments: (_tool, call) => ({
					...verdicts[call.id],
					arguments: call.arguments as Record<string, unknown>,
				}),
			},
		);
		expect(received).toEqual([{ name: "echo", params: { path: "clean" } }]);
		const answers = Object.fromEntries(
			[...results].map(([id, result]) => [id, { text: textOf(result), isError: result.isError }]),
		);
		expect(answers).toEqual({
			"no-hints": { text: "Arguments were truncated.", isError: true },
			"one-hint": {
				text: "Arguments were truncated.\n\n[Tool argument repair]\n- close the string",
				isError: true,
			},
			"no-reason": {
				text: "Tool arguments could not be repaired.\n\n[Tool argument repair]\n- close the string\n- resend the call",
				isError: true,
			},
			clean: { text: "ran echo", isError: false },
		});
	});

	it("answers a call queued behind the call that cancelled the run as never executed", async () => {
		const controller = new AbortController();
		const ran: string[] = [];
		const tool: AgentTool<typeof PATH_SCHEMA, unknown> = {
			name: "step",
			label: "Step",
			description: "Step tool",
			parameters: PATH_SCHEMA,
			concurrency: "exclusive",
			async execute(id) {
				ran.push(id);
				controller.abort("operator stopped the run");
				return { content: [{ type: "text", text: "first done" }], details: {} };
			},
		};
		const { results } = await runTurn(
			[tool],
			[
				{ id: "first", name: "step", arguments: { path: "a" } },
				{ id: "second", name: "step", arguments: { path: "b" } },
			],
			{},
			controller.signal,
		);
		expect(ran).toEqual(["first"]);
		expect(textOf(results.get("first"))).toBe("first done");
		const second = results.get("second");
		expect(textOf(second)).toBe("Tool was not executed because the run was aborted: operator stopped the run.");
		expect(second?.isError).toBe(true);
		expect(second?.details).toEqual({ __skipped: true, source: "cancelled-run", entered: false });
	});

	for (const count of [1, 2]) {
		it(`tells ${count} call${count === 1 ? "" : "s"} parked on the pause gate that the run was cancelled`, async () => {
			const controller = new AbortController();
			const pauseGate = new ObservedPauseGate(count);
			const received: Array<{ name: string; params: unknown }> = [];
			void pauseGate.parked.promise.then(() => controller.abort("operator stopped the run"));
			const calls = Array.from({ length: count }, (_, index) => ({
				id: `parked-${index}`,
				name: "echo",
				arguments: { path: String(index) },
			}));
			const { results } = await runTurn([recordingTool("echo", received)], calls, { pauseGate }, controller.signal);
			expect(received).toEqual([]);
			const first = results.get("parked-0");
			expect(first?.isError).toBe(true);
			if (count === 1) {
				// A one-call batch has no siblings to inventory, so its placeholder carries no ledger.
				expect(textOf(first)).toBe(CANCELLED_NEVER_STARTED);
				expect(first?.details).toEqual({ __skipped: true, source: "cancelled-run", entered: false });
			} else {
				expect(textOf(first).startsWith(`${CANCELLED_NEVER_STARTED}\n\n`)).toBe(true);
				expect(first?.details).toMatchObject({ __skipped: true, source: "cancelled-run", entered: false });
				const second = results.get("parked-1");
				expect(textOf(second)).toBe(CANCELLED_NEVER_STARTED);
				expect(second?.details).toEqual({ __skipped: true, source: "cancelled-run", entered: false });
			}
		});
	}

	it("never lets an afterToolCall hook replace the answer of a call the cancel cut off inside the tool", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		let hookCalls = 0;
		const tool: AgentTool<typeof PATH_SCHEMA, unknown> = {
			name: "hold",
			label: "Hold",
			description: "Hold tool",
			parameters: PATH_SCHEMA,
			async execute(_id, _params, signal) {
				started.resolve();
				await aborted(signal);
				throw new Error("stopped");
			},
		};
		void started.promise.then(() => controller.abort("operator stopped the run"));
		const { results } = await runTurn(
			[tool],
			[{ id: "held", name: "hold", arguments: { path: "a" } }],
			{
				afterToolCall: async () => {
					hookCalls++;
					return { content: [{ type: "text", text: "replaced" }], isError: false };
				},
			},
			controller.signal,
		);
		expect(hookCalls).toBe(0);
		const held = results.get("held");
		expect(textOf(held)).toBe(CANCELLED_AFTER_START);
		expect(held?.isError).toBe(true);
		expect(held?.details).toEqual({ __skipped: true, source: "cancelled-run", entered: true });
	});

	it("persists a thrown call that a hook marks useless as an error without the useless flag", async () => {
		const tool: AgentTool<typeof PATH_SCHEMA, unknown> = {
			name: "fails",
			label: "Fails",
			description: "Fails tool",
			parameters: PATH_SCHEMA,
			async execute() {
				throw new Error("disk full");
			},
		};
		const { results } = await runTurn([tool], [{ id: "thrown", name: "fails", arguments: { path: "a" } }], {
			afterToolCall: async () => ({ useless: true }),
		});
		const thrown = results.get("thrown");
		expect(thrown?.isError).toBe(true);
		expect(textOf(thrown)).toBe("disk full");
		expect(thrown).not.toHaveProperty("useless");
	});

	it("records a call answered before it ran as taking no time, its whole wait queued", async () => {
		const start = Date.parse("2026-01-01T00:00:00.000Z");
		setSystemTime(new Date(start));
		const tool: AgentTool<typeof PATH_SCHEMA, unknown> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: PATH_SCHEMA,
			concurrency: "exclusive",
			async execute() {
				setSystemTime(new Date(start + 5_000));
				return { content: [{ type: "text", text: "slow done" }], details: {} };
			},
		};
		const { results } = await runTurn(
			[tool],
			[
				{ id: "slow", name: "slow", arguments: { path: "a" } },
				{ id: "invalid", name: "slow", arguments: { other: 1 } },
			],
			{ instrumentation: "rich" },
		);
		const metrics = results.get("invalid")?.metrics;
		expect(metrics?.status).toBe("error");
		expect(metrics?.durationMs).toBe(0);
		expect(metrics?.queuedMs).toBeGreaterThanOrEqual(5_000);
	});
});
