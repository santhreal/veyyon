// WHY THIS SUITE EXISTS (A-CARD-NOBODY-CAN-SEE-KEEPS-ASKING-FOR-FRAMES).
//
// The settings card registers motion with the process-wide `motionClock`: the open unfold, the
// pointer band on its list, and — since the category sidebar became a fading surface — the band on
// its tab bar. The card is thrown away when the overlay hides, and nothing was giving those
// registrations back. A fade still travelling when the operator pressed Escape kept ticking against
// a component that would never be painted again, and the clock kept its ticker running for it.
//
// The class this closes: a motion the card OWNS outliving the card. The show site is the only place
// that knows the card is gone for good, so it is the only place that can hand the clock back, and a
// future card with a fourth animation has to reach the same call.
//
// It drives the real `SelectorController.showSettingsSelector` against the real card and the real
// shared clock — no fake component, since the defect is precisely that the real one was never told.
//
// The second defect, same class one level down: a card the operator has NOT closed still throws
// surfaces away. A settings submenu swaps screens by rebuilding its children, so stepping back out
// of a role's model panel drops a live pointer band on the floor. Nothing at the dozens of
// `this.clear()` sites could be trusted to remember, so the base class hands the children back.
//
// WHAT IT DOES NOT CATCH: whether the fade LOOKS right (the band-bytes suite), and a card closed by
// a route other than the overlay's own cancel — every route ends in the same `done`, but nothing
// here proves a future route will.

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { motionClock, TERMINAL } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const FRAME = 1000 / 60;
const WIDTH = 160;

let geometry: StubbedStdoutGeometry | undefined;
let originalColorterm: string | undefined;
let originalTrueColor = false;

/** The card's motion gate is `TERMINAL.trueColor`, probed once at load from a real terminal. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

/** The card is the only overlay this controller ever shows, so the first one shown is it. */
interface OpenedCard {
	card: SettingsSelectorComponent;
	cancel: () => void;
	hide: () => void;
}

/**
 * Three models under two providers: enough for the role picker to paint a list with a hoverable
 * row that is neither the first nor the last, which is what a band test needs.
 */
const MODELS: ReadonlyArray<Model> = ["alpha/one", "alpha/two", "beta/three"].map(name => {
	const [provider, id] = name.split("/") as [string, string];
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
});

/** Only what the role picker reads: the catalog, and whether each row is already usable. */
const MODEL_REGISTRY = {
	getAvailable: () => MODELS,
	getAll: () => MODELS,
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true },
} as unknown as ModelRegistry;

async function openSettings(options?: { withModels?: boolean }): Promise<OpenedCard> {
	const hide = vi.fn();
	const opened = Promise.withResolvers<SettingsSelectorComponent>();
	const showOverlay = vi.fn((component: SettingsSelectorComponent) => {
		opened.resolve(component);
		return { hide };
	});
	const ctx = {
		ui: {
			showOverlay,
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			invalidate: vi.fn(),
			imageBudget: undefined,
			terminal: { columns: WIDTH },
		},
		session: {
			getAvailableThinkingLevels: () => [],
			thinkingLevel: undefined,
			getAvailableModels: () => (options?.withModels ? MODELS : []),
			model: undefined,
			modelRegistry: options?.withModels ? MODEL_REGISTRY : undefined,
		},
		statusLine: {
			updateSettings: vi.fn(),
			invalidate: vi.fn(),
			renderQuietLines: () => ({ locationLine: "", capabilityLine: "" }),
		},
		editorContainer: { children: [{}] },
		// The card's preview pane asks the editor how wide the composer's top border is.
		editor: { getTopBorderAvailableWidth: () => WIDTH },
		showWarning: vi.fn(),
	};
	const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
	controller.showSettingsSelector();
	// The card is built behind a Promise.all of theme, personality and rollback lookups, all of
	// which touch the filesystem: the overlay exists a few macrotasks later. A card that never
	// opens hangs here and is reported as a test timeout rather than as a wrong value.
	const card = await opened.promise;
	// The unfold's timeline starts on the card's FIRST paint rather than at construction, so
	// nothing is on the clock until the host has rendered it once.
	card.render(WIDTH);
	// The production close: what Escape on the top-level card reaches.
	const cancel = () => card.handleInput("\x1b");
	return { card, cancel, hide };
}

/** 1-based screen row and column of a sidebar category, inside the sidebar column of the card. */
function categoryCell(card: SettingsSelectorComponent, label: string): { row: number; col: number } {
	const rows = card.render(WIDTH);
	const index = rows.findIndex(line => {
		const parts = stripVTControlCharacters(line).split("│");
		return parts.length > 2 && parts[1]?.trim().replace(/^›\s*/, "") === label;
	});
	expect(index, `sidebar row for ${label}`).toBeGreaterThanOrEqual(0);
	const col = stripVTControlCharacters(rows[index] as string).indexOf(label) + 1;
	return { row: index + 1, col };
}

/** The card as the operator reads it, one entry per screen row. */
function plain(card: SettingsSelectorComponent): string[] {
	return card.render(WIDTH).map(line => stripVTControlCharacters(line));
}

/** 1-based cell of the first row carrying `text`, wherever on the card it is painted. */
function cellOf(card: SettingsSelectorComponent, text: string): { row: number; col: number } {
	const rows = plain(card);
	const index = rows.findIndex(line => line.includes(text));
	expect(index, `a row reading ${text}`).toBeGreaterThanOrEqual(0);
	return { row: index + 1, col: (rows[index] as string).indexOf(text) + 1 };
}

/** Press and release over a row: how the operator picks one with the pointer. */
function click(card: SettingsSelectorComponent, text: string): void {
	const { row, col } = cellOf(card, text);
	card.handleInput(`\x1b[<0;${col};${row}M`);
	card.handleInput(`\x1b[<0;${col};${row}m`);
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	originalColorterm = Bun.env.COLORTERM;
	Bun.env.COLORTERM = "truecolor";
	originalTrueColor = terminalCaps.trueColor;
	terminalCaps.trueColor = true;
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
	geometry?.restore();
	geometry = undefined;
	terminalCaps.trueColor = originalTrueColor;
	if (originalColorterm === undefined) delete Bun.env.COLORTERM;
	else Bun.env.COLORTERM = originalColorterm;
	resetSettingsForTest();
});

/**
 * Run the shared clock forward from `from` until nothing is registered, or throw. A bounded loop
 * rather than a wait: the clock is ticked by hand, so an animation that never ends is a hang here
 * and a hang in the product.
 */
function drain(from: number): number {
	let now = from;
	for (let frame = 0; frame < 120 && motionClock.liveCount > 0; frame++) {
		now += FRAME;
		motionClock.tick(now);
	}
	expect(motionClock.liveCount, "the card's open unfold ended").toBe(0);
	return now;
}

describe("a closed settings card lets go of the clock", () => {
	it("cancels a travelling sidebar fade when the card is dismissed", async () => {
		const { card, cancel, hide } = await openSettings();
		// The open unfold is on the same clock and clips the frame while it runs, so the sidebar
		// is located after it lands.
		drain(performance.now());
		const cell = categoryCell(card, "Model");

		// A pointer report over a category registers the band's fade on the shared clock. It is
		// left un-ticked on purpose: the point is that a fade STILL TRAVELLING when the card is
		// dismissed goes with it, and a ticked-out fade would have removed itself.
		card.handleInput(`\x1b[<35;${cell.col};${cell.row}M`);
		expect(motionClock.liveCount, "a fade is in flight").toBeGreaterThan(0);

		cancel();

		expect(hide).toHaveBeenCalledTimes(1);
		// A cancelled animation settles where it stands and the clock drops it on its next tick,
		// so two frames is both "the clock let go" and "it is not still travelling": the 90ms fade
		// is barely a third done by here, and an undisposed one would still be registered.
		const now = performance.now();
		for (let frame = 1; frame <= 2; frame++) motionClock.tick(now + frame * FRAME);
		expect(motionClock.liveCount, "the dismissed card left nothing on the clock").toBe(0);
	});

	it("leaves the clock idle when a card is opened and closed without ever being pointed at", async () => {
		const { cancel } = await openSettings();
		drain(performance.now());
		cancel();
		expect(motionClock.liveCount).toBe(0);
	});

	it("hands the clock back when a role's model panel is stepped out of", async () => {
		const { card } = await openSettings({ withModels: true });
		drain(performance.now());

		// Model → Role Models → the first role's picker, each step asserted by what the card
		// paints: a navigation that silently landed somewhere else would test nothing at all.
		click(card, "Model");
		click(card, "Role Models");
		card.handleInput("\r");
		expect(plain(card).some(line => line.includes("Enter to pick model"))).toBe(true);
		card.handleInput("\r");
		expect(plain(card).some(line => line.includes("alpha/two"))).toBe(true);

		const spot = cellOf(card, "alpha/two");
		card.handleInput(`\x1b[<35;${spot.col};${spot.row}M`);
		expect(motionClock.liveCount, "the panel's band is travelling").toBeGreaterThan(0);

		// Escape here does not close the card: the submenu rebuilds its children back into the
		// role list, and the panel it drops is the thing that has to give the clock back.
		card.handleInput("\x1b");
		expect(plain(card).some(line => line.includes("Enter to pick model"))).toBe(true);

		const now = performance.now();
		for (let frame = 1; frame <= 2; frame++) motionClock.tick(now + frame * FRAME);
		expect(motionClock.liveCount, "the swapped-out panel left nothing on the clock").toBe(0);
	});
});
