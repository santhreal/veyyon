import { type Component, centerLine, Ellipsis, padding, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { APP_NAME, DEFAULT_PROFILE_DIR_NAME, getActiveProfileOrDefault } from "@veyyon/utils";
import { isSettingsInitialized, settings } from "../../config/settings-instance";
import { theme } from "../../modes/theme/theme";

export { clearLaunchTip, setLaunchTip, updateInstalledTip } from "./launch-tip";

import { SGR_RESET } from "@veyyon/tui/ansi";
import { takeLaunchTip } from "./launch-tip";
import { sunMark } from "./sun";
import type { LspServerInfo, RecentSession } from "./welcome-helpers";
import {
	filterTipsByGates,
	pickWeightedTip,
	renderWelcomeTip,
	silverEscape,
	TIP_ENTRIES,
	TIPS,
	VEYYON_VALUE_LINE,
	WELCOME_ACTIONS,
	WELCOME_SESSION_SLOTS,
} from "./welcome-helpers";

export type { RecentSession };
export { filterTipsByGates, pickWeightedTip, renderWelcomeTip, silverEscape, TIP_ENTRIES };

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

export { LIGHT_SILVER_STOPS, SILVER_STOPS } from "./welcome-helpers";
