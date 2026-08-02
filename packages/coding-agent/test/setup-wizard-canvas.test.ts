/**
 * The setup wizard's ground is the TERMINAL's ground.
 *
 * THE BUG THIS SUITE LOCKS OUT. The overlay used to wrap every row of every
 * frame in `\x1b[48;2;0;0;0m`, a hardcoded pure-black background, and this file
 * asserted that fill was present. On any terminal whose background is not #000
 * (the report came from a `#1e2127`-class grey) the whole of onboarding was a
 * black slab pasted over the user's own theme. A hardcoded ground cannot be
 * right: it overrides a choice the user already made, on the one screen that is
 * supposed to introduce the tool. It is also invisible in a tmux capture, which
 * renders on black, which is how it shipped. The proof for this change is a
 * grey/black image pair from `scripts/demos/render-setup-wizard.ts`, plus the
 * byte-exact assertions below.
 *
 * WHAT IS PINNED. No frame row carries any background-colour SGR parameter, so
 * the terminal's background shows through. The rows still pad to exactly the
 * requested width and still close with a reset, because "emit no background"
 * would also be satisfied by dropping the padding, and that would shift the
 * layout and let styling leak past the frame.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SetupScene, SetupWizardContext } from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { SetupWizardComponent } from "@veyyon/coding-agent/modes/setup-wizard/wizard-overlay";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { useFullColor } from "./helpers/theme-assertions";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

/** ANSI-aware visible width: strip SGRs, count code points. */
function visibleLength(line: string): number {
	return [...line.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

/** Basic and bright background selectors, plus `49` (reset to default background). */
const BASIC_BACKGROUND = /^(?:4[0-7]|49|10[0-7])$/;

/**
 * Whether an SGR parameter list sets a background.
 *
 * Parsed rather than pattern-matched against the raw bytes, because an extended
 * FOREGROUND is spelled `38;2;r;g;b` and any of those channels can be 40..47 or
 * 49 or 100..107. A regex over the whole sequence reads `\x1b[38;2;40;0;0m` as a
 * background and would make this suite pass on output that does paint one.
 */
function setsBackground(params: readonly string[]): boolean {
	for (let i = 0; i < params.length; i++) {
		const param = params[i] ?? "";
		if (param === "48") return true;
		if (param === "38") {
			const mode = params[i + 1];
			i += mode === "5" ? 2 : mode === "2" ? 4 : 1;
			continue;
		}
		if (BASIC_BACKGROUND.test(param)) return true;
	}
	return false;
}

/** Every background-setting escape in `line`, verbatim, for a readable failure. */
function backgroundEscapes(line: string): string[] {
	const found: string[] = [];
	for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
		if (setsBackground((match[1] ?? "").split(";"))) found.push(match[0]);
	}
	return found;
}

/** Background escapes across a whole frame, tagged with the row they came from. */
function paintedGround(frame: readonly string[]): string[] {
	return frame.flatMap((row, index) =>
		backgroundEscapes(row).map(sequence => `row ${index}: ${JSON.stringify(sequence)}`),
	);
}

/**
 * The detector has to keep working, or every assertion above passes on a frame
 * that is fully painted. An absence assertion that has gone blind is the
 * failure mode this package already guards against elsewhere
 * (undeclared-color-policy-guard), so the two rows that matter are pinned by
 * hand: the exact row the wizard used to emit, and an extended foreground whose
 * colour channels look like background parameters.
 */
describe("the background detector these assertions rest on", () => {
	it("flags the row the wizard used to emit, and each other way to set a ground", () => {
		const slab = `\x1b[48;2;0;0;0m${" ".repeat(8)}\x1b[0m`;
		expect(paintedGround([slab])).toEqual(['row 0: "\\u001b[48;2;0;0;0m"']);
		expect(backgroundEscapes("\x1b[41mred ground\x1b[0m")).toEqual(["\x1b[41m"]);
		expect(backgroundEscapes("\x1b[48;5;236mgrey ground")).toEqual(["\x1b[48;5;236m"]);
		expect(backgroundEscapes("\x1b[100mbright ground")).toEqual(["\x1b[100m"]);
		expect(backgroundEscapes("\x1b[49mdefault ground")).toEqual(["\x1b[49m"]);
	});

	it("does not mistake a truecolor foreground for a ground, whatever its channels", () => {
		// 40, 49 and 100 are background parameters in isolation; here they are the
		// red, green and blue channels of a FOREGROUND, and must not be read as one.
		expect(backgroundEscapes("\x1b[38;2;40;49;100member glyph\x1b[0m")).toEqual([]);
		expect(backgroundEscapes("\x1b[1;38;5;44mbold cyan text")).toEqual([]);
	});
});

describe("the setup wizard renders on the terminal's own ground", () => {
	// The absence assertions below are only meaningful when colour can actually
	// be emitted; under the identity policy there would be nothing to find.
	useFullColor();

	function makeComponent(): SetupWizardComponent {
		const scene: SetupScene = {
			id: "s",
			title: "s",
			minVersion: 1,
			mount: () => ({ title: "s", render: () => ["scene body"], invalidate: () => {} }),
		};
		const ctx = {
			settings: Settings.isolated(),
			ui: { terminal: { rows: 18 }, setFocus: () => {}, requestRender: () => {} },
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as SetupWizardContext;
		return new SetupWizardComponent(ctx, [scene]);
	}

	/** The splash owns the whole viewport, including the rows it leaves visually
	 *  empty. Those filler rows are where a full-frame fill is most obvious. */
	it("splash frame: not one row paints a background", () => {
		const component = makeComponent();
		try {
			void component.run();
			const frame = component.render(64);
			expect(frame.length).toBe(18);
			expect(paintedGround(frame)).toEqual([]);
		} finally {
			component.dispose();
		}
	});

	/** The ground rule lives at the overlay's single render exit, so no phase can
	 *  drift back to a painted frame. */
	it("post-splash frame: not one row paints a background either", () => {
		const component = makeComponent();
		try {
			void component.run();
			// Enter advances out of the splash (into the dissolve toward the scene).
			component.handleInput("\n");
			const frame = component.render(50);
			expect(frame.length).toBe(18);
			expect(paintedGround(frame)).toEqual([]);
		} finally {
			component.dispose();
		}
	});

	/** Dropping the fill must not drop the padding with it: the wizard is a
	 *  full-viewport surface, and a short row would leave the previous frame's
	 *  cells standing to the right of it. */
	it("every row still fills the requested width and closes with a reset", () => {
		const component = makeComponent();
		try {
			void component.run();
			component.handleInput("\n");
			for (const width of [50, 64, 100]) {
				const frame = component.render(width);
				expect(frame.length).toBe(18);
				expect(frame.map(visibleLength)).toEqual(Array.from({ length: 18 }, () => width));
				expect(frame.filter(row => !row.endsWith("\x1b[0m"))).toEqual([]);
			}
		} finally {
			component.dispose();
		}
	});

	/** The exact bytes of a row the wizard leaves empty. Spelled out in full
	 *  because it is the shortest statement of the whole contract: width spaces,
	 *  one reset, and nothing that names a colour. */
	it("an empty row is exactly the requested width in spaces, then a reset", () => {
		const component = makeComponent();
		try {
			void component.run();
			// Row 0 sits above the vertically centred splash content at 18 rows.
			expect(component.render(64)[0]).toBe(`${" ".repeat(64)}\x1b[0m`);
		} finally {
			component.dispose();
		}
	});
});
