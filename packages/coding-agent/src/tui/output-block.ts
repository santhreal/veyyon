/**
 * Bordered output container with optional header and sections.
 */

import type { Component } from "@veyyon/tui";
import {
	ImageProtocol,
	padding,
	reopenBackgroundAfterResets,
	TERMINAL,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { SGR_BG_RESET } from "@veyyon/tui/ansi";
import { clampLow } from "@veyyon/utils/math";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { getSixelLineMask } from "../utils/sixel";
import type { State } from "./types";
import type { RenderCache } from "./utils";
import { getStateBgColor, Hasher, padToWidth } from "./utils";

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean }>;
	width: number;
	applyBg?: boolean;
	contentPaddingLeft?: number;
	/** Override the state-derived border color. Used for muted "legacy" tool
	 * frames that should not visually compete with framed-output tools. */
	borderColor?: ThemeColor;
}

const FRAMED_BLOCK_COMPONENT = Symbol("framedBlockComponent");

export type FramedBlockComponent = Component & { [FRAMED_BLOCK_COMPONENT]?: true };

export function markFramedBlockComponent<T extends Component>(component: T): T & FramedBlockComponent {
	(component as T & FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] = true;
	return component as T & FramedBlockComponent;
}

export function isFramedBlockComponent(component: Component): boolean {
	return (component as FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] === true;
}

type BlockRow =
	| { kind: "header"; text: string }
	| { kind: "label"; text: string }
	| { kind: "rule" }
	| { kind: "content"; inner: string }
	| { kind: "sixel"; raw: string };

/** Cells of rule a label-less section separator draws on the rail. */
const SEPARATOR_CELLS = 12;

function normalizeContentPaddingLeft(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	return Math.max(0, Math.floor(value));
}

/** Inner content width that {@link renderOutputBlock} wraps its body to, for a given outer `width`: the rail and the space after it (2 cells) plus the left */
export function outputBlockContentWidth(width: number, contentPaddingLeft?: number): number {
	return Math.max(1, width - 2 - normalizeContentPaddingLeft(contentPaddingLeft));
}

/**
 * How far apart two `#rrggbb` colours are on their worst channel.
 */
function hexDigitAt(s: string, pos: number): number {
	const code = s.charCodeAt(pos);
	if (code >= 0x30 && code <= 0x39) return code - 0x30;
	if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
	if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
	return -1;
}

function channelDistance(a: string, b: string): number {
	let worst = 0;
	for (let i = 0; i < 3; i++) {
		const base = 1 + i * 2;
		const ca = (hexDigitAt(a, base) << 4) | hexDigitAt(a, base + 1);
		const cb = (hexDigitAt(b, base) << 4) | hexDigitAt(b, base + 1);
		if (ca < 0 || cb < 0) return Number.POSITIVE_INFINITY;
		worst = Math.max(worst, Math.abs(ca - cb));
	}
	return worst;
}

/** Below this the rail and the ground are the same colour to a reader. */
const RAIL_GROUND_MIN_DISTANCE = 12;

/** The rail is the only chrome a block has left, so it may not be drawn in a colour the ground on screen swallows. */
function visibleRailColor(requested: ThemeColor, theme: Theme): ThemeColor {
	const ground = theme.visibleGroundHex();
	const hex = theme.getColorHex(requested);
	if (channelDistance(hex, ground) >= RAIL_GROUND_MIN_DISTANCE) return requested;
	return channelDistance(theme.getColorHex("dim"), ground) >= RAIL_GROUND_MIN_DISTANCE ? "dim" : requested;
}

export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	const { header, headerMeta, state, sections = [], width, applyBg = true } = options;
	const h = theme.boxSharp.horizontal;
	const rail = theme.symbol("block.rail");
	const lineWidth = Math.max(0, width);
	// Rail colors: running/pending use accent, success uses dim (gray), error/warning keep their colors
	const requestedColor: ThemeColor =
		options.borderColor ??
		(state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "dim");
	const borderColor = visibleRailColor(requestedColor, theme);
	const border = (text: string) => theme.fg(borderColor, text);
	const bgFn = (() => {
		if (!state || !applyBg) return undefined;
		const bgAnsi = theme.getBgAnsi(getStateBgColor(state));
		// Keep block background stable even if inner content contains SGR resets (e.g. "\x1b[0m"),
		// which would otherwise clear the outer background mid-line.
		return (text: string) => {
			return `${bgAnsi}${reopenBackgroundAfterResets(text, bgAnsi)}${SGR_BG_RESET}`;
		};
	})();

	const contentPaddingLeft = normalizeContentPaddingLeft(options.contentPaddingLeft);
	// The rail glyph and the one space after it, so this is the same two columns the
	// two borders used to take and `outputBlockContentWidth` still describes it.
	const chromeWidth = visibleWidth(rail) + 1 + contentPaddingLeft;
	const contentWidth = Math.max(0, lineWidth - chromeWidth);
	const contentLeftPadding = contentPaddingLeft > 0 ? padding(contentPaddingLeft) : "";

	// ── Layout pass: collect row descriptors before emitting the railed lines. ──
	const rows: BlockRow[] = [];
	const headerText = header && headerMeta ? `${header}${theme.sep.dot}${headerMeta}` : header || headerMeta || "";
	if (headerText) rows.push({ kind: "header", text: headerText });

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
		const section = normalizedSections[sectionIndex]!;
		// A labelled section names itself on the rail. A label-less section can still
		// ask for a divider, but only between sections — leading with one would draw a
		// stray rule above the first line of output.
		if (section.label) {
			rows.push({ kind: "label", text: section.label });
		} else if (section.separator && sectionIndex > 0) {
			rows.push({ kind: "rule" });
		}
		const allLines: string[] = [];
		for (let li = 0; li < section.lines.length; li++) {
			const src = section.lines[li]!;
			let start = 0;
			for (let si = 0; si <= src.length; si++) {
				if (si === src.length || src.charCodeAt(si) === 0x0a) {
					allLines.push(src.slice(start, si));
					start = si + 1;
				}
			}
		}
		const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const line = allLines[lineIndex]!;
			if (sixelLineMask?.[lineIndex]) {
				rows.push({ kind: "sixel", raw: line });
				continue;
			}
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				rows.push({ kind: "content", inner: wrappedLine });
			}
		}
	}

	// The width the block is drawn at: the widest thing in it plus its own chrome, never the terminal. This only shows when a state background is painted — a plate
	let blockWidth = 0;
	for (const row of rows) {
		if (row.kind === "sixel") continue;
		const ink =
			row.kind === "header"
				? visibleWidth(row.text) + chromeWidth
				: row.kind === "content"
					? visibleWidth(row.inner) + chromeWidth
					: row.kind === "label"
						? visibleWidth(row.text) + chromeWidth
						: SEPARATOR_CELLS + chromeWidth;
		// One column of air at the right, so a painted plate is not text jammed against
		// its own edge. At the terminal width the air is what gets dropped, which is also
		// the only way a content line can be as wide as it was wrapped to.
		blockWidth = Math.max(blockWidth, ink + 1);
	}
	blockWidth = Math.min(lineWidth, blockWidth);
	const innerWidth = Math.max(0, blockWidth - chromeWidth);

	const onRail = (body: string): string => `${border(rail)} ${body}`;

	const lines: string[] = [];
	for (const row of rows) {
		if (row.kind === "sixel") {
			lines.push(row.raw);
			continue;
		}
		const line =
			row.kind === "header"
				? // The header sits ON the rail like every other row. It used to start at
					// column zero, one glyph left of the body and two cells left of the rail below it, so the block's left edge began under its own title: a status
					onRail(row.text)
				: row.kind === "content"
					? onRail(`${contentLeftPadding}${row.inner}`)
					: row.kind === "label"
						? // A label names the rows under it, so it sits at their indent rather than one
							// column left of them. Its colour is the caller's: every section label in the
							// product arrives pre-styled (`toolTitle`, `dim`), and re-styling here would
							// wrap an inner reset in an outer colour and lose both.
							onRail(`${contentLeftPadding}${row.text}`)
						: onRail(border(h.repeat(clampLow(innerWidth, 0, SEPARATOR_CELLS))));
		// Unpainted rows are emitted at their own length: with no right border to reach,
		// padding them would only add trailing spaces to every line of every block, which
		// the live-tail paint has to strip again and a copied transcript keeps.
		lines.push(bgFn ? padToWidth(line, blockWidth, bgFn) : line);
	}

	return lines;
}

/** Cached wrapper around `renderOutputBlock`. Since output blocks are re-rendered on every frame (via `render(width)` closures), */
export class CachedOutputBlock {
	#cache?: RenderCache;

	/** Render with caching. Returns the cached (shared, caller-immutable) lines if options haven't changed. */
	render(options: OutputBlockOptions, theme: Theme): readonly string[] {
		const key = this.#buildKey(options);
		if (this.#cache?.key === key) return this.#cache.lines;
		const lines = renderOutputBlock(options, theme);
		this.#cache = { key, lines };
		return lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const h = new Hasher();
		h.u32(options.width);
		h.u32(normalizeContentPaddingLeft(options.contentPaddingLeft));
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.optional(options.borderColor);
		h.bool(options.applyBg ?? true);
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				h.bool(s.separator ?? false);
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}

/** Build a self-framing tool component backed by a cached output block. The `build` callback returns the block options for a given width; the cache */
export function framedBlock(theme: Theme, build: (width: number) => OutputBlockOptions): Component {
	const block = new CachedOutputBlock();
	// Marked so the tool-execution container treats it as self-framing (renders
	// flush, no extra padding/background) the same way `markFramedBlockComponent`
	// blocks are treated.
	return markFramedBlockComponent({
		render: (width: number): readonly string[] => block.render(build(width), theme),
		invalidate: () => block.invalidate(),
	});
}
