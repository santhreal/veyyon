/**
 * Class closure for interrupted tool calls.
 *
 * Measured over 778 local session transcripts: runs of 52 and 51 consecutive
 * byte-identical skipped tool results, and runs of 39/32/31/30/29 identical
 * "Tool execution was aborted". A run that long is a livelock, and the reason
 * it survived is that every existing test covers ONE interrupt source, the one
 * whoever wrote it had in mind. The siblings were never exercised.
 *
 * So this file does not test a reproduction. It tests the invariant at the
 * choke point every interrupt passes through, `createSkippedToolResult` in
 * `packages/agent/src/agent-loop.ts`, and it derives the member list FROM
 * SOURCE at run time. Adding a member to the union without recording a
 * decision here turns this suite RED, which is the only property that keeps a
 * class closed: a hardcoded list goes stale in silence.
 *
 * Everything runs against the real `agentLoop` with a scripted mock provider.
 * No sleeps, no network, no clocks.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	SteeringInterruptSource,
	SteeringQueueState,
} from "@veyyon/agent-core/types";
import type { Message, ToolResultMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";

const AGENT_SRC = path.resolve(import.meta.dirname, "../../../agent/src");

/**
 * Sentinel for the `undefined` arm of the source union. `undefined` is a real
 * member of the choke point's parameter type and it produces a distinct
 * `details.source` ("steering"), so it needs a recorded decision like any
 * other literal; it just cannot be a Set entry as itself.
 */
const NO_SOURCE = "(undefined)";

/**
 * Read the interrupt-source union out of the two files that define it.
 *
 * This is deliberately a source read rather than a literal list. The union has
 * no runtime representation to enumerate (TypeScript erases it), and the whole
 * point of the exercise is that the member list must come from the code that
 * owns it, so a sixth arm cannot be added without this file noticing.
 */
async function deriveInterruptSources(): Promise<string[]> {
	const types = await fs.readFile(path.join(AGENT_SRC, "types.ts"), "utf8");
	const steeringDecl = /export type SteeringInterruptSource\s*=\s*([^;]+);/.exec(types);
	if (!steeringDecl) throw new Error("SteeringInterruptSource declaration not found in packages/agent/src/types.ts");

	const loop = await fs.readFile(path.join(AGENT_SRC, "agent-loop.ts"), "utf8");
	const chokePoint = /function createSkippedToolResult\(\s*source:\s*([^,]+),/.exec(loop);
	if (!chokePoint) throw new Error("createSkippedToolResult signature not found in packages/agent/src/agent-loop.ts");

	const members = new Set<string>();
	for (const arm of steeringDecl[1]?.split("|") ?? []) {
		const literal = /"([^"]+)"/.exec(arm);
		if (literal?.[1]) members.add(literal[1]);
	}
	for (const arm of chokePoint[1]?.split("|") ?? []) {
		const trimmed = arm.trim();
		if (trimmed === "SteeringInterruptSource") continue;
		if (trimmed === "undefined") {
			members.add(NO_SOURCE);
			continue;
		}
		const literal = /"([^"]+)"/.exec(trimmed);
		if (literal?.[1]) members.add(literal[1]);
		else throw new Error(`unrecognised arm in createSkippedToolResult source union: ${trimmed}`);
	}
	return [...members].sort();
}

/**
 * How each member is covered, and what its skip must say.
 *
 * `drive: "live"` members are exercised through the real loop below.
 * `drive: "defensive"` records a member the loop cannot currently reach, with
 * the reason. A defensive entry still has to name its wording, so a refactor
 * that makes it reachable lands on an assertion rather than on nothing.
 */
const DECISIONS: Record<string, { drive: "defensive" | "live"; reason: RegExp; why?: string }> = {
	"(undefined)": {
		drive: "defensive",
		reason: /Skipped due to pending steering message/,
		// interruptState.source is set to `steeringSource ?? "unknown"` before any
		// placeholder is built, so no live path passes `undefined` today. It stays
		// in the union as the parameter's own default.
		why: "unreachable through the loop: interruptState.source is always set before a placeholder is built",
	},
	"cancelled-run": { drive: "live", reason: /Skipped due to the run being cancelled/ },
	irc: { drive: "live", reason: /Skipped due to pending peer interrupt/ },
	system: { drive: "live", reason: /Skipped due to pending system advisory/ },
	unknown: { drive: "live", reason: /Skipped due to pending steering message/ },
	user: { drive: "live", reason: /Skipped due to queued user message/ },
};

const ANY_OBJECT = type("object");

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

interface InterruptWiring {
	/** Loop config fields that make this source the one the loop observes. */
	config: Partial<AgentLoopConfig>;
	/** Called once the first tool is inside `execute`. */
	trip: (controller: AbortController) => void;
}

function wiringFor(source: string, steeringQueue: AgentMessage[]): InterruptWiring {
	if (source === "cancelled-run") {
		// No queue, no peer: the operator simply cancelled the run.
		return { config: {}, trip: controller => controller.abort("Interrupted by user") };
	}
	if (source === "irc") {
		let interrupting = false;
		return {
			config: { interruptMode: "immediate", hasIrcInterrupts: () => interrupting },
			trip: () => {
				interrupting = true;
			},
		};
	}
	let queued = false;
	// "unknown" is the arm the loop synthesises when a queue reports work
	// without naming its origin, so its wiring omits `source` on purpose.
	const state: SteeringQueueState =
		source === "unknown" ? { queued: true } : { queued: true, source: source as SteeringInterruptSource };
	return {
		config: {
			interruptMode: "immediate",
			hasSteeringMessages: () => (queued ? state : { queued: false }),
			getSteeringMessages: async () => steeringQueue.splice(0),
		},
		trip: () => {
			queued = true;
			steeringQueue.push({
				role: "user",
				content: "hold on, do this instead",
				timestamp: Date.now(),
			} as AgentMessage);
		},
	};
}

interface DriveResult {
	skipped: ToolResultMessage[];
	secondToolRuns: number;
	terminated: boolean;
}

/**
 * Drive one interrupt source through the real loop.
 *
 * Shape: the model asks for two exclusive (serial) tool calls. The first one
 * signals that it is inside `execute`, the interrupt is tripped, and the loop
 * must then skip the second call rather than dispatch it. That is the exact
 * path `createSkippedToolResult` sits on.
 *
 * Nothing here waits on a clock: the interrupt trips off the first tool's own
 * entry, and the run is awaited to completion so a livelock fails the test by
 * timing out rather than by an assertion.
 */
async function driveInterrupt(source: string): Promise<DriveResult> {
	const controller = new AbortController();
	const steeringQueue: AgentMessage[] = [];
	const wiring = wiringFor(source, steeringQueue);
	let secondToolRuns = 0;

	const first: AgentTool = {
		name: "first",
		label: "first",
		description: "runs, then the interrupt lands",
		parameters: ANY_OBJECT,
		concurrency: "exclusive",
		execute: async (_id, _args, signal) => {
			wiring.trip(controller);
			if (signal?.aborted) throw new Error("aborted");
			// A cancelled run aborts the tool's own signal; observe it the way a
			// well-behaved tool does instead of returning a result it cannot have.
			if (source === "cancelled-run") {
				const held = Promise.withResolvers<never>();
				signal?.addEventListener("abort", () => held.reject(new Error("aborted")), { once: true });
				await held.promise;
			}
			return { content: [{ type: "text" as const, text: "first ok" }] };
		},
	};
	const second: AgentTool = {
		name: "second",
		label: "second",
		description: "must be skipped, not dispatched",
		parameters: ANY_OBJECT,
		concurrency: "exclusive",
		execute: async () => {
			secondToolRuns += 1;
			return { content: [{ type: "text" as const, text: "second ok" }] };
		},
	};

	const mock = createMockModel({
		responses: [
			{
				content: [
					{ type: "toolCall", name: "first", arguments: {} },
					{ type: "toolCall", name: "second", arguments: {} },
				],
			},
		],
		// Every later turn answers in text, so the run terminates however many
		// continuations the interrupt causes.
		handler: { content: ["done"] },
	});

	const context: AgentContext = { systemPrompt: ["lock"], messages: [], tools: [first, second] };
	const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, ...wiring.config };

	const messages = await agentLoop(
		[{ role: "user", content: "run both", timestamp: Date.now() } as AgentMessage],
		context,
		config,
		controller.signal,
		mock.stream,
	).result();

	const skipped = messages.filter(
		(message): message is ToolResultMessage =>
			message.role === "toolResult" &&
			message.content.some(block => block.type === "text" && block.text.startsWith("Skipped due to")),
	);
	return { skipped, secondToolRuns, terminated: true };
}

function skipText(message: ToolResultMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

describe("interrupted tool calls, as a closed class", () => {
	it("has a recorded decision for every member of the interrupt-source union", async () => {
		// FAIL BY DEFAULT. A sixth arm on `createSkippedToolResult`, or a fourth
		// SteeringInterruptSource, lands here first. Nobody can add a way to
		// interrupt a tool call and leave this suite green.
		const derived = await deriveInterruptSources();
		expect(derived).toEqual(Object.keys(DECISIONS).sort());
	});

	it("names its own cause for every live member, so a wedge is diagnosable", async () => {
		// The recurring defect this closes: a mechanism wired for the case
		// someone had in mind, with the siblings falling through to a generic
		// string. Every live member is driven, and the reasons must be distinct
		// wherever the union distinguishes them.
		const live = Object.entries(DECISIONS).filter(([, decision]) => decision.drive === "live");
		for (const [source, decision] of live) {
			const result = await driveInterrupt(source);

			expect(result.terminated).toBe(true);
			expect(result.skipped.length).toBeGreaterThan(0);
			const text = skipText(result.skipped[0] as ToolResultMessage);
			expect(text).toMatch(decision.reason);
			// A skip must never read as work that happened, whatever tripped it.
			expect(text).toContain("Do not count this skipped result as completed work");
			expect(text).not.toContain("second ok");
			// And the call it describes must genuinely not have run.
			expect(result.secondToolRuns).toBe(0);
		}

		// Distinctness, per member, against every other member that the union
		// words differently. "unknown" and the undefined default share wording on
		// purpose (both mean "steering, origin unstated"), so the comparison is
		// over the recorded reasons rather than over raw text.
		const reasons = live.map(([source]) => DECISIONS[source]?.reason.source);
		expect(new Set(reasons).size).toBe(reasons.length);
	});

	it("does not cycle on skips: one interrupt yields one skip, not a run of them", async () => {
		// The livelock shape from the transcripts. One pending interrupt must be
		// consumed and must not re-skip the same call on every continuation. The
		// bound is asserted on the WHOLE run, so a cycle fails here rather than
		// running until the operator kills it.
		for (const [source, decision] of Object.entries(DECISIONS)) {
			if (decision.drive !== "live") continue;
			const result = await driveInterrupt(source);
			// One tool call was skipped, once. Anything above that is the start of
			// a run of identical skips.
			expect(result.skipped.length).toBeLessThanOrEqual(1);
			expect(result.secondToolRuns).toBe(0);
		}
	});
});
