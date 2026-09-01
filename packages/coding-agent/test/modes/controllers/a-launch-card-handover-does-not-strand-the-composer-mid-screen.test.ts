/**
 * Adopting the launch card leaves the composer on the bottom row.
 *
 * WHY THIS SUITE EXISTS. `first-frame.ts` paints the launch card and starts the
 * screen before `InteractiveMode` exists, using its own `HomeAnchorLayout`. When
 * the mode lands it drops those children and mounts its own tree with a SECOND
 * layout instance. A fill sized from `ui.composedFrameRows` minus its own fills
 * is correct while one layout owns the frame and wrong at this handover: the
 * frame on screen was composed from the first layout's fills, the mode's fills
 * are still zero, so a viewport-tall frame is counted as content, the slack reads
 * as zero and the composer mounts directly under the hero in the middle of the
 * viewport, where the operator watches it hang for the rest of launch.
 *
 * THE CLASS. Not "the launch card": any measurement of the content taken from a
 * frame rather than from the children about to render. `HomeAnchorLayout.sync`
 * reads the live children and nothing else, which is what makes the handover
 * correct on the mount frame; these arms drive the real handover, so returning
 * any frame-derived term to that measurement turns them red.
 *
 * No repaint is wired after the commit, because there is none in the product:
 * the mount frame is asserted as painted, not as eventually repaired.
 *
 * WHAT IT DOES NOT CATCH. Anything about the launch card's own frame (owned by
 * `first-frame.ts`), the resize path (its own suite), and the visual duration of
 * the flash: this asserts the mount frame is already correct, not how quickly a
 * wrong one would have been repaired.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { mountLaunchComposer } from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import { HomeAnchorLayout } from "@veyyon/coding-agent/modes/terminal/controllers/home-anchor-layout";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { type Component, CURSOR_MARKER, type Focusable, Spacer, TUI } from "@veyyon/tui";
import { settleFrames } from "../../../../../hosts/terminal/engine/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../../hosts/terminal/engine/test/virtual-terminal";

const ROWS = 40;
const COLUMNS = 80;

class Block implements Component {
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

class Composer implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): string[] {
		return [`> ask anything${CURSOR_MARKER}`];
	}
}

function hero(): Block {
	return new Block(["", "  ☀ veyyon", "  1.2.0", "", "  tip: press / for commands", ""]);
}

function lastPaintedRow(term: VirtualTerminal): number {
	return term
		.getViewport()
		.map(row => Bun.stripANSI(row).trimEnd())
		.reduce((last, row, i) => (row.trim().length > 0 ? i : last), -1);
}

/** The mode's own tree, mounted and seeded exactly as `InteractiveMode.init` does. */
function mountMode(tui: TUI): HomeAnchorLayout {
	const layout = new HomeAnchorLayout({ ui: tui, transcriptChildCount: () => 0, hasHero: () => true });
	tui.addChild(layout.topFill);
	tui.addChild(hero());
	tui.addChild(layout.bottomFill);
	tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(1);
	layout.seedAfterMount();
	return layout;
}

describe("a launch card handover does not strand the composer mid-screen", () => {
	beforeAll(async () => {
		// The launch composer's footline reads the settings store, so this suite owns its own
		// rather than inheriting whatever a neighbouring file in the bucket left initialized.
		await Settings.init({ inMemory: true });
		await initTheme(false, "unicode", false, "titanium", "dark");
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	test("the mode's first frame pins the composer to the bottom after adopting the launch card", async () => {
		const term = new VirtualTerminal(COLUMNS, ROWS, 5_000);
		const tui = new TUI(term, true);

		// Arm one: the launch card, painted by its OWN layout instance, exactly as
		// `paintFirstFrame` builds it.
		const cardLayout = new HomeAnchorLayout({ ui: tui, transcriptChildCount: () => 0, hasHero: () => true });
		const cardChildren: Component[] = [
			cardLayout.topFill,
			new Spacer(1),
			hero(),
			new Spacer(1),
			cardLayout.bottomFill,
		];
		mountLaunchComposer({ addChild: child => cardChildren.push(child) }, new Composer());
		for (const child of cardChildren) tui.addChild(child);
		cardLayout.sync();
		tui.start();
		await settleFrames(term, tui);

		// The card really did fill the viewport, or the handover below would be
		// measuring against a short frame and the arm would prove nothing.
		expect({ where: "card", composed: tui.composedFrameRows >= ROWS }).toEqual({ where: "card", composed: true });

		// The handover: the card comes off and the mode mounts its own tree.
		for (const child of cardChildren) tui.removeChild(child);
		const layout = mountMode(tui);
		tui.requestRender();
		await settleFrames(term, tui);

		expect({ where: "mounted", last: lastPaintedRow(term), bottom: ROWS - 1 }).toEqual({
			where: "mounted",
			last: ROWS - 1,
			bottom: ROWS - 1,
		});
		expect(Bun.stripANSI(term.getViewport()[ROWS - 1] ?? "")).toContain("> ask anything");
		// The hero still gets its centring share, so the bottom row above is the
		// anchor doing its job and not every fill collapsing to zero.
		expect(layout.topFillRows(COLUMNS)).toBeGreaterThan(0);

		tui.stop();
		await term.flush();
	}, 30_000);

	test("a launch with no card mounts on the bottom row too", async () => {
		// The same seed on the path where no frame has been composed yet. This is
		// the arm that fails if the mount seed is ever narrowed to "only remeasure
		// when a foreign frame exists".
		const term = new VirtualTerminal(COLUMNS, ROWS, 5_000);
		const tui = new TUI(term, true);

		const layout = mountMode(tui);
		tui.start();
		await settleFrames(term, tui);

		expect({ where: "cold", last: lastPaintedRow(term), bottom: ROWS - 1 }).toEqual({
			where: "cold",
			last: ROWS - 1,
			bottom: ROWS - 1,
		});
		expect(Bun.stripANSI(term.getViewport()[ROWS - 1] ?? "")).toContain("> ask anything");
		expect(layout.topFillRows(COLUMNS)).toBeGreaterThan(0);

		tui.stop();
		await term.flush();
	}, 30_000);
});
