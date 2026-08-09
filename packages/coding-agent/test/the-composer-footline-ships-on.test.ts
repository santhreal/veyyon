/**
 * The composer footline ships ON, and turning it off keeps the one line on it that is not a
 * preference.
 *
 * WHY THIS SUITE EXISTS. The footline shipped OFF for one release, on the argument that everything
 * it carries is either already known (which model, which mode, which directory) or available on
 * demand (`/context` owns the gauge's own breakdown). The first operator to launch a build with the
 * new default read the missing row as the binary having broken: it is the only standing answer to
 * which directory this window is pointed at, which branch, which model and mode are live, and how
 * much context is left, and none of those stay "just chosen" an hour into a session. So the default
 * is ON, and an operator who wants a composer that carries nothing turns the row off in
 * `/settings`.
 *
 * THE RISK A DEFAULT CARRIES RUNS BOTH WAYS, which is why this suite asserts both states of every
 * claim rather than the shipped one:
 *
 *  1. THE DEFAULT ITSELF. A row that ships on has to render on a session that set nothing, which is
 *     exactly the configuration no test exercises when every suite enables it first.
 *  2. THE FOCUS BADGE. While the view is proxied onto an agent, Esc means "go back" rather than
 *     "clear the line", and the badge is the only persistent thing that says so. That defect has
 *     already shipped once: the announcement lived in a preset-gated segment, so on four of six
 *     presets a focused view was indistinguishable from your own (see
 *     `modes/components/the-proxied-view-says-how-to-leave-it.test.ts`). Turning the footline off
 *     must not be able to reintroduce it, so off means "no segments", not "no row".
 *  3. THE CLICK MAP. `quietSegmentAt` answers from the layout the last render recorded, and the
 *     composer routes clicks on that row through it. A row that renders a badge and no segments
 *     must record no segments, or a click lands on wherever `mode` was several renders ago.
 *  4. THE DEPENDENT SETTINGS. A preset is a layout for a row that is not on screen, and the
 *     thinking-level spelling is a detail of a chip that is not rendered. Both hide while the
 *     footline is off. `statusLine.sessionAccent` does NOT hide: it colors the editor border and
 *     the working-message accent, which have nothing to do with this row.
 *
 * The composer path is the harness on purpose. The gate lives at the one caller that decides
 * whether the row exists (`#composerFootline` in `modes/interactive-mode.ts`), not inside the
 * status-line component, so a test that drove the component directly would prove nothing about
 * what the operator's composer does.
 *
 * WHAT THIS DOES NOT CATCH, honestly. It drives the composer that exists. A SECOND composer
 * surface that mounted its own footline without consulting the setting would be a new mount path,
 * and nothing here would see it; today `capabilityLine` is the only one (`mountComposerZone` takes
 * exactly one footline component). It also cannot see a preset that resolves to no visible segments
 * at all: the row would be on, empty, and every assertion here would still pass — the width and
 * content assertions pin what a rendered row looks like, not that a preset selects anything.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";
import { stubStdoutGeometry } from "./helpers/stdout-geometry";

const WIDTH = 100;
const AGENT = "designer-3";

describe("the composer footline ships on", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let geometry: { restore(): void } | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-footline-ships-on-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", () => {}, [], undefined, new EventBus());
		// A real fs.watch on the repo HEAD from a parallel Bun worker is enough to trip a SIGTRAP
		// in unrelated workers; this contract is the footline gate, not branch watching.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		geometry?.restore();
		geometry = undefined;
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** The composer's footline ROWS, as the zone mounts them: an absent row is zero rows, not a blank one. */
	function rows(): string[] {
		return mode.capabilityLine.render(WIDTH).map(line => stripVTControlCharacters(line));
	}

	/** Everything on screen, so "the row is gone" can be checked against the frame and not only the component. */
	function frame(): string {
		return mode.ui
			.render(WIDTH)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
	}

	async function hideFootline(): Promise<void> {
		await Settings.instance.set("statusLine.enabled", false);
	}

	/**
	 * THE DEFAULT, asserted on a session that set nothing. This is the configuration every other
	 * footline suite skips past by enabling the row in its own `beforeEach`, and it is the one an
	 * operator's first launch actually runs: the row shipped off once, and the missing state read as
	 * a broken build rather than as a quiet composer.
	 */
	it("renders the row, with its segments, out of the box", () => {
		expect(Settings.instance.get("statusLine.enabled")).toBe(true);

		const [row, ...rest] = rows();

		expect(rest).toEqual([]);
		expect(row).toContain("Sonnet");
	});

	/**
	 * NON-VACUITY for every "the row is gone" assertion below, and the opt-out itself. Zero rows
	 * rather than one empty row: an empty row still costs the composer a line of vertical space and
	 * still pushes the input up, which is most of what an operator turning it off is asking for.
	 */
	it("renders no row at all once the operator turns it off", async () => {
		await hideFootline();

		expect(rows()).toEqual([]);
	});

	/**
	 * The gate reads the setting per render rather than capturing it when the composer is built, so
	 * toggling the row in `/settings` lands on the next frame. A gate resolved at construction
	 * would need a restart to take effect, which for a display preference reads as a broken toggle.
	 */
	it("appears and disappears on the next frame, with no re-mount", async () => {
		expect(rows().length).toBe(1);

		await hideFootline();
		expect(rows()).toEqual([]);

		await Settings.instance.set("statusLine.enabled", true);
		expect(rows().length).toBe(1);
	});

	/**
	 * The frame is what the operator sees, and the row's content must leave it rather than merely
	 * unmounting. The marker is the rendered row itself: a hand-picked substring (a model name, the
	 * separator) also appears in the welcome splash above the composer, so it would pass on a frame
	 * that still carried the whole footline.
	 */
	it("keeps the footline's segments out of the frame while it is off", async () => {
		const on = frame();
		const row = (rows()[0] ?? "").trim();

		await hideFootline();
		const off = frame();

		expect(row.length).toBeGreaterThan(0);
		expect(on).toContain(row);
		expect(off).not.toContain(row);
	});

	/**
	 * REGRESSION GUARD, the expensive half of the opt-out. Esc changes meaning while the view is
	 * proxied onto an agent, and the badge is the only persistent thing that says so. Turning the
	 * footline off must not be able to hide it.
	 */
	it("still says whose session you are in, and how to leave, while the footline is off", async () => {
		await hideFootline();
		mode.statusLine.setSession(session, AGENT);

		const [row, ...rest] = rows();

		expect(rest).toEqual([]);
		expect(row).toContain(AGENT);
		expect(row).toContain("esc to go back");
	});

	/** Off means "no segments", not "the whole footline whenever an agent is focused". */
	it("carries the badge alone, with none of the footline's segments", async () => {
		await hideFootline();
		mode.statusLine.setSession(session, AGENT);

		const row = rows()[0] ?? "";

		expect(row).toContain(AGENT);
		expect(row).not.toContain("Sonnet");
	});

	/**
	 * THE OTHER MEMBER of the same union: with the footline on, the badge shares the row with the
	 * segments rather than replacing them. Without this, a gate that routed every focused render
	 * through the badge-only path would look correct above and would silently delete the footline
	 * for anyone who opened an agent.
	 *
	 * Asserted at 200 columns on purpose. At 100 the badge plus the right-hand group fills the
	 * budget and the left group is shed entirely, which is the width shed working correctly; a
	 * narrow assertion here would read that as the badge having replaced the segments and would
	 * pin one particular shed order as the contract.
	 */
	it("shares the row between the badge and the segments while the footline is on", () => {
		mode.statusLine.setSession(session, AGENT);

		const row = stripVTControlCharacters(mode.capabilityLine.render(200)[0] ?? "");

		expect(row).toContain(AGENT);
		expect(row).toContain("esc to go back");
		expect(row).toContain("Sonnet");
	});

	/** Nothing proxied: the row says what the session is, and nothing about going back. */
	it("says nothing about going back when nothing is proxied", async () => {
		expect(rows().length).toBe(1);
		expect(frame()).not.toContain("esc to go back");

		await hideFootline();

		expect(rows()).toEqual([]);
		expect(frame()).not.toContain("esc to go back");
	});

	/**
	 * The badge-only row records NO clickable segments. The composer routes clicks on this row
	 * through `quietSegmentAt`, which answers from the last recorded layout, so a stale map would
	 * open the goal detail view or the context breakdown from a row that shows neither.
	 */
	it("leaves no clickable segments behind on the badge-only row", async () => {
		rows();
		expect(mode.statusLine.getQuietSegmentBounds().length).toBeGreaterThan(0);

		await hideFootline();
		mode.statusLine.setSession(session, AGENT);
		rows();

		expect(mode.statusLine.getQuietSegmentBounds()).toEqual([]);
		for (let col = 0; col < WIDTH; col++) {
			expect(mode.statusLine.quietSegmentAt(col)).toBeNull();
		}
	});

	/**
	 * A row wider than the terminal wraps and pushes the composer up on every render, so both states
	 * are pinned: the segments the default renders, and the badge that survives the opt-out. Ten
	 * columns is narrower than either can fit in, which is the width that catches a renderer that
	 * pads to its content instead of to the space it was given.
	 */
	it("fits the width it is given, in both states, even where the content cannot fit", async () => {
		mode.statusLine.setSession(session, AGENT);

		for (const enabled of [true, false]) {
			await Settings.instance.set("statusLine.enabled", enabled);
			for (const width of [10, 30, WIDTH]) {
				const rendered = mode.capabilityLine.render(width).map(line => stripVTControlCharacters(line));

				for (const line of rendered) {
					const fits = line.length <= width;
					expect(`on=${enabled} w=${width} fits=${fits} ${JSON.stringify(line)}`).toBe(
						`on=${enabled} w=${width} fits=true ${JSON.stringify(line)}`,
					);
				}
			}
		}
	});
});

/**
 * The settings screen's half of the same decision: a knob for a row that is not on screen is a
 * knob with nothing behind it.
 */
describe("the Status Line rows that only matter while the footline renders", () => {
	let geometry: { restore(): void } | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
	});

	afterEach(() => {
		geometry?.restore();
		geometry = undefined;
		resetSettingsForTest();
	});

	function appearancePanel(): string {
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["titanium"],
				availablePersonalities: ["default"],
				providers: [],
				cwd: process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		component.openTab("appearance");
		return component.render(WIDTH).map(stripVTControlCharacters).join("\n");
	}

	/** The toggle itself is always reachable, in both states, or the row could not be turned back on. */
	it("offers the footline toggle whichever way it is set", async () => {
		expect(appearancePanel()).toContain("Composer Footline");

		await Settings.instance.set("statusLine.enabled", false);

		expect(appearancePanel()).toContain("Composer Footline");
	});

	it("offers the preset by default, and hides it once the footline is off", async () => {
		expect(appearancePanel()).toContain("Status Line Preset");

		await Settings.instance.set("statusLine.enabled", false);

		expect(appearancePanel()).not.toContain("Status Line Preset");
	});

	/**
	 * `statusLine.compactThinkingLevel` is an advanced row, which the panel folds away unless its
	 * value differs from the default — a changed value always surfaces. Setting it is therefore
	 * what makes the condition observable: with the footline off it must go back to hidden even
	 * though it is changed, because the chip it re-spells is not being rendered.
	 */
	it("hides the changed thinking-level spelling once the footline is off", async () => {
		await Settings.instance.set("statusLine.compactThinkingLevel", true);

		expect(appearancePanel()).toContain("Compact Thinking Level");

		await Settings.instance.set("statusLine.enabled", false);

		expect(appearancePanel()).not.toContain("Compact Thinking Level");
	});

	/**
	 * Session accent is NOT a footline knob: it colors the editor border and the working-message
	 * accent. Hiding it with the footline would take away a control that still does something,
	 * which is the mirror image of the defect this condition fixes.
	 */
	it("keeps the session accent row, which is not part of the footline", async () => {
		await Settings.instance.set("statusLine.sessionAccent", false);
		await Settings.instance.set("statusLine.enabled", false);

		expect(appearancePanel()).toContain("Session Accent");
	});

	/**
	 * CLASS CLOSURE, read from the schema at run time. Every `statusLine.*` row that reaches the
	 * settings screen either hides with the footline or is on the list below with a reason, so a
	 * new footline knob added without a decision turns this red instead of shipping as a control
	 * for a row nobody can see.
	 */
	it("requires a decision from every statusLine row that reaches the settings screen", () => {
		// Reasons these three answer for something other than the footline row:
		//  - `statusLine.enabled` is the master toggle; hiding it would strand the row off.
		//  - `sessionAccent` colors the editor border and the working-message accent.
		//  - `showHookStatus` gates the component's own hook-status rows, mounted above the
		//    hairline, which render whether or not the footline does.
		const independent = new Set(["statusLine.enabled", "statusLine.sessionAccent", "statusLine.showHookStatus"]);
		const rowsWithUi = Object.entries(SETTINGS_SCHEMA)
			.filter(([key, def]) => key.startsWith("statusLine.") && "ui" in def && def.ui !== undefined)
			.map(([key, def]) => [key, (def as { ui: { condition?: string } }).ui.condition] as const);

		expect(rowsWithUi.length).toBeGreaterThanOrEqual(4);
		for (const [key, condition] of rowsWithUi) {
			const expected = independent.has(key) ? undefined : "statusLineEnabled";
			expect(`${key}: ${condition}`).toBe(`${key}: ${expected}`);
		}
	});
});
