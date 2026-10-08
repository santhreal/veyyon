// WHY THIS SUITE EXISTS.
//
// The host repaints after every input event it hands the plan review overlay, and after nothing
// else. The overlay took a `requestRender` hook from its caller and never called it, so a change
// that reached it outside an input event (an annotation the external editor commits once the
// editor exits, a plan the caller swaps in with `setPlanContent`) stayed off screen until an
// unrelated repaint.
//
// The class this closes: an overlay state change with no input event behind it that requests no
// repaint. Both ways such a change enters are swept at run time. The public methods are read off
// the prototype, and the continuations the overlay hands its callbacks are recorded by a callbacks
// object that answers every name, over a tour of every key in every focus region. Each set is
// pinned by exact equality, so a new method or a new continuation fails here until it is given a
// driver, and each driver asserts that the frame changed and that a repaint was requested.
//
// WHAT IT DOES NOT CATCH: a continuation handed to a callback that no key in the tour reaches (a
// mouse-only path, a key sequence longer than one keystroke from a region's resting state), a
// timer the overlay might start on its own, and whether the host honours the request.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import {
	PlanReviewOverlay,
	type PlanReviewOverlayCallbacks,
	type PlanReviewOverlayOptions,
} from "@veyyon/coding-agent/modes/terminal/components/dialogs/plan-review-overlay";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { setKeybindings } from "@veyyon/utils/keybindings";

const WIDTH = 80;
const EXTERNAL_EDITOR = "\x05"; // ctrl+e, bound below
const TAB = "\t";

/** Two top-level headings and a nested one, so the Contents sidebar shows at {@link WIDTH}. */
const PLAN = "# Overview\n\nintro body\n\n## Goal\n\ngoal body\n\n## Steps\n\nstep body\n\n# Risks\n\nrisk body\n";

const OPTIONS: PlanReviewOverlayOptions = {
	promptTitle: "Plan mode - next step",
	options: ["Approve and execute", "Refine plan"],
	externalEditorLabel: "ctrl+e",
	slider: { caption: "continue with", index: 0, segments: [{ label: "default" }, { label: "slow" }] },
};

function frame(overlay: PlanReviewOverlay): string {
	return stripVTControlCharacters(overlay.render(WIDTH).join("\n"));
}

/** An overlay whose repaint requests are counted. */
function countingOverlay(callbacks: PlanReviewOverlayCallbacks): { overlay: PlanReviewOverlay; redraws: () => number } {
	let redraws = 0;
	const overlay = new PlanReviewOverlay(
		PLAN,
		{
			...OPTIONS,
			requestRender: () => {
				redraws++;
			},
		},
		callbacks,
	);
	return { overlay, redraws: () => redraws };
}

const INERT: PlanReviewOverlayCallbacks = { onPick: () => {}, onCancel: () => {} };

/**
 * Keys that put a fresh overlay in each focus region. Tab from the resting `actions` region wraps
 * to the sidebar, and `a` on a sidebar entry opens the annotation draft.
 */
const REGIONS: Record<string, readonly string[]> = {
	actions: [],
	toc: [TAB],
	body: [TAB, TAB],
	annotating: [TAB, "a"],
};

/** Every single keystroke: the C0 controls, printable ASCII, DEL, and the named keys a region reads. */
const KEYS: readonly string[] = [
	...Array.from({ length: 0x80 }, (_, code) => String.fromCharCode(code)),
	"\x1b[A",
	"\x1b[B",
	"\x1b[C",
	"\x1b[D",
	"\x1b[Z",
	"\x1b[1;2A",
	"\x1b[1;2B",
	"\x1b[3~",
	"\x1b[5~",
	"\x1b[6~",
	"\x1b[H",
	"\x1b[F",
];

/**
 * Callbacks that answer every name and record which ones were handed a function, which is how the
 * overlay passes a continuation for a result that arrives later.
 */
function recordingCallbacks(handedAContinuation: Set<string>): PlanReviewOverlayCallbacks {
	return new Proxy(INERT, {
		get: (_target, name) =>
			typeof name !== "string"
				? undefined
				: (...args: unknown[]) => {
						if (args.some(arg => typeof arg === "function")) handedAContinuation.add(name);
					},
	});
}

beforeEach(async () => {
	await initTheme(false);
	setKeybindings(KeybindingsManager.inMemory({ "app.editor.external": "ctrl+e" }));
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

/**
 * Drivers for a public method that changes what the overlay draws with no input event behind it.
 * Each returns text the new frame states and the old one does not.
 */
const METHOD_DRIVERS: Record<string, (overlay: PlanReviewOverlay) => string> = {
	setPlanContent: overlay => {
		overlay.setPlanContent("# Swapped plan\n\nswapped body\n");
		return "swapped body";
	},
};

/**
 * Public methods that need no driver, with the reason. `handleInput` is the input event the host
 * repaints after; `render` changes nothing; `invalidate` is called by the host inside its own
 * repaint.
 */
const NO_DRIVER: readonly string[] = ["handleInput", "invalidate", "render"];

/**
 * Drivers for a continuation the overlay hands a callback. Each opens the path that hands it over,
 * holds the continuation until the keystroke has returned, runs it, and returns the text the new
 * frame states.
 */
const CONTINUATION_DRIVERS: Record<
	string,
	() => { overlay: PlanReviewOverlay; redraws: () => number; run: () => string }
> = {
	onAnnotationExternalEditor: () => {
		let commit: ((text: string | null) => void) | undefined;
		const counted = countingOverlay({
			...INERT,
			onAnnotationExternalEditor: (_draft, handed) => {
				commit = handed;
			},
		});
		frame(counted.overlay);
		for (const key of REGIONS.annotating!) counted.overlay.handleInput(key);
		counted.overlay.handleInput(EXTERNAL_EDITOR);
		return {
			...counted,
			run: () => {
				expect(commit).toBeDefined();
				commit!("committed from the editor");
				return "committed from the editor";
			},
		};
	},
};

describe("a plan review change without a keystroke requests a redraw", () => {
	it("gives every public method a driver or a reason, and nothing else", () => {
		const prototype = PlanReviewOverlay.prototype;
		const methods = Object.getOwnPropertyNames(prototype)
			.filter(name => name !== "constructor")
			.filter(name => typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === "function")
			.sort();

		expect(methods).toEqual([...Object.keys(METHOD_DRIVERS), ...NO_DRIVER].sort());
	});

	for (const [method, drive] of Object.entries(METHOD_DRIVERS)) {
		it(`requests a redraw when ${method} changes the frame`, () => {
			const { overlay, redraws } = countingOverlay(INERT);
			const before = frame(overlay);
			expect(redraws()).toBe(0);

			const stated = drive(overlay);

			expect(redraws()).toBeGreaterThan(0);
			const after = frame(overlay);
			expect(before).not.toContain(stated);
			expect(after).toContain(stated);
		});
	}

	it("hands a continuation to exactly the callbacks that have a driver", () => {
		const handedAContinuation = new Set<string>();
		for (const setup of Object.values(REGIONS)) {
			for (const key of KEYS) {
				const overlay = new PlanReviewOverlay(PLAN, OPTIONS, recordingCallbacks(handedAContinuation));
				frame(overlay);
				for (const step of setup) overlay.handleInput(step);
				overlay.handleInput(key);
			}
		}

		expect([...handedAContinuation].sort()).toEqual(Object.keys(CONTINUATION_DRIVERS).sort());
	});

	for (const [callback, open] of Object.entries(CONTINUATION_DRIVERS)) {
		it(`requests a redraw when the continuation handed to ${callback} changes the frame`, () => {
			const { overlay, redraws, run } = open();
			const before = frame(overlay);
			const settled = redraws();

			const stated = run();

			expect(redraws()).toBeGreaterThan(settled);
			expect(before).not.toContain(stated);
			expect(frame(overlay)).toContain(stated);
		});
	}
});
