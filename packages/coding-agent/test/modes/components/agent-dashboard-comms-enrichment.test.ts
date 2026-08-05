/**
 * What the Comms view says ABOUT the traffic, on top of the traffic itself.
 *
 * The stream tests next door prove the messages arrive and are ordered. This
 * file covers the four things layered over them, each of which answers a
 * question the bodies cannot: the summary line ("did anything not land"), the
 * head-line marks ("what does this answer, and did it wake anyone"), the `f`
 * filter ("show me only this agent"), and conversation scope ("this card
 * belongs to one session, not to every session the process has driven").
 *
 * They are worth locking separately because each one is a small piece of text
 * that is easy to regress into being wrong rather than into being absent: a
 * count that ignores the filter, a reply mark that names the agent already on
 * the row, a strip that disagrees with the body under it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus, type IrcMessage } from "@veyyon/coding-agent/irc/bus";
import { codeNameFor } from "@veyyon/coding-agent/modes/components/agent-activity";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** Right arrow: Live -> Comms. */
const RIGHT = "\x1b[C";
const UP = "\x1b[A";

/** A recipient that accepts every delivery, so sends land as real traffic. */
function acceptingSession(): AgentSession {
	return {
		deliverIrcMessage: async () => "injected",
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

/** A recipient that reports the delivery outcome the test is about. */
function sessionDelivering(outcome: "injected" | "woken"): AgentSession {
	return {
		deliverIrcMessage: async () => outcome,
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

/** Register one more running subagent, so a test can have a third voice. */
function registerAgent(id: string, session: AgentSession | null, scope?: string): void {
	AgentRegistry.global().register({
		id,
		displayName: "helper",
		kind: "sub",
		session,
		status: "running",
		scope,
	});
}

/** Send, then hand back the id the bus minted, so a later message can answer it. */
async function sendAndId(msg: Omit<IrcMessage, "id" | "ts">): Promise<string> {
	await IrcBus.global().send(msg);
	const log = IrcBus.global().log();
	const last = log[log.length - 1];
	if (!last) throw new Error("send recorded no log entry");
	return last.message.id;
}

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerAgent("0-Sub", acceptingSession());
	registerAgent("1-Sub", acceptingSession());
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry.restore();
});

/** A card already switched to the Comms view. */
function commsCard(options: { scope?: string } = {}): {
	dashboard: AgentDashboard;
	frame: () => string;
} {
	const dashboard = new AgentDashboard({
		terminalHeight: 40,
		expandKeys: ["ctrl+o"],
		scope: options.scope,
	});
	dashboard.handleInput(RIGHT);
	return { dashboard, frame: () => dashboard.render(120).join("\n").replace(ANSI_PATTERN, "") };
}

/** The summary line above the stream, without the padding the card draws around it. */
function summaryOf(frame: string): string {
	const line = frame.split("\n").find(row => /\d+ messages? ·|\d+ messages? *$/.test(row));
	if (line === undefined) throw new Error(`no summary line in frame:\n${frame}`);
	// The card draws the line inside its border, so strip the frame glyphs.
	return line.replace(/[│┃┆╎|]/g, "").trim();
}

/** The message head lines: time, speakers, and the marks this file is about. */
function headLinesOf(frame: string): string[] {
	return frame
		.split("\n")
		.filter(row => row.includes("→"))
		.map(row => row.replace(/[│┃┆╎|█]/g, "").trim());
}

describe("Comms summary line", () => {
	/**
	 * The count and the filter state are the line's whole job. Without it the
	 * operator has to scroll the stream to learn how much of it there is, and has
	 * no on-screen record of whether what they are reading is everything.
	 */
	test("reports the message count and that nothing is filtered out", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: "0-Sub", to: "1-Sub", body: "one" });
		await bus.send({ from: "1-Sub", to: "0-Sub", body: "two" });
		const { dashboard, frame } = commsCard();

		expect(summaryOf(frame())).toContain("2 messages · all agents");
		dashboard.dispose();
	});

	/**
	 * "1 messages" is the classic pluralisation tell, and this line is read on
	 * every frame of a quiet session, which is exactly when the count is one.
	 */
	test("says 1 message rather than 1 messages for a single entry", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: "only thing said" });
		const { dashboard, frame } = commsCard();

		const summary = summaryOf(frame());

		expect(summary).toContain("1 message ·");
		expect(summary).not.toContain("1 messages");
		dashboard.dispose();
	});

	/**
	 * The undelivered chunk is a warning, and a warning that shows "0 undelivered"
	 * on a healthy run is noise the reader learns to skip past, which is how they
	 * come to miss it on the run where it says one.
	 */
	test("omits the undelivered count when every message landed", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: "0-Sub", to: "1-Sub", body: "one" });
		await bus.send({ from: "1-Sub", to: "0-Sub", body: "two" });
		const { dashboard, frame } = commsCard();

		expect(summaryOf(frame())).not.toContain("undelivered");
		dashboard.dispose();
	});

	/**
	 * A failure five screens up is invisible, so the count is hoisted to a line
	 * that is always on screen. The failure here is produced the way the product
	 * produces one, by addressing a registered agent whose session has gone, so
	 * the test breaks if the bus stops recording that case as `failed`.
	 */
	test("counts a message that never reached its recipient", async () => {
		registerAgent("2-Sub", null);
		const bus = IrcBus.global();
		await bus.send({ from: "0-Sub", to: "1-Sub", body: "this one landed" });
		await bus.send({ from: "0-Sub", to: "2-Sub", body: "this one did not" });
		const { dashboard, frame } = commsCard();

		expect(summaryOf(frame())).toContain("1 undelivered");
		dashboard.dispose();
	});

	/**
	 * The ` (f)` hint advertises a key that only does something when there is more
	 * than one agent to cycle through. On a log with a single voice the key is a
	 * no-op, and advertising a no-op teaches the operator the hints lie.
	 */
	test("omits the filter hint until more than one agent has appeared", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "0-Sub", body: "talking to myself" });
		const { dashboard, frame } = commsCard();

		expect(summaryOf(frame())).not.toContain("(f)");
		dashboard.dispose();
	});

	/** And once a second voice is in the log the key does something, so it is offered. */
	test("shows the filter hint once a second agent has appeared", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: "0-Sub", to: "0-Sub", body: "talking to myself" });
		await bus.send({ from: "0-Sub", to: "1-Sub", body: "and now to you" });
		const { dashboard, frame } = commsCard();

		expect(summaryOf(frame())).toContain("all agents (f)");
		dashboard.dispose();
	});

	/** The count follows the filter, so the line describes what is under it. */
	test("counts the filtered stream, not the whole log", async () => {
		registerAgent("2-Sub", acceptingSession());
		const bus = IrcBus.global();
		await bus.send({ from: "0-Sub", to: "1-Sub", body: "kestrel to otter" });
		await bus.send({ from: "1-Sub", to: "2-Sub", body: "otter to juniper" });
		const { dashboard, frame } = commsCard();

		dashboard.handleInput("f");

		expect(summaryOf(frame())).toContain(`1 message · ${codeNameFor(0)} only`);
		dashboard.dispose();
	});
});

describe("Comms head line marks", () => {
	/**
	 * A reply to whoever asked gets a bare `↩`. The head already reads
	 * `Otter → Kestrel`, so `↩ re Kestrel` prints Kestrel twice on one line and
	 * teaches nothing; the redundancy is the exact thing the mark was narrowed to
	 * avoid, which is why its absence is asserted and not just the mark's shape.
	 */
	test("marks a reply to the asker without naming them a second time", async () => {
		const asked = await sendAndId({ from: "0-Sub", to: "1-Sub", body: "where is the caller" });
		await IrcBus.global().send({ from: "1-Sub", to: "0-Sub", body: "executor.ts", replyTo: asked });
		const { dashboard, frame } = commsCard();

		const heads = headLinesOf(frame());

		expect(heads[1]).toContain(`${codeNameFor(1)} → ${codeNameFor(0)} ↩`);
		expect(heads[1]).not.toContain("↩ re");
		expect(heads[1]).not.toContain(`↩ re ${codeNameFor(0)}`);
		dashboard.dispose();
	});

	/**
	 * A reply routed to a THIRD agent is the case the name exists for: nothing on
	 * the row says whose question is being relayed, so an interleaved stream would
	 * have to be untangled by reading bodies.
	 */
	test("names the agent being answered when the reply goes to someone else", async () => {
		registerAgent("2-Sub", acceptingSession());
		const asked = await sendAndId({ from: "0-Sub", to: "1-Sub", body: "where is the caller" });
		await IrcBus.global().send({ from: "1-Sub", to: "2-Sub", body: "passing this on", replyTo: asked });
		const { dashboard, frame } = commsCard();

		const heads = headLinesOf(frame());

		expect(heads[1]).toContain(`${codeNameFor(1)} → ${codeNameFor(2)} ↩ re ${codeNameFor(0)}`);
		dashboard.dispose();
	});

	/**
	 * A `replyTo` naming a message the reader cannot see resolves to nothing, not
	 * to a stray name. The link is built from the rendered set precisely so a
	 * filtered or scoped stream degrades to no mark instead of pointing off screen.
	 */
	test("renders no reply mark for a message that is not in the rendered set", async () => {
		await IrcBus.global().send({
			from: "1-Sub",
			to: "0-Sub",
			body: "answering something you cannot see",
			replyTo: "a-message-id-that-is-not-in-this-log",
		});
		const { dashboard, frame } = commsCard();

		const heads = headLinesOf(frame());

		expect(heads).toHaveLength(1);
		expect(heads[0]).not.toContain("↩");
		dashboard.dispose();
	});

	/**
	 * `woke` says the message started a turn in an agent that had stopped, which
	 * is the difference between "they were listening" and "your message is why
	 * they are running". Driven through a real recipient session so the badge is
	 * tied to what the bus reports, not to a hand-written log entry.
	 */
	test("badges a delivery that woke its recipient", async () => {
		registerAgent("2-Sub", sessionDelivering("woken"));
		await IrcBus.global().send({ from: "0-Sub", to: "2-Sub", body: "wake up" });
		const { dashboard, frame } = commsCard();

		const heads = headLinesOf(frame());

		expect(heads[0]).toContain(`${codeNameFor(0)} → ${codeNameFor(2)} woke`);
		dashboard.dispose();
	});

	/**
	 * The ordinary live hand-off gets no badge. It is what almost every message
	 * does, and a badge on every row is a badge nobody reads, which would cost the
	 * two badges that mean something their only value.
	 */
	test("badges nothing for an ordinary live hand-off", async () => {
		registerAgent("2-Sub", sessionDelivering("injected"));
		await IrcBus.global().send({ from: "0-Sub", to: "2-Sub", body: "just a message" });
		const { dashboard, frame } = commsCard();

		const heads = headLinesOf(frame());

		expect(heads[0]).toContain(`${codeNameFor(0)} → ${codeNameFor(2)}`);
		expect(heads[0]).not.toContain("woke");
		expect(heads[0]).not.toContain("revived");
		dashboard.dispose();
	});
});

describe("Comms filter", () => {
	/** Three voices, with one exchange the first agent takes no part in. */
	async function threeWayTraffic(): Promise<void> {
		registerAgent("2-Sub", acceptingSession());
		const bus = IrcBus.global();
		await bus.send({ from: "0-Sub", to: "1-Sub", body: "kestrel speaking to otter" });
		await bus.send({ from: "1-Sub", to: "0-Sub", body: "otter answering kestrel" });
		await bus.send({ from: "1-Sub", to: "2-Sub", body: "otter and juniper alone" });
	}

	/**
	 * Filtering matches an agent at EITHER end. A filter that only matched the
	 * sender would show half of the agent's conversation and call it the
	 * conversation, which is the failure the whole view exists to avoid.
	 */
	test("narrows to one agent's traffic as sender and as recipient", async () => {
		await threeWayTraffic();
		const { dashboard, frame } = commsCard();

		dashboard.handleInput("f");
		const shown = frame();

		expect(shown).toContain("kestrel speaking to otter");
		expect(shown).toContain("otter answering kestrel");
		expect(shown).not.toContain("otter and juniper alone");
		dashboard.dispose();
	});

	/**
	 * The cycle wraps back to unfiltered. Without the wrap the only way out of a
	 * filter would be to close the card, so a keypress meant to glance at one
	 * agent would strand the operator away from the stream.
	 */
	test("cycles through every participant and back to the whole stream", async () => {
		await threeWayTraffic();
		const { dashboard, frame } = commsCard();

		for (let press = 0; press < 4; press++) dashboard.handleInput("f");
		const shown = frame();

		expect(summaryOf(shown)).toContain("3 messages · all agents");
		expect(shown).toContain("kestrel speaking to otter");
		expect(shown).toContain("otter answering kestrel");
		expect(shown).toContain("otter and juniper alone");
		dashboard.dispose();
	});

	/**
	 * The tab strip counts what the pane draws. The Live tab already shipped this
	 * bug once, counting only running agents above a roster that listed every one
	 * of them, and a strip that contradicts the body under it is worse than no
	 * count at all.
	 */
	test("counts the filtered stream in the tab strip", async () => {
		await threeWayTraffic();
		const { dashboard, frame } = commsCard();
		expect(frame()).toContain("Comms (3)");

		dashboard.handleInput("f");

		expect(frame()).toContain("Comms (2)");
		dashboard.dispose();
	});

	/**
	 * A filter change replaces what is on screen, so the scroll offset from the
	 * previous set means nothing against the new one: held, it drops the operator
	 * into the middle of a conversation they did not ask to enter, and hides the
	 * newest message on a view whose entire promise is showing what just happened.
	 */
	test("returns to the newest message when the filter changes while scrolled back", async () => {
		const bus = IrcBus.global();
		for (let index = 0; index < 30; index++) {
			await bus.send({ from: "0-Sub", to: "1-Sub", body: `line ${index}` });
		}
		await bus.send({ from: "1-Sub", to: "0-Sub", body: "the newest thing said" });
		const { dashboard, frame } = commsCard();
		for (let press = 0; press < 12; press++) dashboard.handleInput(UP);
		expect(frame()).not.toContain("the newest thing said");

		dashboard.handleInput("f");

		expect(frame()).toContain("the newest thing said");
		dashboard.dispose();
	});
});

describe("Comms conversation scope", () => {
	/** Two conversations sharing one process, each with its own pair of agents. */
	async function twoConversations(): Promise<void> {
		registerAgent("a-1", acceptingSession(), "session-a");
		registerAgent("a-2", acceptingSession(), "session-a");
		registerAgent("b-1", acceptingSession(), "session-b");
		registerAgent("b-2", acceptingSession(), "session-b");
		const bus = IrcBus.global();
		await bus.send({ from: "a-1", to: "a-2", body: "inside conversation a" });
		await bus.send({ from: "b-1", to: "b-2", body: "inside conversation b" });
	}

	/**
	 * The bus is process-global and this card is not. An ACP or cmux host driving
	 * several sessions at once, or a session resumed over a previous one, had
	 * every card reading the same stream and opening on a stranger's exchange.
	 */
	test("shows only the traffic of the conversation the card was opened for", async () => {
		await twoConversations();
		const { dashboard, frame } = commsCard({ scope: "session-a" });

		const shown = frame();

		expect(shown).toContain("inside conversation a");
		expect(shown).not.toContain("inside conversation b");
		dashboard.dispose();
	});

	/**
	 * EITHER end is enough. Scoping on both would delete the last words of an
	 * agent released moments ago, which is the half of the exchange the operator
	 * most often opens this view to re-read.
	 */
	test("keeps a message with only one end in this conversation", async () => {
		await twoConversations();
		await IrcBus.global().send({ from: "a-1", to: "b-1", body: "one end of this is mine" });
		const { dashboard, frame } = commsCard({ scope: "session-a" });

		expect(frame()).toContain("one end of this is mine");
		dashboard.dispose();
	});

	/**
	 * No scope shows everything. A collab guest and a render-only host have no
	 * conversation to attribute the card to, and a filter that emptied the stream
	 * for them would be a worse failure than the cross-talk it prevents.
	 */
	test("shows every conversation when the card has no scope", async () => {
		await twoConversations();
		const { dashboard, frame } = commsCard();

		const shown = frame();

		expect(shown).toContain("inside conversation a");
		expect(shown).toContain("inside conversation b");
		dashboard.dispose();
	});
});
