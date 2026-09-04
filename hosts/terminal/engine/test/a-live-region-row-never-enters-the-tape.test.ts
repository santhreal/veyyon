/**
 * A live-region row (e.g. status loader, todo HUD, subagent HUD, pinned chrome)
 * never enters the terminal's native scrollback or tape history, at any viewport
 * height, chrome height, transcript height, frame growth rate, or combination of seams.
 *
 * WHY THIS CLOSES THE DEFECT.
 * A transient chrome row — a working loader with its clock and `[esc]` hint, a todo or subagent
 * HUD, the composer — is rewritten every frame, so a copy of it stranded in the terminal's own
 * scrollback is permanent and cannot be repaired without erasing and replaying the screen. The
 * engine keeps chrome out of the commit by deriving a history ceiling from the last root child
 * that claims the native-scrollback replay contract. A host that declares a pinned footer over a
 * plain container claims that contract nowhere, so the ceiling fell back to the whole frame and
 * there was no ceiling at all: growth that advanced `windowTop` past the footer's first row
 * committed the chrome as history, and the tallest members additionally took a destructive erase
 * to repair the prefix they had just violated.
 *
 * THE CLASS, not the incident.
 * The invariant is that no row of an anchored live region, a pinned footer, or anything mounted
 * after the history container may appear in the native scroll buffer, and that keeping it out is
 * never paid for with a destructive repaint — for every protection a host can declare, at every
 * viewport height, chrome height, growth rate and transcript seam position. The sweep runs the
 * real `TUI` against a real `VirtualTerminal`; the containers are the host shape, which is the
 * boundary under test. Every member ends with a block taller than the viewport, so a member that
 * never scrolled is a failure rather than a silent pass.
 *
 * WHAT IT DOES NOT CATCH.
 * The pre-fix engine bounded transcript-replay hosts correctly, so those members of this sweep
 * were green before the fix and cannot witness a regression in the clamp — the pinned-footer
 * members are what go red. It also says nothing about a chrome component that stops updating and
 * stays mounted: such a row is byte-identical frame after frame, which is exactly what the
 * renderer treats as settled content, and no engine-side ceiling can distinguish it. That is a
 * host defect and is defended where the host unmounts it.
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

/**
 * The protections a host can declare over its chrome. This table is the union:
 * {@link SweepVariant} derives its type from it, so a protection added later is
 * swept without anyone remembering to add a case, and `expect(swept)` below
 * pins the set so one cannot be dropped either.
 */
const CHROME_PROTECTIONS = ["transcript-replay", "pinned-footer", "both"] as const;
type ChromeProtection = (typeof CHROME_PROTECTIONS)[number];

const SEAM_KINDS = ["none", "zero", "middle"] as const;
type SeamKind = (typeof SEAM_KINDS)[number];

interface SweepVariant {
	height: number;
	chromeRows: number;
	appendSize: number;
	chromeProtection: ChromeProtection;
	transcriptSeamKind: SeamKind;
}

interface RunOutcome {
	leakedMarkers: string[];
	erases: number;
	/**
	 * Rows the terminal moved into its own scrollback. Zero means the viewport
	 * never scrolled, so the variant never reached the condition the defect
	 * needs and proves nothing — asserted, not reported, because a sweep that
	 * silently skips its hardest members is indistinguishable from a passing one.
	 */
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
		new SettledBlock(["$ tool step 0", "output line 0.1", "output line 0.2", "[Wall: 0.01s | Artifact: 1]"]),
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

	// Burst append 4: a block taller than the viewport, so EVERY variant ends with
	// the chrome above `windowTop`. Without it the tall-viewport/small-append
	// members never scroll and pass without exercising anything.
	transcript.seam = undefined;
	transcript.addChild(
		new SettledBlock([
			"$ final step summary",
			...Array.from({ length: variant.height + 4 }, (_, i) => `summary row ${i + 1}`),
			"completed successfully",
		]),
	);
	tui.requestRender();
	await settleFrames(term, tui);

	const scrollbackLength = term.getBufferPosition().baseY;
	const allRows = term.getScrollBuffer().map(r => Bun.stripANSI(r));
	const history = allRows.slice(0, scrollbackLength);

	const leakedMarkers = CHROME_MARKERS.filter(marker => history.some(row => row.includes(marker)));

	tui.stop();

	return {
		leakedMarkers,
		erases: paints.erases(),
		historyRowCount: scrollbackLength,
	};
}

function sweepVariants(protection: ChromeProtection): SweepVariant[] {
	const list: SweepVariant[] = [];
	for (const height of [8, 12, 24]) {
		for (const chromeRows of [1, 4, 10]) {
			for (const appendSize of [2, 8, 20]) {
				for (const transcriptSeamKind of SEAM_KINDS) {
					list.push({ height, chromeRows, appendSize, chromeProtection: protection, transcriptSeamKind });
				}
			}
		}
	}
	return list;
}

describe("a live-region row never enters the tape", () => {
	test("no chrome row reaches native scrollback, under every protection a host can declare", async () => {
		const swept: string[] = [];
		const failures: string[] = [];

		for (const protection of CHROME_PROTECTIONS) {
			swept.push(protection);
			for (const variant of sweepVariants(protection)) {
				const label = `${protection} h=${variant.height} chr=${variant.chromeRows} app=${variant.appendSize} seam=${variant.transcriptSeamKind}`;
				const outcome = await executeVariant(variant);
				if (outcome.historyRowCount === 0) failures.push(`${label}: never scrolled`);
				if (outcome.leakedMarkers.length > 0) failures.push(`${label}: leaked ${outcome.leakedMarkers.join(", ")}`);
				if (outcome.erases > 0) failures.push(`${label}: ${outcome.erases} destructive erases`);
			}
		}

		expect(failures).toEqual([]);
		expect(swept).toEqual(["transcript-replay", "pinned-footer", "both"]);
	}, 180_000);
});
