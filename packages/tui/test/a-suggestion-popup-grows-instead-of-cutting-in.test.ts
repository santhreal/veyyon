// WHY THIS SUITE EXISTS (A-BLOCK-THAT-APPEARS-GROWS-ONCE-PER-APPEARANCE).
//
// The suggestion popup was a cut: five rows of chrome existed on one frame and not on the frame
// before, under a composer the user is typing into. That is the most frequently repainted surface in
// the product, so it is also where a structural animation can go wrong in ways worse than no
// animation at all:
//
//   1. Replaying the grow on every refresh. The popup rebuilds its list on each keystroke. A reveal
//      armed by RENDER instead of by APPEARANCE restarts a 220ms grow per character typed, so the
//      list never reaches full height while anybody is typing.
//   2. A grow that never finishes, or never starts. Rows must arrive over the curve, the block must
//      end at every row it has, and nothing may be left live on the clock.
//   3. Clicking a row that is not there. The popup is hit-tested by frame row, so a clipped block
//      inside a frame that still reported its full height would accept an invisible suggestion.
//   4. Motion in a terminal that was promised none. With the reveal off, or never lent, the frame
//      must be byte-identical to the frame before this existed.
//
// The invariant: one grow per appearance, on the shared clock, over rows the component already
// rendered — and a popup with no motion lent paints exactly what it always painted.
//
// The cases drive the real `Editor` through its real autocomplete path (provider -> Tab -> popup ->
// render -> routeMouse) against a hand-ticked `MotionClock`. The provider resolves on a microtask,
// so no case needs a wall clock except the one that must go through the 100ms input debounce, which
// is the only production path that rebuilds the list without closing the popup.
//
// WHAT IT DOES NOT CATCH: which row a given suggestion lands on (SelectList's layout, proven where
// it lives), and the ambient gate that decides `enabled`/`ground` in the product — that is
// interactive-mode's `#lendPopupMotion`; what is asserted here is that the editor honors whatever it
// is handed. Two properties of `BlockReveal` are also unobservable through this host and are
// deliberately not claimed: that the timeline starts on the first PAINT rather than at `arm()` (the
// editor paints immediately after arming, so both spellings look the same from here), and that
// `disarm()` clears the armed flag as well as cancelling the animation (`apply` is only reachable
// while the popup is on screen, so a stale flag cannot be seen). A second host that arms well before
// it paints, or paints a block it has disarmed, is where those two would show.

import { describe, expect, it, vi } from "bun:test";
import type { AutocompleteItem, AutocompleteProvider } from "@veyyon/tui/autocomplete";
import { Editor } from "@veyyon/tui/components/editor";
import { MOTION, MotionClock } from "@veyyon/tui/motion";
import { parseSgrMouse } from "@veyyon/tui/mouse";
import { Chalk } from "chalk";
import { defaultEditorTheme, defaultSelectListTheme } from "./test-themes";

const FRAME = 1000 / 60;
const WIDTH = 60;
const GROUND = "#101014";
/** The theme color the popup's own rows carry, as the bytes a fade has to move. */
const ITEM_HEX = "#4fc3f7";
const ITEM_SGR = "38;2;79;195;247";

const ITEMS: AutocompleteItem[] = [
	{ value: "/model", label: "model", description: "Switch model" },
	{ value: "/mcp", label: "mcp", description: "Manage MCP servers" },
	{ value: "/memory", label: "memory", description: "Inspect memory" },
	{ value: "/mode", label: "mode", description: "Switch mode" },
	{ value: "/mount", label: "mount", description: "Mount a path" },
	{ value: "/migrate", label: "migrate", description: "Migrate state" },
];

/** Path completions, which is what Tab opens in FORCE mode — the other way the popup appears. */
const FILES: AutocompleteItem[] = [
	{ value: "src/agent.ts", label: "src/agent.ts" },
	{ value: "src/api.ts", label: "src/api.ts" },
	{ value: "src/app.ts", label: "src/app.ts" },
	{ value: "src/audio.ts", label: "src/audio.ts" },
	{ value: "src/auth.ts", label: "src/auth.ts" },
	{ value: "src/axis.ts", label: "src/axis.ts" },
];

/**
 * The suggestions the composer's own provider would return for `/m`, resolved on a microtask.
 * `applyCompletion` is the real interface method, so an accepted row travels the production path.
 */
const PROVIDER: AutocompleteProvider = {
	getSuggestions: async (lines: string[], cursorLine: number, cursorCol: number) => {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (!before.startsWith("/")) return null;
		const items = ITEMS.filter(item => item.value.startsWith(before));
		return items.length > 0 ? { items, prefix: before } : null;
	},
	applyCompletion: (lines: string[], cursorLine: number, _cursorCol: number, item: AutocompleteItem) => {
		const next = [...lines];
		next[cursorLine] = `${item.value} `;
		return { lines: next, cursorLine, cursorCol: next[cursorLine]?.length ?? 0 };
	},
	getForceFileSuggestions: async (lines: string[], cursorLine: number, cursorCol: number) => {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (before.startsWith("/")) return null;
		const items = FILES.filter(item => item.value.startsWith(before));
		return items.length > 0 ? { items, prefix: before } : null;
	},
};

/** Let every pending microtask run; the provider is a resolved promise, not a timer. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function advance(clock: MotionClock, ms: number, from = 0): number {
	let now = from;
	for (let elapsed = 0; elapsed < ms; elapsed += FRAME) {
		now += FRAME;
		clock.tick(now);
	}
	return now;
}

interface Popup {
	editor: Editor;
	/** Open the popup the way Tab does, then paint it — which is what starts the grow. */
	open: (text?: string) => Promise<void>;
	frame: () => readonly string[];
	/** Rows of the frame that belong to the popup, by height above the closed composer. */
	height: () => number;
	/** Just the popup's rows, joined, for byte assertions. */
	bytes: () => string;
	renders: () => number;
}

function makePopup(options: { clock?: MotionClock; enabled?: boolean; motion?: boolean } = {}): Popup {
	// A truecolor list theme is what makes the fade observable at all: `fadeLineTowards` leaves an
	// indexed color exactly as written rather than guessing its RGB.
	const chalk = new Chalk({ level: 3 });
	const editor = new Editor({
		...defaultEditorTheme,
		selectList: {
			...defaultSelectListTheme,
			selectedPrefix: (text: string) => chalk.hex(ITEM_HEX)(text),
			selectedText: (text: string) => chalk.hex(ITEM_HEX)(text),
			description: (text: string) => chalk.hex(ITEM_HEX)(text),
		},
	});
	editor.setAutocompleteProvider(PROVIDER);
	let renders = 0;
	editor.onAutocompleteUpdate = () => {
		renders++;
	};
	if (options.motion !== false) {
		editor.setAutocompleteMotion({
			requestRender: () => {
				renders++;
			},
			clock: options.clock,
			enabled: options.enabled,
			ground: GROUND,
		});
	}
	const frame = (): readonly string[] => editor.render(WIDTH);
	// The composer's own height, measured with no popup open, so a popup's height is a subtraction
	// rather than a guess at which rows are suggestions.
	const closedHeight = frame().length;
	return {
		editor,
		open: async (text = "/m") => {
			editor.setText(text);
			editor.handleInput("\t");
			await flush();
			expect(editor.isShowingAutocomplete()).toBe(true);
			// The host repaints on `onAutocompleteUpdate`, and the reveal's timeline starts on that
			// first paint rather than at arm — a popup armed a frame before it is painted must not
			// play its grow to nobody.
			frame();
		},
		frame,
		height: () => frame().length - closedHeight,
		bytes: () => frame().slice(closedHeight).join("\n"),
		renders: () => renders,
	};
}

describe("a suggestion popup grows instead of cutting in", () => {
	it("arrives a row at a time over the enter curve and ends at the height it would have cut to", async () => {
		const clock = new MotionClock();
		const popup = makePopup({ clock });
		await popup.open();

		// The curve is quintic, so it is nearly arrived by a third of its duration: the frames worth
		// sampling are the early ones.
		const first = popup.height();
		const early = advance(clock, MOTION.enter.duration / 8);
		const opening = popup.height();
		const midway = advance(clock, MOTION.enter.duration / 8, early);
		const half = popup.height();
		advance(clock, MOTION.enter.duration, midway);
		const settled = popup.height();

		// Monotone growth, and the early frames are genuinely shorter: a reveal that painted every
		// row on frame one is the cut this replaced.
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(opening);
		expect(opening).toBeLessThan(half);
		expect(half).toBeLessThan(settled);

		// And it lands on exactly the block the un-animated popup paints, rows and bytes.
		const unwired = makePopup({ motion: false });
		await unwired.open();
		expect(settled).toBe(unwired.height());
		expect(popup.frame()).toEqual(unwired.frame());
	});

	it("terminates: the clock empties, the frame stops changing, and no more frames are asked for", async () => {
		const clock = new MotionClock();
		const popup = makePopup({ clock });
		await popup.open();

		advance(clock, MOTION.enter.duration * 2);
		expect(clock.liveCount).toBe(0);

		const settled = popup.frame();
		const before = popup.renders();
		advance(clock, MOTION.enter.duration);
		expect(popup.frame()).toEqual(settled);
		expect(popup.renders()).toBe(before);
	});

	it("asks the host for a frame on every animated tick", async () => {
		const clock = new MotionClock();
		const popup = makePopup({ clock });
		await popup.open();

		const armed = popup.renders();
		advance(clock, MOTION.enter.duration / 3);
		// One repaint per sampled frame, or the grow only advances when something else happens to
		// repaint the composer.
		expect(popup.renders()).toBeGreaterThan(armed + 2);
	});

	it("resolves the rows out of the ground it was given, landing on the unfaded bytes", async () => {
		const clock = new MotionClock();
		const popup = makePopup({ clock });
		await popup.open();
		const opening = popup.bytes();
		expect(opening).toContain("\x1b[38;2;");
		// The ground is near-black, so a row faded toward it cannot still carry the theme's channels.
		expect(opening).not.toContain(ITEM_SGR);

		advance(clock, MOTION.enter.duration * 2);
		expect(popup.bytes()).toContain(ITEM_SGR);
	});

	it("grows once per appearance: a keystroke that rebuilds the list keeps every row", async () => {
		const clock = new MotionClock();
		const popup = makePopup({ clock });
		const plain = makePopup({ motion: false });
		await popup.open();
		await plain.open();
		advance(clock, MOTION.enter.duration * 2);
		expect(popup.height()).toBe(plain.height());

		// The one production path that rebuilds the popup's list without closing it is the debounced
		// refresh after a printable key. Its 100ms timer is driven, not waited on. The keystroke also
		// narrows the list, so the twin with no motion is what says how tall the popup should now be —
		// a reveal armed by render, or re-armed by a refresh, would be part way up from one row.
		vi.useFakeTimers();
		try {
			popup.editor.handleInput("o");
			plain.editor.handleInput("o");
			vi.advanceTimersByTime(140);
		} finally {
			vi.useRealTimers();
		}
		await flush();
		expect(popup.editor.isShowingAutocomplete()).toBe(true);
		expect(plain.height()).toBeGreaterThan(1);
		expect(popup.height()).toBe(plain.height());
		expect(clock.liveCount).toBe(0);
	});

	it("grows once per appearance in force mode too, where a refresh re-opens the same popup", async () => {
		// A path popup refreshes by calling the force path again, which sets the state a second time.
		// That is the ONE call site where an appearance-armed reveal could be re-armed by a refresh,
		// so it is the case that pins the idempotence rather than the slash-command path.
		const clock = new MotionClock();
		const popup = makePopup({ clock });
		const plain = makePopup({ motion: false });
		await popup.open("src/a");
		await plain.open("src/a");
		// It grows on the way in, exactly as a slash popup does, before anything is refreshed.
		expect(popup.height()).toBeLessThan(plain.height());
		advance(clock, MOTION.enter.duration * 2);
		expect(popup.height()).toBe(plain.height());

		vi.useFakeTimers();
		try {
			popup.editor.handleInput("u");
			plain.editor.handleInput("u");
			vi.advanceTimersByTime(140);
		} finally {
			vi.useRealTimers();
		}
		await flush();
		expect(popup.editor.isShowingAutocomplete()).toBe(true);
		expect(plain.height()).toBeGreaterThan(1);
		expect(popup.height()).toBe(plain.height());
		expect(clock.liveCount).toBe(0);
	});

	it("grows again on the next appearance, from nothing, and leaves nothing running when dismissed", async () => {
		const clock = new MotionClock();
		const popup = makePopup({ clock });
		await popup.open();
		let now = advance(clock, MOTION.enter.duration * 2);
		const settled = popup.height();

		popup.editor.handleInput("\x1b"); // Escape: gone at once, never faded out
		expect(popup.editor.isShowingAutocomplete()).toBe(false);
		expect(popup.height()).toBe(0);

		// The next appearance is a new one and grows from the bottom again.
		await popup.open();
		now = advance(clock, MOTION.enter.duration / 8, now);
		expect(popup.height()).toBeLessThan(settled);

		// Dismissed MID-GROW: the animation it was running is cancelled, so it paints no further
		// frame and the clock drops it on its next tick rather than ticking on against a block
		// nobody is painting any more.
		popup.editor.handleInput("\x1b");
		expect(popup.height()).toBe(0);
		const quiet = popup.renders();
		now = advance(clock, FRAME * 4, now);
		expect(clock.liveCount).toBe(0);
		expect(popup.renders()).toBe(quiet);

		await popup.open();
		expect(popup.height()).toBeLessThan(settled);
		advance(clock, MOTION.enter.duration * 2, now);
		expect(popup.height()).toBe(settled);
	});

	it("accepts the suggestion on the row the pointer landed on while it is still growing", async () => {
		const clock = new MotionClock();
		const popup = makePopup({ clock });
		await popup.open();

		// Grow far enough that a second row exists, but not to full height.
		advance(clock, MOTION.enter.duration / 8);
		const lines = popup.frame();
		const row = lines.findIndex(line => line.includes("mcp"));
		expect(row).toBeGreaterThan(0);
		expect(popup.height()).toBeLessThan(ITEMS.length);

		const event = parseSgrMouse(`\x1b[<0;3;${row + 1}M`);
		if (event === null) throw new Error("the SGR press did not parse");
		popup.editor.routeMouse(event, row, 2);

		// The row the frame shows is the row that was accepted: a frame that reported its full height
		// while painting a clipped block would land on a different suggestion.
		expect(popup.editor.getText()).toBe("/mcp ");
	});

	it("is byte-identical with the reveal disabled, and registers nothing", async () => {
		const clock = new MotionClock();
		const off = makePopup({ clock, enabled: false });
		await off.open();
		const disabled = off.frame();
		expect(clock.liveCount).toBe(0);

		const unwired = makePopup({ motion: false });
		await unwired.open();

		expect(disabled).toEqual(unwired.frame());
		// And no later tick can change it: there is nothing registered to tick.
		advance(clock, MOTION.enter.duration * 2);
		expect(off.frame()).toEqual(disabled);
	});

	it("stops painting once the editor's motion is disposed", async () => {
		const clock = new MotionClock();
		const popup = makePopup({ clock });
		await popup.open();
		const growing = popup.height();

		const unwired = makePopup({ motion: false });
		await unwired.open();
		const full = unwired.height();
		expect(growing).toBeLessThan(full);

		popup.editor.disposeAutocompleteMotion();
		expect(popup.height()).toBe(full);
		const after = popup.renders();
		advance(clock, MOTION.enter.duration);
		expect(popup.renders()).toBe(after);
		expect(clock.liveCount).toBe(0);
	});
});
