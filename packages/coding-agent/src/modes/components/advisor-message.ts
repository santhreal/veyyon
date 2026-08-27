import { type Component, visibleWidth } from "@veyyon/tui";
import { formatCount } from "@veyyon/utils";
import type { AdvisorMessageDetails, AdvisorSeverity } from "../../advisor";
import {
	createCachedComponent,
	formatBadge,
	replaceTabs,
	type ToolUIColor,
	wrapTextWithAnsi,
} from "../../tools/render-utils";
import { Ellipsis, truncateToWidth } from "../../tui";
import type { Theme } from "../theme/theme";

const COLLAPSED_NOTES = 3;
const NOTE_LINE_WIDTH = 110;

function wrapVarying(text: string, w1: number, w2: number): string[] {
	if (text.length === 0) return [];
	const firstWrap = wrapTextWithAnsi(text, w1);
	if (firstWrap.length <= 1) {
		return firstWrap;
	}
	const firstLine = firstWrap[0];
	const idx = text.indexOf(firstLine);
	if (idx === -1) {
		return wrapTextWithAnsi(text, w2);
	}
	const remainder = text.slice(idx + firstLine.length).trimStart();
	const restWrap = wrapTextWithAnsi(remainder, w2);
	return [firstLine, ...restWrap];
}

function severityColor(severity: AdvisorSeverity | undefined): ToolUIColor {
	switch (severity) {
		case "blocker":
			return "error";
		case "concern":
			return "warning";
		default:
			return "muted";
	}
}

/**
 * Display-only transcript card for advisor notes injected into the primary
 * session. Styled as a distinct voice so notes never blend into thinking
 * output (whose `thinkingText` color equals `toolOutput` in most themes):
 * a bold `customMessageLabel` header tag (skill-card convention), a heavy
 * rail tinted per-note severity, and the note body on the default text color.
 */
export function createAdvisorMessageCard(
	details: AdvisorMessageDetails | undefined,
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const notes = details?.notes ?? [];
	let blockers = 0;
	for (let ni = 0; ni < notes.length; ni++) {
		if (notes[ni]!.severity === "blocker") blockers++;
	}
	const meta: string[] = [formatCount("note", notes.length)];
	if (blockers > 0) meta.push(uiTheme.fg("error", formatCount("blocker", blockers)));

	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const tag = uiTheme.fg("customMessageLabel", uiTheme.bold(`${uiTheme.status.info} Advisor`));
			const lines = [`${tag} ${uiTheme.fg("dim", meta.join(uiTheme.sep.dot))}`];
			const railGlyph = uiTheme.symbol("advisor.rail");
			const shown = expanded ? notes : notes.slice(0, COLLAPSED_NOTES);
			for (let ni = 0; ni < shown.length; ni++) {
				const entry = shown[ni]!;
				const badge = entry.severity
					? `${formatBadge(entry.severity, severityColor(entry.severity), uiTheme)} `
					: "";
				// Multi-advisor: attribute the note to its source. The implicit
				// single ("default") advisor renders unlabeled, as before.
				const who =
					entry.advisor && entry.advisor !== "default"
						? `${uiTheme.fg("dim", `[${replaceTabs(entry.advisor)}]`)} `
						: "";
				const rail = uiTheme.fg(severityColor(entry.severity), railGlyph);
				const quoteWidth = visibleWidth(`  ${railGlyph} `);
				const badgeWidth = visibleWidth(badge);
				const whoWidth = visibleWidth(who);
				const w1 = Math.max(10, Math.min(NOTE_LINE_WIDTH, width) - quoteWidth - badgeWidth - whoWidth);
				const w2 = Math.max(10, Math.min(NOTE_LINE_WIDTH, width) - quoteWidth);

				const rawParagraphs = entry.note.split("\n");
				const paragraphs: string[] = [];
				for (let pi = 0; pi < rawParagraphs.length; pi++) {
					const p = rawParagraphs[pi]!;
					if (p.trim()) paragraphs.push(p);
				}
				const bodyLines: string[] = [];
				for (let i = 0; i < paragraphs.length; i++) {
					const p = paragraphs[i];
					if (i === 0) {
						const wv = wrapVarying(p, w1, w2);
						for (let li = 0; li < wv.length; li++) bodyLines.push(wv[li]!);
					} else {
						const wt = wrapTextWithAnsi(p, w2);
						for (let li = 0; li < wt.length; li++) bodyLines.push(wt[li]!);
					}
				}

				for (let bi = 0; bi < bodyLines.length; bi++) {
					const prefix = bi === 0 ? `${badge}${who}` : "";
					lines.push(`  ${rail} ${prefix}${uiTheme.fg("customMessageText", replaceTabs(bodyLines[bi]!))}`);
				}
			}
			const hidden = notes.length - shown.length;
			if (hidden > 0) {
				const rail = uiTheme.fg("dim", railGlyph);
				lines.push(`  ${rail} ${uiTheme.fg("dim", `… +${hidden} more ${hidden === 1 ? "note" : "notes"}`)}`);
			}
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}
