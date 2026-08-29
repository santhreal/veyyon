/**
 * What a floating card costs to paint, off arm against on arm.
 *
 * WHAT THE ARMS ARE. Three changes to the card share one render path, and each
 * one's pre-change behaviour is still reachable through the shipped API, so both
 * arms run the SAME committed code over the same corpus and inputs — no vendored
 * copy of the old renderer to drift:
 *
 *   sizing  — `ModalSizing.preferredWidth` unset is the percentage-of-area card
 *             (off); set to the measured content width is the content-sized one
 *             (on). Same body rows, same area.
 *   frame   — `theme.fg("borderAccent", …)` is the paint every overlay frame used
 *             (off); `cardOutlineColor()` is the ground-derived hairline (on).
 *   footer  — `layoutShortcutRows` over the accounts chip strip, at each width
 *             where the strip wraps. The balance pass is not switchable, so this
 *             arm reports cost and the widest row rather than a differential, and
 *             the invariants below are what hold it honest.
 *
 * WHAT IS GUARDED. A benchmark that reports a speedup because a frame quietly
 * stopped rendering is worse than none, so every phase asserts its own output:
 * each arm painted a card of the width it claims, the off arm's frame carries the
 * accent open and the on arm's does not, and the footer keeps every chip exactly
 * once in order at or under the width. A missed guard exits non-zero.
 *
 * WHAT IT DOES NOT MEASURE. Terminal I/O and the diff/emit stages, which
 * `packages/tui/bench/frame.bench.ts` owns; this is compose cost and painted
 * bytes for one card, which is the part a card's chrome decides.
 *
 * Run: bun run packages/coding-agent/bench/card-frame.bench.ts
 */

import { setAnsiPolicy, TERMINAL, visibleWidth } from "@veyyon/tui";
import { benchFail, benchStats, makeBench } from "@veyyon/utils/bench-harness";
import {
	layoutShortcutRows,
	MODAL_SIZING_MEDIUM,
	type ModalShortcut,
	type ModalSizing,
	renderModalShell,
} from "../src/modes/components/modal-shell";
import { cardOutlineColor } from "../src/modes/theme/card-outline";
import {
	applyGroundPaint,
	groundHairlineHex,
	resetGroundTintsForTest,
	setDetectedTerminalGround,
} from "../src/modes/theme/ground-tints";
import { initTheme, theme } from "../src/modes/theme/theme";

const ITERATIONS = 2000;
/** Interleaved passes per arm; the reading is the median across them. */
const PASSES = 5;
const AREA_WIDTH = 131;
const AREA_HEIGHT = 36;
/** The ground the proof recorder runs on, so the bench measures the paint the captures show. */
const RECORDER_GROUND = "#1e2127";

/**
 * Two corpora, because the percentage card is wrong in both directions: a wide
 * one whose rows do not fit 60% of the area, and a short one that is given far
 * more card than it has content for.
 */
interface CardCorpus {
	name: string;
	rows: readonly string[];
}

const CORPORA: readonly CardCorpus[] = [
	{
		name: "/account  5 rows",
		rows: [
			"use <provider> <account>        switch the active account for one provider, by name",
			"add <provider>                  store another account for a provider, through the browser",
			"remove <provider> <account>     forget one stored account and its refresh token",
			"list                            every stored account, grouped by provider",
			"manager                         open the account manager",
		],
	},
	{
		name: "/session  2 rows",
		rows: ["new     start a fresh session", "list    every session in this project"],
	},
];

/** The accounts footer strip: ten chips, laid end to end in the cell count the bench prints. */
const ACCOUNTS_FOOTER: readonly ModalShortcut[] = [
	{ id: "up", label: "↑/↓ move" },
	{ id: "tab", label: "tab scope" },
	{ id: "enter", label: "enter use this account for the provider" },
	{ id: "a", label: "a add" },
	{ id: "d", label: "d delete the highlighted account" },
	{ id: "r", label: "r rename" },
	{ id: "s", label: "ctrl+s search" },
	{ id: "l", label: "l log" },
	{ id: "o", label: "o open the browser" },
	{ id: "esc", label: "esc close" },
];

const bench = makeBench(ITERATIONS);

function cardWidthOf(lines: readonly string[]): number {
	for (const styled of lines) {
		const line = styled.replace(/\x1b\[[0-9;:]*m/g, "");
		const start = line.search(/[╭┌]/);
		if (start === -1) continue;
		const end = line.search(/[╮┐]/);
		if (end > start) return end - start + 1;
	}
	return 0;
}

/** Cells a frame actually paints: every non-space column of every row. */
function paintedCells(lines: readonly string[]): number {
	let cells = 0;
	for (const line of lines) {
		for (const glyph of line.replace(/\x1b\[[0-9;:]*m/g, "")) if (glyph !== " ") cells += 1;
	}
	return cells;
}

/** Per-operation microseconds from the harness's total milliseconds. */
function perOpUs(totalMs: number): number {
	return (totalMs * 1000) / ITERATIONS;
}

function shellInput(corpus: CardCorpus, sizing: ModalSizing) {
	return {
		title: "Account",
		sizing,
		areaWidth: AREA_WIDTH,
		areaHeight: AREA_HEIGHT,
		body: corpus.rows,
		preferredBodyRows: corpus.rows.length,
		shortcuts: ACCOUNTS_FOOTER,
		showClose: true,
	};
}

/** The width the card asks for once its rows are measured: content, padding, borders. */
function contentWidthOf(corpus: CardCorpus): number {
	return Math.max(...corpus.rows.map(visibleWidth)) + 2 * MODAL_SIZING_MEDIUM.hPad + 2;
}

/**
 * The width the shell will actually give a preference, so the guard checks the
 * card the on arm can have rather than the one it asked for: `/session`'s two
 * short rows want 43 cells and `minWidth` holds the card at 44.
 */
function honoredWidth(preferred: number): number {
	const ceiling = Math.min(AREA_WIDTH - 4, MODAL_SIZING_MEDIUM.maxWidth);
	return Math.min(Math.max(preferred, MODAL_SIZING_MEDIUM.minWidth), ceiling);
}

async function main(): Promise<void> {
	setAnsiPolicy("full");
	await initTheme(false, "unicode", false, "titanium", "dark");

	// The recorder's terminal: 24-bit, a reported ground, nothing painted over it.
	const caps: { trueColor: boolean } = TERMINAL;
	caps.trueColor = true;
	resetGroundTintsForTest();
	setDetectedTerminalGround(RECORDER_GROUND);
	applyGroundPaint({ paint: null, unhonoredAlways: false }, {});
	if (groundHairlineHex() === undefined) benchFail("no hairline derived: the frame arm would measure the fallback");

	const percentageWidth = Math.floor(AREA_WIDTH * MODAL_SIZING_MEDIUM.widthPct);
	console.info(
		`area ${AREA_WIDTH}x${AREA_HEIGHT}, ${ITERATIONS} iterations, MEDIUM sizing (${percentageWidth} cells at ${MODAL_SIZING_MEDIUM.widthPct} of the area)`,
	);

	console.info("");
	console.info("── sizing: percentage card (off) against content card (on) ──");
	for (const corpus of CORPORA) {
		const contentWidth = contentWidthOf(corpus);
		const off = shellInput(corpus, MODAL_SIZING_MEDIUM);
		const on = shellInput(corpus, { ...MODAL_SIZING_MEDIUM, preferredWidth: contentWidth });
		const offFrame = renderModalShell(off);
		const onFrame = renderModalShell(on);
		if (offFrame.geometry === null || onFrame.geometry === null) benchFail(`${corpus.name}: card did not fit`);
		const offWidth = cardWidthOf(offFrame.lines);
		const onWidth = cardWidthOf(onFrame.lines);
		if (offWidth !== percentageWidth) benchFail(`${corpus.name}: off arm is not the percentage card (${offWidth})`);
		if (onWidth !== honoredWidth(contentWidth)) {
			benchFail(`${corpus.name}: on arm is not the content card (${onWidth}, wanted ${honoredWidth(contentWidth)})`);
		}
		if (offWidth === onWidth) benchFail(`${corpus.name}: both arms are ${onWidth} cells, so there is no arm here`);
		console.info(`  ${corpus.name}`);

		// Passes interleaved between the arms, because a render loop measured once
		// swings 2x on this machine: whichever arm ran first paid the tier-up of
		// everything the two share, and a later pass pays a collection the other
		// arm caused. p50 across interleaved passes is the reading; p95 is printed
		// beside it because a p95 far from the median is itself the finding.
		const offSamples: number[] = [];
		const onSamples: number[] = [];
		for (let pass = 1; pass <= PASSES; pass++) {
			offSamples.push(perOpUs(bench(`  ${corpus.name}  off pass ${pass}`, () => renderModalShell(off))));
			onSamples.push(perOpUs(bench(`  ${corpus.name}  on  pass ${pass}`, () => renderModalShell(on))));
		}
		const offStats = benchStats(offSamples);
		const onStats = benchStats(onSamples);
		console.info(`    card width      off ${offWidth} cells    on ${onWidth} cells`);
		console.info(`    painted cells   off ${paintedCells(offFrame.lines)}    on ${paintedCells(onFrame.lines)}`);
		console.info(
			`    per frame p50   off ${offStats.p50.toFixed(3)} µs    on ${onStats.p50.toFixed(3)} µs` +
				`    (p95 off ${offStats.p95.toFixed(3)}, on ${onStats.p95.toFixed(3)})`,
		);
	}

	console.info("");
	console.info("── frame paint: accent token (off) against ground hairline (on) ──");
	const accentOpen = theme.fg("borderAccent", "─");
	const hairline = cardOutlineColor();
	if (hairline("─") === accentOpen) benchFail("hairline and accent paint the same bytes: no arm to measure");
	const rule = "─".repeat(percentageWidth - 2);
	const accentMs = bench("  accent token                off", () => theme.fg("borderAccent", rule));
	const derivedMs = bench("  ground hairline, per rule   on ", () => cardOutlineColor()(rule));
	const hoistedMs = bench("  ground hairline, hoisted    on ", () => hairline(rule));
	console.info(
		`    per rule        off ${perOpUs(accentMs).toFixed(3)} µs    on ${perOpUs(derivedMs).toFixed(3)} µs    on hoisted ${perOpUs(hoistedMs).toFixed(3)} µs`,
	);

	console.info("");
	console.info("── footer strip: rows the balance pass produces, and what it costs ──");
	const stripCells = ACCOUNTS_FOOTER.reduce((sum, chip) => sum + visibleWidth(chip.label), 0) + 9 * 5;
	console.info(`  strip laid end to end: ${stripCells} cells`);
	for (const width of [70, 90, 110, 131]) {
		const rows = layoutShortcutRows(ACCOUNTS_FOOTER, width);
		const seen = rows.flatMap(row => row.chips.map(chip => chip.id));
		if (seen.length !== ACCOUNTS_FOOTER.length || seen.some((id, i) => id !== ACCOUNTS_FOOTER[i]?.id)) {
			benchFail(`footer at ${width} dropped or reordered chips: ${seen.join(",")}`);
		}
		const widths = rows.map(row => visibleWidth(row.plain));
		if (widths.some(rowWidth => rowWidth > width)) benchFail(`footer at ${width} overflows: ${widths.join(",")}`);
		const totalMs = bench(`  layoutShortcutRows w=${width}`, () => layoutShortcutRows(ACCOUNTS_FOOTER, width));
		console.info(
			`    w=${width}  rows ${widths.join(" / ")}  widest ${Math.max(...widths)}  ${perOpUs(totalMs).toFixed(3)} µs`,
		);
	}

	resetGroundTintsForTest();
}

await main();
