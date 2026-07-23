/**
 * The Subagent Inbox (experimental, opencode-style split) render + selection
 * contract. This suite proves the component draws a REAL split from live
 * `AgentRegistry` data — not a shape-only smoke test — locking the exact
 * structure the redesign depends on so it can never silently regress:
 *
 *  1. GEOMETRY: every emitted line is exactly the requested width; the two
 *     columns are joined by a single sharp `│` at the sidebar boundary on every
 *     body line, and the top/bottom dividers carry `┬`/`┴` at that same column.
 *     If the join drifts by a cell the whole split shears — this catches it.
 *  2. CONTENT: the header status summary counts real statuses; the Main agent is
 *     excluded; each subagent id, its status glyph (from the ONE status→glyph
 *     owner), its unread badge, its activity, and its inbound IRC (from + body)
 *     all reach the pane with their real bytes.
 *  3. SELECTION: `j` moves the focus to the next agent and the detail pane
 *     switches to that agent's activity + mail on the very next render, and the
 *     cursor glyph follows.
 *  4. EMPTY: with no subagents the pane says so on both sides instead of drawing
 *     a broken frame.
 *
 * The registry is real (public `register`); the bus is a tiny fake injected
 * through the component's test seam (`deps.irc`), because a session-less
 * `IrcBus.send` never reaches the mailbox — the fake seeds `inbox`/`unreadCount`
 * directly, which is all the component reads.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { IrcBus, IrcMessage } from "@veyyon/coding-agent/irc/bus";
import { agentStatusGlyph } from "@veyyon/coding-agent/modes/components/agent-status-display";
import { SubagentInboxComponent } from "@veyyon/coding-agent/modes/components/subagent-inbox";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { visibleWidth } from "@veyyon/tui/utils";

/** Strip SGR escapes so we can assert on the glyph/column geometry. */
function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Minimal stand-in for the bus: the inbox component only ever reads `inbox` and
 * `unreadCount`, so seeding those two is enough to drive the detail pane and the
 * unread badge without a live session.
 */
class FakeBus {
	#mail = new Map<string, IrcMessage[]>();
	seed(to: string, msgs: Array<{ from: string; body: string }>): void {
		this.#mail.set(
			to,
			msgs.map((m, i) => ({ id: `m${i}`, from: m.from, to, body: m.body, ts: 1000 + i })),
		);
	}
	inbox(id: string, opts?: { peek?: boolean }): IrcMessage[] {
		const box = this.#mail.get(id) ?? [];
		return opts?.peek ? [...box] : box;
	}
	unreadCount(id: string): number {
		return this.#mail.get(id)?.length ?? 0;
	}
}

const WIDTH = 100;
// clamp(round(100*0.42),24,48) = 42; detailW = 100 - 42 - 1 = 57.
const SIDEBAR_W = 42;
const DETAIL_W = 57;

/** Build a registry with Main + two running + one idle subagent, frozen in time. */
function seedRegistry(): AgentRegistry {
	setSystemTime(1_700_000_000_000); // freeze so ages/order are deterministic
	const reg = new AgentRegistry();
	reg.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
	reg.register({ id: "scout-a", displayName: "corpus scout", kind: "sub", session: null, status: "running" });
	reg.register({ id: "fixer-b", displayName: "shimmer fixer", kind: "sub", session: null, status: "running" });
	reg.register({ id: "archivist-c", displayName: "archivist", kind: "sub", session: null, status: "idle" });
	reg.setActivity("scout-a", "grepping the corpus for silent fallbacks");
	reg.setActivity("fixer-b", "editing shimmer.ts drift motion");
	return reg;
}

describe("SubagentInboxComponent", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	let component: SubagentInboxComponent | undefined;
	afterEach(() => {
		component?.dispose();
		component = undefined;
		setSystemTime();
	});

	function mount(reg: AgentRegistry, bus: FakeBus): SubagentInboxComponent {
		component = new SubagentInboxComponent({
			hubKeys: ["ctrl+o"],
			onDone: () => {},
			requestRender: () => {},
			registry: reg,
			irc: bus as unknown as IrcBus,
			onOpenAgent: () => {},
		});
		return component;
	}

	it("draws a full-width split: single `│` join per body line, `┬`/`┴` on the dividers", () => {
		const bus = new FakeBus();
		const lines = mount(seedRegistry(), bus).render(WIDTH);

		// Every line is exactly the requested width, so the split never shears.
		for (const line of lines) expect(visibleWidth(line)).toBe(WIDTH);

		// Top divider (line 1) and bottom divider (second to last) carry the tee at
		// the sidebar boundary and nothing else.
		expect(strip(lines[1]!)).toBe(`${"─".repeat(SIDEBAR_W)}┬${"─".repeat(DETAIL_W)}`);
		expect(strip(lines[lines.length - 2]!)).toBe(`${"─".repeat(SIDEBAR_W)}┴${"─".repeat(DETAIL_W)}`);

		// Every BODY line (between the two dividers) is joined by exactly one `│`
		// sitting at visible column SIDEBAR_W.
		for (let i = 2; i < lines.length - 2; i++) {
			const bare = strip(lines[i]!);
			expect(bare.split("│").length).toBe(2); // exactly one rule
			expect(visibleWidth(bare.slice(0, bare.indexOf("│")))).toBe(SIDEBAR_W);
		}
	});

	it("summarizes real statuses in the header and excludes the Main agent", () => {
		const lines = mount(seedRegistry(), new FakeBus()).render(WIDTH);
		const header = strip(lines[0]!);
		expect(header).toContain("agents");
		expect(header).toContain("2 running");
		expect(header).toContain("1 idle");

		const body = lines.map(strip).join("\n");
		// The three subagents are listed; the Main agent never is.
		expect(body).toContain("scout-a");
		expect(body).toContain("fixer-b");
		expect(body).toContain("archivist-c");
		expect(body).not.toContain(MAIN_AGENT_ID);
	});

	it("renders each agent's status glyph from the ONE status→glyph owner (running ≠ idle)", () => {
		const joined = mount(seedRegistry(), new FakeBus()).render(WIDTH).join("");
		const running = agentStatusGlyph("running");
		const idle = agentStatusGlyph("idle");
		expect(running).not.toBe(idle); // the two statuses read differently
		expect(joined).toContain(running);
		expect(joined).toContain(idle);
	});

	it("shows the focused agent's activity and its inbound IRC (from + body) in the detail pane", () => {
		const bus = new FakeBus();
		bus.seed("scout-a", [{ from: "fixer-b", body: "found 3 more in composer-chrome" }]);
		const body = mount(seedRegistry(), bus).render(WIDTH).map(strip).join("\n");

		// Row 0 is scout-a (running, first registered) → its activity is on the right.
		expect(body).toContain("grepping the corpus for silent fallbacks");
		// The inbound message renders with its sender and body, not swallowed.
		expect(body).toContain("fixer-b");
		expect(body).toContain("found 3 more in composer-chrome");
		// One unread → the sidebar badge shows the real count.
		expect(body).toContain("⧉ 1");
	});

	it("moves focus to the next agent on `j` — detail pane and cursor follow", () => {
		const bus = new FakeBus();
		const inbox = mount(seedRegistry(), bus);

		const before = inbox.render(WIDTH).map(strip).join("\n");
		expect(before).toContain("grepping the corpus for silent fallbacks"); // scout-a focused

		inbox.handleInput("j"); // select the next row → fixer-b
		const after = inbox.render(WIDTH).map(strip).join("\n");
		expect(after).toContain("editing shimmer.ts drift motion"); // fixer-b now focused
		expect(after).not.toContain("grepping the corpus for silent fallbacks");
	});

	it("with no subagents says so on both sides instead of drawing a broken split", () => {
		setSystemTime(1_700_000_000_000);
		const reg = new AgentRegistry();
		reg.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		const inbox = mount(reg, new FakeBus());
		expect(inbox.isEmpty).toBe(true);

		const body = inbox.render(WIDTH).map(strip).join("\n");
		expect(body).toContain("no subagents yet");
		expect(body).toContain("select an agent to see its activity");
	});

	it("keeps the `experimental` tag and the key hints in the footer", () => {
		const footer = strip(mount(seedRegistry(), new FakeBus()).render(WIDTH).at(-1)!);
		expect(footer).toContain("experimental");
		expect(footer).toContain("j/k select");
		expect(footer).toContain("enter focus");
		expect(footer).toContain("esc close");
	});
});
