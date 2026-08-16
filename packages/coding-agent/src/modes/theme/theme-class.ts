// The Theme class: resolved color/symbol accessors for one loaded theme,
// including SGR emission (fg/bg), symbol lookup, spinner frames, and language
// icon tinting. Construction/registry/lifecycle live in theme.ts; this module
// owns only the per-instance behavior.

import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Effort } from "@veyyon/ai";
import { attributesEnabled, colorEnabled } from "@veyyon/tui";
import { colorLuma, relativeLuminance } from "@veyyon/utils/color";
// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import * as logger from "@veyyon/utils/logger";
import { bgAnsi, type ColorMode, colorToAnsi, fgAnsi, resolveToHex, type ThemeBg, type ThemeColor } from "./color";
import {
	SPINNER_FRAMES,
	type SpinnerType,
	SYMBOL_PRESETS,
	type SymbolKey,
	type SymbolMap,
	type SymbolPreset,
} from "./symbols";

// ============================================================================
// Theme Class
// ============================================================================

const langMap: Record<string, SymbolKey> = {
	typescript: "lang.typescript",
	ts: "lang.typescript",
	tsx: "lang.typescript",
	javascript: "lang.javascript",
	js: "lang.javascript",
	jsx: "lang.javascript",
	mjs: "lang.javascript",
	cjs: "lang.javascript",
	python: "lang.python",
	py: "lang.python",
	rust: "lang.rust",
	rs: "lang.rust",
	go: "lang.go",
	java: "lang.java",
	c: "lang.c",
	cpp: "lang.cpp",
	"c++": "lang.cpp",
	cc: "lang.cpp",
	cxx: "lang.cpp",
	csharp: "lang.csharp",
	cs: "lang.csharp",
	ruby: "lang.ruby",
	rb: "lang.ruby",
	julia: "lang.julia",
	jl: "lang.julia",
	php: "lang.php",
	swift: "lang.swift",
	kotlin: "lang.kotlin",
	kt: "lang.kotlin",
	bash: "lang.shell",
	sh: "lang.shell",
	zsh: "lang.shell",
	fish: "lang.shell",
	powershell: "lang.shell",
	just: "lang.shell",
	shell: "lang.shell",
	html: "lang.html",
	htm: "lang.html",
	astro: "lang.html",
	vue: "lang.html",
	svelte: "lang.html",
	css: "lang.css",
	scss: "lang.css",
	sass: "lang.css",
	less: "lang.css",
	json: "lang.json",
	yaml: "lang.yaml",
	yml: "lang.yaml",
	markdown: "lang.markdown",
	md: "lang.markdown",
	sql: "lang.sql",
	dockerfile: "lang.docker",
	docker: "lang.docker",
	lua: "lang.lua",
	text: "lang.text",
	txt: "lang.text",
	plain: "lang.text",
	log: "lang.log",
	env: "lang.env",
	dotenv: "lang.env",
	toml: "lang.toml",
	xml: "lang.xml",
	ini: "lang.ini",
	conf: "lang.conf",
	cfg: "lang.conf",
	config: "lang.conf",
	properties: "lang.conf",
	csv: "lang.csv",
	tsv: "lang.tsv",
	image: "lang.image",
	img: "lang.image",
	png: "lang.image",
	jpg: "lang.image",
	jpeg: "lang.image",
	gif: "lang.image",
	webp: "lang.image",
	svg: "lang.image",
	ico: "lang.image",
	bmp: "lang.image",
	tiff: "lang.image",
	pdf: "lang.pdf",
	zip: "lang.archive",
	tar: "lang.archive",
	gz: "lang.archive",
	tgz: "lang.archive",
	bz2: "lang.archive",
	xz: "lang.archive",
	"7z": "lang.archive",
	exe: "lang.binary",
	dll: "lang.binary",
	so: "lang.binary",
	dylib: "lang.binary",
	wasm: "lang.binary",
	bin: "lang.binary",
};

/**
 * Brand colors for language icons, keyed by the resolved `lang.*` SymbolKey.
 * Used by {@link Theme.getLangIconStyled} so eval-kernel cell headers tint each
 * language with its recognizable hue (JS yellow, Ruby red, Julia purple, Python
 * blue) instead of a flat muted gray. Applied as truecolor/256 per the active
 * color mode; languages without an entry fall back to the muted theme color.
 */
const LANG_BRAND_COLORS: Partial<Record<SymbolKey, string>> = {
	"lang.javascript": "#f7df1e",
	"lang.python": "#3776ab",
	"lang.ruby": "#cc342d",
	"lang.julia": "#9558b2",
};

export class Theme {
	#fgColors: Record<ThemeColor, string>;
	#bgColors: Record<ThemeBg, string>;
	/** Resolved hex strings for foreground colors — populated at construction. */
	readonly #hexFgColors: Record<ThemeColor, string>;
	/** Resolved hex strings for background colors — populated at construction. */
	readonly #hexBgColors: Record<ThemeBg, string>;
	#symbols: SymbolMap;
	#spinnerFramesOverrides: Partial<Record<SpinnerType, string[]>>;
	/**
	 * Perceptual luma (0..1) of the status-line background — used to classify the
	 * theme light/dark. Undefined when it can't be resolved. Classified against the
	 * status line (the surface session accents render on) rather than the chat bubble
	 * (`userMessageBg`), which some themes (e.g. `porcelain`) style dark on an
	 * otherwise-light theme.
	 */
	readonly statusLineLuminance: number | undefined;
	/** WCAG relative luminance of the status-line background — basis for accent contrast. */
	readonly #statusLineContrastLuminance: number | undefined;
	/**
	 * The theme's terminal ground as `#RRGGBB`, or undefined when the theme
	 * declares none. This is the color the painted-ground feature
	 * (`tui.paintGround`) sets as the terminal background, derived from the
	 * theme's `export.pageBg` and validated to a 6-digit hex at construction.
	 */
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
		// `link` (bare-URL/interactive link color) is optional in theme JSON;
		// themes without it inherit the markdown link color.
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
		// Build symbol map from preset + overrides
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
	}

	/** True when the active theme has a light status-line background. */
	get isLight(): boolean {
		return this.statusLineLuminance !== undefined && this.statusLineLuminance > 0.5;
	}

	/**
	 * Surface luminance to size session accents against on light themes; undefined on
	 * dark themes so accents stay vivid. Pass straight to `getSessionAccentHex`.
	 */
	get accentSurfaceLuminance(): number | undefined {
		return this.isLight ? this.#statusLineContrastLuminance : undefined;
	}

	/**
	 * Get the resolved CSS hex string for a foreground theme color.
	 */
	getColorHex(color: ThemeColor): string {
		const hex = this.#hexFgColors[color];
		if (hex === undefined) throw new Error(`Unknown theme color: ${color}`);
		return hex || (this.isLight ? "#000000" : "#e5e5e7");
	}

	/**
	 * Get the resolved CSS hex string for a background theme color (the
	 * background-key counterpart to {@link getColorHex}). Backgrounds are
	 * pre-resolved at construction, so a default-terminal background surfaces as
	 * the theme's resolved default rather than the raw "".
	 */
	getBgColorHex(color: ThemeBg): string {
		const hex = this.#hexBgColors[color];
		if (hex === undefined) throw new Error(`Unknown theme background color: ${color}`);
		return hex;
	}

	/**
	 * The theme's terminal ground color as `#RRGGBB`, or undefined when the theme
	 * declares none. The painted-ground consumer (`tui.paintGround`) uses this as
	 * the OSC 11 background color; a theme without a ground returns undefined and
	 * the consumer inherits the terminal's own background rather than inventing a
	 * color the theme never chose.
	 */
	getGroundHex(): string | undefined {
		return this.#groundHex;
	}

	/**
	 * The ground an animation resolves a color OUT OF: the declared ground when the
	 * theme has one, else the extreme of its appearance.
	 *
	 * Distinct from {@link getGroundHex}, and the difference is which answer is
	 * safe. Painting the terminal background with a color the theme never declared
	 * would leave the operator's terminal recolored, so that consumer takes the
	 * undefined. An animation cannot use undefined — it needs a color to mix from
	 * for one frame — and black or white by appearance is the neutral choice, never
	 * the terminal's own reported background, which is how a fade acquires a hue
	 * the theme has nothing to do with.
	 */
	getResolvedGroundHex(): string {
		return this.#groundHex ?? (this.isLight ? "#ffffff" : "#000000");
	}

	/**
	 * Get all foreground and background theme colors as CSS hex strings.
	 * Skips colors resolved to the default terminal color (unstyled).
	 */
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

	/**
	 * Get the most visually dominant theme colors as CSS hex strings — accent,
	 * border, success, error, warning, heading, link, diff markers, etc.
	 * These are the colors the session accent could visually clash with.
	 * Skips colors resolved to the default terminal color (unstyled).
	 */
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
	/**
	 * Get the resolved CSS hex string for the theme's accent color.
	 */
	getAccentColorHex(): string {
		return this.getColorHex("accent");
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		// The unknown-colour check runs FIRST and unconditionally: a typo'd key
		// must fail the same way whether or not colour happens to be enabled, or
		// the bug only surfaces on the machines that render it.
		if (!colorEnabled()) return text;
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		if (!colorEnabled()) return text;
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	/**
	 * A background band in a hex an animation computed, rather than one of the
	 * theme's named backgrounds. Degradation is the same as {@link bg}: the color
	 * goes through the theme's own color mode, so a 256-color terminal gets the
	 * nearest index and a mono one gets no band at all.
	 *
	 * The caller owns the color. This exists because a fading band's color is not
	 * a theme color — it is a mix of one with whatever it sits on — and the
	 * alternative was every animated surface writing its own `48;2;r;g;b`.
	 */
	bgHex(hex: string, text: string): string {
		if (!colorEnabled()) return text;
		return `${bgAnsi(hex, this.mode)}${text}\x1b[49m`;
	}

	// Text attributes emit raw SGR pairs, NEVER chalk: chalk's level
	// auto-detection returned 0 under bun-in-tmux and silently stripped every
	// bold/italic in the live TUI (markdown **emphasis** rendered as plain
	// text, the wordmark lost its weight) while the theme's own raw truecolor
	// escapes painted fine. The theme already IS the terminal-capability
	// authority here; a second detector that can quietly disagree is a silent
	// fallback (Law 10). Each attribute closes with its specific off-code so
	// nesting inside colored spans survives.
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

	/**
	 * Foreground ANSI for text drawn **on top of** `fillColor` used as a solid
	 * background (e.g. a powerline chip). Picks near-black or near-white by the
	 * fill's perceived luminance (Rec. 601 luma) so the label stays legible on
	 * both bright and dark fills, across light and dark themes.
	 *
	 * Reads the RGB out of the already-resolved truecolor escape; when the fill
	 * is encoded as a 256-palette index (limited terminals) the RGB is
	 * unavailable, so it falls back to the theme `text` color.
	 */
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
		// Map thinking levels to dedicated theme colors
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
				// thinkingMax is optional; themes without it resolve to the xhigh color.
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

	/**
	 * Border/glyph color for the `/yolo` full-bypass danger state. Uses the
	 * theme's `error` role so "every prompt is off" reads as loud and unmistakable
	 * in every theme. Single owner for the bypass indicator color.
	 */
	getBypassModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("error", str);
	}

	// ============================================================================
	// Symbol Methods
	// ============================================================================

	/**
	 * Get a symbol by key.
	 */
	symbol(key: SymbolKey): string {
		return this.#symbols[key];
	}

	/**
	 * Get a symbol styled with a color.
	 */
	styledSymbol(key: SymbolKey, color: ThemeColor): string {
		const symbol = this.#symbols[key];
		return symbol ? this.fg(color, symbol) : "";
	}

	/**
	 * Get the current symbol preset.
	 */
	getSymbolPreset(): SymbolPreset {
		return this.symbolPreset;
	}

	// ============================================================================
	// Symbol Category Accessors
	// ============================================================================

	get status() {
		return {
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
	}

	get nav() {
		return {
			cursor: this.#symbols["nav.cursor"],
			selected: this.#symbols["nav.selected"],
			expand: this.#symbols["nav.expand"],
			collapse: this.#symbols["nav.collapse"],
			back: this.#symbols["nav.back"],
			prev: this.#symbols["nav.prev"],
			next: this.#symbols["nav.next"],
		};
	}

	get tree() {
		return {
			branch: this.#symbols["tree.branch"],
			last: this.#symbols["tree.last"],
			vertical: this.#symbols["tree.vertical"],
			horizontal: this.#symbols["tree.horizontal"],
			hook: this.#symbols["tree.hook"],
		};
	}

	get boxRound() {
		return {
			topLeft: this.#symbols["boxRound.topLeft"],
			topRight: this.#symbols["boxRound.topRight"],
			bottomLeft: this.#symbols["boxRound.bottomLeft"],
			bottomRight: this.#symbols["boxRound.bottomRight"],
			horizontal: this.#symbols["boxRound.horizontal"],
			vertical: this.#symbols["boxRound.vertical"],
			// Junctions have no rounded Unicode variant, so a rounded box reuses the
			// sharp tee/cross glyphs. Sourcing them from the boxSharp.* tokens keeps a
			// theme's `boxSharp.tee*` overrides effective for rounded-box dividers.
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
	}

	get boxSharp() {
		return {
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
	}

	get sep() {
		return {
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
	}

	get icon() {
		return {
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
	}

	get thinking() {
		return {
			minimal: this.#symbols["thinking.minimal"],
			low: this.#symbols["thinking.low"],
			medium: this.#symbols["thinking.medium"],
			high: this.#symbols["thinking.high"],
			xhigh: this.#symbols["thinking.xhigh"],
			max: this.#symbols["thinking.max"],
			autoPending: this.#symbols["thinking.autoPending"],
		};
	}

	/** Three task states, not two plus a colour. `progress` is total the same way
	 *  its siblings are: every preset is typed `SymbolMap`, so a preset cannot
	 *  omit the key, and the override loop above only assigns keys already
	 *  present rather than introducing or deleting any. */
	get checkbox() {
		return {
			checked: this.#symbols["checkbox.checked"],
			unchecked: this.#symbols["checkbox.unchecked"],
			progress: this.#symbols["checkbox.progress"],
		};
	}

	get radio() {
		return {
			selected: this.#symbols["radio.selected"],
			unselected: this.#symbols["radio.unselected"],
		};
	}

	get format() {
		return {
			bullet: this.#symbols["format.bullet"],
			dash: this.#symbols["format.dash"],
			bracketLeft: this.#symbols["format.bracketLeft"],
			bracketRight: this.#symbols["format.bracketRight"],
		};
	}

	get md() {
		return {
			quoteBorder: this.#symbols["md.quoteBorder"],
			hrChar: this.#symbols["md.hrChar"],
			bullet: this.#symbols["md.bullet"],
			colorSwatch: this.#symbols["md.colorSwatch"],
		};
	}

	/**
	 * Default spinner frames (status spinner).
	 */
	get spinnerFrames(): string[] {
		return this.getSpinnerFrames();
	}

	/**
	 * Get spinner frames by type.
	 */
	getSpinnerFrames(type: SpinnerType = "status"): string[] {
		return this.#spinnerFramesOverrides[type] ?? SPINNER_FRAMES[this.symbolPreset][type];
	}

	/**
	 * The badge for a language, or the empty string when the preset has none.
	 *
	 * AN EMPTY GLYPH IS AN ANSWER, not a hole to patch. This used to resurrect a blank
	 * per-language glyph as `lang.default`, so the unicode preset — where every language is
	 * deliberately blank — badged every file in the product with `⌘`, the Command mark, and
	 * an Edit header read `⌘ packages/tui/src/box.ts`. The same mark on every row carries no
	 * information and costs two columns of a header that truncates its path to fit.
	 *
	 * Callers therefore have to cope with `""` by omitting the separator they would have put
	 * after it, which is the one thing the fallback was hiding.
	 */
	getLangIcon(lang: string | undefined): string {
		if (!lang) return this.#symbols["lang.default"];
		const key = langMap[lang.toLowerCase()];
		return key ? this.#symbols[key] : this.#symbols["lang.default"];
	}

	/**
	 * The muted language badge AND the space after it, or `""` when the preset has none.
	 *
	 * Every header that puts a badge before a path wants exactly this, and each one used to
	 * build it itself as `${icon} ${path}`. With a preset that has no glyph for the language
	 * that leaves a leading space before the path, so the fix for the universal `⌘` badge
	 * would have traded one cosmetic defect for another on four surfaces. The separator
	 * belongs to the badge.
	 */
	langBadge(lang: string | undefined): string {
		const icon = this.getLangIcon(lang);
		return icon ? `${this.fg("muted", icon)} ` : "";
	}

	/**
	 * Language icon tinted with the language's brand color (see
	 * {@link LANG_BRAND_COLORS}). Falls back to the muted theme color for
	 * languages without a brand entry, and returns the bare (possibly empty)
	 * icon when the active symbol preset has none.
	 */
	getLangIconStyled(lang: string | undefined): string {
		const icon = this.getLangIcon(lang);
		if (!icon) return icon;
		const key = lang ? langMap[lang.toLowerCase()] : undefined;
		const hex = key ? LANG_BRAND_COLORS[key] : undefined;
		if (!hex) return this.fg("muted", icon);
		return `${colorToAnsi(hex, this.mode)}${icon}\x1b[39m`;
	}
}
