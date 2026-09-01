import type { TextBox } from "./types";

export interface ColumnLayout {
	columnCount: number;
	columns: TextBox[][];
	boundaries: number[];
}

const MIN_GAP_RATIO = 0.15;
const MIN_BOXES_PER_COLUMN = 4;
const MIN_GAP_PTS = 40;

export function detectColumns(textBoxes: TextBox[]): ColumnLayout {
	if (textBoxes.length < MIN_BOXES_PER_COLUMN * 2) {
		return { columnCount: 1, columns: [textBoxes], boundaries: [] };
	}
	const lefts = Array.from(new Set(textBoxes.map(tb => Math.round(tb.bounds.left)))).sort((a, b) => a - b);
	if (lefts.length < 2) {
		return { columnCount: 1, columns: [textBoxes], boundaries: [] };
	}
	const textXMin = lefts[0];
	const textXMax = Math.max(...textBoxes.map(tb => Math.round(tb.bounds.right)));
	const textWidth = textXMax - textXMin;
	if (textWidth <= 0) {
		return { columnCount: 1, columns: [textBoxes], boundaries: [] };
	}
	let maxGap = 0;
	let gapLeft = 0;
	let gapRight = 0;
	for (let i = 1; i < lefts.length; i++) {
		const gap = lefts[i] - lefts[i - 1];
		if (gap > maxGap) {
			maxGap = gap;
			gapLeft = lefts[i - 1];
			gapRight = lefts[i];
		}
	}
	const gapRatio = maxGap / textWidth;
	if (gapRatio < MIN_GAP_RATIO || maxGap < MIN_GAP_PTS) {
		return { columnCount: 1, columns: [textBoxes], boundaries: [] };
	}
	const splitX = (gapLeft + gapRight) / 2;
	const leftCol: TextBox[] = [];
	const rightCol: TextBox[] = [];
	for (const tb of textBoxes) {
		const cx = (tb.bounds.left + tb.bounds.right) / 2;
		if (cx < splitX) {
			leftCol.push(tb);
		} else {
			rightCol.push(tb);
		}
	}
	if (leftCol.length < MIN_BOXES_PER_COLUMN || rightCol.length < MIN_BOXES_PER_COLUMN) {
		return { columnCount: 1, columns: [textBoxes], boundaries: [] };
	}
	return {
		columnCount: 2,
		columns: [leftCol, rightCol],
		boundaries: [splitX],
	};
}
