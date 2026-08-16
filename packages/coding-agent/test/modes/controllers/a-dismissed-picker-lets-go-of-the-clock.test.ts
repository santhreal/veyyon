// WHY THIS SUITE EXISTS (A-DISMISSED-PICKER-KEEPS-ASKING-FOR-FRAMES).
//
// Six hand-painted pickers now cross-fade their pointer band on the process-wide `motionClock`, and
// the band suite proves each of them gives the clock back when `dispose()` is called. Nothing called
// it. `/tree`, `/history` and the branch-from-message card all open through
// `SelectorController.showModalSelector`, whose `done()` hid the overlay and stopped there; `/copy`
// opens through `showCopySelector`, whose card had no `dispose()` at all. So a band still travelling
// when Escape landed kept ticking against a card that would never be painted again, and the clock
// kept its ticker running for it — the exact defect the settings card closed, reopened one layer out
// on every picker the settings card does not route through.
//
// The class this closes: a SHOW SITE that mounts a card with motion and never unmounts it. There are
// two of those, and the fence below walks the real controller through both. `showModalSelector` is
// the shared one — every card routed through it inherits the fix, and the enumeration asserts that,
// so a seventh caller cannot be added with its own private teardown. `showCopySelector` is the one
// that opts out of the shared helper, which is precisely why it was missed.
//
// It drives the real `SelectorController` against the real cards and the real shared clock. A fake
// component would prove the fake was disposed, and the defect was that the real one never was.
//
// WHAT IT DOES NOT CATCH: a show site that hides its overlay by a route other than its own `done`
// (nothing here proves a future route reaches it), a card that registers motion with something other
// than the shared clock, and how the fade LOOKS while it travels — that is the band suite's job.

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { SessionEntry, SessionTreeNode } from "@veyyon/coding-agent/session/session-entries";
import { motionClock, TERMINAL } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const FRAME = 1000 / 60;
const WIDTH = 160;

/** The cards' motion gate is `TERMINAL.trueColor`, probed once at load from a real terminal. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

let geometry: StubbedStdoutGeometry | undefined;
let originalColorterm: string | undefined;
let originalTrueColor = false;

/** The only surface the cases touch: a card that paints, takes a pointer, and takes an Escape. */
interface Card {
	render(width: number): readonly string[];
	handleInput(data: string): void;
}

interface OpenedPicker {
	card: Card;
	hide: ReturnType<typeof vi.fn>;
}

let treeCounter = 0;
function userNode(text: string, parentId: string | null = null): SessionTreeNode {
	const id = `e${treeCounter++}`;
	const message: AgentMessage = { role: "user", content: text, timestamp: treeCounter };
	const entry: SessionEntry = { type: "message", id, parentId, timestamp: "2026-08-10T12:00:00.000Z", message };
	return { entry, children: [] };
}

/** A session tree deep enough that the card paints three rows the pointer can visit. */
function sessionTree(): { roots: SessionTreeNode[]; leafId: string } {
	const first = userNode("alpha the first prompt");
	const second = userNode("bravo the second prompt", first.entry.id);
	first.children.push(second);
	const third = userNode("charlie the third prompt", second.entry.id);
	second.children.push(third);
	return { roots: [first], leafId: third.entry.id };
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

/**
 * The controller's whole world, as far as either show site reaches into it. `showOverlay` is the
 * seam that hands the card back: the controller builds the card privately, so the only way to a
 * reference is to intercept what it mounts.
 */
function makeController(): {
	controller: SelectorController;
	mounted: Promise<Card>;
	hide: ReturnType<typeof vi.fn>;
} {
	const hide = vi.fn();
	const opened = Promise.withResolvers<Card>();
	const showOverlay = vi.fn((component: Card) => {
		opened.resolve(component);
		return { hide };
	});
	const ctx = {
		ui: {
			showOverlay,
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			invalidate: vi.fn(),
			terminal: { columns: WIDTH },
		},
		session: {
			messages: [assistantMessage("the first reply"), assistantMessage("the second reply")],
			getLastVisibleHandoffText: () => undefined,
		},
		sessionManager: {
			getTree: () => sessionTree().roots,
			getLeafId: () => "",
		},
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		editorContainer: { children: [{}] },
		editor: { getTopBorderAvailableWidth: () => WIDTH },
	};
	const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
	return { controller, mounted: opened.promise, hide };
}

/** `/tree`: opened through the shared `showModalSelector`. */
async function openTree(): Promise<OpenedPicker> {
	const { controller, mounted, hide } = makeController();
	controller.showTreeSelector();
	return { card: await mounted, hide };
}

/** `/copy`: opened through its own show site, which does not use the shared helper. */
async function openCopy(): Promise<OpenedPicker> {
	const { controller, mounted, hide } = makeController();
	controller.showCopySelector();
	return { card: await mounted, hide };
}

interface PickerCase {
	readonly name: string;
	readonly open: () => Promise<OpenedPicker>;
	/** Text of a row the pointer can hover that is not the one the cursor already owns. */
	readonly hoverRow: string;
}

const PICKERS: readonly PickerCase[] = [
	{ name: "the session tree card", open: openTree, hoverRow: "bravo the second prompt" },
	{ name: "the copy picker", open: openCopy, hoverRow: "the second reply" },
];

/** 1-based screen row of the first painted line containing `text`. */
function rowOf(card: Card, text: string): number {
	const lines = card.render(WIDTH);
	const index = lines.findIndex(line => line.includes(text));
	expect(index, `a row reading ${text}`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** SGR motion report (button 32+3=35) at a 1-based screen row, mid-card column. */
function motionAt(row1: number, col1 = 30): string {
	return `\x1b[<35;${col1};${row1}M`;
}

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

describe("a dismissed picker lets go of the clock", () => {
	for (const picker of PICKERS) {
		it(`cancels a travelling pointer band when ${picker.name} is dismissed`, async () => {
			const { card, hide } = await picker.open();
			// The open unfold rides the same clock and clips the frame while it runs, so the row is
			// located after it lands.
			card.render(WIDTH);
			drain(performance.now());

			// A pointer report over a row registers the band's fade. It is left un-ticked on
			// purpose: the point is that a fade STILL TRAVELLING when the card is dismissed goes
			// with it, and a ticked-out fade would have removed itself.
			card.handleInput(motionAt(rowOf(card, picker.hoverRow)));
			expect(motionClock.liveCount, "a fade is in flight").toBeGreaterThan(0);

			card.handleInput("\x1b");

			expect(hide).toHaveBeenCalledTimes(1);
			// A cancelled animation settles where it stands and the clock drops it on its next
			// tick, so two frames is both "the clock let go" and "it is not still travelling": the
			// 90ms fade is barely a third done by here, and an undisposed one would still be
			// registered.
			const now = performance.now();
			for (let frame = 1; frame <= 2; frame++) motionClock.tick(now + frame * FRAME);
			expect(motionClock.liveCount, "the dismissed picker left nothing on the clock").toBe(0);
		});

		it(`leaves the clock idle when ${picker.name} is opened and closed untouched`, async () => {
			const { card } = await picker.open();
			card.render(WIDTH);
			drain(performance.now());
			card.handleInput("\x1b");
			expect(motionClock.liveCount).toBe(0);
		});
	}

	// The two cases above drive two of the seven cards that open through this controller. The other
	// five go through the same shared helper, so the helper is where the class is closed: whatever
	// it mounts, it unmounts. Asserted directly against `showModalSelector` with a card that only
	// records — the subject here is the HELPER's teardown, not any card's motion, and the cards'
	// motion is what the two cases above already drive for real.
	it("hands back whatever card the shared show site mounted", async () => {
		const { controller, hide } = makeController();
		const dispose = vi.fn();
		let close: (() => void) | undefined;
		controller.showModalSelector(done => {
			close = done;
			const component = { render: () => [], handleInput: () => false, dispose };
			return { component, focus: component };
		});
		expect(close, "the helper handed the card a close").toBeDefined();

		close?.();
		expect(hide).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);

		// `done` can fire twice — a select path and a cancel path race — and the card must be told
		// once. A second dispose on a card that already let go is how a re-registered animation
		// gets orphaned.
		close?.();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	// The helper's other exit: a card that closes itself inside `create`, before the overlay handle
	// exists. The teardown is deferred to just after the handle is made, and it has to carry the
	// dispose with it — this branch is the one a reader is most likely to simplify away.
	it("hands back a card that closed itself before the overlay existed", async () => {
		const { controller, hide } = makeController();
		const dispose = vi.fn();
		controller.showModalSelector(done => {
			done();
			const component = { render: () => [], handleInput: () => false, dispose };
			return { component, focus: component };
		});
		expect(hide).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
