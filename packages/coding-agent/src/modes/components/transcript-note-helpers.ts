import { fillSurface, TERMINAL, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";
import type { ThemeColor } from "../theme/color";
import { getVisibleGround } from "../theme/ground-tints";
import { theme } from "../theme/theme";

export interface TranscriptNote {
	tone: ThemeColor;
	headline: string;
	rows: readonly string[];
}

export const NOTE_LIFT = 0.075;

export const NOTE_CHROME_COLS = 4;

export function renderTranscriptNote(note: TranscriptNote, contentWidth: number): string[] {
	const rail = theme.fg(note.tone, theme.sep.block);
	const textWidth = Math.max(8, contentWidth - NOTE_CHROME_COLS + 1);
	const headline = wrapTextWithAnsi(note.headline, textWidth);
	const rows: string[] = [];
	for (let ri = 0; ri < note.rows.length; ri++) {
		const row = note.rows[ri]!;
		if (row === "") {
			rows.push("");
			continue;
		}
		const wtLines = wrapTextWithAnsi(row, textWidth);
		for (let li = 0; li < wtLines.length; li++) rows.push(wtLines[li]!);
	}

	const lines: string[] = new Array(headline.length + (rows.length > 0 ? 1 : 0) + rows.length);
	let li = 0;
	for (let hi = 0; hi < headline.length; hi++) {
		lines[li++] = `${rail} ${theme.bold(theme.fg(note.tone, headline[hi]!))}`;
	}
	if (rows.length > 0) lines[li++] = rail;
	for (let ri = 0; ri < rows.length; ri++) {
		lines[li++] = rows[ri] === "" ? rail : `${rail} ${rows[ri]!}`;
	}

	const ground = TERMINAL.trueColor ? getVisibleGround() : undefined;
	if (ground === undefined) return lines;
	let widest = 0;
	for (let hi = 0; hi < headline.length; hi++) {
		const w = visibleWidth(headline[hi]!);
		if (w > widest) widest = w;
	}
	for (let ri = 0; ri < rows.length; ri++) {
		const w = visibleWidth(rows[ri]!);
		if (w > widest) widest = w;
	}
	const noteWidth = Math.min(contentWidth, widest + NOTE_CHROME_COLS);
	return fillSurface(lines, noteWidth, { ground, lift: NOTE_LIFT });
}
