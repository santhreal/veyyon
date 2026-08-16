/**
 * The setup wizard's footer keys are chips, and the three the wizard itself
 * acts on are click targets.
 *
 * WHY: onboarding is the first screen a new user sees and the one they are most
 * likely to be stuck on, and its footer was a dim line of text. Every other
 * surface in the product draws the same keys as chips a pointer can hit, so the
 * one screen whose whole job is "here is how to get through this" was also the
 * one screen where the way out could not be clicked.
 *
 * The class this closes: a hint that names a key and answers no pointer. Back,
 * skip and leave are the wizard's own keys, so a click on each does exactly what
 * the key does; hover lights the chip under the pointer and clears when it
 * leaves.
 *
 * Not caught: a scene hint (`↑↓ select`, `tab switch panel`) is deliberately
 * inert, because the wizard cannot press a scene's key for it — the negative
 * control below pins that a click on one changes nothing, so making a scene chip
 * clickable later is a decision someone has to record here.
 *
 * Also not caught: dropping the `!chip.clickable` half of the rect filter in
 * `#recordChipRects`. `layoutShortcutRows` sets `clickable` to
 * `Boolean(s.clickable && s.id)`, so today an id and a clickable flag arrive
 * together and the surviving `chip.id === undefined` test rejects the same
 * chips. It goes red the moment a wizard chip is declared with an id and no
 * flag, which is the case the filter is there for.
 */

import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type {
	SetupScene,
	SetupSceneController,
	SetupWizardContext,
} from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { SetupWizardComponent } from "@veyyon/coding-agent/modes/setup-wizard/wizard-overlay";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { useFullColor } from "./helpers/theme-assertions";

const WIDTH = 100;
const ROWS = 24;

// Hover paints a background band, and the default test ANSI policy drops
// background parameters, which would make the band invisible and the hover case
// green for the wrong reason.
useFullColor();

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

/** A scene with an empty body, so the only copy in the frame is the chrome. */
function emptyScene(id: string): SetupScene {
	return {
		id,
		title: id,
		minVersion: 1,
		mount: (): SetupSceneController => ({ title: id, render: () => [], invalidate: () => {} }),
	};
}

function makeContext(): SetupWizardContext {
	return {
		settings: Settings.isolated(),
		ui: {
			terminal: { rows: ROWS },
			setFocus: () => {},
			requestRender: () => {},
		},
		refreshComposerShortcuts: () => {},
		dismissWelcome: () => {},
	} as unknown as SetupWizardContext;
}

/** SGR left press at a 0-based screen cell. */
function press(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** SGR motion with no button held, at a 0-based screen cell. */
function motion(row: number, col: number): string {
	return `\x1b[<35;${col + 1};${row + 1}M`;
}

interface Driven {
	component: SetupWizardComponent;
	frame: () => string[];
	plain: () => string[];
	/** The 0-based cell of a chip's first character in the last frame. */
	cellOf: (label: string) => { row: number; col: number };
	ended: () => boolean;
	dispose: () => void;
}

/**
 * Drive the wizard past the splash and the 420ms dissolve into a settled scene.
 * Fake timers step the phase clock, which is an interval plus `performance.now()`
 * — nothing here waits on the wall clock.
 */
function drive(scenes: readonly SetupScene[]): Driven {
	const component = new SetupWizardComponent(makeContext(), scenes);
	vi.useFakeTimers();
	let ended = false;
	void component.run().then(() => {
		ended = true;
	});
	component.handleInput("\r");
	vi.advanceTimersByTime(500);
	const frame = (): string[] => [...component.render(WIDTH)];
	const plain = (): string[] => frame().map(line => stripVTControlCharacters(line));
	return {
		component,
		frame,
		plain,
		cellOf: (label: string) => {
			const rows = plain();
			for (let row = 0; row < rows.length; row++) {
				const col = rows[row]?.indexOf(label) ?? -1;
				if (col >= 0) return { row, col };
			}
			throw new Error(`no chip reads "${label}" in the frame`);
		},
		ended: () => ended,
		dispose: () => {
			vi.useRealTimers();
			component.dispose();
		},
	};
}

describe("the setup wizard footer chips", () => {
	it("leaves setup when the leave chip is clicked, exactly as Esc does", () => {
		const run = drive([emptyScene("only")]);
		try {
			run.frame();
			const chip = run.cellOf("esc leave setup");
			run.component.handleInput(press(chip.row, chip.col));
			// The outro plays on the same clock the splash did; the run resolves at
			// its end, which is the observable "setup is over".
			vi.advanceTimersByTime(5_000);
			expect(run.ended()).toBe(true);
		} finally {
			run.dispose();
		}
	});

	it("advances a step when the skip chip is clicked, and goes back when the back chip is", () => {
		const run = drive([emptyScene("first"), emptyScene("second")]);
		try {
			run.frame();
			expect(run.plain().some(line => line.includes("1/2"))).toBe(true);
			const skip = run.cellOf("→ skip step");
			run.component.handleInput(press(skip.row, skip.col));
			vi.advanceTimersByTime(500);
			expect(run.plain().some(line => line.includes("2/2"))).toBe(true);

			// The back chip exists only from the second step on, which is itself the
			// contract: clicking it on step one would have to mean nothing.
			const back = run.cellOf("← back");
			run.component.handleInput(press(back.row, back.col));
			vi.advanceTimersByTime(500);
			expect(run.plain().some(line => line.includes("1/2"))).toBe(true);
			expect(run.plain().some(line => line.includes("← back"))).toBe(false);
			expect(run.ended()).toBe(false);
		} finally {
			run.dispose();
		}
	});

	it("lights the chip under the pointer and clears it when the pointer leaves", () => {
		const run = drive([emptyScene("only")]);
		try {
			run.frame();
			const chip = run.cellOf("esc leave setup");
			expect(run.frame()[chip.row]).not.toContain("48;");

			run.component.handleInput(motion(chip.row, chip.col + 1));
			const hovered = run.frame()[chip.row] ?? "";
			expect(hovered).toContain("48;");

			// One column left of the chip is the separator, which belongs to no chip.
			run.component.handleInput(motion(chip.row, Math.max(0, chip.col - 2)));
			expect(run.frame()[chip.row]).not.toContain("48;");
		} finally {
			run.dispose();
		}
	});

	it("does nothing when a scene's own hint is clicked", () => {
		const run = drive([emptyScene("first"), emptyScene("second")]);
		try {
			run.frame();
			const hint = run.cellOf("↑↓ select");
			run.component.handleInput(press(hint.row, hint.col));
			vi.advanceTimersByTime(500);
			expect(run.plain().some(line => line.includes("1/2"))).toBe(true);
			expect(run.ended()).toBe(false);
		} finally {
			run.dispose();
		}
	});

	/**
	 * A press on the scene column must stay a scene press. The chip strip is the
	 * wizard's own chrome and its rects are the last row of the frame, so a body
	 * click that resolved against them would act on a key nobody pressed.
	 */
	it("keeps a press on the body away from the chips", () => {
		const run = drive([emptyScene("first"), emptyScene("second")]);
		try {
			run.frame();
			const chip = run.cellOf("→ skip step");
			run.component.handleInput(press(Math.max(0, chip.row - 4), chip.col));
			vi.advanceTimersByTime(500);
			expect(run.plain().some(line => line.includes("1/2"))).toBe(true);
			expect(run.ended()).toBe(false);
		} finally {
			run.dispose();
		}
	});
});
