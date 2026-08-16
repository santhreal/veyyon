// WHY THIS SUITE EXISTS (AN-OVERLAY-EXIT-IS-PAINT-ONLY).
//
// Every modal card in this product opens on the shared motion clock and used to close by
// disappearing between two frames. Adding the close animation opens a defect class that is worse
// than the missing polish, because each member of it is a card the operator cannot get rid of or
// cannot type past:
//
//   1. A card that keeps taking input while it fades. The operator pressed Esc, the card is on its
//      way out, and their next keystroke still lands in it.
//   2. A card whose exit never finishes, so it is painted forever with nothing left running to
//      remove it. A dispose racing the fade is the way in: cancelling the animation drops the
//      callback that removes the entry from the overlay stack.
//   3. A card that is dismissed twice and removed once, or removed twice.
//   4. A card that animates on a terminal that skipped the entrance, where sub-frame chrome motion
//      reads as flicker rather than as motion.
//
// So the invariant is one sentence: an exit is PAINT ONLY. The instant `hide()` is called the card
// stops holding focus, stops answering `hasOverlay()`, and is guaranteed to leave — the only thing
// the animation may delay is a pixel.
//
// The cases below drive the real `TUI` overlay stack and the real `ModalRevealDriver` against a
// hand-driven `MotionClock`, so nothing here waits on a wall clock. The enumeration at the end
// sweeps the components barrel at run time: a new exported card that renders a modal shell and
// forgets to forward its exit lands in the exempt set and turns this red.
//
// WHAT IT DOES NOT CATCH: whether a card LOOKS right while it leaves (that is a render proof, not
// an assertion), and cards that are not exported from the barrel — those are reached through their
// own surfaces' suites. It also says nothing about a host that removes an overlay without going
// through the handle, which no caller does.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as components from "@veyyon/coding-agent/modes/components/index";
import * as modalShell from "@veyyon/coding-agent/modes/components/modal-shell";
import { ModalRevealDriver } from "@veyyon/coding-agent/modes/components/modal-shell";
import { type Component, MOTION, MotionClock, TUI } from "@veyyon/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const FRAME = 1000 / 60;

/** A card that plays itself out on a clock the test owns. */
class FadingCard implements Component {
	readonly reveal: ModalRevealDriver;
	renders = 0;
	inputs: string[] = [];

	constructor(clock: MotionClock) {
		this.reveal = new ModalRevealDriver(clock);
	}

	render(width: number): string[] {
		this.renders++;
		return [`card ${width} @ ${this.reveal.value.toFixed(2)}`];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return this.reveal.exit(requestRender, done);
	}
}

/** A card with no exit at all, which must still close the way it always did. */
class PlainCard implements Component {
	render(): string[] {
		return ["plain"];
	}
}

describe("a dismissed overlay plays out before it leaves", () => {
	let clock: MotionClock;
	let tui: TUI;

	beforeEach(() => {
		clock = new MotionClock();
		tui = new TUI(new VirtualTerminal(80, 24));
	});

	afterEach(() => {
		// Anything still live would tick into the next file.
		for (let frame = 1; frame <= 60 && clock.liveCount > 0; frame++) clock.tick(frame * FRAME);
	});

	/** Drive `frames` frames of 60Hz from t = 0. */
	function run(frames: number): void {
		for (let frame = 1; frame <= frames; frame++) clock.tick(frame * FRAME);
	}

	it("keeps painting the card and stops routing to it the instant it is dismissed", () => {
		const card = new FadingCard(clock);
		const handle = tui.showOverlay(card);
		expect(tui.hasOverlay()).toBe(true);

		handle.hide();

		// Still in the stack, so it is still drawn.
		expect(tui.overlayStack.map(entry => entry.component)).toEqual([card]);
		// And already gone as far as input is concerned: this is the whole contract. `hasOverlay()`
		// is what decides whether a keystroke belongs to a card or to the session behind it.
		expect(tui.hasOverlay()).toBe(false);
	});

	it("removes the card on the frame its exit settles, and not before", () => {
		const card = new FadingCard(clock);
		tui.showOverlay(card).hide();

		// One frame short of the exit duration: still there.
		const framesToSettle = Math.ceil(MOTION.exit.duration / FRAME);
		run(framesToSettle - 1);
		expect(tui.overlayStack.length).toBe(1);
		expect(card.reveal.value).toBeLessThan(1);

		run(framesToSettle + 2);
		expect(tui.overlayStack).toEqual([]);
		expect(clock.liveCount).toBe(0);
	});

	/**
	 * The stranding class. A card disposed mid-fade must still be removed: `stop()` FINISHES the
	 * exit rather than cancelling it, because the exit's completion callback is the only thing that
	 * takes the entry out of the stack.
	 */
	it("still leaves when it is disposed in the middle of its exit", () => {
		const card = new FadingCard(clock);
		tui.showOverlay(card).hide();
		run(2);
		expect(tui.overlayStack.length).toBe(1);

		card.reveal.stop();

		expect(tui.overlayStack).toEqual([]);
	});

	/** Two paths can race to close one card (a selection and a cancel). It leaves exactly once. */
	it("survives being dismissed twice", () => {
		const card = new FadingCard(clock);
		const handle = tui.showOverlay(card);
		let exits = 0;
		const begin = card.beginOverlayExit.bind(card);
		card.beginOverlayExit = (requestRender, done) => {
			exits++;
			return begin(requestRender, done);
		};

		handle.hide();
		handle.hide();
		run(Math.ceil(MOTION.exit.duration / FRAME) + 2);
		handle.hide();

		expect(exits).toBe(1);
		expect(tui.overlayStack).toEqual([]);
	});

	/**
	 * The host guards re-entry with its own flag, so the DRIVER's guard needs its own case: a
	 * second `exit()` on a card already leaving must decline rather than restart the fade from
	 * wherever it had got to, which would make a card dismissed twice take longer to go than one
	 * dismissed once and could keep it on screen indefinitely under a repeating key.
	 */
	it("declines a second exit rather than replaying it", () => {
		const card = new FadingCard(clock);
		let completions = 0;
		expect(
			card.reveal.exit(
				() => {},
				() => completions++,
			),
		).toBe(true);
		run(3);
		const mid = card.reveal.value;
		expect(mid).toBeLessThan(1);

		expect(
			card.reveal.exit(
				() => {},
				() => completions++,
			),
		).toBe(false);

		// The value kept falling from where it was rather than restarting.
		expect(card.reveal.value).toBeLessThanOrEqual(mid);
		run(Math.ceil(MOTION.exit.duration / FRAME) + 2);
		expect(completions).toBe(1);
		expect(card.reveal.value).toBe(0);
	});

	/** A card that will not animate is removed on the spot, exactly as before this existed. */
	it("removes a card that declines the exit immediately", () => {
		const card = new FadingCard(clock);
		card.beginOverlayExit = () => false;
		tui.showOverlay(card).hide();

		expect(tui.overlayStack).toEqual([]);
	});

	it("removes a card that has no exit at all immediately", () => {
		tui.showOverlay(new PlainCard()).hide();

		expect(tui.overlayStack).toEqual([]);
	});

	/**
	 * The exit is started from wherever the entrance had got to. A card dismissed while it is still
	 * opening must fold away from its current size, not snap open first and then close.
	 */
	it("leaves from where the entrance had got to", () => {
		const card = new FadingCard(clock);
		card.reveal.start(() => {});
		void card.reveal.value; // arms the entrance on first read, as a first paint would
		run(3);
		const midEntrance = card.reveal.value;
		expect(midEntrance).toBeGreaterThan(0);
		expect(midEntrance).toBeLessThan(1);

		tui.showOverlay(card).hide();

		expect(card.reveal.value).toBeLessThanOrEqual(midEntrance);
		run(Math.ceil(MOTION.exit.duration / FRAME) + 2);
		expect(tui.overlayStack).toEqual([]);
	});

	/** A terminal that skipped the entrance is handed no exit either. */
	it("does not animate when the ambient motion gate is off", () => {
		const reveal = new ModalRevealDriver(clock);
		const gate = spyOn(modalShell, "modalRevealEnabled").mockReturnValue(false);
		try {
			expect(
				modalShell.beginModalExit(
					reveal,
					() => {},
					() => {},
				),
			).toBe(false);
			expect(reveal.exiting).toBe(false);
		} finally {
			gate.mockRestore();
		}
	});
});

/**
 * Sweep the barrel rather than a hand-written list, so a card added next year is covered by the
 * decision below instead of by whoever remembers this file.
 */
describe("every modal card exported from the components barrel plays itself out", () => {
	/** Exported classes that render. A card is one of these; so is a transcript block. */
	function renderableClasses(): [string, { prototype: Record<string, unknown> }][] {
		return Object.entries(components).filter(
			([, value]) =>
				typeof value === "function" &&
				value.prototype !== undefined &&
				typeof (value.prototype as Record<string, unknown>).render === "function",
		) as [string, { prototype: Record<string, unknown> }][];
	}

	/**
	 * Everything exported and renderable that does NOT play itself out, pinned by exact equality.
	 *
	 * These are the components that are never shown as an overlay ROOT: transcript blocks, the
	 * composer and its loader, the status line, and the panes that live INSIDE a card (the model
	 * browser and selector panel paint into the model hub's shell, which owns the reveal).
	 *
	 * Exact equality rather than a count or a filter: a new overlay card that forgets to forward
	 * its exit appears here and turns this red, and the author either wires it or writes it down.
	 */
	const NOT_AN_OVERLAY_ROOT = [
		"AssistantMessageComponent",
		"BashExecutionComponent",
		"BranchSummaryMessageComponent",
		"CompactionSummaryMessageComponent",
		"ComposerLoader",
		"CustomEditor",
		"CustomMessageComponent",
		"HandoffSummaryMessageComponent",
		"HookMessageComponent",
		"ModelBrowser",
		"ModelChainSubmenu",
		"ModelSelectorPanel",
		"OAuthSelectorComponent",
		"ReadToolGroupComponent",
		"StatusLineComponent",
		"TinyTitleDownloadProgressComponent",
		"TodoReminderComponent",
		"ToolExecutionComponent",
		"TtsrNotificationComponent",
		"UserMessageComponent",
		"WelcomeComponent",
	];

	it("wires every card that is one, and names every component that is not", () => {
		const classes = renderableClasses();
		expect(classes.length).toBeGreaterThan(20);

		const without = classes
			.filter(([, value]) => typeof value.prototype.beginOverlayExit !== "function")
			.map(([name]) => name)
			.sort();

		expect(without).toEqual(NOT_AN_OVERLAY_ROOT);
	});

	/** The capability is a two-argument call. A forwarder that drops `done` strands the card. */
	it("takes a repaint callback and a completion callback", () => {
		const wired = renderableClasses().filter(([, value]) => typeof value.prototype.beginOverlayExit === "function");
		expect(wired.length).toBeGreaterThan(0);

		const wrongArity = wired
			.filter(([, value]) => (value.prototype.beginOverlayExit as (...args: unknown[]) => unknown).length !== 2)
			.map(([name]) => name);

		expect(wrongArity).toEqual([]);
	});
});
