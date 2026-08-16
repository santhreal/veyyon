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
// WHAT IT DOES NOT CATCH: whether the fade LOOKS right (the band-bytes suite), and a card closed by
// a route other than the overlay's own cancel — every route ends in the same `done`, but nothing
// here proves a future route will.

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
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

async function openSettings(): Promise<OpenedCard> {
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
			getAvailableModels: () => [],
			model: undefined,
			modelRegistry: undefined,
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
});
