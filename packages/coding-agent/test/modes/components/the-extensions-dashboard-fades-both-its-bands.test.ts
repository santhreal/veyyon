// WHY THIS SUITE EXISTS (A-DASHBOARD-BAND-STROBES-WHILE-THE-PICKERS-FADE).
//
// The extensions dashboard has two pointer surfaces in one frame — the provider tab bar along the
// top and the inventory list under it — and both switched their band on the frame a motion report
// arrived while every picker beside them cross-faded. The list is not a card: it holds no repaint of
// its own and takes no mouse reports, because the dashboard hit-tests for it and calls
// `setHoverIndex`. So the list is lent motion (`setHoverMotion`) and the dashboard is what lends it,
// which makes the dashboard the only place that can hand the shared clock back when it closes.
//
// The class this closes: a pointer surface inside a composite card, where the card owns the frames
// and the surface owns the band. The pane table in
// `a-pointer-band-fades-on-a-hand-painted-list.test.ts` is the fence for cards that take their own
// mouse reports; this is its counterpart for a surface that does not, and the two together are
// where a new fading surface belongs.
//
// It drives the real `ExtensionList` and the real `ExtensionDashboard` against the real shared
// clock. The dashboard's inventory is discovered from the filesystem, so the row-level assertions
// use the list directly (fixture rows, deterministic) and the dashboard is driven for the wiring:
// motion registers a fade, and dismissal gives it back.
//
// WHAT IT DOES NOT CATCH: how the fade LOOKS while it travels, the inspector pane (it paints no
// band), and a dashboard closed by a route that does not reach `onClose`.
//
// Colour is forced ON and the theme is built in truecolor: `theme.bg` returns its argument unchanged
// when colour is off, so under the default piped policy every band here would be byte-identical to a
// bare row and no assertion could tell them apart.

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ExtensionDashboard } from "@veyyon/coding-agent/modes/components/extensions/extension-dashboard";
import { ExtensionList } from "@veyyon/coding-agent/modes/components/extensions/extension-list";
import type { ExtensionRow } from "@veyyon/coding-agent/modes/components/extensions/types";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, initTheme, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { type AnsiPolicy, getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 110;
const FRAME = 1000 / 60;
/** MOTION.hover is 90ms; 30 frames is half a second, so a settle loop that runs out is a hang. */
const SETTLE_FRAMES = 30;

/** The list's own repaint gate is `TERMINAL.trueColor`, probed once at load from a real terminal. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;
let originalTrueColor: boolean;
let originalColorterm: string | undefined;
let clockNow = 0;
let clockAnchored = false;

/**
 * Advance the shared clock by `ms`. The list takes the production clock, so the frames are driven
 * through its public `tick` rather than by waiting. The anchor is re-taken every time the ticker
 * restarts: a clock that runs dry re-bases on the wall clock, and a harness that kept counting from
 * its own first anchor would land a 90ms fade in one step.
 */
function advance(ms: number): void {
	if (!clockAnchored) {
		clockNow = performance.now();
		clockAnchored = true;
	}
	clockNow += ms;
	motionClock.tick(clockNow);
	if (motionClock.liveCount === 0) clockAnchored = false;
}

/** Run frames until nothing is animating. Returns the frames it took. */
function settle(): number {
	for (let frame = 1; frame <= SETTLE_FRAMES; frame++) {
		advance(FRAME);
		if (motionClock.liveCount === 0) return frame;
	}
	throw new Error(`hover fade still live after ${SETTLE_FRAMES} frames`);
}

function skill(name: string): ExtensionRow {
	return {
		id: `skill:${name}`,
		kind: "skill",
		name,
		displayName: name,
		path: `/tmp/skill-${name}`,
		source: { provider: "native", providerName: "Native", level: "native" },
		state: "active",
		raw: {},
	};
}

/**
 * A focused list of three skills, rendered once so its hit rows exist. Lines 0 and 1 are the search
 * banner and its blank; line 2 is the kind header; the skills follow.
 */
function makeList(lend: boolean): ExtensionList {
	const list = new ExtensionList([skill("alpha"), skill("beta"), skill("gamma")], { masterSwitchProvider: null });
	list.setFocused(true);
	if (lend) list.setHoverMotion({ requestRender: () => {}, enabled: true });
	list.render(WIDTH);
	return list;
}

/** The painted bytes of the row for `line`, which is what the assertions are about. */
function rowAt(list: ExtensionList, line: number): string {
	const rendered = list.render(WIDTH)[line];
	if (rendered === undefined) throw new Error(`no line ${line} in a ${WIDTH}-column frame`);
	return rendered;
}

/** The same row with the pointer parked on it and no motion lent: the switched band. */
function switchedBandRow(line: number): string {
	const twin = makeList(false);
	twin.setHoverIndex(twin.hitTest(line));
	return rowAt(twin, line);
}

/** Rendered lines with escapes stripped, for locating chrome by its text. */
function plain(component: { render(width: number): readonly string[] }): string[] {
	return component.render(WIDTH).map(line => stripVTControlCharacters(line));
}

/**
 * Frames until `text` is painted. A card opened through its show site unfolds on the shared clock:
 * its first frames are a collapsed shell, so chrome is waited for rather than assumed. Bounded, so
 * a card that never opens is a failure here rather than a hang.
 */
function unfold(component: { render(width: number): readonly string[] }, text: string): string[] {
	for (let frame = 0; frame <= SETTLE_FRAMES; frame++) {
		const lines = plain(component);
		if (lines.some(line => line.includes(text))) return lines;
		advance(FRAME);
	}
	throw new Error(`no row reading ${text} after ${SETTLE_FRAMES} frames`);
}

beforeEach(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
	originalColorterm = Bun.env.COLORTERM;
	Bun.env.COLORTERM = "truecolor";
	const loaded = await getThemeByName("titanium");
	if (!loaded) throw new Error("titanium theme unavailable in test env");
	if (loaded.getColorMode() !== "truecolor") throw new Error(`titanium built as ${loaded.getColorMode()}`);
	setThemeInstance(loaded);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	originalTrueColor = terminalCaps.trueColor;
	terminalCaps.trueColor = true;
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
	clockAnchored = false;
});

afterEach(() => {
	motionClock.clear();
	setAnsiPolicy(policy);
	terminalCaps.trueColor = originalTrueColor;
	geometry.restore();
	if (originalColorterm === undefined) delete Bun.env.COLORTERM;
	else Bun.env.COLORTERM = originalColorterm;
});

/** Line of the first skill row, and of the second: the two the pointer travels between. */
const FIRST_ROW = 3;
const SECOND_ROW = 4;

describe("the extensions inventory list fades its band", () => {
	it("arrives over frames and lands on the band it always painted", () => {
		const list = makeList(true);
		const bare = rowAt(list, FIRST_ROW);
		expect(bare).not.toContain("48;2;");

		list.setHoverIndex(list.hitTest(FIRST_ROW));
		// Strength 0 is the ABSENCE of a band, so the frame the report lands on is the bare row
		// byte for byte. A list that switches the band on fails here.
		expect(rowAt(list, FIRST_ROW)).toBe(bare);

		advance(FRAME * 2);
		const travelling = rowAt(list, FIRST_ROW);
		expect(travelling).not.toBe(bare);
		expect(travelling).not.toBe(switchedBandRow(FIRST_ROW));

		settle();
		expect(rowAt(list, FIRST_ROW)).toBe(switchedBandRow(FIRST_ROW));
	});

	it("bands the row it left and the row it arrived at in the same frame", () => {
		const list = makeList(true);
		list.setHoverIndex(list.hitTest(FIRST_ROW));
		settle();

		list.setHoverIndex(list.hitTest(SECOND_ROW));
		advance(FRAME * 2);
		// The whole reason strength is per row: the row being left is still on its way out while
		// the row being arrived at is on its way in.
		expect(rowAt(list, FIRST_ROW)).toContain("48;2;");
		expect(rowAt(list, SECOND_ROW)).toContain("48;2;");
		expect(rowAt(list, FIRST_ROW)).not.toBe(rowAt(list, SECOND_ROW));

		settle();
		expect(rowAt(list, FIRST_ROW)).not.toContain("48;2;");
		expect(rowAt(list, SECOND_ROW)).toBe(switchedBandRow(SECOND_ROW));
	});

	it("never bands the selected row from the pointer", () => {
		const list = makeList(true);
		// Clicking a row selects it; the selection owns its own styling, and a pointer band on top
		// of it reads as two selections.
		list.handleClick(FIRST_ROW);
		const selected = rowAt(list, FIRST_ROW);
		list.setHoverIndex(list.hitTest(FIRST_ROW));
		settle();
		expect(rowAt(list, FIRST_ROW)).toBe(selected);
	});

	it("switches the band when no motion was lent to it", () => {
		// Every direct construction — the dashboard's own tests included — depends on this, and the
		// switched band is asserted to be the endpoint of the fade rather than a hardcoded escape:
		// adopting the fade cannot change what a settled row looks like.
		const unwired = makeList(false);
		unwired.setHoverIndex(unwired.hitTest(FIRST_ROW));
		const switched = rowAt(unwired, FIRST_ROW);
		expect(switched).toContain("48;2;");
		expect(motionClock.liveCount, "an unwired list registers nothing").toBe(0);

		const wired = makeList(true);
		wired.setHoverIndex(wired.hitTest(FIRST_ROW));
		settle();
		expect(rowAt(wired, FIRST_ROW)).toBe(switched);
	});

	it("forgets the pointer and the clock when the motion is taken back", () => {
		const list = makeList(true);
		list.setHoverIndex(list.hitTest(FIRST_ROW));
		expect(motionClock.liveCount).toBeGreaterThan(0);

		list.disposeHoverMotion();
		advance(FRAME);
		expect(motionClock.liveCount).toBe(0);
		expect(rowAt(list, FIRST_ROW)).not.toContain("48;2;");
	});
});

describe("the extensions dashboard hands both its bands the clock and takes it back", () => {
	it("registers a fade when the pointer moves over a provider tab, and drops it on close", async () => {
		const dashboard = await ExtensionDashboard.create(process.cwd(), null, 40, false);
		let renders = 0;
		dashboard.setOnRequestRender(() => {
			renders += 1;
		});
		const lines = plain(dashboard);
		const tabLine = lines.findIndex(line => line.includes("ALL ("));
		expect(tabLine, "the provider tab bar is painted").toBeGreaterThanOrEqual(0);
		const tabCol = lines[tabLine]!.indexOf("ALL (") + 1;

		dashboard.handleInput(`\x1b[<35;${tabCol};${tabLine + 1}M`);
		expect(renders, "the dashboard asked for a repaint").toBeGreaterThan(0);
		expect(motionClock.liveCount, "the tab band is travelling").toBeGreaterThan(0);

		dashboard.dispose();
		advance(FRAME);
		expect(motionClock.liveCount, "the dismissed dashboard left nothing on the clock").toBe(0);
	});

	it("registers a fade when the pointer moves over an inventory row", async () => {
		const dashboard = await ExtensionDashboard.create(process.cwd(), null, 40, false);
		dashboard.setOnRequestRender(() => {});
		const lines = plain(dashboard);
		// The inventory rows are the ones the list paints with its bullet; the dashboard discovers
		// them from the filesystem, so the row is found rather than assumed. A frame with none is a
		// hole in this fence, not a pass.
		const rowLine = lines.findIndex(line => line.includes("▪ "));
		expect(rowLine, "the inventory list painted at least one row").toBeGreaterThanOrEqual(0);
		const rowCol = lines[rowLine]!.indexOf("▪ ") + 1;

		dashboard.handleInput(`\x1b[<35;${rowCol};${rowLine + 1}M`);
		expect(motionClock.liveCount, "the list band is travelling").toBeGreaterThan(0);

		dashboard.dispose();
		advance(FRAME);
		expect(motionClock.liveCount).toBe(0);
	});

	// The two cases above call `dispose()` themselves, which proves the dashboard can let go but
	// not that anything ever tells it to. This one goes through the real show site and the real
	// close path — Escape on the card — because that is the wiring that was missing.
	it("hands the clock back when the show site's card is dismissed", async () => {
		const hide = vi.fn();
		const opened = Promise.withResolvers<ExtensionDashboard>();
		const ctx = {
			settings: null,
			ui: {
				showOverlay: (component: ExtensionDashboard) => {
					opened.resolve(component);
					return { hide };
				},
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				terminal: { columns: WIDTH, rows: 40 },
			},
			// Closing the card re-targets focus at the composer, which the controller reaches
			// through the context rather than through the stub above.
			editorContainer: { children: [] },
			editor: {},
			focusActiveEditorArea: vi.fn(),
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
		await controller.showExtensionsDashboard();
		const dashboard = await opened.promise;

		// This card opens with the unfold the direct constructions above switch off, so the tab bar
		// arrives a few frames in.
		const lines = unfold(dashboard, "ALL (");
		const tabLine = lines.findIndex(line => line.includes("ALL ("));
		dashboard.handleInput(`\x1b[<35;${lines[tabLine]!.indexOf("ALL (") + 1};${tabLine + 1}M`);
		expect(motionClock.liveCount, "a band is travelling").toBeGreaterThan(0);

		dashboard.handleInput("\x1b");
		expect(hide).toHaveBeenCalledTimes(1);
		advance(FRAME);
		expect(motionClock.liveCount, "the dismissed dashboard left nothing on the clock").toBe(0);
	});
});
