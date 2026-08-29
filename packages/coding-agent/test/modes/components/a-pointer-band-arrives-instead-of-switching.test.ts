// WHY THIS SUITE EXISTS (A-POINTER-SURFACE-THAT-LENDS-NO-REPAINT-CAN-NEVER-FADE).
//
// `HoverFade` is a primitive that needs a repaint lent to it: the frames between two mouse reports
// carry no input, so a host that never hands it `requestRender` gets a band that switches on the
// frame the report lands and unswitches on the frame the pointer leaves. That failure is invisible
// to the primitive's own suite — `HoverFade` passes while three shipped surfaces strobe — and it is
// invisible to a component test that renders one frame, because one frame of a switched band and
// one frame of a settled fade are the same bytes.
//
// Three surfaces were in that state: the subagent dashboard's roster, which answered a pointer only
// on a terminable row and only by swapping in its `[x]`; the ask dialog's question tabs; and the
// setup wizard's provider tabs.
//
// What it locks, per surface:
//
//   1. The frame the report lands on paints no band at all. Strength 0 is the ABSENCE of a band,
//      not a band mixed out to the ground — an explicit fill on every row is invisible on black and
//      a slab on grey.
//   2. A band exists mid-fade, and its colour is NOT the settled colour. This is the assertion that
//      separates a fade from a switch: a switched band is at its endpoint on frame one.
//   3. It reaches the endpoint the surface always painted, compared against the band the same
//      surface paints with motion off rather than against a hardcoded escape. If the endpoint
//      moved, the change was a theme change wearing an animation's clothes.
//   4. It TERMINATES: the shared clock goes quiet, so a card left open is not a repaint loop.
//   5. A disposed surface stops asking the clock for frames.
//
// The surface table is driven, not described: each row constructs the real component, drives a real
// SGR motion report through its real input path, and reads bytes back out of its real render. A row
// that cannot be constructed fails rather than being skipped, and the sweep asserts the table is
// not empty.
//
// Colour is forced ON and the theme is built in truecolor. `theme.bg` returns its argument
// unchanged when colour is off, so under the default piped policy every band here would be
// byte-identical to a bare row. The ground is reset for the same reason the sibling pointer-fade
// suite resets it: a detected ground changes what a band mixes out of, and one arm of each
// comparison below runs with `TERMINAL.trueColor` off, which is also the gate on ground-derived
// chrome.
//
// WHAT IT DOES NOT CATCH: a surface added to the product and not to the table. There is no runtime
// registry of pointer surfaces to sweep — a host is wired by calling `setHoverMotion` or by
// constructing a `HoverFade`, and neither leaves a discoverable trace — so a fourth strobing
// surface is caught by nobody. The setup wizard's provider tabs were wired in the same change and
// are NOT driven here: the scene constructs its panels against the whole interactive context, and
// its bar takes the identical `TabBar.setHoverMotion` path the ask-dialog arm below proves. The
// suite also says nothing about the fade's duration or easing, which are `MOTION.hover`'s and the
// theme's.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { AskDialogComponent } from "@veyyon/coding-agent/modes/components/ask-dialog";
import { resetGroundTintsForTest } from "@veyyon/coding-agent/modes/theme/ground-tints";
import { getThemeByName, initTheme, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type AnsiPolicy, getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 120;
const FRAME = 1000 / 60;
/** MOTION.hover is 90ms; 30 frames is half a second, so a settle loop that runs out is a hang. */
const SETTLE_FRAMES = 30;

/** The one writable capability these surfaces gate their motion on; `TERMINAL` declares it readonly. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;
let originalTrueColor: boolean;
let originalColorterm: string | undefined;
let clockNow = 0;
let clockAnchored = false;

/**
 * Advance the shared clock. Each surface takes the production clock — its host lends it a repaint,
 * not a clock — so frames are driven through `tick` rather than by waiting. The anchor is re-taken
 * whenever the ticker runs dry, or the next fade is handed every millisecond already spent.
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

function settle(): number {
	for (let frame = 1; frame <= SETTLE_FRAMES; frame++) {
		advance(FRAME);
		if (motionClock.liveCount === 0) return frame;
	}
	throw new Error(`a pointer fade was still live after ${SETTLE_FRAMES} frames`);
}

/**
 * The truecolor background in force at a 0-based visible column, or null when that cell paints
 * none.
 *
 * Not the first `48;2` on the line: a tab strip draws several tabs on ONE row, and the active tab
 * carries a fill of its own, so a line-wide search reports the active tab's paint for every column
 * of the row and can never see the band arrive beside it.
 */
function bandRgbAt(row: string, column: number): [number, number, number] | null {
	const sgr = /\x1b\[([0-9;]*)m/g;
	let background: [number, number, number] | null = null;
	let visible = 0;
	let cursor = 0;
	for (let match = sgr.exec(row); match !== null; match = sgr.exec(row)) {
		visible += stripVTControlCharacters(row.slice(cursor, match.index)).length;
		if (visible > column) return background;
		const codes = (match[1] ?? "").split(";");
		for (let index = 0; index < codes.length; index++) {
			const code = codes[index];
			if (code === "0" || code === "49" || code === "") background = null;
			else if (code === "48" && codes[index + 1] === "2") {
				background = [Number(codes[index + 2]), Number(codes[index + 3]), Number(codes[index + 4])];
				index += 4;
			}
		}
		cursor = match.index + match[0].length;
	}
	return visible + stripVTControlCharacters(row.slice(cursor)).length > column ? background : null;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** Truecolor background OPENINGS on a row. A band painted over a band opens one more. */
function fillCount(row: string): number {
	return row.split("48;2;").length - 1;
}

/** SGR motion report (button 32+3=35) at a 0-based screen cell; the reports are 1-based. */
function motionAt(row: number, col: number): string {
	return `\x1b[<35;${col + 1};${row + 1}M`;
}

/**
 * One pointer surface, reachable the way a user reaches it.
 *
 * `build` returns the component plus the row and column a pointer must land on to band a row, and
 * the text that identifies that row in the rendered frame. `render` is a thunk rather than a
 * captured array because every frame of a fade is a fresh render.
 */
interface Surface {
	name: string;
	/** Construct the component, lend it `requestRender`, and report where to point. */
	build: (requestRender: () => void) => {
		render: () => readonly string[];
		handleInput: (data: string) => void;
		dispose: () => void;
		/** Screen row the pointer must reach, resolved against the component's own render. */
		target: () => { row: number; col: number };
		/**
		 * A cell already carrying this band at full strength: the selected roster row, the active
		 * tab. Pointing at one must change nothing, or the surface paints a second fill inside the
		 * first and the row's escapes nest.
		 */
		alreadyBanded: () => { row: number; col: number };
	};
}

function registerSub(id: string, type: string): void {
	AgentRegistry.global().register({
		id,
		displayName: type,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status: "running",
	});
}

/** The 0-based screen row of the rendered line containing `needle`. */
function rowContaining(lines: readonly string[], needle: string): number {
	const index = lines.findIndex(line => stripVTControlCharacters(line).includes(needle));
	if (index < 0) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
	return index;
}

const SURFACES: readonly Surface[] = [
	{
		name: "the subagent dashboard's roster",
		build: requestRender => {
			registerSub("0-Sub", "reviewer");
			registerSub("1-Sub", "scout");
			const dashboard = new AgentDashboard({ terminalHeight: 40 });
			dashboard.onRequestRender = requestRender;
			const render = () => dashboard.render(WIDTH);
			return {
				render,
				handleInput: data => dashboard.handleInput(data),
				dispose: () => dashboard.dispose(),
				// The SECOND roster row: the first is the selected one, and a selected row is
				// already this band at full strength, so it answers the pointer by not changing.
				target: () => ({ row: rowContaining(render(), "scout"), col: 20 }),
				alreadyBanded: () => ({ row: rowContaining(render(), "reviewer"), col: 20 }),
			};
		},
	},
	{
		name: "the ask dialog's question tabs",
		build: requestRender => {
			// `header` is the tab's label; the question text never reaches the strip.
			const dialog = new AskDialogComponent(
				[
					{
						id: "one",
						header: "Alpha",
						question: "First question?",
						options: [{ label: "yes" }, { label: "no" }],
					},
					{
						id: "two",
						header: "Bravo",
						question: "Second question?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
				{
					onSubmit: () => {},
					onCancel: () => {},
					onPrompt: async () => undefined,
				},
			);
			dialog.setOnRequestRender(requestRender);
			const render = () => dialog.render(WIDTH);
			return {
				render,
				handleInput: data => dialog.handleInput(data),
				dispose: () => dialog.dispose(),
				// The SECOND tab: the first is active, and an active tab is never a pointer target.
				target: () => {
					const lines = render();
					const row = rowContaining(lines, "Bravo");
					const text = stripVTControlCharacters(lines[row] ?? "");
					return { row, col: text.indexOf("Bravo") + 1 };
				},
				alreadyBanded: () => {
					const lines = render();
					const row = rowContaining(lines, "Alpha");
					const text = stripVTControlCharacters(lines[row] ?? "");
					return { row, col: text.indexOf("Alpha") + 1 };
				},
			};
		},
	},
];

beforeEach(async () => {
	resetSettingsForTest();
	resetGroundTintsForTest();
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
	AgentRegistry.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
	clockAnchored = false;
});

afterEach(() => {
	motionClock.clear();
	setAnsiPolicy(policy);
	terminalCaps.trueColor = originalTrueColor;
	AgentRegistry.resetGlobalForTests();
	geometry.restore();
	resetGroundTintsForTest();
	if (originalColorterm === undefined) delete Bun.env.COLORTERM;
	else Bun.env.COLORTERM = originalColorterm;
});

describe("a pointer band arrives instead of switching", () => {
	it("sweeps every surface the product lends a repaint to", () => {
		expect(SURFACES.length, "an empty table sweeps nothing").toBeGreaterThan(0);
	});

	for (const surface of SURFACES) {
		describe(surface.name, () => {
			it("paints no band on the frame the report lands, and one mid-fade that is not the endpoint", () => {
				let renders = 0;
				const host = surface.build(() => {
					renders += 1;
				});
				const cell = host.target();
				const bare = host.render()[cell.row] ?? "";
				expect(bandRgbAt(bare, cell.col), "a cell nobody points at carries no fill").toBeNull();

				host.handleInput(motionAt(cell.row, cell.col));
				// The fade starts at 0, so the frame the report lands on is untouched.
				expect(bandRgbAt(host.render()[cell.row] ?? "", cell.col), "the arrival frame is still bare").toBeNull();

				advance(15);
				const midway = bandRgbAt(host.render()[cell.row] ?? "", cell.col);
				expect(midway, "a band exists mid-fade").not.toBeNull();
				expect(renders, "the fade asked its host for the frames it needs").toBeGreaterThan(0);

				settle();
				const settled = bandRgbAt(host.render()[cell.row] ?? "", cell.col);
				expect(settled, "the settled band paints a truecolor background").not.toBeNull();
				expect(
					distance(midway as [number, number, number], settled as [number, number, number]),
					"a switched band is already at its endpoint on frame one",
				).toBeGreaterThan(0);
				host.dispose();
			});

			it("lands on the band the surface paints with motion off", () => {
				const host = surface.build(() => {});
				const cell = host.target();
				host.handleInput(motionAt(cell.row, cell.col));
				settle();
				const faded = host.render()[cell.row] ?? "";
				host.dispose();

				// The same surface with motion off: `pointerMotionEnabled()` is
				// `TERMINAL.trueColor && transitionsEnabled()`, and the endpoint must be the
				// bytes that arm always painted.
				terminalCaps.trueColor = false;
				const twin = surface.build(() => {});
				const twinCell = twin.target();
				twin.handleInput(motionAt(twinCell.row, twinCell.col));
				const switched = twin.render()[twinCell.row] ?? "";
				twin.dispose();
				terminalCaps.trueColor = true;

				// Both directions. Equality alone passes when NEITHER arm bands — a surface whose
				// band was removed outright would report a clean match against nothing.
				expect(
					bandRgbAt(switched, twinCell.col),
					"the motion-off arm paints a band at the pointed-at cell",
				).not.toBeNull();
				expect(faded).toBe(switched);
			});

			it("terminates, and a disposed surface stops asking for frames", () => {
				const host = surface.build(() => {});
				const cell = host.target();
				host.handleInput(motionAt(cell.row, cell.col));
				expect(motionClock.liveCount, "the fade registered with the shared clock").toBeGreaterThan(0);
				expect(settle(), "the fade ends well inside half a second").toBeLessThanOrEqual(SETTLE_FRAMES);

				host.handleInput(motionAt(cell.row, cell.col + 1));
				host.dispose();
				expect(motionClock.liveCount, "a disposed surface leaves nothing running").toBe(0);
			});

			it("adds no second band to a cell already at full strength", () => {
				const host = surface.build(() => {});
				const cell = host.alreadyBanded();
				const before = host.render()[cell.row] ?? "";
				const banded = bandRgbAt(before, cell.col);
				expect(banded, "the cell this arm points at is supposed to arrive already banded").not.toBeNull();

				host.handleInput(motionAt(cell.row, cell.col));
				// The ROW may still change: a terminable roster row swaps in its `[x]`, which is a
				// glyph and not a fill. What must not change is the paint, and how many fills the
				// row opens — a band painted over a band nests its escapes and leaves the second
				// one to close a background the first still owns.
				const after = host.render()[cell.row] ?? "";
				expect(bandRgbAt(after, cell.col), "the paint under the pointer moved").toEqual(banded);
				expect(fillCount(after), "a second fill inside the first").toBe(fillCount(before));
				if (motionClock.liveCount > 0) settle();
				const settled = host.render()[cell.row] ?? "";
				expect(bandRgbAt(settled, cell.col)).toEqual(banded);
				expect(fillCount(settled)).toBe(fillCount(before));
				host.dispose();
			});
		});
	}
});
