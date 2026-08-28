import {
	type Component,
	centerLine,
	Ellipsis,
	padding,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { APP_NAME, clamp01, DEFAULT_PROFILE_DIR_NAME, getActiveProfileOrDefault } from "@veyyon/utils";
import { isSettingsInitialized, settings } from "../../config/settings-instance";
import { theme } from "../../modes/theme/theme";

export { clearLaunchTip, setLaunchTip, updateInstalledTip } from "./launch-tip";

import { SGR_RESET } from "@veyyon/tui/ansi";
import { takeLaunchTip } from "./launch-tip";
import { sunMark } from "./sun";
import tipsText from "./tips.txt" with { type: "text" };

const TIP_GATE = /^\[gate:([a-zA-Z0-9.]+)\]\s*/;

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

const TIPS: readonly string[] = TIP_ENTRIES.map(tip => tip.text);

export const WELCOME_SESSION_SLOTS = 3;

export const VEYYON_VALUE_LINE = "Hashline edits that land. Your keys.";

const WELCOME_ACTIONS: ReadonlyArray<readonly [label: string, shortcut: string]> = [
	["Resume session", "/resume"],
	["Settings", "/settings"],
	["Providers", "/providers"],
	["Quit", "ctrl+d"],
];

const NEW_TIP_MARKER = /\s*\[NEW\]\s*$/;

const NEW_TAG_TEXT = "new";

const NEW_TIP_WEIGHT = 4;

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

export class WelcomeComponent implements Component {
	#selectedTip: string | undefined;
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		_lspServers: LspServerInfo[] = [],
		private readonly full: boolean = false,
	) {}

	get tip(): string | undefined {
		if (this.#selectedTip === undefined) {
			this.#selectedTip = takeLaunchTip();
		}
		if (this.#selectedTip === undefined) {
			if (theme.getSymbolPreset() === "unicode" && Math.random() < 0.1) {
				this.#selectedTip = "Please use nerdfont for the best symbol rendering.";
			} else {
				const visible = isSettingsInitialized()
					? filterTipsByGates(TIP_ENTRIES, key => settings.get(key as Parameters<typeof settings.get>[0]) === true)
					: TIPS;
				this.#selectedTip = pickWeightedTip(visible, Math.random());
			}
		}
		return this.#selectedTip || undefined;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
		this.invalidate();
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
		this.invalidate();
	}

	setLspServers(_servers: LspServerInfo[]): void {}

	render(termWidth: number): readonly string[] {
		if (this.#cachedLines && this.#cachedWidth === termWidth) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(termWidth);
		this.#cachedLines = lines;
		this.#cachedWidth = termWidth;
		return lines;
	}

	#renderLines(termWidth: number): string[] {
		if (termWidth < 30) return [];
		const lines = this.#sunriseHeader(termWidth);
		if (!this.full) {
			lines.push("");
			const recent = this.recentSessions[0];
			if (recent) {
				const nameBudget = Math.max(8, Math.min(40, termWidth - 30));
				const name =
					visibleWidth(recent.name) > nameBudget ? truncateToWidth(recent.name, nameBudget) : recent.name;
				lines.push(
					centerLine(
						theme.fg("muted", name) + theme.fg("dim", ` · ${recent.timeAgo} — `) + theme.fg("accent", "/resume"),
						termWidth,
					),
				);
			}
			const more = recent ? "  ·  /settings" : "  ·  /resume  ·  /settings";
			lines.push(
				centerLine(theme.fg("dim", "more: ") + theme.fg("accent", "/welcome") + theme.fg("dim", more), termWidth),
			);
			const tipBlock = this.#centeredTipBlock(termWidth);
			for (let ti = 0; ti < tipBlock.length; ti++) lines.push(tipBlock[ti]!);
			return lines;
		}
		const colW = Math.min(56, termWidth - 4);
		const colPad = padding(Math.max(0, Math.floor((termWidth - colW) / 2)));
		for (let ai = 0; ai < WELCOME_ACTIONS.length; ai++) {
			const [label, shortcut] = WELCOME_ACTIONS[ai]!;
			lines.push(colPad + this.#menuRow(label, shortcut, colW));
		}
		const sessions = this.recentSessions.slice(0, WELCOME_SESSION_SLOTS);
		if (sessions.length > 0) {
			lines.push("");
			for (let si = 0; si < sessions.length; si++) lines.push(colPad + this.#sessionRow(sessions[si]!, colW));
		}
		lines.push("");
		const tipLines = this.#renderTip(colW);
		for (let ti = 0; ti < tipLines.length; ti++) {
			const tipLine = tipLines[ti]!;
			lines.push(colPad + (tipLine.startsWith(" ") ? tipLine.slice(1) : tipLine));
		}
		return lines;
	}

	#sunriseHeader(termWidth: number): string[] {
		const lines: string[] = [];
		const rawRows = process.stdout.rows;
		const termRows = Number.isFinite(rawRows) && (rawRows ?? 0) > 0 ? (rawRows as number) : 60;
		const sunRowBudget = Math.max(6, termRows - 24);
		const sunW = Math.max(
			26,
			Math.min(60, Math.round(termWidth * 0.36), Math.round(((sunRowBudget - 2) * 2.1) / 0.6)),
		);
		const sunH = Math.min(Math.max(7, Math.round((sunW * 0.6) / 2.1) + 2), sunRowBudget);
		const sun = this.#currentLogoFrame(sunW, sunH);
		const sunPad = padding(Math.max(0, Math.floor((termWidth - sunW) / 2)));
		for (let ri = 0; ri < sun.length; ri++) lines.push(sunPad + sun[ri]!);
		lines.push("");
		const logoRows = gradientLogo([APP_NAME.split("").join(" ")]);
		for (let ri = 0; ri < logoRows.length; ri++) {
			lines.push(centerLine(theme.bold(logoRows[ri]!), termWidth));
		}
		lines.push("");
		const model =
			this.modelName && this.providerName
				? `${this.modelName} · ${this.providerName}`
				: this.modelName || this.providerName;
		const meta = model
			? theme.fg("dim", `v${this.version} · ${model}`)
			: theme.fg("dim", `v${this.version} · no model yet · `) + theme.fg("accent", "/login");
		const profile = getActiveProfileOrDefault();
		const metaLine =
			profile === DEFAULT_PROFILE_DIR_NAME ? meta : theme.fg("muted", profile) + theme.fg("dim", " · ") + meta;
		lines.push(centerLine(metaLine, termWidth));
		lines.push(centerLine(theme.fg("muted", VEYYON_VALUE_LINE), termWidth));
		return lines;
	}

	#menuRow(label: string, shortcut: string, width: number): string {
		const used = visibleWidth(label) + visibleWidth(shortcut);
		const gap = Math.max(2, width - used);
		return this.#fitToWidth(
			`${theme.bold(theme.fg("accent", label))}${padding(gap)}${theme.fg("dim", shortcut)}`,
			width,
		);
	}

	#sessionRow(session: RecentSession, width: number): string {
		const bullet = `${theme.md.bullet} `;
		const time = ` ${session.timeAgo}`;
		const budget = Math.max(1, width - visibleWidth(bullet) - visibleWidth(time));
		const name = visibleWidth(session.name) > budget ? truncateToWidth(session.name, budget) : session.name;
		return this.#fitToWidth(`${theme.fg("dim", bullet)}${theme.fg("muted", name)}${theme.fg("dim", time)}`, width);
	}

	#renderTip(boxWidth: number): string[] {
		const tip = this.tip;
		if (!tip) return [];
		return renderWelcomeTip(tip, boxWidth);
	}

	#centeredTipBlock(termWidth: number): string[] {
		const rawTipLines = this.#renderTip(Math.min(64, termWidth - 4));
		const tipLines: string[] = new Array(rawTipLines.length);
		for (let li = 0; li < rawTipLines.length; li++) {
			const line = rawTipLines[li]!;
			tipLines[li] = line.startsWith(" ") ? line.slice(1) : line;
		}
		if (tipLines.length === 0) return [];
		let blockWidth = 0;
		for (let li = 0; li < tipLines.length; li++) {
			const w = visibleWidth(tipLines[li]!);
			if (w > blockWidth) blockWidth = w;
		}
		const pad = padding(Math.max(0, Math.floor((termWidth - blockWidth) / 2)));
		const result: string[] = new Array(tipLines.length + 1);
		result[0] = "";
		for (let li = 0; li < tipLines.length; li++) result[li + 1] = pad + tipLines[li]!;
		return result;
	}

	#fitToWidth(str: string, width: number): string {
		return truncateToWidth(str, width, Ellipsis.Unicode, true);
	}

	#currentLogoFrame(sunW: number, sunH: number): readonly string[] {
		return sunMark(sunW, sunH, { trueColor: TERMINAL.trueColor, time: 0.6 });
	}
}

export const SILVER_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[116, 123, 134], // #747B86
	[198, 203, 212], // #C6CBD4 — brand silver (website --silver / titanium `silver`)
	[230, 233, 238], // #E6E9EE — silver bright (website --silver-hi / titanium `silverBright`)
];

export const LIGHT_SILVER_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[124, 131, 142], // #7C838E — light `silverDim`
	[92, 100, 112], // #5C6470 — light `silver`
	[52, 59, 69], // #343B45 — light `silverStrong`
];

const SILVER_RAMP_256 = [243, 250, 255];

const LIGHT_SILVER_RAMP_256 = [246, 242, 238];

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

export function gradientLogo(lines: readonly string[]): string[] {
	const reset = SGR_RESET;
	const result: string[] = new Array(lines.length);
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;
		let painted = "";
		for (let ci = 0; ci < line.length; ci++) {
			const char = line[ci]!;
			if (char === " ") {
				painted += char;
				continue;
			}
			painted += silverEscape(0.55) + char + reset;
		}
		result[li] = painted;
	}
	return result;
}
