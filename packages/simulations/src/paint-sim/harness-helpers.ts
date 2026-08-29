export interface PaintShape {
	width: number;
	height: number;
	headerRows: number;
	hudRows: number;
	footerRows: number;
	turns: number;
	streamFrames: number;
	scrollbackRebuild: boolean;
	virtualized: boolean;
	homeAnchor: boolean;
	shrink: ShrinkKind;
}

export interface PaintFrame {
	fullRedraws: number;
	erases: number;
	bytes: number;
}
export interface PaintReport {
	frames: PaintFrame[];
	fullRedraws: number;
	erases: number;
	bytes: number;
	lostTurns: number[];
	scrollTapeRows: number;
	hudShrinks: number;
	viewport: string[];
	blankBand: number;
	contentBlankRun: number;
	historyRowsOnScreen: number;
	shrinkRedraws: number;
	shrinkErases: number;
	topFillRows: number;
	bottomFillRows: number;
}

/** Shipped ways a settled screen ends up shorter than the viewport. */
export type ShrinkKind = "none" | "answer-collapse" | "hud-collapse";

export const SHRINKS: readonly ShrinkKind[] = ["none", "answer-collapse", "hud-collapse"];

/** Longest run of consecutive blank rows in `rows`. */
export function blankRun(rows: readonly string[]): number {
	let run = 0;
	let longest = 0;
	for (const row of rows) {
		run = row.trim().length === 0 ? run + 1 : 0;
		if (run > longest) longest = run;
	}
	return longest;
}

/** A finalized block: plain components are final, so their rows commit. */
