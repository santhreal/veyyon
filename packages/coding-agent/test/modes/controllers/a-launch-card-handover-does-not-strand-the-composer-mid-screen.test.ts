/**
 * Adopting the launch card leaves the composer on the bottom row.
 *
 * WHY THIS SUITE EXISTS. `first-frame.ts` paints the launch card and starts the
 * screen before `InteractiveMode` exists, using its own `HomeAnchorLayout`. When
 * the mode lands it drops those children and mounts its own tree with a SECOND
 * layout instance. `HomeAnchorLayout.sync()` prefers `ui.composedFrameRows` and
 * subtracts its own fills from it — correct while one layout owns the frame,
 * wrong at this handover: the frame on screen was composed from the first
 * layout's fills, the mode's fills are still zero, so a viewport-tall frame is
 * counted as content, the slack reads as zero and the composer mounts directly
 * under the hero in the middle of the viewport. The operator sees it hang there
 * during launch until the next composed frame re-anchors it.
 *
 * THE CLASS. Not "the launch card": any mount-time seed taken against a composed
 * frame this layout did not produce. The fix is that the mount path has one named
 * owner, `seedAfterMount()`, which always remeasures. These arms call that
 * production entry point, so replacing its body with a bare `sync()` turns them
 * red.
 *
 * The frame-composed self-correction is deliberately NOT wired here. It is what
 * makes the defect temporary rather than permanent, and wiring it would hide the
 * mount frame — the one frame this suite is about.
 *
 * WHAT IT DOES NOT CATCH. Anything about the launch card's own frame (owned by
 * `first-frame.ts`), the resize path (its own suite), and the visual duration of
 * the flash: this asserts the mount frame is already correct, not how quickly a
 * wrong one would have been repaired.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { StaticComposerFrame } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { HomeAnchorLayout } from "@veyyon/coding-agent/modes/controllers/home-anchor-layout";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, CURSOR_MARKER, type Focusable, Spacer, TUI } from "@veyyon/tui";
import { settleFrames, VirtualTerminal } from "@veyyon/render-oracle";

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
		await initTheme(false, "unicode", false, "titanium", "dark");
	});

	test("the mode's first frame pins the composer to the bottom after adopting the launch card", async () => {
		const term = new VirtualTerminal(COLUMNS, ROWS, 5_000);
		const tui = new TUI(term, true);

		// Arm one: the launch card, painted by its OWN layout instance, exactly as
		// `paintFirstFrame` builds it.
		const cardLayout = new HomeAnchorLayout({ ui: tui, transcriptChildCount: () => 0, hasHero: () => true });
		const cardChildren = [
			cardLayout.topFill,
			new Spacer(1),
			hero(),
			new Spacer(1),
			cardLayout.bottomFill,
			new StaticComposerFrame(),
		];
		for (const child of cardChildren) tui.addChild(child);
		cardLayout.sync(true);
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
