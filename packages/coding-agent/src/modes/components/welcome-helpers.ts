import { padding, replaceTabs, TERMINAL, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";
import { clamp01 } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import tipsText from "./tips.txt" with { type: "text" };

export const TIP_GATE = /^\[gate:([a-zA-Z0-9.]+)\]\s*/;

export interface TipEntry {
	text: string;
	gate?: string;
}

export const TIP_ENTRIES: readonly TipEntry[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0)
	.map(line => {
		const gate = TIP_GATE.exec(line);
		return gate ? { text: line.slice(gate[0].length), gate: gate[1] } : { text: line };
	});

export function filterTipsByGates(tips: readonly TipEntry[], isEnabled: (key: string) => boolean): string[] {
	return tips.filter(tip => tip.gate === undefined || isEnabled(tip.gate)).map(tip => tip.text);
}

export const TIPS: readonly string[] = TIP_ENTRIES.map(tip => tip.text);

export const WELCOME_SESSION_SLOTS = 3;

export const VEYYON_VALUE_LINE = "Hashline edits that land. Your keys.";

export const WELCOME_ACTIONS: ReadonlyArray<readonly [label: string, shortcut: string]> = [
	["Resume session", "/resume"],
	["Settings", "/settings"],
	["Providers", "/providers"],
	["Quit", "ctrl+d"],
];

export const NEW_TIP_MARKER = /\s*\[NEW\]\s*$/;

export const NEW_TAG_TEXT = "new";

export const NEW_TIP_WEIGHT = 4;

export function pickWeightedTip(tips: readonly string[], r: number): string {
	if (tips.length === 0) return "";
	const weights = new Array<number>(tips.length);
	let total = 0;
	for (let ti = 0; ti < tips.length; ti++) {
		weights[ti] = NEW_TIP_MARKER.test(tips[ti]!) ? NEW_TIP_WEIGHT : 1;
		total += weights[ti]!;
	}
	let acc = r * total;
	for (let i = 0; i < tips.length; i++) {
		acc -= weights[i] ?? 1;
		if (acc < 0) return tips[i] ?? "";
	}
	return tips[tips.length - 1] ?? "";
}

function renderNewTag(): string {
	return `\x1b[1m${silverEscape(1)}${NEW_TAG_TEXT}\x1b[0m`;
}

export function renderWelcomeTip(tip: string, boxWidth: number, _phase = 0): string[] {
	const label = "Tip: ";
	const labelWidth = visibleWidth(label);
	const bodyBudget = boxWidth - 1 - labelWidth; // 1 = leading indent
	if (bodyBudget < 8) return [];

	const isNew = NEW_TIP_MARKER.test(tip);
	const body = isNew ? tip.replace(NEW_TIP_MARKER, "") : tip;

	const wrappedBody = wrapTextWithAnsi(replaceTabs(body), bodyBudget);
	if (wrappedBody.length === 0) return [];

	const continuationIndent = padding(labelWidth);
	const styledLabel = theme.fg("infoAccent", label);

	const lines: string[] = new Array(wrappedBody.length);
	for (let li = 0; li < wrappedBody.length; li++) {
		const styledBody = theme.fg("muted", wrappedBody[li]!);
		const content = li === 0 ? `${styledLabel}${styledBody}` : `${continuationIndent}${styledBody}`;
		lines[li] = ` ${theme.italic(content)}`;
	}

	if (isNew) {
		const tag = renderNewTag();
		const tagWidth = 1 + visibleWidth(NEW_TAG_TEXT); // 1 = space separator
		const lastLine = lines[lines.length - 1];
		if (lastLine !== undefined && visibleWidth(lastLine) + tagWidth <= boxWidth) {
			lines[lines.length - 1] = `${lastLine} ${tag}`;
		} else {
			lines.push(` ${continuationIndent}${tag}`);
		}
	}

	return lines;
}

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting" | "available";
	fileTypes: string[];
}

export const SILVER_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[116, 123, 134],
	[198, 203, 212],
	[230, 233, 238],
];
export const LIGHT_SILVER_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[124, 131, 142],
	[92, 100, 112],
	[52, 59, 69],
];
export const SILVER_RAMP_256 = [243, 250, 255];
export const LIGHT_SILVER_RAMP_256 = [246, 242, 238];

export function silverEscape(intensity: number): string {
	const t = clamp01(intensity);
	const stops = theme.isLight ? LIGHT_SILVER_STOPS : SILVER_STOPS;
	const ramp256 = theme.isLight ? LIGHT_SILVER_RAMP_256 : SILVER_RAMP_256;
	if (TERMINAL.trueColor) {
		const seg = t * (stops.length - 1);
		const i = Math.min(stops.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = stops[i];
		const b = stops[i + 1];
		const r = Math.round(a[0] + (b[0] - a[0]) * f);
		const g = Math.round(a[1] + (b[1] - a[1]) * f);
		const bl = Math.round(a[2] + (b[2] - a[2]) * f);
		return `\x1b[38;2;${r};${g};${bl}m`;
	}
	const idx = Math.min(ramp256.length - 1, Math.max(0, Math.round(t * (ramp256.length - 1))));
	return `\x1b[38;5;${ramp256[idx]}m`;
}
