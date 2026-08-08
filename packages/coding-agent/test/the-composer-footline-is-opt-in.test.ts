/**
 * The composer footline ships OFF, and the one line on it that is not a preference stays.
 *
 * WHY THIS SUITE EXISTS. The footline is a permanent row of standing state under a composer whose
 * whole design is quiet, and almost everything it carries is either already known (which model,
 * which mode, which directory) or available on demand (`/context` owns the gauge's own breakdown).
 * It is now opt-in: `statusLine.enabled` defaults to false, and an operator who wants the row
 * turns it on in `/settings`.
 *
 * The risk a default flip like this carries is not "the row is missing" — that is the feature. It
 * is the things that were riding on the row and are not preferences:
 *
 *  1. THE FOCUS BADGE. While the view is proxied onto an agent, Esc means "go back" rather than
 *     "clear the line", and the badge is the only persistent thing that says so. That defect has
 *     already shipped once, from the other direction: the announcement lived in a preset-gated
 *     segment, so on four of six presets a focused view was indistinguishable from your own
 *     (see `modes/components/the-proxied-view-says-how-to-leave-it.test.ts`). A footline
 *     preference must not be able to reintroduce it, so off means "no segments", not "no row".
 *  2. THE CLICK MAP. `quietSegmentAt` answers from the layout the last render recorded, and the
 *     composer routes clicks on that row through it. A row that renders a badge and no segments
 *     must record no segments, or a click lands on wherever `mode` was several renders ago.
 *  3. THE DEPENDENT SETTINGS. A preset is a layout for a row that is not on screen, and the
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
 * exactly one footline component). Moving the gate INSIDE the status-line component would leave
 * every test here green, which is correct: these assert the contract, not where it is enforced.
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

describe("the composer footline is opt-in", () => {
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
		tempDir = TempDir.createSync("@pi-footline-opt-in-");
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

	async function enableFootline(): Promise<void> {
		await Settings.instance.set("statusLine.enabled", true);
	}

	/**
	 * THE DEFAULT. Zero rows rather than one empty row: an empty row still costs the composer a
	 * line of vertical space and still pushes the input up, which is most of what the operator was
	 * turning off.
	 */
	it("renders no footline row at all until it is asked for", () => {
		expect(Settings.instance.get("statusLine.enabled")).toBe(false);
		expect(rows()).toEqual([]);
	});

	/**
	 * NON-VACUITY for every "the row is gone" assertion here. If the row never rendered under any
	 * setting, the tests above would pass on a permanently dead component.
	 */
	it("renders the row, with its segments, once the setting is on", async () => {
		await enableFootline();

		const [row, ...rest] = rows();

		expect(rest).toEqual([]);
		expect(row).toBeDefined();
		expect(row).toContain("Sonnet");
	});

	/**
	 * The gate reads the setting per render rather than capturing it when the composer is built, so
	 * toggling the row in `/settings` lands on the next frame. A gate resolved at construction
	 * would need a restart to take effect, which for a display preference reads as a broken toggle.
	 */
	it("appears and disappears on the next frame, with no re-mount", async () => {
		expect(rows()).toEqual([]);

		await enableFootline();
		expect(rows().length).toBe(1);

		await Settings.instance.set("statusLine.enabled", false);
		expect(rows()).toEqual([]);
	});

	/**
	 * The frame is what the operator sees, and the row's content must be absent from it rather than
	 * merely unmounted. The marker is the rendered row itself: a hand-picked substring (a model
	 * name, the separator) also appears in the welcome splash above the composer, so it would pass
	 * on a frame that still carried the whole footline.
	 */
	it("keeps the footline's segments out of the frame while it is off", async () => {
		const off = frame();

		await enableFootline();
		const on = frame();
		const row = (rows()[0] ?? "").trim();

		expect(row.length).toBeGreaterThan(0);
		expect(on).toContain(row);
		expect(off).not.toContain(row);
	});

	/**
	 * REGRESSION GUARD, the expensive half of this change. Esc changes meaning while the view is
	 * proxied onto an agent, and the badge is the only persistent thing that says so. Turning the
	 * footline off must not be able to hide it.
	 */
	it("still says whose session you are in, and how to leave, while the footline is off", () => {
		mode.statusLine.setSession(session, AGENT);

		const [row, ...rest] = rows();

		expect(rest).toEqual([]);
		expect(row).toContain(AGENT);
		expect(row).toContain("esc to go back");
	});

	/** Off means "no segments", not "the whole footline whenever an agent is focused". */
	it("carries the badge alone, with none of the footline's segments", () => {
		mode.statusLine.setSession(session, AGENT);

		const row = rows()[0] ?? "";

		expect(row).toContain(AGENT);
		expect(row).not.toContain("Sonnet");
	});

	/**
	 * THE OTHER MEMBER of the same union: with the footline ON, the badge shares the row with the
	 * segments rather than replacing them. Without this, a gate that routed every focused render
	 * through the badge-only path would look correct here and would silently delete the footline
	 * for anyone who both turned it on and opened an agent.
	 */
	it("shares the row between the badge and the segments while the footline is on", async () => {
		await enableFootline();
		mode.statusLine.setSession(session, AGENT);

		const row = rows()[0] ?? "";

		expect(row).toContain(AGENT);
		expect(row).toContain("esc to go back");
		expect(row).toContain("Sonnet");
	});

	/** Unproxied and off is the resting state: no badge, no row. */
	it("says nothing about going back when nothing is proxied", () => {
		expect(rows()).toEqual([]);
		expect(frame()).not.toContain("esc to go back");
	});

	/**
	 * The badge-only row records NO clickable segments. The composer routes clicks on this row
	 * through `quietSegmentAt`, which answers from the last recorded layout, so a stale map would
	 * open the goal detail view or the context breakdown from a row that shows neither.
	 */
	it("leaves no clickable segments behind on the badge-only row", async () => {
		await enableFootline();
		rows();
		expect(mode.statusLine.getQuietSegmentBounds().length).toBeGreaterThan(0);

		await Settings.instance.set("statusLine.enabled", false);
		mode.statusLine.setSession(session, AGENT);
		rows();

		expect(mode.statusLine.getQuietSegmentBounds()).toEqual([]);
		for (let col = 0; col < WIDTH; col++) {
			expect(mode.statusLine.quietSegmentAt(col)).toBeNull();
		}
	});

	/** A badge wider than the terminal would wrap and push the composer up a row on every render. */
	it("fits the width it is given, even at a width the badge cannot fit in", () => {
		mode.statusLine.setSession(session, AGENT);

		for (const width of [10, 30, WIDTH]) {
			const rendered = mode.capabilityLine.render(width).map(line => stripVTControlCharacters(line));

			for (const line of rendered) {
				expect(`${width}: ${line.length <= width}`).toBe(`${width}: true`);
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

	/** The toggle itself is always reachable, or the feature could not be turned on at all. */
	it("offers the footline toggle while the footline is off", () => {
		expect(appearancePanel()).toContain("Composer Footline");
	});

	it("hides the preset while the footline is off, and offers it once it is on", async () => {
		expect(appearancePanel()).not.toContain("Status Line Preset");

		await Settings.instance.set("statusLine.enabled", true);

		expect(appearancePanel()).toContain("Status Line Preset");
	});

	/**
	 * `statusLine.compactThinkingLevel` is an advanced row, which the panel folds away unless its
	 * value differs from the default — a changed value always surfaces. Setting it is therefore
	 * what makes the condition observable: with the footline off it must stay hidden even though
	 * it is changed, because the chip it re-spells is not being rendered.
	 */
	it("hides the changed thinking-level spelling while the footline is off", async () => {
		await Settings.instance.set("statusLine.compactThinkingLevel", true);

		expect(appearancePanel()).not.toContain("Compact Thinking Level");

		await Settings.instance.set("statusLine.enabled", true);

		expect(appearancePanel()).toContain("Compact Thinking Level");
	});

	/**
	 * Session accent is NOT a footline knob: it colors the editor border and the working-message
	 * accent. Hiding it with the footline would take away a control that still does something,
	 * which is the mirror image of the defect this condition fixes.
	 */
	it("keeps the session accent row, which is not part of the footline", async () => {
		await Settings.instance.set("statusLine.sessionAccent", false);

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
		//  - `statusLine.enabled` is the master toggle; hiding it would strand the feature off.
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
