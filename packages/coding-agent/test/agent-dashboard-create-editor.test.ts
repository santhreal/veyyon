import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import * as discovery from "@veyyon/coding-agent/task/discovery";
import { removeWithRetries } from "@veyyon/utils";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const tempDirs: string[] = [];

const settingsStub = {
	get: (_key: string) => undefined,
	set: (_key: string, _value: unknown) => {},
	getModelRole: (_role: string) => undefined,
} as unknown as Settings;

async function makeTempCwd(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-agent-dashboard-"));
	tempDirs.push(dir);
	return dir;
}

function typeText(dashboard: AgentDashboard, text: string): void {
	for (const char of text) {
		dashboard.handleInput(char);
	}
}

/**
 * Pin the terminal geometry the dashboard reads via `process.stdout.rows/columns`
 * so the height-fit assertions don't depend on whether the suite runs under a TTY.
 */
function stubStdoutGeometry(cols: number): { setRows(n: number): void; restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = 24;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		setRows(n: number) {
			rows = n;
		},
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("AgentDashboard create editor", () => {
	test("keeps carriage return as multiline editor text", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\r");
		typeText(dashboard, "second line");
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("> first line");
		expect(rendered).toContain("  second line");
		expect(rendered).toContain("Ctrl+Q/Ctrl+Enter: generate");
		expect(rendered).toContain("Enter: newline");
		expect(rendered).not.toContain("Description is required.");
	});

	test("submits multiline new-agent descriptions on CSI-u Ctrl+Enter", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\r");
		typeText(dashboard, "second line");
		dashboard.handleInput("\x1b[13;5u");
		await Bun.sleep(0);
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("Model registry unavailable in current session.");
		expect(rendered).not.toContain("Description is required.");
	});

	test("keeps bare LF as multiline editor text on non-Windows terminals", async () => {
		if (process.platform === "win32") return;
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\n");
		typeText(dashboard, "second line");
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("> first line");
		expect(rendered).toContain("  second line");
		expect(rendered).toContain("Ctrl+Q/Ctrl+Enter: generate");
		expect(rendered).toContain("Enter: newline");
		expect(rendered).not.toContain("Model registry unavailable in current session.");
		expect(rendered).not.toContain("Description is required.");
	});

	test("submits new-agent descriptions on Ctrl+Q (Windows Terminal fallback for #2118)", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\r");
		typeText(dashboard, "second line");
		// Ctrl+Q raw byte (0x11). Windows Terminal can't deliver a distinct
		// Ctrl+Enter event, so the app.message.followUp keybinding doubles as a
		// portable submit chord and must apply to the create form too.
		dashboard.handleInput("\x11");
		await Bun.sleep(0);
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("Model registry unavailable in current session.");
		expect(rendered).not.toContain("Description is required.");
	});

	test("Ctrl+Q still works after pressing Enter for a newline (Windows Terminal)", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "line one");
		// Windows Terminal sends bare `\r` for both Enter and Ctrl+Enter; the
		// dashboard must treat `\r` as a newline so the user can keep typing.
		dashboard.handleInput("\r");
		typeText(dashboard, "line two");
		const beforeSubmit = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");
		expect(beforeSubmit).toContain("> line one");
		expect(beforeSubmit).toContain("  line two");
		expect(beforeSubmit).not.toContain("Model registry unavailable in current session.");

		dashboard.handleInput("\x11");
		await Bun.sleep(0);
		const afterSubmit = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(afterSubmit).toContain("Model registry unavailable in current session.");
	});
});

describe("AgentDashboard layout", () => {
	test("fills the terminal height exactly and keeps the footer visible", async () => {
		await initTheme(false);
		const geo = stubStdoutGeometry(100);
		try {
			geo.setRows(30);
			const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 30, {});
			const lines = dashboard.render(100);
			const plain = lines.map(line => line.replace(ANSI_PATTERN, "")).join("\n");

			// Full-screen overlay must occupy exactly the viewport — never overflow
			// past it (which is what pushed the controls into scrollback).
			expect(lines.length).toBe(30);
			expect(plain).toContain("Agent Control Center");
			expect(plain).toContain("esc close");
		} finally {
			geo.restore();
		}
	});

	test("re-fits the body when the terminal height shrinks", async () => {
		await initTheme(false);
		const geo = stubStdoutGeometry(100);
		try {
			geo.setRows(30);
			const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 30, {});
			expect(dashboard.render(100).length).toBe(30);

			geo.setRows(18);
			const shrunk = dashboard.render(100);
			expect(shrunk.length).toBe(18);
			// Footer survives the shrink instead of being clipped off the bottom.
			expect(shrunk.map(line => line.replace(ANSI_PATTERN, "")).join("\n")).toContain("esc close");
		} finally {
			geo.restore();
		}
	});
});

/**
 * The Room view opens on the newest turn.
 *
 * WHY (found by the render proof, 2026-07-25). The Room handed the whole
 * conversation to `ScrollView` together with `totalRows`, which is the mode where
 * the CALLER windows and the component only draws the bar. So the frame showed
 * the OPENING of the conversation under a scrollbar parked at the bottom: the bar
 * said "you are at the end" over the first screen of text. A reader would have
 * had to scroll down to reach the present, in a view whose entire purpose is
 * showing what just happened. Nothing in a type check or a shape assertion can
 * see that, so the tail is asserted by content here.
 */
describe("AgentDashboard room view", () => {
	async function seedRoom(turnCount: number): Promise<{ dashboard: AgentDashboard; frame: () => string }> {
		await initTheme(false);
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ projectAgentsDir: null, agents: [] });
		const dir = await makeTempCwd();
		const file = path.join(dir, "main.jsonl");
		let at = Date.parse("2026-07-25T09:00:00.000Z");
		const lines: string[] = [];
		for (let turn = 0; turn < turnCount; turn++) {
			at += 1_000;
			lines.push(
				JSON.stringify({
					type: "message",
					id: `m${turn}`,
					parentId: null,
					timestamp: new Date(at).toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: `turn number ${turn}` }] },
				}),
			);
		}
		await fs.writeFile(file, `${lines.join("\n")}\n`);

		AgentRegistry.resetGlobalForTests();
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "Main Session",
			kind: "main",
			session: null,
			sessionFile: file,
		});

		const dashboard = await AgentDashboard.create(dir, settingsStub, 30, {});
		return { dashboard, frame: () => dashboard.render(120).join("\n").replace(ANSI_PATTERN, "") };
	}

	test("opens on the newest turns, not the oldest", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(30);
			const { dashboard, frame } = await seedRoom(30);
			// Live -> Room. The card opened on Live because the main session is running.
			dashboard.handleInput("\x1b[C");
			await Bun.sleep(20);
			const shown = frame();

			expect(shown).toContain("turn number 29");
			expect(shown).not.toContain("turn number 0\n");
			dashboard.dispose();
		} finally {
			AgentRegistry.resetGlobalForTests();
			geo.restore();
		}
	});

	/**
	 * And the driving session is labelled, because a conversation you cannot
	 * attribute is not a conversation. `Main` is the label the Live roster uses for
	 * the same agent, so the two views name the same participant the same way.
	 */
	/**
	 * Ages are seconds, and the unit is stated once.
	 *
	 * WHY (found by the render proof, 2026-07-25). `formatAge` takes SECONDS and
	 * appends " ago" itself; the roster handed it MILLISECONDS. A four-second-old
	 * agent rendered as "1h ago" and a two-minute-old one as "1d ago", and the lens
	 * appended a second " ago" on top, so it read "51m ago ago". Every number on
	 * the surface was wrong by a factor of a thousand while the code typechecked
	 * and every existing test passed, because nothing asserted the text.
	 */
	test("renders ages in real units, once", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			// Taller than the sibling cases on purpose: the lens is a full-height pane,
			// and at 30 rows the card's body budget clips it before the age lines.
			geo.setRows(50);
			await initTheme(false);
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ projectAgentsDir: null, agents: [] });
			AgentRegistry.resetGlobalForTests();
			const registry = AgentRegistry.global();
			registry.register({ id: MAIN_AGENT_ID, displayName: "Main Session", kind: "main", session: null });
			const ref = registry.get(MAIN_AGENT_ID);
			if (!ref) throw new Error("registration did not take");
			const now = Date.now();
			ref.createdAt = now - 9 * 60_000;
			ref.lastActivity = now - 3 * 60_000;

			const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 50, {});
			const roster = dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");
			expect(roster).toContain("3m ago");
			expect(roster).not.toContain("ago ago");

			// And the lens agrees, from the same helper.
			dashboard.handleInput("\r");
			const lens = dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");
			expect(lens).toContain("Started: 9m ago");
			expect(lens).toContain("last activity 3m ago");
			expect(lens).not.toContain("ago ago");
			// The driving session's id IS its call sign, so the header does not say it twice.
			expect(lens).not.toContain("Main (Main)");
			dashboard.dispose();
		} finally {
			AgentRegistry.resetGlobalForTests();
			geo.restore();
		}
	});

	test("labels the driving session Main", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(30);
			const { dashboard, frame } = await seedRoom(3);
			dashboard.handleInput("\x1b[C");
			await Bun.sleep(20);
			expect(frame()).toContain("Main says");
			dashboard.dispose();
		} finally {
			AgentRegistry.resetGlobalForTests();
			geo.restore();
		}
	});
});

/**
 * The inspector after the model plumbing was collapsed (AGENTCC-DETAIL-PANE-IS-MODEL-PLUMBING).
 *
 * The pane was nine lines and seven were model-resolution stages: `Default
 * pattern`, `Default resolves`, `Override`, `Effective pattern`, `Effective`,
 * `Decided by`, `Path`. On a stock install those stages are pairwise identical,
 * so the reader spent five lines learning one fact -- while the description,
 * the only line that says what the agent is FOR, sat last, below all of it,
 * where someone deciding whether to enable the agent never reached it.
 *
 * Both halves are pinned: the default pane leads with purpose and states the
 * model once, and the breakdown is still reachable rather than deleted, because
 * it is the only way to tell an override that took effect from one that was
 * outranked.
 */
describe("AgentDashboard inspector", () => {
	async function inspectorFrame(): Promise<{ dashboard: AgentDashboard; frame: () => string }> {
		await initTheme(false);
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			projectAgentsDir: null,
			agents: [
				{
					name: "scout",
					description: "Use this agent when you need a fast read-only survey of an unfamiliar codebase.",
					systemPrompt: "",
					source: "bundled",
				},
			],
		});
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 50, {});
		return { dashboard, frame: () => dashboard.render(120).join("\n").replace(ANSI_PATTERN, "") };
	}

	/** Purpose first, model once, resolution stages absent until asked for. */
	test("leads with what the agent is for and states the model once", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(50);
			const { frame } = await inspectorFrame();
			const shown = frame();

			// Matched in wrap-safe pieces: the pane wraps the description to the
			// inspector column, so asserting the whole sentence would fail on layout
			// rather than on the behaviour under test.
			expect(shown).toContain("Use this agent when you need a fast read-only");
			expect(shown).toContain("unfamiliar codebase.");
			expect(shown).toContain("Runs on:");
			expect(shown).not.toContain("Default pattern:");
			expect(shown).not.toContain("Effective pattern:");
			expect(shown).not.toContain("Default resolves:");
		} finally {
			geo.restore();
		}
	});

	/**
	 * The configuration list says when it will delegate nothing
	 * (SUBAGENT-DELEGATION-IGNORES-THE-AGENT-TABLE). Two settings decide whether
	 * any work leaves the main session, and someone toggling rows here cannot see
	 * the other one. The single agent in this fixture is a bundled specialist, so
	 * it ships disabled and the table is inert -- which the card has to say rather
	 * than imply it is about to run something.
	 */
	test("warns when the whole table will delegate nothing", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(50);
			const { frame } = await inspectorFrame();
			expect(frame()).toContain("No agent is enabled");
		} finally {
			geo.restore();
		}
	});

	/** `m` opens the breakdown and `m` closes it. A one-way reveal would be a trap. */
	test("m reveals the model resolution stages and hides them again", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(50);
			const { dashboard, frame } = await inspectorFrame();

			dashboard.handleInput("m");
			const open = frame();
			expect(open).toContain("Default pattern:");
			expect(open).toContain("Effective pattern:");
			expect(open).toContain("Override:");

			dashboard.handleInput("m");
			expect(frame()).not.toContain("Default pattern:");
		} finally {
			geo.restore();
		}
	});

	/**
	 * `m` acts instead of typing, the same way `n` does. Without this the key would
	 * be swallowed by the search box and the footer chip would advertise a control
	 * that does nothing.
	 */
	test("does not type m into the search box", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(50);
			const { dashboard, frame } = await inspectorFrame();
			dashboard.handleInput("m");
			expect(frame()).not.toContain("Search: m");
		} finally {
			geo.restore();
		}
	});
});

/**
 * The view strip that replaced the source tabs (AGENTCC-BUNDLED-TAB-SERVES-ZERO-PURPOSE).
 *
 * The card used to open on All / Project / User / Bundled, which filtered the
 * configuration list by where an agent's markdown file lives. That answered a
 * question nobody opens the card to ask, and on a normal install every tab
 * showed almost the same rows. The strip now switches between three genuinely
 * different views, and the configuration list always holds EVERY agent -- which
 * is the part a screenshot cannot prove and the part most likely to be undone by
 * someone reintroducing a filter, so it is asserted directly.
 */
describe("AgentDashboard view navigation", () => {
	async function dashboardWithAgents() {
		await initTheme(false);
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			projectAgentsDir: null,
			agents: [
				{ name: "proj-agent", description: "p", systemPrompt: "", source: "project" },
				{ name: "bundled-agent", description: "b", systemPrompt: "", source: "bundled" },
			],
		});
		return AgentDashboard.create(await makeTempCwd(), settingsStub, 30, {});
	}

	/**
	 * The strip names the three views and no source ever again. `Bundled` is
	 * asserted absent by name because that is the exact word the removed tab used,
	 * and it is the one most likely to come back as "just a small filter".
	 */
	test("shows Live, Room and Agents instead of source tabs", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(30);
			const dashboard = await dashboardWithAgents();
			const frame = dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");

			expect(frame).toContain("Live (0)");
			expect(frame).toContain("Room (0)");
			expect(frame).toContain("Agents (2)");
			expect(frame).not.toContain("Bundled (");
			expect(frame).not.toContain("Project (");
			expect(frame).not.toContain("All (");
		} finally {
			geo.restore();
		}
	});

	/**
	 * With nothing running there is no live picture to show, so the card opens
	 * where the work is: the configuration list, holding BOTH agents at once. The
	 * old first frame showed the same two rows behind an "All" tab that existed
	 * only so three other tabs could hide one of them.
	 */
	test("opens on the configuration list with every agent in it when nothing is running", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(30);
			const dashboard = await dashboardWithAgents();
			const frame = dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");

			expect(frame).toContain("proj-agent");
			expect(frame).toContain("bundled-agent");
		} finally {
			geo.restore();
		}
	});

	/**
	 * Left/right cycle the three views, wrapping. The configuration list is the
	 * only one holding agents here, so seeing `proj-agent` come back after a full
	 * lap is what proves the cycle is closed rather than one-way.
	 */
	test("left and right cycle the three views and wrap around", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(30);
			const dashboard = await dashboardWithAgents();
			const strip = () => dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");

			// Agents -> Live (wraps past the end of the strip).
			dashboard.handleInput("\x1b[C");
			expect(strip()).toContain("Nothing running.");
			expect(strip()).not.toContain("proj-agent");

			// Live -> Room.
			dashboard.handleInput("\x1b[C");
			expect(strip()).toContain("Nothing said yet.");

			// Room -> Agents, back where it started.
			dashboard.handleInput("\x1b[C");
			expect(strip()).toContain("proj-agent");

			// And left walks the same ring backwards.
			dashboard.handleInput("\x1b[D");
			expect(strip()).toContain("Nothing said yet.");
		} finally {
			geo.restore();
		}
	});

	/**
	 * `space` toggles an agent's enabled flag in the configuration list, so it must
	 * not reach the list while the reader is looking at Live or Room. A keypress
	 * that silently changes a setting in a view that does not show that setting is
	 * the worst kind of hidden state.
	 */
	test("does not let list keys act while Live or Room is showing", async () => {
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(30);
			const dashboard = await dashboardWithAgents();
			const setCalls: unknown[] = [];
			const original = settingsStub.set;
			settingsStub.set = ((...args: unknown[]) => {
				setCalls.push(args);
				return original?.apply(settingsStub, args as never);
			}) as typeof settingsStub.set;
			try {
				dashboard.handleInput("\x1b[C"); // -> Live
				dashboard.handleInput(" ");
				dashboard.handleInput("\x1b[C"); // -> Room
				dashboard.handleInput(" ");
				expect(setCalls).toEqual([]);

				// The same key in the configuration list does write.
				dashboard.handleInput("\x1b[C"); // -> Agents
				dashboard.handleInput(" ");
				expect(setCalls.length).toBe(1);
			} finally {
				settingsStub.set = original;
			}
		} finally {
			geo.restore();
		}
	});
});
