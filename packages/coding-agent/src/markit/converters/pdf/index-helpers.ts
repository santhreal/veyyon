import { resolveTableGrids } from "./grid";
import { renderPageContent } from "./render";
import type { Segment, TextBox } from "./types";

export const EXTENSIONS = [".pdf"];
export const MIMETYPES = ["application/pdf", "application/x-pdf"];

export type ImageBlock = { topY: number; markdown: string };

export function processColumn(
	pageNumber: number,
	textBoxes: TextBox[],
	segments: Segment[],
	imageBlocks: ImageBlock[],
): string {
	const { grids, consumedIds } = resolveTableGrids(pageNumber, textBoxes, segments);
	const consumedSet = new Set(consumedIds);
	const freeTextBoxes = textBoxes.filter(tb => !consumedSet.has(tb.id));
	return renderPageContent(freeTextBoxes, grids, imageBlocks, textBoxes);
}
