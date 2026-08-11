/**
 * A transport fault kills a tool batch that CANNOT be replayed.
 *
 * WHAT THIS CLOSES. `stream-death-mid-batch.test.ts` covers the batch a retry
 * can resend: every retained call is paired with a never-ran placeholder, so
 * discarding the turn duplicates nothing. This file covers the shape that
 * suite said it could not reach. A Cursor exec-channel call is dispatched
 * through the caller's handler INSIDE the provider stream, before its
 * `toolCall` block is even synthesized, so the call may have finished, may
 * still be running, and may have applied half its work. Its block carries
 * `kCursorExecResolved`, replay safety refuses the retry, and the session then
 * had nothing left to do: it ended the turn dead. The reported turn was 75
 * calls, 0 ran, 21 interrupted, 54 never ran, on a fault the classifier itself
 * calls transient, and the operator's only way forward was to notice and type.
 *
 * RETRY AND CONTINUATION ANSWER DIFFERENT QUESTIONS. Retry re-sends the turn,
 * which is what replay safety forbids. Continuation sends the turn that is
 * ALREADY in context: the failed assistant message with its calls, a never-ran
 * placeholder for each call the loop never dispatched, and the batch ledger
 * naming which ones need reissuing. Nothing is duplicated because nothing is
 * resent. So replay-unsafety must block the retry and must not block progress.
 *
 * THE ROWS ARE THE SPEC.
 *  1. A transient death on a batch holding one exec-channel call and one
 *     ordinary call continues exactly once, and the request it continues with
 *     KEEPS the dead turn, the placeholder and the ledger. That retention is
 *     the whole difference from a retry, whose request carries none of them.
 *  2. The same fault WITHOUT an exec-channel call still goes down the retry
 *     road: a clean replay, and no continuation notice. The two paths must not
 *     both fire on one failure.
 *  3. A non-transient failure does not continue. Making the dead turn
 *     recoverable must not promote a permanent fault into the ladder.
 *  4. With retry disabled nothing continues: one operator switch turns off
 *     every automatic re-request, and a continuation is one of those.
 *  5. A provider that dies on every attempt continues at most `maxRetries`
 *     times and then settles. A continuation is charged against the retry
 *     budget, so this cannot loop.
 *  6. A batch in which NOTHING never ran does not continue. Every call was
 *     dispatched out of band and the results are still in flight, so there is
 *     no work to carry forward; the ledger travels as a turn-level notice and
 *     the conversation stays answerable the old way.
 *  7. A call whose ARGUMENTS never finished streaming is outstanding even though
 *     no result will ever pair against it: its block is deleted, so the only
 *     record is `incompleteToolCalls` and the ledger's instruction to rebuild
 *     the arguments, and only a further request can carry that out.
 *  8. A batch that IS safe to replay and exhausted its retry budget does not
 *     then continue. Continuation is the answer to replay-unsafety, not a
 *     second budget bolted onto every failure.
 *  9. A turn that comes back resets the budget, so a session that hits this
 *     twice in its life gets the full allowance both times.
 *
 * The rule the last two rows share is that the question is asked per CALL. A
 * call that already carries a real result is answered, and a never-ran
 * placeholder sitting beside that result does not make it outstanding again;
 * that arm is driven at the session level in
 * `packages/coding-agent/test/agent-session-retry-cap.test.ts`, in "does not
 * retry a timeout whose tool call already carries a real result", which asserts
 * both that no retry happened and that no continuation notice was raised.
 *
 * WHAT IT DOES NOT CATCH. The exec channel's out-of-band result never arrives
 * in these rows (the transport died), so the continued request carries a
 * `toolCall` with no result. Pairing that up is `transformMessages`' job on the
 * outbound wire and is asserted where that lives; here the assertion stops at
 * what the session decides to send. Two guards in the gate also survive
 * mutation on purpose and are documented rather than pretended-covered: the
 * `retriable(id, { replayUnsafe: true })` check states the bar ("blocked ONLY
 * by replay safety") but is unreachable today, because a failure that survives
 * replay-unsafety is consumed by the retry ladder before the gate is reached;
 * and the abort/dispose guard is a re-entrancy interlock a scripted provider
 * cannot race.
 */
import { expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { TOOL } from "@veyyon/coding-agent/tools/builtin-names";
import { createSimulation, type ScriptedTurn, simTool } from "./harness";

/** The watchdog's own stall text, transient from its prose alone. */
const STALL_TEXT = "Provider stream stalled while waiting for the next event";
/** What the operator's report actually carried. */
const HTTP2_TEXT = "stream error: NGHTTP2_INTERNAL_ERROR";
const PERMANENT_TEXT = "Provider returned error finish_reason: content_filter";
const LEDGER_MARKER = "Partial completion ledger";
const PLACEHOLDER_MARKER = "was not executed because the provider stream ended";
const NOTICE_SOURCE = "unreplayable-batch";

interface Outcome {
	requests: number;
	/** Every text (and error text) in each request's context, joined per call. */
	contexts: string[];
	/** Which tools actually executed, in order. */
	ran: string[];
	noticeTexts: string[];
	assistantText: string;
	toolTexts: string[];
}

function contextText(turn: ScriptedTurn): string {
	const parts: string[] = [];
	for (const message of turn.context.messages) {
		parts.push(`role:${message.role}`);
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") parts.push(content);
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
					parts.push(String((block as { text?: unknown }).text ?? ""));
				}
			}
		}
		const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
		if (typeof errorMessage === "string") parts.push(`errorMessage:${errorMessage}`);
	}
	return parts.join("\n");
}

async function run(options: {
	/** How the first (and, when `dieEveryCall`, every) turn ends. */
	fail: (turn: ScriptedTurn) => void;
	/** Emit the exec-channel call that makes the batch unsafe to replay. */
	execResolved: boolean;
	/** Emit an ordinary call too, so something in the batch genuinely never ran. */
	ordinary: boolean;
	/** Open a call whose arguments never finish, so its block is deleted. */
	unfinishedArgs?: boolean;
	maxRetries: number;
	retryEnabled?: boolean;
	dieEveryCall?: boolean;
}): Promise<Outcome> {
	const ran: string[] = [];
	const contexts: string[] = [];
	const sim = await createSimulation({
		settings: {
			"retry.maxRetries": options.maxRetries,
			...(options.retryEnabled === false ? { "retry.enabled": false } : {}),
		},
		tools: [
			simTool(TOOL.bash, async () => {
				ran.push("bash");
				return { content: [{ type: "text", text: "bash ran" }] };
			}),
			simTool(TOOL.read, async () => {
				ran.push("read");
				return { content: [{ type: "text", text: "read ran" }] };
			}),
		],
		script: turn => {
			contexts.push(contextText(turn));
			if (turn.call === 1 || options.dieEveryCall === true) {
				if (options.ordinary) turn.toolCall(TOOL.bash, { command: "echo one" }, `call-a-${turn.call}`);
				if (options.execResolved)
					turn.execResolvedToolCall(TOOL.read, { path: "README.md" }, `call-b-${turn.call}`);
				if (options.unfinishedArgs === true)
					turn.openToolCall(TOOL.bash, '{"command":"echo par', `call-c-${turn.call}`);
				options.fail(turn);
				return;
			}
			turn.text("carried on");
			turn.finish();
		},
	});
	try {
		await sim.session.prompt("do two things");
		const assistantText = sim
			.eventsOfType("message_end")
			.flatMap(event => (event.message.role === "assistant" ? event.message.content : []))
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join(" ");
		const toolTexts: string[] = [];
		for (const event of sim.eventsOfType("tool_execution_end")) {
			for (const block of event.result.content ?? []) {
				if (block.type === "text") toolTexts.push(block.text);
			}
		}
		return {
			requests: sim.sessionRequests().length,
			contexts,
			ran,
			noticeTexts: sim.session.operatorNotices
				.all()
				.filter(notice => notice.source === NOTICE_SOURCE)
				.map(notice => notice.text),
			assistantText,
			toolTexts,
		};
	} finally {
		sim.dispose();
	}
}

it("continues a transient death on a batch it may not replay, keeping the turn it continues from", async () => {
	// Guard the premise both ways: transient on its own, refused once the batch
	// is replay-unsafe. A fixture that failed either half would make this row
	// green for the wrong reason.
	const id = AIError.classifyMessage({ errorMessage: HTTP2_TEXT });
	expect(AIError.retriable(id, { replayUnsafe: false })).toBe(true);
	expect(AIError.retriable(id, { replayUnsafe: true })).toBe(false);

	const result = await run({
		fail: turn => turn.fail(HTTP2_TEXT),
		execResolved: true,
		ordinary: true,
		maxRetries: 2,
	});

	// Exactly one continuation: the dead batch is not retried, and the turn does
	// not die either.
	expect(result.requests).toBe(2);
	expect(result.assistantText).toContain("carried on");
	expect(result.noticeTexts).toEqual([
		"The provider stream failed partway through a tool batch that cannot be replayed. Continuing with the calls that never ran.",
	]);

	// THE DIFFERENCE FROM A RETRY. A retry's request carries only the user turn
	// (asserted in stream-death-mid-batch.test.ts); a continuation carries the
	// failed turn, its never-ran placeholder and the ledger, which is what makes
	// it duplicate nothing.
	const continued = result.contexts[1];
	expect(continued).toBeDefined();
	expect(continued).toContain(PLACEHOLDER_MARKER);
	expect(continued).toContain(LEDGER_MARKER);
	expect(continued).toContain(`errorMessage:${HTTP2_TEXT}`);
	// The exec-channel call is never paired with a placeholder: its result is
	// emitted out of band, so inventing one here would answer a call that ran.
	expect(result.toolTexts.filter(text => text.includes(PLACEHOLDER_MARKER))).toHaveLength(1);
	// Nothing in this process ran the exec-channel tool a second time.
	expect(result.ran).toEqual([]);
});

it("still retries the same fault when the batch is safe to replay", async () => {
	const result = await run({
		fail: turn => turn.fail(HTTP2_TEXT),
		execResolved: false,
		ordinary: true,
		maxRetries: 2,
	});

	expect(result.requests).toBe(2);
	expect(result.assistantText).toContain("carried on");
	// The negative control for row 1: one failure must take ONE road. A retry
	// whose replay also raised the continuation notice would be re-sending the
	// batch and claiming it had not.
	expect(result.noticeTexts).toEqual([]);
	// A retry discards the dead turn, so its replay carries none of it.
	const replayed = result.contexts[1];
	expect(replayed).toBeDefined();
	expect(replayed).not.toContain(PLACEHOLDER_MARKER);
	expect(replayed).not.toContain(LEDGER_MARKER);
	expect(replayed).not.toContain(HTTP2_TEXT);
});

it("does not continue a permanent failure on an unreplayable batch", async () => {
	expect(AIError.retriable(AIError.classifyMessage({ errorMessage: PERMANENT_TEXT }), { replayUnsafe: false })).toBe(
		false,
	);

	const result = await run({
		fail: turn => turn.fail(PERMANENT_TEXT),
		execResolved: true,
		ordinary: true,
		maxRetries: 2,
	});

	expect(result.requests).toBe(1);
	expect(result.noticeTexts).toEqual([]);
	// The safety net is unchanged: the batch still leaves the conversation answerable.
	expect(result.toolTexts.filter(text => text.includes(LEDGER_MARKER))).toHaveLength(1);
});

it("does not continue when the operator turned retry off", async () => {
	const result = await run({
		fail: turn => turn.fail(STALL_TEXT),
		execResolved: true,
		ordinary: true,
		maxRetries: 2,
		retryEnabled: false,
	});

	expect(result.requests).toBe(1);
	expect(result.noticeTexts).toEqual([]);
});

it("spends the retry budget on continuations and then settles", async () => {
	// The row that proves this cannot loop. Awaiting the prompt is the assertion:
	// a session that kept continuing would never return.
	const result = await run({
		fail: turn => turn.fail(STALL_TEXT),
		execResolved: true,
		ordinary: true,
		maxRetries: 2,
		dieEveryCall: true,
	});

	expect(result.requests).toBe(3);
	// Identical notices collapse, so the operator sees the reason once, not once
	// per attempt.
	expect(result.noticeTexts).toHaveLength(1);
});

it("does not continue a batch in which nothing never ran", async () => {
	// Every call went out of band, so there is no carried-forward work to make
	// progress on and the results are still in flight. The bar is deliberately
	// this narrow.
	const result = await run({
		fail: turn => turn.fail(STALL_TEXT),
		execResolved: true,
		ordinary: false,
		maxRetries: 2,
	});

	expect(result.requests).toBe(1);
	expect(result.noticeTexts).toEqual([]);
	// No placeholder exists to carry the ledger, so it travels as a turn-level
	// notice instead and the model still learns what happened.
	expect(result.contexts).toHaveLength(1);
	expect(result.toolTexts.filter(text => text.includes(PLACEHOLDER_MARKER))).toEqual([]);
});
it("continues when the only outstanding call is one whose arguments never finished", async () => {
	// The shape that has no placeholder to count. `retainCompletedToolCalls`
	// deletes the block of a call whose arguments were still streaming, so
	// nothing in the transcript ever pairs against that id and looking for a
	// never-ran result can only answer no. The work is outstanding all the same,
	// and only a further request can reconstruct the arguments the ledger asks
	// the model to rebuild, so the turn continues rather than going quiet.
	const result = await run({
		fail: turn => turn.fail(STALL_TEXT),
		execResolved: true,
		ordinary: false,
		unfinishedArgs: true,
		maxRetries: 2,
	});

	expect(result.requests).toBe(2);
	expect(result.noticeTexts).toEqual([
		"The provider stream failed partway through a tool batch that cannot be replayed. Continuing with the calls that never ran.",
	]);
	expect(result.assistantText).toContain("carried on");
});

it("does not continue a replay-safe batch that merely ran out of retries", async () => {
	// The retry ladder already owns this failure and already spent its budget.
	// Continuation exists because replay-unsafety refuses the retry, not because
	// a transient fault deserves a second allowance under another name.
	const result = await run({
		fail: turn => turn.fail(STALL_TEXT),
		execResolved: false,
		ordinary: true,
		maxRetries: 1,
		dieEveryCall: true,
	});

	expect(result.requests).toBe(2);
	expect(result.noticeTexts).toEqual([]);
});

it("gives the second unreplayable death its own budget once a turn has landed", async () => {
	// A session lives for hours and a flaky transport hits it more than once. The
	// counter is a per-incident allowance, not a per-session one, so a turn that
	// came back has to clear it.
	const ran: string[] = [];
	const sim = await createSimulation({
		settings: { "retry.maxRetries": 1 },
		tools: [
			simTool(TOOL.bash, async () => {
				ran.push("bash");
				return { content: [{ type: "text", text: "bash ran" }] };
			}),
			simTool(TOOL.read, async () => {
				ran.push("read");
				return { content: [{ type: "text", text: "read ran" }] };
			}),
		],
		script: turn => {
			// Calls 1 and 3 die on an unreplayable batch; 2 and 4 are the
			// continuations, and each one lands.
			if (turn.call === 1 || turn.call === 3) {
				turn.toolCall(TOOL.bash, { command: "echo" }, `call-a-${turn.call}`);
				turn.execResolvedToolCall(TOOL.read, { path: "README.md" }, `call-b-${turn.call}`);
				turn.fail(STALL_TEXT);
				return;
			}
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});
	try {
		await sim.session.prompt("first");
		await sim.session.prompt("second");

		// Four requests: two deaths, two continuations. Three would mean the second
		// death found the budget already spent by the first.
		expect(sim.sessionRequests()).toHaveLength(4);
		expect(ran).toEqual([]);
	} finally {
		sim.dispose();
	}
});

it("hands a resumed session a paired, ledger-free version of the continued turn", async () => {
	// The class that produced the resume defect on the RETRY path: history and
	// the outbound context are two lists, and the stored dead turn is only
	// history. A reopened session must not re-ask the model to reissue a batch
	// the continuation already moved past, and must not hand the provider a
	// `tool_use` with no answer -- the exec-channel call has no result on disk,
	// because its result was still in flight when the transport died.
	const contexts: string[] = [];
	const sim = await createSimulation({
		persist: true,
		settings: { "retry.maxRetries": 2 },
		tools: [simTool(TOOL.bash, async () => ({ content: [{ type: "text", text: "bash ran" }] }))],
		script: turn => {
			contexts.push(contextText(turn));
			if (turn.call === 1) {
				turn.toolCall(TOOL.bash, { command: "echo" }, "call-a");
				turn.execResolvedToolCall(TOOL.read, { path: "README.md" }, "call-b");
				turn.fail(STALL_TEXT);
				return;
			}
			turn.text("carried on");
			turn.finish();
		},
	});
	try {
		await sim.session.prompt("do two things");
		const reopened = await sim.reopen();
		try {
			await reopened.session.prompt("and now this");
			const resumed = reopened.sessionRequests().length;
			expect(resumed).toBe(1);
			const request = contexts.at(-1) ?? "";
			// The work the turn produced survives; the instruction to redo it does not.
			expect(request).toContain("carried on");
			expect(request).not.toContain(LEDGER_MARKER);
			// Pairing, which is what a strict provider rejects.
			const messages = reopened.session.agent.state.messages;
			const answered = new Set(
				messages.filter(message => message.role === "toolResult").map(message => message.toolCallId),
			);
			const unanswered: string[] = [];
			for (const message of messages) {
				if (message.role !== "assistant") continue;
				for (const block of message.content) {
					if (block.type === "toolCall" && !answered.has(block.id)) unanswered.push(block.id);
				}
			}
			expect(unanswered).toEqual([]);
		} finally {
			await reopened.dispose();
		}
	} finally {
		sim.dispose();
	}
});
