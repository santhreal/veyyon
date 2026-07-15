import {
	type Component,
	padding,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/pi-tui";
import { APP_NAME } from "@veyyon/pi-utils";
import { theme } from "../../modes/theme/theme";
import tipsText from "./tips.txt" with { type: "text" };

/** Tips embedded at build time, one per line; blanks dropped. */
const TIPS: readonly string[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0);

/**
 * Fixed number of session rows in the welcome box so its height stays stable
 * across recent-session updates.
 */
export const WELCOME_SESSION_SLOTS = 4;

/**
 * Fixed number of LSP-server rows, for the same reason. Overflow is sliced so
 * the box height is constant regardless of how many servers a project has.
 */
export const WELCOME_LSP_SLOTS = 4;

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

	// Pull both colors from the active theme so the line stays readable on light
	// themes; the previous hardcoded `#b48cff` / `#9ccfff` pastels (plus a manual
	// `\x1b[2m` dim on the body) dropped to ~1.5:1 contrast on a white background.
	const continuationIndent = padding(labelWidth);
	const styledLabel = theme.fg("customMessageLabel", label);

	const lines = wrappedBody.map((line, index) => {
		const styledBody = theme.fg("muted", line);
		const content = index === 0 ? `${styledLabel}${styledBody}` : `${continuationIndent}${styledBody}`;
		return ` ${theme.italic(content)}`;
	});

	if (isNew) {
		// Append a quiet silver "new" tag — static, no motion.
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
 * Welcome screen with block Veyyon wordmark and two-column layout.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: Timer | null = null;
	#selectedTip: string | undefined;
	// Render cache: the welcome box is the first transcript-area component, so
	// returning a stable array reference keeps the whole frame prefix stable.
	// Bypassed while the intro animation runs (every frame differs).
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		private lspServers: LspServerInfo[] = [],
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
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
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
		// Box dimensions - responsive with max width and small-terminal support
		const maxWidth = 100;
		const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
		if (boxWidth < 4) {
			return [];
		}
		const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
		const preferredLeftCol = 22;
		const minLeftCol = 18; // compact VEYYON_LOGO width
		const minRightCol = 22;
		const leftMinContentWidth = Math.max(
			minLeftCol,
			visibleWidth("Welcome"),
			visibleWidth(this.modelName),
			visibleWidth(this.providerName),
		);
		const desiredLeftCol = Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.35)));
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		// Logo: pick a frame from the intro animation if active, else the resting frame.
		const logoColored = this.#currentLogoFrame();

		// Left column - centered content
		const leftLines = [
			"",
			this.#centerText(theme.fg("dim", "Welcome"), leftCol),
			"",
			...logoColored.map(l => this.#centerText(l, leftCol)),
			"",
			this.#centerText(theme.fg("muted", this.modelName), leftCol),
			this.#centerText(theme.fg("dim", this.providerName), leftCol),
		];

		// Right column separator
		const separatorWidth = Math.max(0, rightCol - 2); // padding on each side
		const separator = ` ${theme.fg("borderMuted", theme.boxSharp.horizontal.repeat(separatorWidth))}`;

		// Recent sessions content
		const sessionLines: string[] = [];
		if (this.recentSessions.length === 0) {
			sessionLines.push(` ${theme.fg("dim", "No recent sessions")}`);
		} else {
			// Reserve width for the bullet prefix (" • ") and the trailing " (timeAgo)"
			// so the relative time is never the part that gets truncated. The name
			// absorbs whatever space is left.
			const bulletPrefix = ` ${theme.md.bullet} `;
			const prefixWidth = visibleWidth(bulletPrefix);
			for (const session of this.recentSessions.slice(0, WELCOME_SESSION_SLOTS)) {
				const timeSuffixRaw = ` (${session.timeAgo})`;
				const timeWidth = visibleWidth(timeSuffixRaw);
				const nameBudget = Math.max(1, rightCol - prefixWidth - timeWidth);
				const nameVis = visibleWidth(session.name);
				const name = nameVis > nameBudget ? truncateToWidth(session.name, nameBudget) : session.name;
				sessionLines.push(
					`${theme.fg("dim", bulletPrefix)}${theme.fg("muted", name)}${theme.fg("dim", timeSuffixRaw)}`,
				);
			}
		}
		// Pad to the fixed slot count so the box height doesn't depend on session count.
		while (sessionLines.length < WELCOME_SESSION_SLOTS) {
			sessionLines.push("");
		}

		// LSP servers content
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", "No LSP servers")}`);
		} else {
			for (const server of this.lspServers.slice(0, WELCOME_LSP_SLOTS)) {
				const icon =
					server.status === "ready"
						? theme.styledSymbol("status.enabled", "success")
						: server.status === "available"
							? theme.styledSymbol("status.enabled", "dim")
							: server.status === "connecting"
								? theme.styledSymbol("status.pending", "muted")
								: theme.styledSymbol("status.error", "error");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}
		// Pad to the fixed slot count so the box height doesn't depend on server count.
		while (lspLines.length < WELCOME_LSP_SLOTS) {
			lspLines.push("");
		}

		// Right column
		const rightLines = [
			` ${theme.fg("dim", "Tips")}`,
			` ${theme.fg("dim", "#")}${theme.fg("muted", " prompt actions")}`,
			` ${theme.fg("dim", "/")}${theme.fg("muted", " commands")}`,
			` ${theme.fg("dim", "!")}${theme.fg("muted", " bash")}`,
			` ${theme.fg("dim", "$")}${theme.fg("muted", " python")}`,
			separator,
			` ${theme.fg("dim", "LSP")}`,
			...lspLines,
			separator,
			` ${theme.fg("dim", "Sessions")}`,
			...sessionLines,
			"",
		];

		// Hairline chrome — silver only on the product name in the title rail
		const hChar = theme.boxSharp.horizontal;
		const h = theme.fg("borderMuted", hChar);
		const v = theme.fg("borderMuted", theme.boxSharp.vertical);
		const tl = theme.fg("borderMuted", theme.boxSharp.topLeft);
		const tr = theme.fg("borderMuted", theme.boxSharp.topRight);
		const bl = theme.fg("borderMuted", theme.boxSharp.bottomLeft);
		const br = theme.fg("borderMuted", theme.boxSharp.bottomRight);

		const lines: string[] = [];

		const title = ` ${APP_NAME} `;
		const version = `v${this.version} `;
		const titlePrefixRaw = hChar.repeat(2);
		const titleStyled =
			theme.fg("borderMuted", titlePrefixRaw) +
			theme.bold(theme.fg("accent", title)) +
			theme.fg("dim", version);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title) + visibleWidth(version);
		const titleSpace = boxWidth - 2;
		if (titleVisLen >= titleSpace) {
			lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
		} else {
			const afterTitle = titleSpace - titleVisLen;
			lines.push(tl + titleStyled + theme.fg("borderMuted", hChar.repeat(afterTitle)) + tr);
		}

		// Content rows
		const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
		for (let i = 0; i < maxRows; i++) {
			const left = this.#fitToWidth(leftLines[i] ?? "", leftCol);
			if (showRightColumn) {
				const right = this.#fitToWidth(rightLines[i] ?? "", rightCol);
				lines.push(v + left + v + right + v);
			} else {
				lines.push(v + left + v);
			}
		}
		// Bottom border
		if (showRightColumn) {
			lines.push(bl + h.repeat(leftCol) + theme.fg("borderMuted", theme.boxSharp.teeUp) + h.repeat(rightCol) + br);
		} else {
			lines.push(bl + h.repeat(leftCol) + br);
		}

		// Randomly picked tip, rendered directly beneath the box.
		lines.push(...this.#renderTip(boxWidth));

		return lines;
	}

	/**
	 * Render the per-instance tip line: the `customMessageLabel`-themed `Tip:`
	 * label followed by a `muted` body, the whole line italicized. Returns `[]`
	 * when no tip is available or the box is too narrow to be useful.
	 */
	#renderTip(boxWidth: number): string[] {
		const tip = this.tip;
		if (!tip) return [];
		return renderWelcomeTip(tip, boxWidth);
	}

	/** Center text within a given width */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) {
			return truncateToWidth(text, width);
		}
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return padding(leftPad) + text + padding(rightPad);
	}

	/** Fit string to exact width with ANSI-aware truncation/padding */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			const ellipsis = "…";
			const ellipsisWidth = visibleWidth(ellipsis);
			const maxWidth = Math.max(0, width - ellipsisWidth);
			let truncated = "";
			let currentWidth = 0;
			let inEscape = false;
			for (const char of str) {
				if (char === "\x1b") inEscape = true;
				if (inEscape) {
					truncated += char;
					if (char === "m") inEscape = false;
				} else if (currentWidth < maxWidth) {
					truncated += char;
					currentWidth++;
				}
			}
			return `${truncated}${ellipsis}`;
		}
		return str + padding(width - visLen);
	}

	/** Pick the logo frame for the current intro phase, or the resting frame. */
	#currentLogoFrame(): readonly string[] {
		if (this.#animStart == null) return REST_FRAME;
		const elapsed = performance.now() - this.#animStart;
		if (elapsed >= INTRO_MS) return REST_FRAME;
		return introLogoFrame(elapsed / INTRO_MS);
	}
}

/** Compact box-drawing wordmark — sharp, fits the welcome column, reads VEYYON. */
export const VEYYON_LOGO = [
	"╦  ╦╔═╗╦ ╦╦ ╦╔═╗╔╗╔",
	"╚╗╔╝║╣ ╚═╣╚╦╝║ ║║║║",
	" ╚╝ ╚═╝  ╩ ╩ ╚═╝╝╚╝",
];

/** Veyyon silver luminance stops: dark → brand → bright. */
const SILVER_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[116, 123, 134], // #747B86
	[184, 189, 199], // #B8BDC7
	[225, 228, 233], // #E1E4E9
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
	/** 0 = fully revealed / resting; 1 = intro start (edge hot). Used only for entrance fade. */
	strength: number;
	/** Reveal frontier along the wordmark (0..1), left → right. */
	pos: number;
}

/**
 * Wordmark / tip foreground. Resting = brand silver. During entrance, `shine.pos`
 * is the reveal frontier and `shine.strength` warms the leading edge.
 */
export function gradientEscape(_t: number, shine?: ShineConfig): string {
	if (!shine || shine.strength <= 0) return silverEscape(0.55);
	const edge = Math.max(0, 1 - Math.abs(_t - shine.pos) / 0.12) * shine.strength;
	return silverEscape(0.45 + edge * 0.55);
}

/**
 * Paint multi-line art in Veyyon silver. Entrance uses a left→right reveal with a
 * bright leading edge that settles to brand silver.
 */
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

/** Total length of the intro animation. */
const INTRO_MS = 2200;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;

/**
 * Logo frame for a normalized intro progress in [0, 1).
 * Ease-out reveal left → right; leading edge bright, settles to brand silver.
 */
function introLogoFrame(progress: number): string[] {
	const eased = 1 - (1 - progress) ** 3;
	const edge = Math.max(0, 1 - eased) ** 1.2;
	return gradientLogo(VEYYON_LOGO, 0, { pos: eased, strength: edge });
}

/** Resting wordmark, cached for re-renders outside of the intro. */
const REST_FRAME = gradientLogo(VEYYON_LOGO, 0);
