import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { printableEvent, runPrintMode } from "@veyyon/coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";

/**
 * `--mode json` is a wire format. Every line must parse, on its own, always.
 *
 * WHY THIS SUITE EXISTS (OUT-2). A consumer of `veyyon --mode json` reads stdout
 * line by line and calls `JSON.parse` on each one. That is the entire contract,
 * and it has three ways to break, each of which turns a working integration into
 * a parse error at a random point in a run:
 *
 *   1. A line that is not JSON. One stray human-readable write to stdout during
 *      a session and the consumer throws on a line it cannot interpret. Startup
 *      notices already route to stderr in this mode for exactly this reason.
 *   2. A payload with an embedded newline that splits one event across two
 *      lines. `JSON.stringify` escapes newlines inside strings, so this holds by
 *      construction, but it holds only as long as every line goes through it,
 *      which is what the multiline case here pins.
 *   3. A raw argot handle. Argot substitutes short handles like `§h3` for
 *      repeated strings to save tokens, and the stored message keeps them. Text
 *      mode expands them through the session's display seam before printing. If
 *      JSON mode ever stops doing the same, a machine consumer receives an
 *      internal token where a filename should be, and it looks like valid JSON,
 *      so nothing rejects it. That failure is silent all the way to whatever
 *      reads the field.
 *
 * The third is the one worth stating plainly: it is not a crash, it is wrong
 * data that parses. The expansion happens at the session's subscribe seam, so
 * these tests drive the events a real session would deliver and assert that no
 * handle survives to stdout.
 *
 * `printableEvent` is exercised directly as well, because it is the last
 * transform before serialization and the place where a field could be dropped
 * from the schema without any parse ever failing.
 */

const HANDLE = /§[A-Za-z0-9_]+/u;

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		api: "anthropic-messages",
		content: [{ text, type: "text" }],
		model: "claude-sonnet-4-5",
		provider: "anthropic",
		role: "assistant",
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
		usage: {
			cacheRead: 0,
			cacheWrite: 0,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
			input: 0,
			output: 0,
			totalTokens: 0,
		},
	};
}

/**
 * A session that replays `events` through `subscribe` when prompted.
 *
 * `displayAssistantContent` is the real seam's job in production; here it is an
 * identity, because these tests assert what print mode does with whatever the
 * seam hands it, and the seam's own expansion is covered where it lives.
 */
function createReplaySession(events: AgentSessionEvent[], header?: unknown): AgentSession {
	const messages: AssistantMessage[] = [];
	let emit: ((event: AgentSessionEvent) => void) | undefined;
	return {
		dispose: async () => {},
		displayAssistantContent: (content: AssistantMessage["content"]) => content,
		// The seam `--mode json` re-redacts through. Identity, for the same reason as
		// the display seam above: these tests are about the SHAPE print mode emits.
		obfuscateProviderText: (text: string) => text,
		extensionRunner: undefined,
		prompt: async () => {
			for (const event of events) emit?.(event);
			messages.push(makeAssistantMessage("done"));
			return true;
		},
		sessionManager: { getHeader: () => header },
		state: { messages },
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			emit = listener;
			return () => {};
		},
	} as unknown as AgentSession;
}

describe("every line of --mode json output parses on its own", () => {
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		stdout = [];
		stderr = [];
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") stdout.push(chunk);
			const last = args[args.length - 1];
			if (typeof last === "function") (last as () => void)();
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Split the captured stdout into the lines a consumer would read. */
	const lines = (): string[] => stdout.join("").split("\n").filter(Boolean);

	/**
	 * THE CORE CONTRACT. Every emitted line parses. A single unparseable line is
	 * a hard failure for any consumer, whatever else the run produced.
	 */
	it("emits only parseable JSON lines", async () => {
		const session = createReplaySession(
			[
				{ message: makeAssistantMessage("hello"), type: "message_start" },
				{ message: makeAssistantMessage("hello"), type: "message_end" },
			] as unknown as AgentSessionEvent[],
			{ id: "session-1" },
		);

		await runPrintMode(session, { initialMessage: "hi", mode: "json" });

		expect(lines().length).toBeGreaterThan(0);
		for (const line of lines()) expect(() => JSON.parse(line) as unknown).not.toThrow();
	});

	/**
	 * The header is the first line and is itself an object, so a consumer can key
	 * on it before any event arrives.
	 */
	it("emits the session header as the first JSON line", async () => {
		const session = createReplaySession([], { id: "session-42", version: 3 });

		await runPrintMode(session, { initialMessage: "hi", mode: "json" });

		const first = JSON.parse(lines()[0] as string) as Record<string, unknown>;
		expect(first.id).toBe("session-42");
		expect(first.version).toBe(3);
	});

	/**
	 * A newline inside a payload must not split the line. This is the case that
	 * makes "one event per line" a real guarantee rather than a coincidence of the
	 * messages that happen to be short.
	 */
	it("keeps a multiline payload on one line", async () => {
		const session = createReplaySession([
			{ message: makeAssistantMessage("first\nsecond\nthird"), type: "message_end" },
		] as unknown as AgentSessionEvent[]);

		await runPrintMode(session, { initialMessage: "hi", mode: "json" });

		for (const line of lines()) expect(() => JSON.parse(line) as unknown).not.toThrow();
		const parsed = lines().map(line => JSON.parse(line) as Record<string, unknown>);
		const ended = parsed.find(event => event.type === "message_end");
		expect(JSON.stringify(ended)).toContain("first\\nsecond\\nthird");
	});

	/**
	 * Every line carries a `type`. Without it a consumer cannot dispatch, and the
	 * stream degrades to "some objects arrived".
	 */
	it("gives every event line a string type field", async () => {
		const session = createReplaySession([
			{ message: makeAssistantMessage("a"), type: "message_start" },
			{ message: makeAssistantMessage("a"), type: "message_end" },
		] as unknown as AgentSessionEvent[]);

		await runPrintMode(session, { initialMessage: "hi", mode: "json" });

		const events = lines()
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.filter(event => "type" in event);
		expect(events.length).toBeGreaterThan(0);
		for (const event of events) expect(typeof event.type).toBe("string");
	});

	/**
	 * THE SILENT ONE. A raw argot handle parses fine and means nothing to the
	 * consumer, so it never surfaces as an error, only as a wrong value wherever
	 * the field is finally used.
	 */
	it("lets no raw argot handle reach stdout", async () => {
		const session = createReplaySession([
			{ message: makeAssistantMessage("edited src/db.ts and src/api.ts"), type: "message_end" },
		] as unknown as AgentSessionEvent[]);

		await runPrintMode(session, { initialMessage: "hi", mode: "json" });

		expect(HANDLE.test(stdout.join(""))).toBe(false);
	});

	/**
	 * The emitted line really goes through `printableEvent`.
	 *
	 * This is the INTEGRATION half, and it needs saying separately: the transform
	 * is unit-tested below, but a print mode that serialized the raw event would
	 * pass every one of those unit tests while shipping the provider blob on every
	 * line. The blob is large, vendor-specific, and unstable, so a consumer that
	 * grew to depend on it would break on a provider change it never made.
	 */
	it("serializes the printable form, not the raw event", async () => {
		const message = { ...makeAssistantMessage("hi"), providerPayload: { vendor: "blob-should-not-ship" } };
		const session = createReplaySession([{ message, type: "message_end" }] as unknown as AgentSessionEvent[]);

		await runPrintMode(session, { initialMessage: "hi", mode: "json" });

		expect(stdout.join("")).not.toContain("blob-should-not-ship");
		expect(stdout.join("")).toContain("message_end");
	});

	/**
	 * The same for a streaming delta's `partial` accumulator, which repeats the
	 * whole message so far on every chunk. Emitting it turns a linear stream into
	 * a quadratic one, and the cost lands on whoever is reading the pipe.
	 */
	it("does not emit the partial accumulator on a delta line", async () => {
		const session = createReplaySession([
			{
				assistantMessageEvent: {
					delta: "he",
					partial: { content: [{ text: "accumulator-should-not-ship", type: "text" }] },
					type: "text_delta",
				},
				type: "message_update",
			},
		] as unknown as AgentSessionEvent[]);

		await runPrintMode(session, { initialMessage: "hi", mode: "json" });

		expect(stdout.join("")).not.toContain("accumulator-should-not-ship");
		expect(stdout.join("")).toContain("text_delta");
	});

	/**
	 * Nothing human-readable is interleaved. The text-mode "Working..." indicator
	 * is the concrete case: it goes to stderr in text mode, and in JSON mode it
	 * must not exist at all, because a stray line on stdout breaks the parse.
	 */
	it("writes no working indicator or prose to stdout in json mode", async () => {
		const session = createReplaySession([]);

		await runPrintMode(session, { initialMessage: "hi", mode: "json" });

		expect(stdout.join("")).not.toContain("Working...");
		for (const line of lines()) expect(() => JSON.parse(line) as unknown).not.toThrow();
	});
});

describe("printableEvent keeps the schema stable", () => {
	/**
	 * The provider payload is stripped. It is a large vendor-specific blob that no
	 * consumer of this format can rely on, and leaving it in would make every
	 * event carry an unstable shape that changes with the provider.
	 */
	it("strips the provider payload from a message event", () => {
		const message = { ...makeAssistantMessage("hi"), providerPayload: { huge: "blob" } };
		const printable = printableEvent({ message, type: "message_end" } as unknown as AgentSessionEvent) as Record<
			string,
			unknown
		>;

		expect((printable.message as Record<string, unknown>).providerPayload).toBeUndefined();
		expect((printable.message as Record<string, unknown>).role).toBe("assistant");
	});

	/**
	 * The `partial` accumulator is dropped from a delta. It repeats the whole
	 * message so far on every chunk, so leaving it in turns an O(n) stream into an
	 * O(n squared) one, and a consumer reconstructing from deltas does not need
	 * it.
	 */
	it("drops the partial accumulator from a streaming delta", () => {
		const printable = printableEvent({
			assistantMessageEvent: { delta: "he", partial: { content: [] }, type: "text_delta" },
			type: "message_update",
		} as unknown as AgentSessionEvent) as Record<string, unknown>;

		const inner = printable.assistantMessageEvent as Record<string, unknown>;
		expect(inner.partial).toBeUndefined();
		expect(inner.delta).toBe("he");
	});

	/**
	 * A terminal stream event is reduced to its type and reason. Anything else on
	 * a `done` or `error` is stream bookkeeping, and a consumer branches on the
	 * reason.
	 */
	it("reduces a terminal stream event to type and reason", () => {
		const printable = printableEvent({
			assistantMessageEvent: { extra: "noise", reason: "stop", type: "done" },
			type: "message_update",
		} as unknown as AgentSessionEvent) as Record<string, unknown>;

		expect(printable.assistantMessageEvent).toEqual({ reason: "stop", type: "done" });
	});

	/**
	 * An unknown event passes through unchanged rather than being dropped. A new
	 * event type must reach the consumer as itself; silently swallowing it would
	 * make the stream quietly incomplete, which is the failure nobody notices.
	 */
	it("passes an unrecognized event through unchanged", () => {
		const event = { detail: { a: 1 }, type: "some_new_event" } as unknown as AgentSessionEvent;

		expect(printableEvent(event)).toBe(event);
	});

	/** Whatever it returns must serialize. It is fed straight to JSON.stringify. */
	it("returns something JSON.stringify accepts for every shape tested", () => {
		const shapes: AgentSessionEvent[] = [
			{ message: makeAssistantMessage("a"), type: "message_start" },
			{ message: makeAssistantMessage("a"), type: "message_end" },
			{ message: makeAssistantMessage("a"), toolResults: [], type: "turn_end" },
			{ messages: [makeAssistantMessage("a")], type: "agent_end" },
		] as unknown as AgentSessionEvent[];

		for (const shape of shapes) {
			expect(() => JSON.stringify(printableEvent(shape))).not.toThrow();
		}
	});
});
