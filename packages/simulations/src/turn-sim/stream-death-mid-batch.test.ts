/**
 * A provider stream that dies AFTER streaming its tool calls, before any of them
 * could run.
 *
 * WHAT THIS CLOSES. The session refused to retry any failed turn that carried a
 * tool call, on the premise that a completed call may already have applied its
 * side effects. The premise is false for the shape that actually recurs:
 * the agent loop has one `tool.execute()` call site and the error stop returns
 * before it, so every retained call is paired with a never-ran placeholder. The
 * fault was a zero-cost transport failure and the product turned it into a dead
 * turn: the provider's error on screen, and a ledger handed to the model telling
 * it to reissue calls on a batch where nothing had happened.
 *
 * THE ROWS ARE THE SPEC.
 *  1. A stalled stream (transient from its prose) is retried, both tools run on
 *     the replay, and the replayed request carries neither the dead turn nor its
 *     placeholders nor the ledger.
 *  2. The same for OpenAI's incomplete stream, whose prose classifies to 0 and
 *     which is transient only because the throw site attaches the flag. The two
 *     failures are different rows because they are transient for different
 *     reasons.
 *  3. A RESUME of that session does not replay the death. Rows 1 and 2 watch the
 *     live context, and history is a second list: the store keeps the recovered
 *     turn on purpose (the transcript renders a retry from it) and kept its
 *     never-ran placeholders too, so a reopened session handed the model tool
 *     results whose call was gone, one of them carrying the ledger asking it to
 *     reissue calls the retry had already run.
 *  4. With no retry budget the safety net is unchanged: placeholders and the
 *     ledger still reach the model, because a turn that cannot be replayed still
 *     has to leave the conversation answerable.
 *  5. A non-transient failure with tool calls is still not retried. Narrowing
 *     replay-safety must not promote a permanent fault into the retry ladder.
 *
 * WHAT IT DOES NOT CATCH. The genuinely replay-unsafe shape is a Cursor
 * exec-channel block, which dispatches the tool inside the provider stream.
 * That is `unreplayable-batch-continue.test.ts`, which stamps
 * `kCursorExecResolved` through the harness and asserts the session continues
 * the turn instead of retrying it. Rows 1 and 2 here are what would go red if
 * the guard were dropped in the other direction (retrying everything), because
 * a real paired result also stops the retry.
 */
import { expect, it } from "bun:test";
import { SUPERSEDED_NOTICE } from "@veyyon/agent-core/compaction/pruning";
import * as AIError from "@veyyon/ai/error";
import { TOOL } from "@veyyon/coding-agent/tools/builtin-names";
import { createSimulation, type ScriptedTurn, type Simulation, simTool } from "./harness";

/** Row 1: the watchdog's own stall message, transient from its prose. */
const STALL_TEXT = "Provider stream stalled while waiting for the next event";
/** Row 2: OpenAI's incomplete stream, transient only via its error id. */
const INCOMPLETE_STREAM_TEXT = "OpenAI completions stream closed before a terminal finish reason was received";
const INCOMPLETE_STREAM_ID = AIError.classify(
	new AIError.ProviderResponseError(INCOMPLETE_STREAM_TEXT, { provider: "openai", kind: "incomplete-stream" }),
);
const LEDGER_MARKER = "Partial completion ledger";
const PLACEHOLDER_MARKER = "was not executed because the provider stream ended";

interface ContextShape {
	roles: string[];
	texts: string[];
}

function contextShape(turn: ScriptedTurn): ContextShape {
	const roles: string[] = [];
	const texts: string[] = [];
	for (const message of turn.context.messages) {
		roles.push(message.role);
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") texts.push(content);
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
					texts.push(String((block as { text?: unknown }).text ?? ""));
				}
			}
		}
		const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
		if (typeof errorMessage === "string") texts.push(`errorMessage:${errorMessage}`);
	}
	return { roles, texts };
}

/**
 * What a NEW process reads back out of the store, and what it would send.
 *
 * Two lists again: the stored branch is the operator's history and legitimately keeps a
 * turn a retry recovered (that is what the dim "retried" note in the transcript renders
 * from), while the context a resumed session hands the model must not contain a dead turn
 * or a placeholder telling it to reissue calls that never ran.
 */
interface StoredShape {
	/** One row per stored message: its role, and an errored assistant's stop reason. */
	rows: string[];
	/** Every text stored as a tool result, placeholders included. */
	toolTexts: string[];
	/** The context the resumed session's first request carries. */
	resumed: ContextShape | undefined;
}

async function storedShape(sim: Simulation, resumeContext: () => ContextShape | undefined): Promise<StoredShape> {
	const rows: string[] = [];
	const toolTexts: string[] = [];
	for (const entry of sim.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		rows.push(message.role === "assistant" ? `assistant:${message.stopReason}` : message.role);
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") toolTexts.push(block.text);
		}
	}
	// One prompt on the reopened session, which is what a resume does: the request it
	// builds is the only place the replayed history is observable.
	await sim.session.prompt("carry on");
	return { rows, toolTexts, resumed: resumeContext() };
}

async function runStreamDeath(options: {
	failWith: (turn: ScriptedTurn) => void;
	maxRetries: number;
	/** Store the transcript and read it back through a second session. */
	persist?: boolean;
}): Promise<{
	ran: string[];
	requests: number;
	replayed: ContextShape | undefined;
	assistantText: string;
	/** Every text the model is handed as a tool result, placeholders included. */
	toolTexts: string[];
	/** The stored transcript as a reopened session reads it, when `persist` is on. */
	stored: StoredShape | undefined;
}> {
	const ran: string[] = [];
	const contexts: ContextShape[] = [];
	const sim = await createSimulation({
		persist: options.persist === true,
		settings: { "retry.maxRetries": options.maxRetries },
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
			contexts.push(contextShape(turn));
			if (turn.call === 1) {
				turn.toolCall(TOOL.bash, { command: "echo one" }, "call-a");
				turn.toolCall(TOOL.read, { path: "README.md" }, "call-b");
				options.failWith(turn);
				return;
			}
			if (turn.call === 2 && ran.length === 0) {
				// The replay: the model reissues the batch it never got to run.
				turn.toolCall(TOOL.bash, { command: "echo one" }, "call-a");
				turn.toolCall(TOOL.read, { path: "README.md" }, "call-b");
				turn.finish();
				return;
			}
			turn.text("both done");
			turn.finish();
		},
	});
	try {
		await sim.session.prompt("do two things");
		const assistant = sim
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
		let stored: StoredShape | undefined;
		if (options.persist === true) {
			// A second session over the same store, which is the only way to see what a
			// resume would replay: the live context is already asserted above.
			const reopened = await sim.reopen();
			try {
				stored = await storedShape(reopened, () => contexts.at(-1));
			} finally {
				await reopened.dispose();
			}
		}
		return {
			ran,
			requests: sim.sessionRequests().length,
			replayed: contexts[1],
			assistantText: assistant,
			toolTexts,
			stored,
		};
	} finally {
		sim.dispose();
	}
}

it("retries a stalled stream that killed a tool batch before anything ran", async () => {
	const result = await runStreamDeath({ failWith: turn => turn.fail(STALL_TEXT), maxRetries: 2 });

	expect(result.ran).toEqual(["bash", "read"]);
	expect(result.requests).toBe(3);
	expect(result.assistantText).toContain("both done");

	const replayed = result.replayed;
	expect(replayed).toBeDefined();
	// The dead turn, its never-ran placeholders and the ledger are all gone from
	// the context the replay is served with.
	expect(replayed?.roles).toEqual(["user"]);
	expect(replayed?.texts.join("\n")).not.toContain(LEDGER_MARKER);
	expect(replayed?.texts.join("\n")).not.toContain(PLACEHOLDER_MARKER);
	expect(replayed?.texts.join("\n")).not.toContain(STALL_TEXT);
});

it("retries an OpenAI incomplete stream, which is transient only through its error id", async () => {
	// Guard the premise: this prose is NOT transient on its own, so a scenario
	// without the id would measure the text classifier instead of the retry.
	expect(AIError.is(AIError.classifyMessage({ errorMessage: INCOMPLETE_STREAM_TEXT }), AIError.Flag.Transient)).toBe(
		false,
	);
	expect(AIError.is(INCOMPLETE_STREAM_ID, AIError.Flag.Transient)).toBe(true);

	const result = await runStreamDeath({
		failWith: turn => turn.fail(INCOMPLETE_STREAM_TEXT, INCOMPLETE_STREAM_ID),
		maxRetries: 2,
	});

	expect(result.ran).toEqual(["bash", "read"]);
	expect(result.requests).toBe(3);
	expect(result.replayed?.roles).toEqual(["user"]);
	expect(result.replayed?.texts.join("\n")).not.toContain(PLACEHOLDER_MARKER);
});

it("does not replay the dead turn or its placeholders when the session is resumed", async () => {
	const result = await runStreamDeath({ failWith: turn => turn.fail(STALL_TEXT), maxRetries: 2, persist: true });

	expect(result.ran).toEqual(["bash", "read"]);
	const stored = result.stored;
	expect(stored).toBeDefined();
	// History keeps the recovered turn on purpose: the transcript renders a retry from it.
	// The two placeholders stored beside it are the reason this row exists.
	expect(stored?.rows).toEqual([
		"user",
		"assistant:error",
		"toolResult",
		"toolResult",
		"assistant:toolUse",
		"toolResult",
		"toolResult",
		"assistant:stop",
	]);
	// BOTH stored placeholders still name the transport fault. Neither is rewritten to
	// "[Superseded by a newer read of this file]": the dead `read` never ran, so it is not
	// a read of that path in either direction, and blanking it would replace the one fact
	// it carries with a claim about a read that did not happen.
	expect(stored?.toolTexts.filter(text => text.includes(PLACEHOLDER_MARKER))).toHaveLength(2);
	expect(stored?.toolTexts.filter(text => text === SUPERSEDED_NOTICE)).toEqual([]);
	expect(stored?.toolTexts.filter(text => text === "bash ran" || text === "read ran")).toEqual([
		"bash ran",
		"read ran",
	]);

	// The contract: what a resumed session SENDS. A dead turn whose batch never ran is
	// not a fact about the conversation, and a placeholder telling the model to reissue
	// those calls is a fabrication once the retry already reissued them.
	const resumed = stored?.resumed;
	expect(resumed).toBeDefined();
	const resumedText = resumed?.texts.join("\n") ?? "";
	expect(resumedText).not.toContain(PLACEHOLDER_MARKER);
	expect(resumedText).not.toContain(LEDGER_MARKER);
	expect(resumedText).not.toContain(STALL_TEXT);
	// The row cannot pass by resuming an empty session: the work that DID happen is there.
	expect(resumed?.texts.join("\n")).toContain("bash ran");
	expect(resumed?.roles).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant", "user"]);
});

it("keeps the placeholder safety net when there is no retry budget left", async () => {
	const result = await runStreamDeath({ failWith: turn => turn.fail(STALL_TEXT), maxRetries: 0 });

	expect(result.ran).toEqual([]);
	expect(result.requests).toBe(1);
	// Nothing replays, so the conversation stays answerable the old way: every
	// dropped call is paired, and the ledger says which ones never ran.
	const placeholders = result.toolTexts.filter(text => text.includes(PLACEHOLDER_MARKER));
	expect(placeholders.length).toBe(2);
	expect(result.toolTexts.filter(text => text.includes(LEDGER_MARKER)).length).toBe(1);
});

it("does not retry a non-transient failure that carried tool calls", async () => {
	const permanentText = "Provider returned error finish_reason: content_filter";
	expect(AIError.retriable(AIError.classifyMessage({ errorMessage: permanentText }))).toBe(false);

	const result = await runStreamDeath({ failWith: turn => turn.fail(permanentText), maxRetries: 2 });

	expect(result.ran).toEqual([]);
	expect(result.requests).toBe(1);
});
