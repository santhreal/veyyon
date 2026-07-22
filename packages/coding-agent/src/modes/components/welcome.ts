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
import { shimmerEnabled } from "../../modes/theme/shimmer";
import { theme } from "../../modes/theme/theme";
import { sunMark } from "./sun";
import { isSettingsInitialized, settings } from "../../config/settings";
import tipsText from "./tips.txt" with { type: "text" };

/** Optional gate prefix on a tips.txt line: `[gate:magicKeywords.enabled]`.
 *  A gated tip is shown only while that boolean setting is true — a tip that
 *  says "type `orchestrate` and watch it glow" is a lie when magic keywords
 *  are disabled, and the hero must never advertise behavior the user turned
 *  off. */
const TIP_GATE = /^\[gate:([a-zA-Z0-9.]+)\]\s*/;

/** A tip's display text plus the boolean setting that must be true to show it. */
export interface TipEntry {
	text: string;
	gate?: string;
}

/** Tips embedded at build time, one per line; blanks dropped. Exported for the
 *  schema-conformance test (every gate must name a real settings key). */
export const TIP_ENTRIES: readonly TipEntry[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0)
	.map(line => {
		const gate = TIP_GATE.exec(line);
		return gate ? { text: line.slice(gate[0].length), gate: gate[1] } : { text: line };
	});

/** Resolve gated tips against live settings. `isEnabled` is injected so tests
 *  need no settings singleton; unknown keys are the conformance test's job,
 *  not a runtime branch. Exported for tests. */
export function filterTipsByGates(tips: readonly TipEntry[], isEnabled: (key: string) => boolean): string[] {
	return tips.filter(tip => tip.gate === undefined || isEnabled(tip.gate)).map(tip => tip.text);
}

const TIPS: readonly string[] = TIP_ENTRIES.map(tip => tip.text);

/** Max recent-session rows shown under the action menu (only when present). */
export const WELCOME_SESSION_SLOTS = 3;

/**
 * Retained for call-site API stability. LSP status no longer paints on the
 * welcome hero (operational noise; it belongs in `/lsp` or the status line).
 */
export const WELCOME_LSP_SLOTS = 0;

/** One-line value prop under the wordmark — shipped strengths only. */
export const VEYYON_VALUE_LINE = "Hashline edits that land. Your keys.";

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
	// Daybreak cool arc: informational callouts carry the info accent (rose on
	// titanium), keeping tips visually distinct from session/mode/share chrome.
	const styledLabel = theme.fg("infoAccent", label);

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
		// LSP status no longer paints on the welcome hero (see WELCOME_LSP_SLOTS);
		// this positional slot is retained for call-site API stability and discarded.
		_lspServers: LspServerInfo[] = [],
		/** Sunrise header + centred menu column on `/welcome`; the default home is
		 *  the header alone with one hint line. */
		private readonly full: boolean = false,
	) {}

	get tip(): string | undefined {
		if (this.#selectedTip === undefined) {
			if (theme.getSymbolPreset() === "unicode" && Math.random() < 0.1) {
				this.#selectedTip = "Please use nerdfont for the best symbol rendering.";
			} else {
				// Gated tips resolve against live settings at pick time, so a tip
				// never advertises a feature the user has disabled. Pre-init
				// contexts (bare component tests) see the full corpus.
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

	/** No-op: LSP status no longer paints on the welcome hero (see WELCOME_LSP_SLOTS);
	 *  retained for call-site API stability. */
	setLspServers(_servers: LspServerInfo[]): void {
		// Discarded — LSP status no longer paints on the welcome hero.
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
		if (termWidth < 30) return [];
		const lines = this.#sunriseHeader(termWidth);
		if (!this.full) {
			lines.push("");
			// Continue where you left off: the most recent session, one quiet
			// line. The data was always fetched for the hero; before this it was
			// only ever shown behind /welcome — the single most useful thing at
			// launch stayed hidden.
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
			// The /resume hint dedups against the continue line above.
			const more = recent ? "  ·  /settings" : "  ·  /resume  ·  /settings";
			lines.push(
				centerLine(theme.fg("dim", "more: ") + theme.fg("accent", "/welcome") + theme.fg("dim", more), termWidth),
			);
			for (const tipLine of this.#centeredTipBlock(termWidth)) lines.push(tipLine);
			return lines;
		}
		// /welcome: the sunrise header, then a centred menu column. Open space is
		// the frame here too — no box on the brand's front porch.
		const colW = Math.min(56, termWidth - 4);
		const colPad = padding(Math.max(0, Math.floor((termWidth - colW) / 2)));
		lines.push("");
		for (const [label, shortcut] of WELCOME_ACTIONS) lines.push(colPad + this.#menuRow(label, shortcut, colW));
		const sessions = this.recentSessions.slice(0, WELCOME_SESSION_SLOTS);
		if (sessions.length > 0) {
			lines.push("");
			lines.push(colPad + theme.fg("dim", "Recent"));
			for (const session of sessions) lines.push(colPad + this.#sessionRow(session, colW));
		}
		lines.push("");
		// Drop only renderWelcomeTip's single indent space — trimStart here used
		// to strip the continuation indent too, breaking the hanging alignment
		// of wrapped tips.
		for (const tipLine of this.#renderTip(colW)) {
			lines.push(colPad + (tipLine.startsWith(" ") ? tipLine.slice(1) : tipLine));
		}
		return lines;
	}

	/**
	 * The sunrise: a grand dithered sun over the silver wordmark, then one quiet
	 * line of metadata. No box, no rails — open space is the frame, exactly like
	 * the website's hero. Vertical centring is interactive-mode's topFill.
	 */
	#sunriseHeader(termWidth: number): string[] {
		const lines: string[] = [];
		// The sun scales with the viewport, never past it: reserve rows for the
		// wordmark, metadata, hints, and the composer so the disc is never clipped.
		// (Non-TTY / pre-start contexts report 0 or undefined rows — fall back to
		// a generous viewport so the cap is inert there.)
		const rawRows = process.stdout.rows;
		const termRows = Number.isFinite(rawRows) && (rawRows ?? 0) > 0 ? (rawRows as number) : 60;
		const sunRowBudget = Math.max(6, termRows - 24);
		const sunW = Math.max(
			26,
			Math.min(60, Math.round(termWidth * 0.36), Math.round(((sunRowBudget - 2) * 2.1) / 0.6)),
		);
		// Disc diameter is 0.6·sunW (sunMark); rows restore roundness at the 2.1
		// cell aspect, with one row of air under the disc.
		// Cap-wins, NOT clamp/clampLow: on a short terminal (sunRowBudget < 7) the
		// budget must win so the sun never overflows the rows we have. clamp/clampLow
		// let the low bound (7) win in that degenerate case, which would draw the sun
		// taller than the budget and break the layout.
		const sunH = Math.min(Math.max(7, Math.round((sunW * 0.6) / 2.1) + 2), sunRowBudget);
		const sun = this.#currentLogoFrame(sunW, sunH);
		const sunPad = padding(Math.max(0, Math.floor((termWidth - sunW) / 2)));
		for (const row of sun) lines.push(sunPad + row);
		lines.push("");
		let shine: ShineConfig | undefined;
		if (this.#animStart != null) {
			const p = Math.min(1, (performance.now() - this.#animStart) / INTRO_MS);
			shine = { strength: 1 - p, pos: p };
		}
		// The wordmark is text, not glyph art — it renders in the terminal's own
		// font (JetBrains Mono), letterspaced to hold its own under the sun,
		// silver with the shine sweeping through it.
		for (const row of gradientLogo([APP_NAME.split("").join(" ")], 0, shine)) {
			lines.push(centerLine(theme.bold(row), termWidth));
		}
		lines.push("");
		const model =
			this.modelName && this.providerName
				? `${this.modelName} · ${this.providerName}`
				: this.modelName || this.providerName;
		const meta = model
			? theme.fg("dim", `v${this.version} · ${model}`)
			: theme.fg("dim", `v${this.version} · no model yet · `) + theme.fg("accent", "/login");
		// A named profile leads the metadata so you know at launch which sandbox's
		// config, sessions, and keys are live. The built-in "default" profile is the
		// common case and stays silent, keeping the vanilla hero uncluttered.
		const profile = getActiveProfileOrDefault();
		const metaLine =
			profile === DEFAULT_PROFILE_DIR_NAME ? meta : theme.fg("muted", profile) + theme.fg("dim", " · ") + meta;
		lines.push(centerLine(metaLine, termWidth));
		lines.push(centerLine(theme.fg("muted", VEYYON_VALUE_LINE), termWidth));
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

	/**
	 * The tip centred as ONE BLOCK: a shared left offset from the widest line,
	 * hanging indent intact. Centring each wrapped line individually shattered
	 * the paragraph — the last fragment ("just images") floated alone mid-air
	 * with no visual connection to its sentence. Returns a leading blank line
	 * when there is a tip, nothing otherwise.
	 */
	#centeredTipBlock(termWidth: number): string[] {
		// renderWelcomeTip prefixes every line with one indent space; drop that
		// single space (keeping the continuation indent) before re-centring.
		const tipLines = this.#renderTip(Math.min(64, termWidth - 4)).map(line =>
			line.startsWith(" ") ? line.slice(1) : line,
		);
		if (tipLines.length === 0) return [];
		const blockWidth = Math.max(...tipLines.map(line => visibleWidth(line)));
		const pad = padding(Math.max(0, Math.floor((termWidth - blockWidth) / 2)));
		return ["", ...tipLines.map(line => pad + line)];
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
	#currentLogoFrame(sunW: number, sunH: number): readonly string[] {
		let bloom: number | undefined;
		let rise: number | undefined;
		let time = 0.6;
		if (this.#animStart != null) {
			const elapsed = performance.now() - this.#animStart;
			bloom = Math.min(1, elapsed / INTRO_MS);
			// The opening is a sunrise: the disc climbs over the field's bottom
			// edge (its horizon) as it blooms. Rise completes a beat before the
			// bloom so the sun settles onto its resting centre, still growing.
			rise = Math.min(1, bloom * 1.25);
			time = 0.2 + (elapsed / 1000) * 1.6;
		}
		return sunMark(sunW, sunH, { trueColor: TERMINAL.trueColor, bloom, rise, time });
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
	const t = clamp01(intensity);
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
	const frontier = shine ? clamp01(shine.pos) : 1;
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
