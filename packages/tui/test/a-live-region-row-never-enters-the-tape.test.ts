/**
 * A live-region row (e.g. status loader, todo HUD, subagent HUD, pinned chrome)
 * never enters the terminal's native scrollback or tape history, at any viewport
 * height, chrome height, transcript height, frame growth rate, or combination of seams.
 *
 * WHY THIS CLOSES THE DEFECT.
 * When a transient chrome row (such as a working loader displaying `[esc]` with a task clock)
 * sits in an anchored live region or pinned footer below the transcript, tall tool output or
 * rapid frame growth advances `windowTop`. In previous versions, the engine's `#historyEndRow`
 * calculation did not clamp to `pinnedFooterChildCount` unless a child implemented
 * `canPrepareNativeScrollbackReplay`. When `pinnedFooterChildCount` was used alone or when
 * live-region boundaries were merged with topmost seams, frame scrolling allowed chrome rows
 * to commit into immutable native scrollback as if they were history. Once in scrollback,
 * the chrome row became permanent, wedged between settled transcript blocks.
 *
 * THE CLASS, not the incident.
 * The invariant defended here is that no row belonging to an anchored live-region container
 * (`NativeScrollbackLiveRegion`, seam at 0), pinned footer child, or component mounted after
 * the history container may ever appear in the terminal's native scroll buffer — across all
 * viewport heights, chrome heights, transcript growth rates, and presence or absence of
 * transcript streaming seams. A frame whose visible tail cannot commit without taking live
 * rows must take a bounded in-place repaint rather than an illegal scrollback commit.
 *
 * WHAT IT DOES NOT CATCH.
 * Single-screen terminal models without Kitty graphics or multiplexer pane wrapping differences.
 * Image transmit buffers and OSC escape sequences are tested in their dedicated suites.
 */
import { describe, expect, test } from "bun:test";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	type NativeScrollbackLiveRegion,
	type NativeScrollbackReplay,
	TUI,
} from "../src/index";
import { countDestructivePaints } from "./helpers/destructive-paints";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

const CHROME_MARKERS = [
	"▌ Searching for aria project",
	"▌ Finding directories named aria",
	"[esc]",
	"todo-hud-task",
	"composer-prompt",
] as const;

class SettledBlock implements Component {
	constructor(private lines: readonly string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

class AnchoredLiveContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}
}

class TranscriptContainer extends Container implements NativeScrollbackLiveRegion, NativeScrollbackReplay {
	seam: number | undefined = undefined;
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.seam;
	}
	prepareNativeScrollbackReplay(): void {}
}

class PlainContainerTranscript extends Container implements NativeScrollbackLiveRegion {
	seam: number | undefined = undefined;
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.seam;
	}
}

class ComposerComponent implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): string[] {
		return [`> composer-prompt${CURSOR_MARKER}`];
	}
}

interface SweepVariant {
	height: number;
	chromeRows: number;
	appendSize: number;
	chromeProtection: "transcript-replay" | "pinned-footer" | "both";
	transcriptSeamKind: "none" | "zero" | "middle";
}

interface RunOutcome {
	leakedMarkers: string[];
	erases: number;
	historyRowCount: number;
}

async function executeVariant(variant: SweepVariant): Promise<RunOutcome> {
	const term = new VirtualTerminal(80, variant.height, 20_000);
	const paints = countDestructivePaints(term);
	const tui = new TUI(term, true);
	tui.setScrollbackRebuild(true);

	const hasTranscriptReplay = variant.chromeProtection === "transcript-replay" || variant.chromeProtection === "both";
	const hasPinnedFooter = variant.chromeProtection === "pinned-footer" || variant.chromeProtection === "both";

	const transcript = hasTranscriptReplay ? new TranscriptContainer() : new PlainContainerTranscript();
	tui.addChild(transcript);

	const statusContainer = new AnchoredLiveContainer();
	tui.addChild(statusContainer);

	const composer = new ComposerComponent();
	tui.addChild(composer);

	if (hasPinnedFooter) {
		tui.setPinnedFooterChildCount(2);
	}

	tui.start();
	await settleFrames(term, tui);

	// Initial settled content
	transcript.addChild(
		new SettledBlock([
			"$ tool step 0",
			"output line 0.1",
			"output line 0.2",
			"[Wall: 0.01s | Artifact: 1]",
		]),
	);

	// Chrome: loader + optional HUD lines
	const chromeLines = [
		"▌ Searching for aria project · 0:00 [esc]",
		...Array.from({ length: Math.max(0, variant.chromeRows - 1) }, (_, i) => `[ ] todo-hud-task ${i + 1}`),
	];
	statusContainer.addChild(new SettledBlock(chromeLines));

	tui.requestRender();
	await settleFrames(term, tui);

	// Streaming or settled middle step
	if (variant.transcriptSeamKind === "zero") {
		transcript.seam = 0;
	} else if (variant.transcriptSeamKind === "middle") {
		transcript.seam = 2;
	} else {
		transcript.seam = undefined;
	}

	// Burst append 1: multi-row block
	const burst1Lines = [
		"Thinking",
		...Array.from({ length: variant.appendSize }, (_, i) => `thought line ${i + 1} of burst`),
	];
	transcript.addChild(new SettledBlock(burst1Lines));
	tui.requestRender();
	await settleFrames(term, tui);

	// Burst append 2: second tool card
	const burst2Lines = [
		"× failed: $ tool step 1",
		"Output",
		...Array.from({ length: variant.appendSize }, (_, i) => `result row ${i + 1}`),
		"[Wall: 0.03s | Exit: 1]",
		"↓ 826 ↑ 105 29K 7.8s",
	];
	transcript.addChild(new SettledBlock(burst2Lines));

	// Transition loader in status container
	statusContainer.clear();
	statusContainer.addChild(new SettledBlock(["▌ Finding directories named aria · 0:00 [esc]"]));

	tui.requestRender();
	await settleFrames(term, tui);

	// Burst append 3: final settled summary
	transcript.seam = undefined;
	transcript.addChild(
		new SettledBlock([
			"$ final step summary",
			"completed successfully",
		]),
	);
	tui.requestRender();
	await settleFrames(term, tui);

	const scrollbackLength = term.getBufferPosition().baseY;
	const allRows = term.getScrollBuffer().map(r => Bun.stripANSI(r));
	const history = allRows.slice(0, scrollbackLength);

	const leakedMarkers = CHROME_MARKERS.filter(marker =>
		history.some(row => row.includes(marker)),
	);

	tui.stop();

	return {
		leakedMarkers,
		erases: paints.erases(),
		historyRowCount: scrollbackLength,
	};
}

function generateVariantsForProtection(protection: "transcript-replay" | "pinned-footer" | "both"): SweepVariant[] {
	const heights = [8, 12, 24];
	const chromeRowCounts = [1, 4, 10];
	const appendSizes = [2, 8, 20];
	const seamKinds: Array<"none" | "zero" | "middle"> = ["none", "zero", "middle"];

	const list: SweepVariant[] = [];
	for (const height of heights) {
		for (const chromeRows of chromeRowCounts) {
			for (const appendSize of appendSizes) {
				for (const transcriptSeamKind of seamKinds) {
					list.push({
						height,
						chromeRows,
						appendSize,
						chromeProtection: protection,
						transcriptSeamKind,
					});
				}
			}
		}
	}
	return list;
}

describe("a live-region row never enters the tape", () => {
	test("pinned-footer protects chrome across heights, chrome rows, burst sizes, and seams", async () => {
		const variants = generateVariantsForProtection("pinned-footer");
		const failures: Array<{ variant: string; leaked: string[]; erases: number }> = [];

		for (const variant of variants) {
			const label = `h=${variant.height} chr=${variant.chromeRows} app=${variant.appendSize} seam=${variant.transcriptSeamKind}`;
			const outcome = await executeVariant(variant);
			if (outcome.leakedMarkers.length > 0 || outcome.erases > 0) {
				failures.push({
					variant: label,
					leaked: outcome.leakedMarkers,
					erases: outcome.erases,
				});
			}
		}

		expect(failures).toEqual([]);
	}, 60_000);

	test("transcript-replay protects chrome across heights, chrome rows, burst sizes, and seams", async () => {
		const variants = generateVariantsForProtection("transcript-replay");
		const failures: Array<{ variant: string; leaked: string[]; erases: number }> = [];

		for (const variant of variants) {
			const label = `h=${variant.height} chr=${variant.chromeRows} app=${variant.appendSize} seam=${variant.transcriptSeamKind}`;
			const outcome = await executeVariant(variant);
			if (outcome.leakedMarkers.length > 0 || outcome.erases > 0) {
				failures.push({
					variant: label,
					leaked: outcome.leakedMarkers,
					erases: outcome.erases,
				});
			}
		}

		expect(failures).toEqual([]);
	}, 60_000);

	test("both protections combined (interactive-mode shape) protect chrome across heights, chrome rows, burst sizes, and seams", async () => {
		const variants = generateVariantsForProtection("both");
		const failures: Array<{ variant: string; leaked: string[]; erases: number }> = [];

		for (const variant of variants) {
			const label = `h=${variant.height} chr=${variant.chromeRows} app=${variant.appendSize} seam=${variant.transcriptSeamKind}`;
			const outcome = await executeVariant(variant);
			if (outcome.leakedMarkers.length > 0 || outcome.erases > 0) {
				failures.push({
					variant: label,
					leaked: outcome.leakedMarkers,
					erases: outcome.erases,
				});
			}
		}

		expect(failures).toEqual([]);
	}, 60_000);
});
