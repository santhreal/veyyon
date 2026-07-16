import {
	type Component,
	Ellipsis,
	padding,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/pi-tui";
import { APP_NAME } from "@veyyon/pi-utils";
import { shimmerEnabled } from "../../modes/theme/shimmer";
import { theme } from "../../modes/theme/theme";
import { sunMark } from "./sun";
import tipsText from "./tips.txt" with { type: "text" };

/** Tips embedded at build time, one per line; blanks dropped. */
const TIPS: readonly string[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0);

/** Max recent-session rows shown under the action menu (only when present). */
export const WELCOME_SESSION_SLOTS = 3;

/**
 * Retained for call-site API stability. LSP status no longer paints on the
 * welcome hero (operational noise; it belongs in `/lsp` or the status line).
 */
export const WELCOME_LSP_SLOTS = 0;

/** One-line value prop under the wordmark — shipped strengths only. */
export const VEYYON_VALUE_LINE = "Hashline edits that land. Your keys.";

/** Card width cap — a constrained, centred column (Grok geometry), never full-bleed. */
const HERO_MAX_WIDTH = 72;
/** Sun mark size (cells) for the full card's left column. */
const SUN_W = 18;
const SUN_H = 8;
/** Below this inner width the sun is dropped and the identity goes full-width. */
const SUN_MIN_INNER = 42;
/** Sun mark size (cells) for the compact card — same disc, quarter the area. */
const COMPACT_SUN_W = 9;
const COMPACT_SUN_H = 4;
/** Below this inner width the compact card drops the sun. */
const COMPACT_SUN_MIN_INNER = 30;
/** Hard height contract for the compact card, borders and tip included. */
export const WELCOME_COMPACT_MAX_ROWS = 8;

/** Action rows: label left, shortcut right. The composer is the primary affordance. */
const WELCOME_ACTIONS: ReadonlyArray<readonly [label: string, shortcut: string]> = [
	["Resume session", "/resume"],
	["Settings", "/settings"],
	["Providers", "/providers"],
	["Quit", "ctrl+d"],
];

/** Trailing marker that flags a tip as a "what's new" callout. Stripped before
 *  wrapping (with any preceding whitespace) and replaced by {@link NEW_TAG_TEXT}
 *  painted with a silver shimmer. Non-global so `.test` stays stateless. */
const NEW_TIP_MARKER = /\s*\[NEW\]\s*$/;

/** Visible text rendered in place of {@link NEW_TIP_MARKER}. Quiet, not shouty. */
const NEW_TAG_TEXT = "new";

/** Selection weight for "[NEW]" tips; ordinary tips weigh 1, so a freshly added
 *  affordance surfaces this many times as often. */
const NEW_TIP_WEIGHT = 4;

/** Pick a tip from `tips`, biased toward "[NEW]" tips by {@link NEW_TIP_WEIGHT};
 *  `r` is a uniform sample in [0, 1). Returns "" when `tips` is empty.
 *  Exported for tests. */
export function pickWeightedTip(tips: readonly string[], r: number): string {
	if (tips.length === 0) return "";
	const weights = tips.map(tip => (NEW_TIP_MARKER.test(tip) ? NEW_TIP_WEIGHT : 1));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let acc = r * total;
	for (let i = 0; i < tips.length; i++) {
		acc -= weights[i] ?? 1;
		if (acc < 0) return tips[i] ?? "";
	}
	return tips[tips.length - 1] ?? "";
}

/** Static silver-bright tag — no rainbow, no motion (brand: restrained chrome). */
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
	const styledLabel = theme.fg("customMessageLabel", label);

	const lines = wrappedBody.map((line, index) => {
		const styledBody = theme.fg("muted", line);
		const content = index === 0 ? `${styledLabel}${styledBody}` : `${continuationIndent}${styledBody}`;
		return ` ${theme.italic(content)}`;
	});

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

/**
 * Welcome hero: one centred card. The living sun is the mark on the left; the
 * identity (wordmark, value line, action menu, recent sessions) sits on the
 * right. Grok card composition, Veyyon brand — silver on black, the sun the one
 * ember. No dashboard panels, no interior dividers, no clutter.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: Timer | null = null;
	#selectedTip: string | undefined;
	// Render cache: the welcome box is the first transcript-area component, so a
	// stable array reference keeps the whole frame prefix stable. Bypassed while
	// the intro animation runs (every frame differs).
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		private lspServers: LspServerInfo[] = [],
		/** Full hero (sun column, action menu, recents). Default is the compact
		 *  ≤{@link WELCOME_COMPACT_MAX_ROWS}-row card; `/welcome` shows the full one. */
		private readonly full: boolean = false,
	) {}

	get tip(): string | undefined {
		if (this.#selectedTip === undefined) {
			if (theme.getSymbolPreset() === "unicode" && Math.random() < 0.1) {
				this.#selectedTip = "Please use nerdfont for the best symbol rendering.";
			} else {
				this.#selectedTip = pickWeightedTip(TIPS, Math.random());
			}
		}
		return this.#selectedTip || undefined;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	/**
	 * Play the one-shot launch bloom: the sun rises from a hot point to a full
	 * resting disc, then settles. Safe to call repeatedly — it resets and replays.
	 * Degraded path: without truecolor, or with animations disabled
	 * (`display.shimmer: disabled`), the bloom is skipped entirely and the mark
	 * renders one static settled frame.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		if (!TERMINAL.trueColor || !shimmerEnabled()) {
			requestRender();
			return;
		}
		this.#animStart = performance.now();
		requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			requestRender();
		}, INTRO_TICK_MS);
	}

	/** Halt the intro timer — used when the card is dismissed mid-bloom so the
	 *  interval doesn't keep repainting a removed component. */
	stopIntro(): void {
		this.#stopAnimation();
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
		// The settled (resting) frame differs from the last intro frame.
		this.invalidate();
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

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
		this.invalidate();
	}

	render(termWidth: number): readonly string[] {
		const animating = this.#animStart != null;
		if (!animating && this.#cachedLines && this.#cachedWidth === termWidth) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(termWidth);
		if (animating) {
			this.#cachedLines = undefined;
			this.#cachedWidth = -1;
		} else {
			this.#cachedLines = lines;
			this.#cachedWidth = termWidth;
		}
		return lines;
	}

	#renderLines(termWidth: number): string[] {
		const boxWidth = Math.min(HERO_MAX_WIDTH, Math.max(0, termWidth - 2));
		if (boxWidth < 24) return [];
		const inner = boxWidth - 4; // │ + space + content + space + │
		if (!this.full) return this.#renderCompactLines(termWidth, boxWidth, inner);

		// Two columns, no interior divider: the sun on the left, identity on the right.
		const sunW = inner >= SUN_MIN_INNER ? SUN_W : 0;
		const gap = sunW ? 3 : 0;
		const rightW = Math.max(1, inner - sunW - gap);
		const sun = sunW ? this.#currentLogoFrame(sunW) : [];
		const right = this.#rightColumn(rightW);

		const rowsN = Math.max(sun.length, right.length);
		const sunTop = Math.floor((rowsN - sun.length) / 2);
		const rightTop = Math.floor((rowsN - right.length) / 2);
		const body: string[] = [""];
		for (let i = 0; i < rowsN; i++) {
			const l = sunW ? (sun[i - sunTop] ?? padding(sunW)) : "";
			const r = right[i - rightTop] ?? "";
			body.push(this.#fitToWidth(sunW ? l + padding(gap) + r : r, inner));
		}
		body.push("");
		for (const tipLine of this.#renderTip(inner)) {
			body.push(this.#fitToWidth(tipLine.trimStart(), inner));
		}

		// Plain sharp border — the identity lives inside the card, not on the rail.
		// Uses the visible `border` silver (not the recessive `borderMuted`) so the
		// hero card reads as a crisp frame on black, not a barely-there outline.
		const hChar = theme.boxSharp.horizontal;
		const bm = (s: string) => theme.fg("border", s);
		const v = bm(theme.boxSharp.vertical);
		const top = bm(theme.boxSharp.topLeft + hChar.repeat(boxWidth - 2) + theme.boxSharp.topRight);
		const bottom = bm(theme.boxSharp.bottomLeft + hChar.repeat(boxWidth - 2) + theme.boxSharp.bottomRight);

		// Centre the card horizontally in the terminal (Grok placement).
		const leftMargin = padding(Math.max(0, Math.floor((termWidth - boxWidth) / 2)));

		const lines: string[] = [leftMargin + top];
		for (const row of body) {
			lines.push(`${leftMargin}${v} ${this.#fitToWidth(row, inner)} ${v}`);
		}
		lines.push(leftMargin + bottom);
		return lines;
	}

	/**
	 * Compact card: the same two-column composition at quarter scale — a 4-row
	 * sun, wordmark, value line, model line, and a `/welcome` pointer — capped at
	 * {@link WELCOME_COMPACT_MAX_ROWS} rows including borders and tip.
	 */
	#renderCompactLines(termWidth: number, boxWidth: number, inner: number): string[] {
		const sunW = inner >= COMPACT_SUN_MIN_INNER ? COMPACT_SUN_W : 0;
		const gap = sunW ? 3 : 0;
		const rightW = Math.max(1, inner - sunW - gap);
		const sun = sunW ? this.#currentLogoFrame(sunW, COMPACT_SUN_H) : [];

		const right: string[] = [];
		right.push(
			this.#fitToWidth(theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`), rightW),
		);
		right.push(this.#fitToWidth(theme.fg("muted", VEYYON_VALUE_LINE), rightW));
		const model =
			this.modelName && this.providerName
				? `${this.modelName} · ${this.providerName}`
				: this.modelName || this.providerName;
		right.push(
			this.#fitToWidth(
				model ? theme.fg("dim", model) : theme.fg("dim", `no model yet · ${theme.fg("accent", "/login")}`),
				rightW,
			),
		);
		right.push(
			this.#fitToWidth(
				`${theme.fg("dim", "more:")} ${theme.fg("accent", "/welcome")}${theme.fg("dim", " · /resume · /settings")}`,
				rightW,
			),
		);

		const rowsN = Math.max(sun.length, right.length);
		const sunTop = Math.floor((rowsN - sun.length) / 2);
		const rightTop = Math.floor((rowsN - right.length) / 2);
		const body: string[] = [];
		for (let i = 0; i < rowsN; i++) {
			const l = sunW ? (sun[i - sunTop] ?? padding(sunW)) : "";
			const r = right[i - rightTop] ?? "";
			body.push(this.#fitToWidth(sunW ? l + padding(gap) + r : r, inner));
		}
		// Tip: exactly one line in compact. Wrapping breaks at word boundaries, so a
		// dropped continuation never trips #fitToWidth's overflow ellipsis — mark
		// the cut explicitly or the tip reads as a complete (garbled) sentence.
		const tipLines = this.#renderTip(inner);
		const tipLine = tipLines[0];
		if (tipLine !== undefined && body.length + 3 <= WELCOME_COMPACT_MAX_ROWS) {
			const clipped = tipLines.length > 1 ? `${tipLine.trimStart()}${theme.fg("muted", "…")}` : tipLine.trimStart();
			body.push(this.#fitToWidth(clipped, inner));
		}

		const hChar = theme.boxSharp.horizontal;
		const bm = (s: string) => theme.fg("border", s);
		const v = bm(theme.boxSharp.vertical);
		const top = bm(theme.boxSharp.topLeft + hChar.repeat(boxWidth - 2) + theme.boxSharp.topRight);
		const bottom = bm(theme.boxSharp.bottomLeft + hChar.repeat(boxWidth - 2) + theme.boxSharp.bottomRight);
		const leftMargin = padding(Math.max(0, Math.floor((termWidth - boxWidth) / 2)));

		const lines: string[] = [leftMargin + top];
		for (const row of body.slice(0, WELCOME_COMPACT_MAX_ROWS - 2)) {
			lines.push(`${leftMargin}${v} ${this.#fitToWidth(row, inner)} ${v}`);
		}
		lines.push(leftMargin + bottom);
		return lines;
	}

	/** Identity column: wordmark + version, value line, model, action menu, recents. */
	#rightColumn(w: number): string[] {
		const lines: string[] = [];
		lines.push(this.#fitToWidth(theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`), w));
		lines.push("");
		for (const line of wrapTextWithAnsi(VEYYON_VALUE_LINE, w)) {
			lines.push(this.#fitToWidth(theme.fg("muted", line), w));
		}
		// Model line. With a model set it reads `model · provider`; with none it
		// becomes a quiet call to action rather than a bare "Unknown · Unknown"
		// (a launch you can't act on is worse than one that tells you the next step).
		const model =
			this.modelName && this.providerName
				? `${this.modelName} · ${this.providerName}`
				: this.modelName || this.providerName;
		lines.push(
			this.#fitToWidth(
				model ? theme.fg("dim", model) : theme.fg("dim", `no model yet · ${theme.fg("accent", "/login")}`),
				w,
			),
		);
		lines.push("");
		for (const [label, shortcut] of WELCOME_ACTIONS) lines.push(this.#menuRow(label, shortcut, w));

		const sessions = this.recentSessions.slice(0, WELCOME_SESSION_SLOTS);
		if (sessions.length > 0) {
			lines.push("");
			lines.push(this.#fitToWidth(theme.fg("dim", "Recent"), w));
			for (const session of sessions) lines.push(this.#sessionRow(session, w));
		}
		return lines;
	}

	/** Label flush left, shortcut flush right. */
	#menuRow(label: string, shortcut: string, width: number): string {
		const used = visibleWidth(label) + visibleWidth(shortcut);
		const gap = Math.max(2, width - used);
		return this.#fitToWidth(
			`${theme.bold(theme.fg("accent", label))}${padding(gap)}${theme.fg("dim", shortcut)}`,
			width,
		);
	}

	/** Recent-session row: bullet + name, relative time flush right (name truncates first). */
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

	/** Fit string to exact width with ANSI-aware truncation/padding. */
	#fitToWidth(str: string, width: number): string {
		return truncateToWidth(str, width, Ellipsis.Unicode, true);
	}

	/**
	 * The sun mark for the card. At rest it is a steady ember disc; during the
	 * intro it blooms (radius eases open, dither churns) then settles. A pure
	 * function of elapsed time, so the intro timer drives it by re-rendering.
	 */
	#currentLogoFrame(sunW: number, sunH: number = SUN_H): readonly string[] {
		let bloom: number | undefined;
		let time = 0.6;
		if (this.#animStart != null) {
			const elapsed = performance.now() - this.#animStart;
			bloom = Math.min(1, elapsed / INTRO_MS);
			time = 0.2 + (elapsed / 1000) * 1.6;
		}
		return sunMark(sunW, sunH, { trueColor: TERMINAL.trueColor, bloom, time });
	}
}

/** Retained for API/compat and tests — the old box-drawing wordmark. */
export const VEYYON_LOGO = ["╦  ╦╔═╗╦ ╦╦ ╦╔═╗╔╗╔", "╚╗╔╝║╣ ╚═╣╚╦╝║ ║║║║", " ╚╝ ╚═╝  ╩ ╩ ╚═╝╝╚╝"];

/**
 * Veyyon silver luminance stops: dark → brand → bright. The middle/bright
 * stops are the brand silvers (website --silver / --silver-hi); brand-conformance
 * tests pin them to site.css so the wordmark shimmer cannot drift off-brand.
 */
export const SILVER_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[116, 123, 134], // #747B86
	[198, 203, 212], // #C6CBD4 — brand silver (website --silver / titanium `silver`)
	[230, 233, 238], // #E6E9EE — silver bright (website --silver-hi / titanium `silverBright`)
];

/** 256-color approx for the three silver stops. */
const SILVER_RAMP_256 = [243, 250, 255];

/**
 * Foreground SGR for a silver intensity in [0, 1] (0 = silver-dark, 0.5 = brand, 1 = bright).
 * Brand contract: monochrome silver only — no hue sweep.
 */
export function silverEscape(intensity: number): string {
	const t = Math.max(0, Math.min(1, intensity));
	if (TERMINAL.trueColor) {
		const seg = t * (SILVER_STOPS.length - 1);
		const i = Math.min(SILVER_STOPS.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = SILVER_STOPS[i];
		const b = SILVER_STOPS[i + 1];
		const r = Math.round(a[0] + (b[0] - a[0]) * f);
		const g = Math.round(a[1] + (b[1] - a[1]) * f);
		const bl = Math.round(a[2] + (b[2] - a[2]) * f);
		return `\x1b[38;2;${r};${g};${bl}m`;
	}
	const idx = Math.min(SILVER_RAMP_256.length - 1, Math.max(0, Math.round(t * (SILVER_RAMP_256.length - 1))));
	return `\x1b[38;5;${SILVER_RAMP_256[idx]}m`;
}

export interface ShineConfig {
	/** 0 = fully revealed / resting; 1 = intro start (edge hot). */
	strength: number;
	/** Reveal frontier along the wordmark (0..1), left → right. */
	pos: number;
}

/**
 * Wordmark foreground. Resting = brand silver. During entrance, `shine.pos` is
 * the reveal frontier and `shine.strength` warms the leading edge.
 */
export function gradientEscape(_t: number, shine?: ShineConfig): string {
	if (!shine || shine.strength <= 0) return silverEscape(0.55);
	const edge = Math.max(0, 1 - Math.abs(_t - shine.pos) / 0.12) * shine.strength;
	return silverEscape(0.45 + edge * 0.55);
}

/** Paint multi-line art in Veyyon silver with an optional left→right reveal. */
export function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
	const reset = "\x1b[0m";
	const cols = Math.max(1, ...lines.map(l => l.length));
	const frontier = shine ? Math.max(0, Math.min(1, shine.pos)) : 1;
	const edgeStrength = shine?.strength ?? 0;
	void phase;
	return lines.map(line => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			const t = x / Math.max(1, cols - 1);
			if (t > frontier + 0.02) {
				result += " ";
				continue;
			}
			const nearEdge = Math.max(0, 1 - Math.abs(t - frontier) / 0.14) * edgeStrength;
			const intensity = frontier >= 0.999 ? 0.55 : 0.4 + nearEdge * 0.6;
			result += silverEscape(intensity) + char + reset;
		}
		return result;
	});
}

/** Total length of the launch bloom. */
const INTRO_MS = 2200;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
