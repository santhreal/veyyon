// WHY THIS SUITE EXISTS (A-MODEL-CARD-BAND-STROBES-WHILE-THE-PICKERS-FADE).
//
// `ModelBrowser` is the searchable model list, and it is not a card: it holds no repaint of its
// own, paints inside whatever card embeds it (`/model`'s picker, the model hub's body pane, every
// settings model submenu) and switched its hover band on the frame a motion report arrived. The
// two cards that embed it own two MORE hand-painted pointer surfaces between them — the hub's
// scope sidebar and its roles pane — and the account manager owns a third, its provider sidebar.
// Four surfaces, three cards, one shared clock, and every one of them strobed while the pickers
// beside them cross-faded.
//
// The class this closes: a pointer surface that owns a band but not a repaint. It must be LENT
// motion by the card that owns the frames (`setHoverMotion`), which makes that card the only place
// that can hand the clock back, and makes the card's show site the only place that can tell it to.
// The pane table in `a-pointer-band-fades-on-a-hand-painted-list.test.ts` fences cards that take
// their own mouse reports; `the-extensions-dashboard-fades-both-its-bands.test.ts` fences the same
// lending relationship for the extensions dashboard. This is the third: the model cards.
//
// The endpoint is asserted against `hoverBandAt(…, 1)` rather than against an unwired twin,
// because these cards build their fade in the CONSTRUCTOR (their hosts lend the clock there, not
// through a setter) and so an unwired twin of the hub does not exist. The band colour does not
// depend on the row, so a one-character sample of full strength is the same fill the settled row
// must carry. The account manager IS constructible without a repaint, so it carries the switched
// control for all three.
//
// WHAT IT DOES NOT CATCH: how the fade LOOKS while it travels; a fourth surface added inside one
// of these cards (it would inherit nothing and sit outside this file); and the settings model
// submenus, whose panel teardown rides on `MouseRoutedSubmenu.clear()` and is fenced by the
// settings card's own suite.
//
// Colour is forced ON and the theme is built in truecolor: `theme.bg` returns its argument
// unchanged when colour is off, so under the default piped policy every band here would be
// byte-identical to a bare row and no assertion could tell them apart.

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/components/account-manager";
import { ModelHubComponent } from "@veyyon/coding-agent/modes/components/model-hub";
import { ModelPickerComponent } from "@veyyon/coding-agent/modes/components/model-picker";
import { hoverBandAt } from "@veyyon/coding-agent/modes/components/selector-helpers";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, initTheme, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AccountInventory } from "@veyyon/coding-agent/session/account-inventory";
import { type AnsiPolicy, getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL, type TUI } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 110;
const ROWS = 40;
const FRAME = 1000 / 60;
/** MOTION.hover is 90ms; 30 frames is half a second, so a settle loop that runs out is a hang. */
const SETTLE_FRAMES = 30;

/** The cards' own repaint gate is `TERMINAL.trueColor`, probed once at load from a real terminal. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;
let originalTrueColor: boolean;
let originalColorterm: string | undefined;
let clockNow = 0;
let clockAnchored = false;

/**
 * Advance the shared clock by `ms`. The cards take the production clock (their hosts hand them a
 * repaint, not a clock), so frames are driven through its public `tick` rather than by waiting.
 * The anchor is re-taken whenever the ticker restarts: a clock that runs dry re-bases on the wall
 * clock, and a harness counting from its own first anchor would land a 90ms fade in one step.
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

/** `48;2;r;g;b` from a rendered row, or null when the row paints no truecolor background. */
function bandRgb(row: string): [number, number, number] | null {
	const match = /\x1b\[[0-9;]*?48;2;(\d+);(\d+);(\d+)/.exec(row);
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * The fill a settled band carries. The band colour is a property of the theme, not of the row it
 * covers, so a one-character sample at full strength is the endpoint every surface here lands on.
 */
function fullBandRgb(): [number, number, number] {
	const rgb = bandRgb(hoverBandAt("x", 8, 1));
	if (rgb === null) throw new Error("full strength painted no truecolor fill");
	return rgb;
}

/** How far one colour is from another, summed over the channels. */
function distance(a: [number, number, number], b: [number, number, number]): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

interface Card {
	render(width: number): readonly string[];
	handleInput(data: string): void;
}

/** Rendered lines with escapes stripped, for locating a row by the text on it. */
function plain(card: Card): string[] {
	return card.render(WIDTH).map(line => stripVTControlCharacters(line));
}

/**
 * Run frames until `text` is on screen. A card opened through its show site unfolds on the shared
 * clock, so its body is empty for the first frames; the bound turns a card that never opens into a
 * failure rather than a hang.
 */
function unfold(card: Card, text: string): void {
	for (let frame = 0; frame < SETTLE_FRAMES; frame++) {
		if (plain(card).some(line => line.includes(text))) return;
		advance(FRAME);
	}
	throw new Error(`the card never painted ${JSON.stringify(text)} within ${SETTLE_FRAMES} frames`);
}

/** 1-based screen row and column of `text`, aimed at the middle of the word. */
function locate(card: Card, text: string): { row: number; col: number } {
	const lines = plain(card);
	const row = lines.findIndex(line => line.includes(text));
	expect(row, `a row containing ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
	const col = (lines[row] as string).indexOf(text) + 1;
	return { row: row + 1, col };
}

/** SGR motion report (button 32+3=35) at a 1-based screen position. */
function motionAt(position: { row: number; col: number }): string {
	return `\x1b[<35;${position.col};${position.row}M`;
}

/** The painted bytes of a 1-based screen row. */
function rowText(card: Card, row: number): string {
	const line = card.render(WIDTH)[row - 1];
	if (line === undefined) throw new Error(`no row ${row} in a ${WIDTH}-column frame`);
	return line;
}

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

const MODELS: readonly Model[] = [makeModel("alpha", "one"), makeModel("alpha", "two"), makeModel("beta", "three")];

function makeRegistry(): ModelRegistry {
	return {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => [...MODELS],
		getAll: () => [...MODELS],
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		authStorage: { hasAuth: () => false },
	} as unknown as ModelRegistry;
}

function makeTui(onRender: () => void = () => {}): TUI {
	return { requestRender: onRender, terminal: { rows: ROWS, columns: WIDTH } } as unknown as TUI;
}

function makeHub(onRender: () => void = () => {}): ModelHubComponent {
	return new ModelHubComponent(makeTui(onRender), Settings.isolated({}), makeRegistry(), [], {
		onAssign: () => {},
		onUnassign: () => {},
		onCancel: () => {},
	});
}

function makePicker(onRender: () => void = () => {}): ModelPickerComponent {
	return new ModelPickerComponent(makeTui(onRender), Settings.isolated({}), makeRegistry(), [], {
		onPick: () => {},
		onCancel: () => {},
	});
}

/** Three providers with no accounts: the sidebar rows are the pointer surface, not the bodies. */
function makeAccountManager(requestRender?: () => void): AccountManagerComponent {
	const inventory = {
		providers: [
			{ provider: "anthropic", label: "Anthropic", rows: [] },
			{ provider: "openai", label: "OpenAI", rows: [] },
			{ provider: "google", label: "Google", rows: [] },
		],
		totalAccounts: 0,
		unhealthyCount: 0,
	} as unknown as AccountInventory;
	return new AccountManagerComponent(
		inventory,
		{
			onUseAccount: () => {},
			onRename: () => {},
			onRefresh: () => {},
			onLogout: () => {},
			onShowUsage: () => {},
			onAddAccount: () => {},
			onToggleLoadBalancing: () => false,
			onClearRateLimitBlock: () => {},
			onCancel: () => {},
		},
		{ terminalHeight: ROWS, requestRender },
	);
}

beforeEach(async () => {
	await initTheme(false);
	// The mix is a truecolor computation and the theme's mode is fixed at construction from the
	// environment: a suite that trusts the CI terminal's capability asserts the 256-colour branch
	// instead, which is how a band test stays green while the band is broken.
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
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: ROWS });
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

describe("the model hub fades every band it owns", () => {
	it("arrives over frames on a scope sidebar row and settles on the full band", () => {
		let renders = 0;
		const hub = makeHub(() => {
			renders += 1;
		});
		const target = locate(hub, "▪ beta");
		const bare = rowText(hub, target.row);
		expect(bandRgb(bare), "a row nobody points at carries no fill").toBeNull();

		hub.handleInput(motionAt(target));
		expect(renders, "the hub asked for a repaint").toBeGreaterThan(0);
		// Strength 0 is the ABSENCE of a band, so the frame the report lands on is untouched.
		expect(rowText(hub, target.row)).toBe(bare);

		advance(15);
		const midway = bandRgb(rowText(hub, target.row));
		expect(midway, "a band mid-fade").not.toBeNull();
		expect(distance(midway as [number, number, number], fullBandRgb())).toBeGreaterThan(0);

		settle();
		expect(bandRgb(rowText(hub, target.row))).toEqual(fullBandRgb());
		hub.dispose();
	});

	it("keeps the sidebar row the pointer left banding while the new row arrives", () => {
		const hub = makeHub();
		const leaving = locate(hub, "▪ alpha");
		const arriving = locate(hub, "▪ beta");
		const bareLeaving = rowText(hub, leaving.row);

		hub.handleInput(motionAt(leaving));
		settle();
		hub.handleInput(motionAt(arriving));
		advance(15);

		const outgoing = bandRgb(rowText(hub, leaving.row));
		const incoming = bandRgb(rowText(hub, arriving.row));
		expect(outgoing, "the row the pointer left still bands").not.toBeNull();
		expect(incoming, "the row the pointer arrived at bands").not.toBeNull();
		// Both are mid-travel on the same frame, which is why strength is per ROW.
		expect(distance(outgoing as [number, number, number], fullBandRgb())).toBeGreaterThan(0);
		expect(distance(incoming as [number, number, number], fullBandRgb())).toBeGreaterThan(0);

		settle();
		expect(rowText(hub, leaving.row)).toBe(bareLeaving);
		expect(bandRgb(rowText(hub, arriving.row))).toEqual(fullBandRgb());
		hub.dispose();
	});

	it("fades the model list the body pane embeds", () => {
		const hub = makeHub();
		const target = locate(hub, "alpha/two");
		const bare = rowText(hub, target.row);

		hub.handleInput(motionAt(target));
		expect(rowText(hub, target.row), "the model row does not switch its band on").toBe(bare);
		expect(motionClock.liveCount, "the embedded list registered a fade").toBeGreaterThan(0);

		advance(15);
		expect(bandRgb(rowText(hub, target.row)), "the model row bands mid-fade").not.toBeNull();
		settle();
		expect(bandRgb(rowText(hub, target.row))).toEqual(fullBandRgb());
		hub.dispose();
	});

	it("fades the roles pane and hands every one of its bands back when disposed", () => {
		const hub = makeHub();
		const roles = locate(hub, "Roles");
		hub.handleInput(`\x1b[<0;${roles.col};${roles.row}M`);
		hub.handleInput(`\x1b[<0;${roles.col};${roles.row}m`);
		const rolesRow = locate(hub, "▫ VISION");
		const bare = rowText(hub, rolesRow.row);

		// The sidebar band is put in flight first and never allowed to land: the pointer leaves it
		// for the roles pane, so at the moment of dispose the card owns TWO travelling fades. A
		// dispose that settles only the surface the pointer is over passes otherwise.
		hub.handleInput(motionAt(locate(hub, "All models")));
		advance(15);
		hub.handleInput(motionAt(rolesRow));
		expect(rowText(hub, rolesRow.row), "the roles row does not switch its band on").toBe(bare);
		advance(15);
		expect(bandRgb(rowText(hub, rolesRow.row)), "the roles row bands mid-fade").not.toBeNull();
		expect(motionClock.liveCount).toBeGreaterThan(0);

		// One dispose settles all three surfaces: the card owns the frames all three run on.
		hub.dispose();
		advance(FRAME);
		expect(motionClock.liveCount, "a disposed hub leaves nothing on the clock").toBe(0);
		expect(rowText(hub, rolesRow.row)).toBe(bare);
	});

	it("settles and stops asking for frames", () => {
		let renders = 0;
		const hub = makeHub(() => {
			renders += 1;
		});
		const target = locate(hub, "▪ beta");
		hub.handleInput(motionAt(target));
		const frames = settle();
		expect(frames, "the band travelled over more than one frame").toBeGreaterThan(1);

		const settledRenders = renders;
		for (let frame = 0; frame < 5; frame++) advance(FRAME);
		expect(renders, "a settled band asks for no further frames").toBe(settledRenders);
		hub.dispose();
	});
});

describe("the session model picker fades the list it embeds", () => {
	it("arrives over frames and settles on the full band", () => {
		let renders = 0;
		const picker = makePicker(() => {
			renders += 1;
		});
		const target = locate(picker, "alpha/two");
		const bare = rowText(picker, target.row);
		expect(bandRgb(bare)).toBeNull();

		picker.handleInput(motionAt(target));
		expect(renders).toBeGreaterThan(0);
		expect(rowText(picker, target.row)).toBe(bare);

		advance(15);
		const midway = bandRgb(rowText(picker, target.row));
		expect(midway, "a band mid-fade").not.toBeNull();
		expect(distance(midway as [number, number, number], fullBandRgb())).toBeGreaterThan(0);

		settle();
		expect(bandRgb(rowText(picker, target.row))).toEqual(fullBandRgb());

		picker.dispose();
		advance(FRAME);
		expect(rowText(picker, target.row)).toBe(bare);
		expect(motionClock.liveCount).toBe(0);
	});

	// The case above disposes the card itself, which proves the picker can let go and not that
	// anything ever tells it to. This one goes through the real show site and the real close path.
	it("hands the clock back when the show site's card is dismissed", () => {
		const hide = vi.fn();
		let card: (Card & { dispose(): void }) | undefined;
		const ctx = {
			settings: Settings.isolated({}),
			session: {
				model: undefined,
				scopedModels: [],
				modelRegistry: makeRegistry(),
				getContextUsage: () => undefined,
			},
			ui: {
				showOverlay: (component: Card & { dispose(): void }) => {
					card = component;
					return { hide };
				},
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				terminal: { columns: WIDTH, rows: ROWS },
			},
			// `done()` re-targets focus at the visible editor slot on the way out.
			editorContainer: { children: [] },
			editor: {},
			focusActiveEditorArea: vi.fn(),
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
		controller.showModelSelector();
		const picker = card;
		if (!picker) throw new Error("the show site opened no overlay");

		// The show site opens the card with its unfold running, so the list has no rows for the
		// first few frames. Drive the same clock the unfold is on until they are painted.
		unfold(picker, "alpha/two");
		picker.handleInput(motionAt(locate(picker, "alpha/two")));
		expect(motionClock.liveCount, "a band is travelling").toBeGreaterThan(0);

		picker.handleInput("\x1b");
		expect(hide).toHaveBeenCalledTimes(1);
		advance(FRAME);
		expect(motionClock.liveCount, "the dismissed picker left nothing on the clock").toBe(0);
	});
});

describe("the account manager fades its provider sidebar", () => {
	it("arrives over frames and settles on the full band", () => {
		let renders = 0;
		const manager = makeAccountManager(() => {
			renders += 1;
		});
		const target = locate(manager, "Anthropic");
		const bare = rowText(manager, target.row);
		expect(bandRgb(bare)).toBeNull();

		manager.handleInput(motionAt(target));
		expect(renders).toBeGreaterThan(0);
		expect(rowText(manager, target.row)).toBe(bare);

		advance(15);
		expect(bandRgb(rowText(manager, target.row)), "a band mid-fade").not.toBeNull();
		settle();
		expect(bandRgb(rowText(manager, target.row))).toEqual(fullBandRgb());

		manager.dispose();
		advance(FRAME);
		expect(rowText(manager, target.row)).toBe(bare);
		expect(motionClock.liveCount).toBe(0);
	});

	// The case above disposes a card whose band has already landed, which a card that merely drops
	// its fade survives. The clock only notices a fade that is still travelling.
	it("cancels a band still travelling when the card is disposed", () => {
		const manager = makeAccountManager(() => {});
		const target = locate(manager, "Anthropic");
		const bare = rowText(manager, target.row);

		manager.handleInput(motionAt(target));
		advance(15);
		expect(motionClock.liveCount, "a fade is in flight").toBeGreaterThan(0);

		manager.dispose();
		advance(FRAME);
		expect(motionClock.liveCount, "a disposed manager leaves nothing on the clock").toBe(0);
		expect(rowText(manager, target.row)).toBe(bare);
	});

	it("paints the switched band when no host lends a repaint", () => {
		const manager = makeAccountManager();
		const target = locate(manager, "Anthropic");
		const bare = rowText(manager, target.row);

		manager.handleInput(motionAt(target));
		const painted = rowText(manager, target.row);
		expect(painted, "an unwired card still bands the row under the pointer").not.toBe(bare);
		expect(bandRgb(painted)).toEqual(fullBandRgb());
		// An unwired surface registers no fade at all, so the shared clock never wakes for it.
		expect(motionClock.liveCount).toBe(0);
		expect(rowText(manager, target.row)).toBe(painted);
		manager.dispose();
	});
});
