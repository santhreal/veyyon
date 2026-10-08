/**
 * A spinner tick draws the row a fresh layout of its frame draws, without laying the message out again.
 *
 * WHY. The working line repaints on every 80 ms spinner tick while the agent works, through a tool
 * run as much as through a streamed answer. The tick changes one glyph, yet `Loader` composed
 * `${frame} ${message}` as new text, so every tick re-wrapped the message and re-measured each row:
 * a tick's render took 1.95 µs, and 0.1 µs without the layout. A loader whose frames are
 * interchangeable words now lays the message out against one of them and draws the current frame in
 * its place.
 *
 * THE INVARIANT, swept over frame sets that share a layout and frame sets that do not, at widths
 * from one column to forty and over messages that fit, wrap and hold wide text: after every tick, the
 * row equals the row a loader built with that one frame draws. A frame set whose frames could wrap
 * differently (unequal widths, more than one cluster, an escape sequence, whitespace, a control
 * character, a cluster that joins the space after it) falls back to laying the message out per
 * frame. Every tick that advances the frame requests a repaint. The suite pins which frame sets share
 * a layout, and a tick of one of them measures no text, so a loader that went back to re-wrapping per
 * tick fails here.
 *
 * WHAT IT DOES NOT CATCH. A colorizer whose output changes without the message changing is the
 * animated path, unchanged here and covered by `loader.test.ts`. The cluster check uses
 * `Intl.Segmenter`, and the native wrapper segments by its own Unicode tables; a Unicode version
 * where the two disagree about a frame glyph is outside this sweep.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { TUI } from "@veyyon/tui";
import { Loader } from "@veyyon/tui/components/loader";

const SPINNER_ADVANCE_MS = 80;
// Undefined runs the frames Loader draws when given none, listed in DEFAULT_FRAMES.
const DEFAULT_FRAMES = ["·", ":", "░", "▒", "▓", "█", "▓", "▒", "░", ":"];

const FRAME_SETS: Record<string, string[] | undefined> = {
	default: undefined,
	ascii: ["-", "\\", "|", "/"],
	braille: ["⠋", "⠙", "⠹", "⠸"],
	digits: ["0", "1", "2"],
	"wide emoji": ["🌑", "🌒", "🌓"],
	"combining cluster": ["e\u0301", "a\u0300"],
	"held frame": ["x", "x", "y"],
	"unequal widths": ["a", "語"],
	"two clusters": ["ab", "cd"],
	whitespace: [" ", "x"],
	"escape sequence": ["\x1b[1mX\x1b[0m", "Y"],
	"control characters": ["\x07", "\x1b"],
	"prepend joins the space": ["\u0600", "\u0601"],
};

const SHARED_LAYOUT = ["default", "ascii", "braille", "digits", "wide emoji", "combining cluster", "held frame"];

const MESSAGES = [
	"Checking",
	"Reading a long path name that wraps across rows · 0:42 ⟦esc⟧",
	"語の幅を確かめる message",
	"",
];

const WIDTHS = [1, 2, 3, 5, 8, 12, 40];

const spinner = (text: string) => `<${text}>`;
const colorMessage = (text: string) => `[${text}]`;

function stubUi() {
	return { requestDirectWrite: vi.fn(), requestComponentRender: vi.fn() };
}

/** The row a loader showing only `frame` draws: the layout of that frame, with no sharing. */
function reference(frame: string, message: string, width: number): readonly string[] {
	const loader = new Loader(stubUi() as unknown as TUI, spinner, colorMessage, message, [frame]);
	loader.stop();
	return loader.render(width);
}

const SCREEN_WIDTH = 40;

/**
 * A host that repaints a loader only when the loader asks, the way the TUI does: requests made between two
 * paints coalesce into one, and `shown` holds the row each paint drew.
 */
function paintedScreen() {
	let pending: Loader | undefined;
	const shown: string[] = [];
	const request = (component: Loader) => {
		pending = component;
	};
	return {
		ui: { requestDirectWrite: request, requestComponentRender: request } as unknown as TUI,
		shown,
		paint() {
			if (pending) shown.push(pending.render(SCREEN_WIDTH).join("\n"));
			pending = undefined;
		},
	};
}

describe("a spinner tick", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	for (const [name, frames] of Object.entries(FRAME_SETS)) {
		it(`draws the row a fresh layout of its frame draws (${name})`, () => {
			vi.useFakeTimers();
			const cycle = frames ?? DEFAULT_FRAMES;
			for (const message of MESSAGES) {
				const screen = paintedScreen();
				const loader = new Loader(screen.ui, spinner, colorMessage, message, frames);
				screen.paint();
				// The mount paints the first frame, then every tick paints the frame it moved to, and a tick
				// that keeps the frame paints nothing.
				const wantShown = [reference(cycle[0]!, message, SCREEN_WIDTH).join("\n")];
				const mismatches: { tick: number; width: number; got: readonly string[]; want: readonly string[] }[] = [];
				for (let tick = 0; tick < cycle.length * 2; tick++) {
					const frame = cycle[tick % cycle.length]!;
					for (const width of WIDTHS) {
						const got = loader.render(width);
						const want = reference(frame, message, width);
						if (got.join("\n") !== want.join("\n")) mismatches.push({ tick, width, got, want });
					}
					const next = cycle[(tick + 1) % cycle.length]!;
					if (next !== frame) wantShown.push(reference(next, message, SCREEN_WIDTH).join("\n"));
					vi.advanceTimersByTime(SPINNER_ADVANCE_MS);
					screen.paint();
				}
				loader.stop();
				expect(mismatches).toEqual([]);
				expect(screen.shown).toEqual(wantShown);
			}
		});
	}

	it("lays the message out once for every frame set that shares a layout", () => {
		vi.useFakeTimers();
		const shared: string[] = [];
		for (const [name, frames] of Object.entries(FRAME_SETS)) {
			const loader = new Loader(stubUi() as unknown as TUI, spinner, colorMessage, "Checking · 0:42 語", frames);
			loader.render(40);
			const measure = spyOn(Bun, "stringWidth");
			for (let tick = 0; tick < 4; tick++) {
				vi.advanceTimersByTime(SPINNER_ADVANCE_MS);
				loader.render(40);
			}
			if (measure.mock.calls.length === 0) shared.push(name);
			measure.mockRestore();
			loader.stop();
		}
		expect(shared).toEqual(SHARED_LAYOUT);
	});
});
