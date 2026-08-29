import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Effort } from "@veyyon/ai";
import { attributesEnabled, colorEnabled } from "@veyyon/tui";
import type { SubCellBarRamp } from "@veyyon/tui/sub-cell-bar";
import { colorLuma, relativeLuminance } from "@veyyon/utils/color";
import * as logger from "@veyyon/utils/logger";
import { bgAnsi, type ColorMode, colorToAnsi, fgAnsi, resolveToHex, type ThemeBg, type ThemeColor } from "./color";
import { getVisibleGround } from "./ground-tints";
import {
	BAR_RAMPS,
	SPINNER_FRAMES,
	type SpinnerType,
	SYMBOL_PRESETS,
	type SymbolKey,
	type SymbolMap,
	type SymbolPreset,
} from "./symbols";

import { LANG_BRAND_COLORS, langMap } from "./theme-class-helpers";

export class Theme {
	#fgColors: Record<ThemeColor, string>;
	#bgColors: Record<ThemeBg, string>;
	readonly #hexFgColors: Record<ThemeColor, string>;
	readonly #hexBgColors: Record<ThemeBg, string>;
	#symbols: SymbolMap;
	#spinnerFramesOverrides: Partial<Record<SpinnerType, string[]>>;
	readonly #statusCache;
	readonly #navCache;
	readonly #treeCache;
	readonly #boxRoundCache;
	readonly #boxSharpCache;
	readonly #sepCache;
	readonly #iconCache;
	readonly #thinkingCache;
	readonly #checkboxCache;
	readonly #radioCache;
	readonly #formatCache;
	readonly #mdCache;
	readonly statusLineLuminance: number | undefined;
	readonly #statusLineContrastLuminance: number | undefined;
	readonly #groundHex: string | undefined;
	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		private readonly mode: ColorMode,
		private readonly symbolPreset: SymbolPreset,
		symbolOverrides: Partial<Record<SymbolKey, string>>,
		spinnerFramesOverrides: Partial<Record<SpinnerType, string[]>> = {},
		groundHex: string | undefined = undefined,
	) {
		this.#groundHex = groundHex;
		this.statusLineLuminance = colorLuma(bgColors.statusLineBg);
		this.#statusLineContrastLuminance = relativeLuminance(bgColors.statusLineBg);
		const slIsLight = this.statusLineLuminance !== undefined && this.statusLineLuminance > 0.5;

		this.#fgColors = {} as Record<ThemeColor, string>;
		this.#hexFgColors = {} as Record<ThemeColor, string>;
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.#fgColors[key] = fgAnsi(value, mode);
			this.#hexFgColors[key] = resolveToHex(value, slIsLight);
		}
		if (this.#fgColors.link === undefined) {
			this.#fgColors.link = this.#fgColors.mdLink;
			this.#hexFgColors.link = this.#hexFgColors.mdLink;
		}
		this.#bgColors = {} as Record<ThemeBg, string>;
		this.#hexBgColors = {} as Record<ThemeBg, string>;
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.#bgColors[key] = bgAnsi(value, mode);
			this.#hexBgColors[key] = resolveToHex(value, slIsLight);
		}
		const baseSymbols = SYMBOL_PRESETS[symbolPreset];
		this.#symbols = { ...baseSymbols };
		for (const [key, value] of Object.entries(symbolOverrides)) {
			if (key in this.#symbols) {
				this.#symbols[key as SymbolKey] = value;
			} else {
				logger.debug("Invalid symbol key in override", { key, availableKeys: Object.keys(this.#symbols) });
			}
		}
		this.#spinnerFramesOverrides = spinnerFramesOverrides;
		this.#statusCache = {
			success: this.#symbols["status.success"],
			error: this.#symbols["status.error"],
			warning: this.#symbols["status.warning"],
			info: this.#symbols["status.info"],
			pending: this.#symbols["status.pending"],
			disabled: this.#symbols["status.disabled"],
			enabled: this.#symbols["status.enabled"],
			running: this.#symbols["status.running"],
			connecting: this.#symbols["status.connecting"],
			active: this.#symbols["status.active"],
			shadowed: this.#symbols["status.shadowed"],
			aborted: this.#symbols["status.aborted"],
			done: this.#symbols["status.done"],
		};
		this.#navCache = {
			cursor: this.#symbols["nav.cursor"],
			selected: this.#symbols["nav.selected"],
			expand: this.#symbols["nav.expand"],
			collapse: this.#symbols["nav.collapse"],
			back: this.#symbols["nav.back"],
			prev: this.#symbols["nav.prev"],
			next: this.#symbols["nav.next"],
		};
		this.#treeCache = {
			branch: this.#symbols["tree.branch"],
			last: this.#symbols["tree.last"],
			vertical: this.#symbols["tree.vertical"],
			horizontal: this.#symbols["tree.horizontal"],
			hook: this.#symbols["tree.hook"],
		};
		this.#boxRoundCache = {
			topLeft: this.#symbols["boxRound.topLeft"],
			topRight: this.#symbols["boxRound.topRight"],
			bottomLeft: this.#symbols["boxRound.bottomLeft"],
			bottomRight: this.#symbols["boxRound.bottomRight"],
			horizontal: this.#symbols["boxRound.horizontal"],
			vertical: this.#symbols["boxRound.vertical"],
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
		this.#boxSharpCache = {
			topLeft: this.#symbols["boxSharp.topLeft"],
			topRight: this.#symbols["boxSharp.topRight"],
			bottomLeft: this.#symbols["boxSharp.bottomLeft"],
			bottomRight: this.#symbols["boxSharp.bottomRight"],
			horizontal: this.#symbols["boxSharp.horizontal"],
			vertical: this.#symbols["boxSharp.vertical"],
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
		this.#sepCache = {
			powerline: this.#symbols["sep.powerline"],
			powerlineThin: this.#symbols["sep.powerlineThin"],
			powerlineLeft: this.#symbols["sep.powerlineLeft"],
			powerlineRight: this.#symbols["sep.powerlineRight"],
			powerlineThinLeft: this.#symbols["sep.powerlineThinLeft"],
			powerlineThinRight: this.#symbols["sep.powerlineThinRight"],
			block: this.#symbols["sep.block"],
			space: this.#symbols["sep.space"],
			asciiLeft: this.#symbols["sep.asciiLeft"],
			asciiRight: this.#symbols["sep.asciiRight"],
			dot: this.#symbols["sep.dot"],
			slash: this.#symbols["sep.slash"],
			pipe: this.#symbols["sep.pipe"],
		};
		this.#iconCache = {
			model: this.#symbols["icon.model"],
			plan: this.#symbols["icon.plan"],
			prewalk: this.#symbols["icon.prewalk"],
			goal: this.#symbols["icon.goal"],
			pause: this.#symbols["icon.pause"],
			loop: this.#symbols["icon.loop"],
			folder: this.#symbols["icon.folder"],
			worktree: this.#symbols["icon.worktree"],
			scratchFolder: this.#symbols["icon.scratchFolder"],
			file: this.#symbols["icon.file"],
			git: this.#symbols["icon.git"],
			branch: this.#symbols["icon.branch"],
			pr: this.#symbols["icon.pr"],
			tokens: this.#symbols["icon.tokens"],
			context: this.#symbols["icon.context"],
			cost: this.#symbols["icon.cost"],
			time: this.#symbols["icon.time"],
			pi: this.#symbols["icon.pi"],
			ghost: this.#symbols["icon.ghost"],
			agents: this.#symbols["icon.agents"],
			job: this.#symbols["icon.job"],
			cache: this.#symbols["icon.cache"],
			cacheMiss: this.#symbols["icon.cacheMiss"],
			input: this.#symbols["icon.input"],
			output: this.#symbols["icon.output"],
			throughput: this.#symbols["icon.throughput"],
			host: this.#symbols["icon.host"],
			profile: this.#symbols["icon.profile"],
			session: this.#symbols["icon.session"],
			package: this.#symbols["icon.package"],
			warning: this.#symbols["icon.warning"],
			rewind: this.#symbols["icon.rewind"],
			auto: this.#symbols["icon.auto"],
			fast: this.#symbols["icon.fast"],
			extensionSkill: this.#symbols["icon.extensionSkill"],
			extensionTool: this.#symbols["icon.extensionTool"],
			extensionSlashCommand: this.#symbols["icon.extensionSlashCommand"],
			extensionMcp: this.#symbols["icon.extensionMcp"],
			extensionRule: this.#symbols["icon.extensionRule"],
			extensionHook: this.#symbols["icon.extensionHook"],
			extensionPrompt: this.#symbols["icon.extensionPrompt"],
			extensionContextFile: this.#symbols["icon.extensionContextFile"],
			extensionInstruction: this.#symbols["icon.extensionInstruction"],
			mic: this.#symbols["icon.mic"],
			camera: this.#symbols["icon.camera"],
		};
		this.#thinkingCache = {
			minimal: this.#symbols["thinking.minimal"],
			low: this.#symbols["thinking.low"],
			medium: this.#symbols["thinking.medium"],
			high: this.#symbols["thinking.high"],
			xhigh: this.#symbols["thinking.xhigh"],
			max: this.#symbols["thinking.max"],
			autoPending: this.#symbols["thinking.autoPending"],
		};
		this.#checkboxCache = {
			checked: this.#symbols["checkbox.checked"],
			unchecked: this.#symbols["checkbox.unchecked"],
			progress: this.#symbols["checkbox.progress"],
		};
		this.#radioCache = {
			selected: this.#symbols["radio.selected"],
			unselected: this.#symbols["radio.unselected"],
		};
		this.#formatCache = {
			bullet: this.#symbols["format.bullet"],
			dash: this.#symbols["format.dash"],
			bracketLeft: this.#symbols["format.bracketLeft"],
			bracketRight: this.#symbols["format.bracketRight"],
		};
		this.#mdCache = {
			quoteBorder: this.#symbols["md.quoteBorder"],
			hrChar: this.#symbols["md.hrChar"],
			bullet: this.#symbols["md.bullet"],
			colorSwatch: this.#symbols["md.colorSwatch"],
		};
	}

	get isLight(): boolean {
		return this.statusLineLuminance !== undefined && this.statusLineLuminance > 0.5;
	}

	get accentSurfaceLuminance(): number | undefined {
		return this.isLight ? this.#statusLineContrastLuminance : undefined;
	}

	getColorHex(color: ThemeColor): string {
		const hex = this.#hexFgColors[color];
		if (hex === undefined) throw new Error(`Unknown theme color: ${color}`);
		return hex || (this.isLight ? "#000000" : "#e5e5e7");
	}

	getBgColorHex(color: ThemeBg): string {
		const hex = this.#hexBgColors[color];
		if (hex === undefined) throw new Error(`Unknown theme background color: ${color}`);
		return hex;
	}

	getGroundHex(): string | undefined {
		return this.#groundHex;
	}

	getResolvedGroundHex(): string {
		return this.#groundHex ?? (this.isLight ? "#ffffff" : "#000000");
	}

	visibleGroundHex(): string {
		return getVisibleGround() ?? this.getResolvedGroundHex();
	}

	getAllThemeColorHexes(): string[] {
		const hexes: string[] = [];
		for (const hex of Object.values(this.#hexFgColors)) {
			if (hex) hexes.push(hex);
		}
		for (const hex of Object.values(this.#hexBgColors)) {
			if (hex) hexes.push(hex);
		}
		return hexes;
	}

	getMajorThemeColorHexes(): string[] {
		const majors: ThemeColor[] = [
			"accent",
			"border",
			"borderAccent",
			"borderMuted",
			"success",
			"error",
			"warning",
			"mdHeading",
			"mdLink",
			"mdCode",
			"mdCodeBlock",
			"mdQuoteBorder",
			"mdListBullet",
			"toolDiffAdded",
			"toolDiffRemoved",
			"customMessageLabel",
			"thinkingText",
		];
		const hexes: string[] = [];
		for (const key of majors) {
			const hex = this.#hexFgColors[key];
			if (hex) hexes.push(hex);
		}
		return hexes;
	}
	getAccentColorHex(): string {
		return this.getColorHex("accent");
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		if (!colorEnabled()) return text;
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		if (!colorEnabled()) return text;
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bgHex(hex: string, text: string): string {
		if (!colorEnabled()) return text;
		return `${bgAnsi(hex, this.mode)}${text}\x1b[49m`;
	}

	fgHexAnsi(hex: string): string {
		if (!colorEnabled()) return "";
		return colorToAnsi(hex, this.mode);
	}

	bold(text: string): string {
		return attributesEnabled() ? `\x1b[1m${text}\x1b[22m` : text;
	}

	italic(text: string): string {
		return attributesEnabled() ? `\x1b[3m${text}\x1b[23m` : text;
	}

	underline(text: string): string {
		return attributesEnabled() ? `\x1b[4m${text}\x1b[24m` : text;
	}

	strikethrough(text: string): string {
		return attributesEnabled() ? `\x1b[9m${text}\x1b[29m` : text;
	}

	inverse(text: string): string {
		return attributesEnabled() ? `\x1b[7m${text}\x1b[27m` : text;
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getContrastFgAnsi(fillColor: ThemeColor): string {
		const ansi = this.#fgColors[fillColor];
		const match = ansi ? /38;2;(\d+);(\d+);(\d+)/.exec(ansi) : null;
		if (!match) return this.#fgColors.text;
		const luma = 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3]);
		return luma > 140 ? "\x1b[38;2;0;0;0m" : "\x1b[38;2;255;255;255m";
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: ThinkingLevel | Effort): (str: string) => string {
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			case "max":
				return (str: string) => this.fg(this.#fgColors.thinkingMax ? "thinkingMax" : "thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}

	getPythonModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("pythonMode", str);
	}

	getBypassModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("error", str);
	}

	symbol(key: SymbolKey): string {
		return this.#symbols[key];
	}

	styledSymbol(key: SymbolKey, color: ThemeColor): string {
		const symbol = this.#symbols[key];
		return symbol ? this.fg(color, symbol) : "";
	}

	getSymbolPreset(): SymbolPreset {
		return this.symbolPreset;
	}

	get status() {
		return this.#statusCache;
	}

	get nav() {
		return this.#navCache;
	}

	get tree() {
		return this.#treeCache;
	}

	get boxRound() {
		return this.#boxRoundCache;
	}

	get boxSharp() {
		return this.#boxSharpCache;
	}

	get sep() {
		return this.#sepCache;
	}

	get icon() {
		return this.#iconCache;
	}

	get thinking() {
		return this.#thinkingCache;
	}

	get checkbox() {
		return this.#checkboxCache;
	}

	get radio() {
		return this.#radioCache;
	}

	get format() {
		return this.#formatCache;
	}

	get md() {
		return this.#mdCache;
	}

	get spinnerFrames(): string[] {
		return this.getSpinnerFrames();
	}

	getSpinnerFrames(type: SpinnerType = "status"): string[] {
		return this.#spinnerFramesOverrides[type] ?? SPINNER_FRAMES[this.symbolPreset][type];
	}

	getBarRamp(): SubCellBarRamp {
		return BAR_RAMPS[this.symbolPreset];
	}

	getLangIcon(lang: string | undefined): string {
		if (!lang) return this.#symbols["lang.default"];
		const key = langMap[lang.toLowerCase()];
		return key ? this.#symbols[key] : this.#symbols["lang.default"];
	}

	langBadge(lang: string | undefined): string {
		const icon = this.getLangIcon(lang);
		return icon ? `${this.fg("muted", icon)} ` : "";
	}

	getLangIconStyled(lang: string | undefined): string {
		const icon = this.getLangIcon(lang);
		if (!icon) return icon;
		const key = lang ? langMap[lang.toLowerCase()] : undefined;
		const hex = key ? LANG_BRAND_COLORS[key] : undefined;
		if (!hex) return this.fg("muted", icon);
		return `${colorToAnsi(hex, this.mode)}${icon}\x1b[39m`;
	}
}
