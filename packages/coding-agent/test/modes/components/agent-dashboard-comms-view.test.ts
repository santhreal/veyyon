/**
 * The Comms view of the Agent Control Center: agent-to-agent traffic, streaming.
 *
 * WHY IT READS THE BUS. A subagent's session file shows what THAT agent
 * received, so a view built from transcripts shows each half of a conversation
 * in a different file and never shows the legs that failed to land at all. The
 * bus sees every leg, keeps them after delivery has drained the mailbox, and
 * pushes each one to watchers as it happens, which is what makes this view live
 * rather than a snapshot of whatever had been said when it was opened.
 *
 * The truncation tests are the ones worth reading twice: agents send each other
 * paragraphs, and a stream that silently clips them reads as a stream of short
 * messages. Every fold is announced with the count it hid, and Ctrl+O unfolds.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
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
const DOWN = "\x1b[B";

/** A recipient that accepts every delivery, so sends land as real traffic. */
function acceptingSession(): AgentSession {
	return {
		deliverIrcMessage: async () => "injected",
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentRegistry.global().register({
		id: "0-Sub",
		displayName: "reviewer",
		kind: "sub",
		session: acceptingSession(),
		status: "running",
	});
	AgentRegistry.global().register({
		id: "1-Sub",
		displayName: "scout",
		kind: "sub",
		session: acceptingSession(),
		status: "running",
	});
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry.restore();
});

/** A card already switched to the Comms view. */
function commsCard(options: { expandKeys?: readonly ["ctrl+o"] } = {}): {
	dashboard: AgentDashboard;
	frame: () => string;
} {
	const dashboard = new AgentDashboard({
		terminalHeight: 40,
		expandKeys: options.expandKeys ?? ["ctrl+o"],
	});
	dashboard.handleInput(RIGHT);
	return { dashboard, frame: () => dashboard.render(120).join("\n").replace(ANSI_PATTERN, "") };
}

describe("Comms stream", () => {
	/** Sender, recipient and body, for traffic the mailboxes have already drained. */
	test("shows delivered traffic that no mailbox still holds", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: "found the caller in executor.ts" });
		const { dashboard, frame } = commsCard();

		const shown = frame();

		expect(IrcBus.global().unreadCount("1-Sub")).toBe(0);
		expect(shown).toContain(codeNameFor(0));
		expect(shown).toContain(codeNameFor(1));
		expect(shown).toContain("found the caller in executor.ts");
		dashboard.dispose();
	});

	/** Oldest first: it is a log, and a log read bottom-up is not a log. */
	test("orders messages oldest first", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: "0-Sub", to: "1-Sub", body: "first thing said" });
		await bus.send({ from: "1-Sub", to: "0-Sub", body: "second thing said" });
		const { dashboard, frame } = commsCard();

		const shown = frame();

		expect(shown.indexOf("first thing said")).toBeLessThan(shown.indexOf("second thing said"));
		dashboard.dispose();
	});

	/**
	 * The view opens on the NEWEST message. A stream whose entire purpose is
	 * showing what just happened must not open on the opening of the conversation
	 * under a scrollbar parked at the bottom.
	 */
	test("opens on the newest message, not the oldest", async () => {
		const bus = IrcBus.global();
		for (let i = 0; i < 40; i++) {
			await bus.send({ from: "0-Sub", to: "1-Sub", body: `message number ${i}` });
		}
		const { dashboard, frame } = commsCard();

		const shown = frame();

		expect(shown).toContain("message number 39");
		expect(shown).not.toContain("message number 0 ");
		dashboard.dispose();
	});

	/** The tab strip counts the traffic, so the count is visible before switching. */
	test("counts the traffic in the tab strip", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: "0-Sub", to: "1-Sub", body: "one" });
		await bus.send({ from: "1-Sub", to: "0-Sub", body: "two" });
		const { dashboard, frame } = commsCard();

		expect(frame()).toContain("Comms (2)");
		dashboard.dispose();
	});

	/** Nothing said yet is stated, not left as a blank pane. */
	test("states the empty case", () => {
		const { dashboard, frame } = commsCard();

		expect(frame()).toContain("No agent traffic yet.");
		dashboard.dispose();
	});
});

describe("Truncation and Ctrl+O", () => {
	const LONG_BODY = Array.from({ length: 9 }, (_, i) => `body line ${i}`).join("\n");

	/** A long message is folded, and the fold says how many lines it hid. */
	test("folds a long message and reports the hidden line count", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: LONG_BODY });
		const { dashboard, frame } = commsCard();

		const shown = frame();

		expect(shown).toContain("body line 0");
		expect(shown).toContain("body line 2");
		expect(shown).not.toContain("body line 8");
		expect(shown).toContain("6 more lines");
		expect(shown).toContain("ctrl+o");
		dashboard.dispose();
	});

	/** Ctrl+O unfolds every message in the stream. */
	test("Ctrl+O expands the folded lines", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: LONG_BODY });
		const { dashboard, frame } = commsCard();

		dashboard.handleInput("\x0f");
		const expanded = frame();

		expect(expanded).toContain("body line 8");
		expect(expanded).not.toContain("more lines");
		dashboard.dispose();
	});

	/** And it toggles back, so the gesture is reversible rather than one-way. */
	test("Ctrl+O folds again on a second press", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: LONG_BODY });
		const { dashboard, frame } = commsCard();

		dashboard.handleInput("\x0f");
		dashboard.handleInput("\x0f");
		const refolded = frame();

		expect(refolded).not.toContain("body line 8");
		expect(refolded).toContain("6 more lines");
		dashboard.dispose();
	});

	/**
	 * The expand key comes from `app.tools.expand`, not from a literal in this
	 * component, so rebinding it moves both the transcript's expand and this one.
	 * With no keys wired the press does nothing rather than falling back to a
	 * hardcoded chord that the operator's config says is something else.
	 */
	test("uses the configured expand keys rather than a hardcoded chord", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: LONG_BODY });
		const dashboard = new AgentDashboard({ terminalHeight: 40, expandKeys: [] });
		dashboard.handleInput(RIGHT);

		dashboard.handleInput("\x0f");
		const shown = dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");

		expect(shown).toContain("6 more lines");
		expect(shown).not.toContain("body line 8");
		dashboard.dispose();
	});
});

describe("Delivery failures", () => {
	/**
	 * A message that never reached its recipient is the line that explains a
	 * reply which never comes, so it is marked on the row with its reason rather
	 * than rendered identically to a delivered one.
	 */
	test("marks traffic that was not delivered, with the reason", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "ghost", body: "anyone there" });
		const { dashboard, frame } = commsCard();

		const shown = frame();

		expect(shown).toContain("anyone there");
		expect(shown).toContain("not delivered");
		expect(shown).toContain('Unknown agent "ghost"');
		dashboard.dispose();
	});
});

describe("Streaming", () => {
	/**
	 * A message sent while the card is open appears without any keypress. This is
	 * the whole difference between a comms view and a comms report: the operator
	 * opens it to watch agents talk, and a snapshot taken at open time would show
	 * an empty screen for the rest of the run.
	 */
	test("shows a message that arrives while the view is open", async () => {
		const { dashboard, frame } = commsCard();
		expect(frame()).toContain("No agent traffic yet.");
		let rendered = 0;
		dashboard.onRequestRender = () => {
			rendered++;
		};

		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: "arrived mid-view" });

		expect(frame()).toContain("arrived mid-view");
		expect(rendered).toBeGreaterThan(0);
		dashboard.dispose();
	});

	/**
	 * And a disposed card stops listening. The bus is process-global and outlives
	 * every card opened against it, so a card that kept its subscription would
	 * rebuild a layout nobody is looking at once per message for the rest of the
	 * session.
	 */
	test("stops rebuilding once disposed", async () => {
		const { dashboard } = commsCard();
		let rendered = 0;
		dashboard.onRequestRender = () => {
			rendered++;
		};

		dashboard.dispose();
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: "after dispose" });

		expect(rendered).toBe(0);
	});
});

describe("Who is speaking", () => {
	/**
	 * The stream names agents the way the roster does. The bus records raw ids,
	 * and a spawn-scoped id is exactly what call signs exist to replace: the point
	 * of a room view is that you follow a conversation by who is speaking, and
	 * `Kestrel → Otter` is followable where `0-Sub → 1-Sub` is a pair of tokens
	 * you have to look up on the other tab.
	 */
	test("labels both ends of a message with the call sign the Live roster shows", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: "ping" });
		const { dashboard, frame } = commsCard();

		const shown = frame();

		expect(shown).toContain(`${codeNameFor(0)} → ${codeNameFor(1)}`);
		dashboard.dispose();
	});

	/** The raw id is gone from the line, not merely joined by the call sign. */
	test("does not print the raw agent id beside the call sign", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: "ping" });
		const { dashboard, frame } = commsCard();

		const shown = frame();

		expect(shown).not.toContain("0-Sub");
		expect(shown).not.toContain("1-Sub");
		dashboard.dispose();
	});

	/**
	 * An agent with no roster row prints as its id. It has been released, so there
	 * is no call sign to show, and what it said still happened: a placeholder like
	 * `unknown` on both ends of an old exchange would make two different departed
	 * agents read as one.
	 */
	test("falls back to the id for an agent that is no longer registered", async () => {
		await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: "ping" });
		AgentRegistry.global().unregister("0-Sub");
		const { dashboard, frame } = commsCard();

		const shown = frame();

		expect(shown).toContain(`0-Sub → ${codeNameFor(0)}`);
		dashboard.dispose();
	});
});

describe("Following the newest traffic", () => {
	/**
	 * The frame with everything that legitimately moves when a message arrives
	 * taken out, leaving the stream's text.
	 *
	 * Three things move and none of them is the stream scrolling. The view strip
	 * counts the traffic and the summary line counts it again, and both MUST
	 * change on a new message: folding either into a whole-frame comparison would
	 * assert the counts are frozen, which is the opposite of what a live view owes
	 * the operator. The scrollbar thumb moves because the total grew under a fixed
	 * start row, which is the bar reporting the truth. What must NOT move is the
	 * text, so that is what is compared.
	 */
	function streamOf(frame: string): string {
		return frame
			.split("\n")
			.filter(line => !line.includes("Comms (") && !/\d+ messages? ·/.test(line))
			.map(line => line.replaceAll("█", "").replaceAll("│", ""))
			.join("\n");
	}

	/** Enough messages to overflow the pane, so the tail and the top differ. */
	async function fillStream(count: number): Promise<void> {
		for (let index = 0; index < count; index++) {
			await IrcBus.global().send({ from: "0-Sub", to: "1-Sub", body: `line ${index}` });
		}
	}

	/**
	 * The view tails by default, so traffic arriving on a full stream scrolls the
	 * newest message into sight on its own. A stream that stayed where it was
	 * opened would show the same frozen page while agents kept talking, which is
	 * the failure the Streaming tests above only catch on an EMPTY view: there,
	 * any position shows the one message there is.
	 */
	test("scrolls a full stream to the message that just arrived", async () => {
		await fillStream(30);
		const { dashboard, frame } = commsCard();

		await IrcBus.global().send({ from: "1-Sub", to: "0-Sub", body: "the newest thing said" });

		expect(frame()).toContain("the newest thing said");
		expect(frame()).not.toContain("line 0");
		dashboard.dispose();
	});

	/**
	 * Scrolling back pins the view. An operator reading something a few messages
	 * back is doing the one thing a live stream makes hard, and yanking them to
	 * the bottom on the next message would make reading history impossible on a
	 * busy session.
	 */
	test("holds position when traffic arrives after scrolling back", async () => {
		await fillStream(30);
		const { dashboard, frame } = commsCard();
		for (let press = 0; press < 12; press++) dashboard.handleInput(UP);
		const parked = streamOf(frame());

		await IrcBus.global().send({ from: "1-Sub", to: "0-Sub", body: "the newest thing said" });

		expect(streamOf(frame())).toBe(parked);
		expect(frame()).not.toContain("the newest thing said");
		dashboard.dispose();
	});

	/**
	 * And scrolling back down re-arms the tail, rather than leaving the view
	 * pinned to whatever row happened to be the bottom at the time. Without this
	 * the only way back to live traffic would be to close the card and reopen it.
	 */
	test("resumes following once scrolled back to the bottom", async () => {
		await fillStream(30);
		const { dashboard, frame } = commsCard();
		for (let press = 0; press < 12; press++) dashboard.handleInput(UP);
		for (let press = 0; press < 12; press++) dashboard.handleInput(DOWN);

		await IrcBus.global().send({ from: "1-Sub", to: "0-Sub", body: "the newest thing said" });

		expect(frame()).toContain("the newest thing said");
		dashboard.dispose();
	});
});
