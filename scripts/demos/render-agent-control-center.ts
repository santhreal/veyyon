/**
 * Print an Agent Control Center view as ANSI, for the render proofs.
 *
 * The card cannot be captured by launching veyyon and pressing `/agents`: both
 * of its views show LIVE state -- which agents are running, and what they have
 * said to each other -- so a live capture would show whatever this machine
 * happened to be doing, and would show nothing at all on an idle session. This
 * script seeds the process-global {@link AgentRegistry} and {@link IrcBus}, then
 * renders the real component, so every ground and every view comes out identical
 * on every machine.
 *
 * Usage:
 *
 *     bun scripts/demos/render-agent-control-center.ts --view termination [--rows 34] [--theme titanium]
 *       | bun scripts/demos/render-proof.ts --out /tmp/proof/acc-termination --width 120
 *
 * Views: `live` (the roster), `live-hover` (the roster's pointer affordance),
 * `termination` (the confirmation reached through that affordance), and `comms`
 * (the message stream). The card used to carry a configuration list of the
 * agent TYPES a stock install ships, which said nothing about what was running
 * and could not be opened; `/settings` -> Subagents owns that table.
 */
import { IrcBus } from "../../packages/coding-agent/src/irc/bus";
import { AgentDashboard } from "../../packages/coding-agent/src/modes/components/agent-dashboard";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "../../packages/coding-agent/src/registry/agent-registry";
import type { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import type { Component, TUI } from "../../packages/tui/src";
import { flag, renderWidth } from "./render-args";

const view = flag("view", "live");
const themeName = flag("theme", "titanium");
const width = renderWidth();
// `--rows` because the card's height rule is a thing a proof has to be able to
// show: the roster's capacity is a step function of terminal height, and the
// step that mattered (a 25-row terminal showing no agents at all) is invisible
// at any single size.
const ROWS = Number.parseInt(flag("rows", "34"), 10);

await initTheme(false, "unicode", false, themeName, themeName);

// Fixed geometry: the card sizes itself from the live terminal, and a proof that
// changes shape with the window it was generated in cannot be compared.
Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => ROWS });
Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => width });

const registry = AgentRegistry.global();

/**
 * A session that accepts deliveries, so the seeded traffic LANDS.
 *
 * Only the two fields the bus touches on the delivery path. An agent registered
 * with no session at all rejects every message, and a Comms proof where nothing
 * was delivered shows the failure styling five times over and never shows the
 * ordinary case.
 */
function acceptingSession(): AgentSession {
	return {
		deliverIrcMessage: async () => "injected",
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

registry.register({ id: MAIN_AGENT_ID, displayName: "Main Session", kind: "main", session: acceptingSession() });

registry.register({
	id: "task-7f21",
	displayName: "scout",
	kind: "sub",
	session: acceptingSession(),
	model: "anthropic/claude-opus-5",
});
registry.setActivity("task-7f21", "reading agent-dashboard.ts, 1,436 lines");

registry.register({
	id: "task-b904",
	displayName: "reviewer",
	kind: "sub",
	session: acceptingSession(),
	model: "anthropic/claude-sonnet-5",
});
registry.setActivity("task-b904", "grep for enableStateDisplay callers");

registry.register({
	id: "task-3ac8",
	displayName: "librarian",
	kind: "sub",
	session: null,
	model: "anthropic/claude-sonnet-5",
});
registry.setStatus("task-3ac8", "idle");

// Spawn times and activity stamps are wall-clock at registration, so every row
// would read the same age and the roster would order on id alone. Stamping them
// gives the proof the shape a real fan-out has: an older agent still working, a
// newer one just started, and one that has already finished.
const now = Date.now();
const stamp = (id: string, ageMs: number, idleMs: number) => {
	const ref = registry.get(id);
	if (!ref) return;
	ref.createdAt = now - ageMs;
	ref.lastActivity = now - idleMs;
};
stamp(MAIN_AGENT_ID, 14 * 60_000, 4_000);
stamp("task-7f21", 6 * 60_000, 3_000);
stamp("task-b904", 4 * 60_000, 3 * 60_000);
stamp("task-3ac8", 9 * 60_000, 8 * 60_000);

// Traffic for the Comms view, sent through the real bus so the outcomes on the
// proof are the outcomes the bus produced. The last leg is addressed to the one
// agent seeded without a session, so it fails the way a message to a released
// agent fails: a stream that showed only what landed would hide the one thing
// an operator opens it to find.
//
// The fourth leg answers the third. A reply is recorded on the message and the
// stream names who is being answered, so the proof has to contain one or the
// picture cannot show the difference between four agents talking and four
// agents talking past each other.
const traffic: Array<[string, string, string, number]> = [
	["task-7f21", MAIN_AGENT_ID, "The tab strip filters on AgentSource and nothing downstream reads it.", 260_000],
	[MAIN_AGENT_ID, "task-b904", "Take the inspector next. Seven of nine lines are model resolution.", 190_000],
	["task-b904", "task-7f21", "Which file holds the badge formatter? I have two that disagree.", 120_000],
	["task-7f21", "task-b904", "agent-model-badge.ts. It is one owner now, shared with the task widget.", 74_000],
	["task-b904", "task-3ac8", "Collect the theme matrix when you are done.", 22_000],
];
const sentIds: string[] = [];
for (const [index, [from, to, body]] of traffic.entries()) {
	// Leg 4 answers leg 3, by the id the bus minted for it.
	const replyTo = index === 3 ? sentIds[2] : undefined;
	await IrcBus.global().send({ from, to, body, ...(replyTo ? { replyTo } : {}) });
	sentIds.push(IrcBus.global().log().at(-1)?.message.id ?? "");
}
// Every message was sent within the same millisecond, so the clock column would
// read one time down the whole stream. The ages above are what the roster
// shows; these are the same story told on the other view.
const log = IrcBus.global().log();
for (const [index, entry] of log.entries()) {
	const age = traffic[index]?.[3];
	if (age !== undefined) entry.message.ts = now - age;
}

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Locate text in a rendered frame and return one-based SGR coordinates. */
function positionOf(lines: readonly string[], needle: string): { row: number; col: number } {
	const plain = lines.map(line => line.replace(ANSI_PATTERN, ""));
	const row = plain.findIndex(line => line.includes(needle));
	if (row < 0) throw new Error(`Agent Control Center proof could not find ${JSON.stringify(needle)}`);
	return { row: row + 1, col: plain[row]!.indexOf(needle) + 1 };
}

let overlay: Component | undefined;
const ui = {
	requestRender: () => {},
	requestComponentRender: () => {},
	showOverlay: (component: Component) => {
		overlay = component;
		return {
			hide: () => {
				if (overlay === component) overlay = undefined;
			},
		};
	},
	setFocus: () => {},
} as unknown as TUI;

const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true, ui });

// `\x1b[C` is right-arrow: the card opens on Live, so Comms is one step from it.
if (view === "comms" || view === "comms-filtered") dashboard.handleInput("\x1b[C");
// `f` cycles the filter one agent forward. Two presses lands on the second
// participant, which is the state worth a picture: one agent's half of a
// four-way stream, with the summary line naming what was narrowed to.
if (view === "comms-filtered") {
	dashboard.handleInput("f");
	dashboard.handleInput("f");
}
let lines = dashboard.render(width);
if (view === "live-hover" || view === "termination") {
	const scout = positionOf(lines, "scout");
	dashboard.handleInput(`\x1b[<35;${scout.col};${scout.row}M`);
	lines = dashboard.render(width);
}
if (view === "termination") {
	const scout = positionOf(lines, "scout");
	const scoutLine = lines[scout.row - 1]!.replace(ANSI_PATTERN, "");
	const terminateCol = scoutLine.lastIndexOf("[x]") + 1;
	if (terminateCol === 0) throw new Error("Agent Control Center proof did not reveal the row termination action");
	dashboard.handleInput(`\x1b[<0;${terminateCol};${scout.row}M`);
	if (!overlay) throw new Error("Agent Control Center proof did not mount the termination confirmation");
	lines = overlay.render(width);
}

process.stdout.write(`${lines.join("\n")}\n`);

dashboard.dispose();
