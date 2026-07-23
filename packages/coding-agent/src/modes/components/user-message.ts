import { Container, Markdown, TERMINAL } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { imageReferenceHyperlink, renderPlaceholders } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";
import { paintHotTail, shimmerPhase } from "./follow";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers
// Do not emit OSC 133 C ("command start") here: the transcript has no matching
// command-finished marker, so terminals can group later assistant/tool output
// under the first submitted prompt.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	// Memoized OSC 133 zone wrapping keyed on the underlying container render
	// (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	// component reference-stable for the transcript's incremental assembly and
	// never mutates the container's cached array.
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	// While the agent works on this prompt, its text carries the follow's
	// liquid glow (same sheen as streaming reveal) so the operator can see at a
	// glance WHICH message is being worked. The event controller flips this on
	// the turn's agent_start and off at agent_end.
	#working = false;

	setWorking(working: boolean): void {
		this.#working = working;
	}

	/**
	 * While working, rows repaint every frame (the sheen moves), so the block
	 * must stay in the transcript's live region instead of freezing into
	 * native scrollback mid-glow.
	 */
	isTranscriptBlockFinalized(): boolean {
		return !this.#working;
	}

	constructor(text: string, synthetic = false, imageLinks?: readonly (string | undefined)[]) {
		super();
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		// Paint the magic keywords ("ultrathink"/"orchestrate"/"workflowz") inside the rendered
		// bubble too — matching the live editor glow. The Markdown component routes code spans and
		// fenced blocks through its own code styling (never `color`), so those are already excluded;
		// `highlightMagicKeywords` additionally restores the bubble's own foreground after each
		// painted keyword so the gradient never bleeds into the rest of the line.
		const keywordReset = theme.getFgAnsi("userMessageText") || "\x1b[39m";
		const baseText = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", highlightMagicKeywords(value, keywordReset));
		const imageLabel = (value: string) => theme.fg("accent", `\x1b[1m\x1b[4m${value}\x1b[24m\x1b[22m`);
		const color = (value: string) =>
			renderPlaceholders(value, {
				renderText: baseText,
				renderReference: (label, kind, index) =>
					kind === "image"
						? imageReferenceHyperlink(label, index, imageLinks, imageLabel)
						: theme.fg("accent", `\x1b[1m${label}\x1b[22m`),
			});
		// paddingX 0: the render gutter (` › `) owns the horizontal inset.
		const md = new Markdown(text, 0, 1, getMarkdownTheme(), {
			bgColor,
			color,
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}

	override render(width: number): readonly string[] {
		// The prompt gutter (approved composer mockups, §02 "full screen at
		// rest"): a past prompt reads `› …` — the same glyph you typed behind,
		// with the glyph dim and the TEXT bright (the operator's own words were
		// gray-on-gray and unreadable, user report 2026-07-22). Children render
		// 3 columns narrower so the gutter never pushes a wrapped line past the
		// terminal edge.
		const lines = super.render(Math.max(1, width - 3));
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#withWorkingGlow(this.#zoneLines);
		}
		const gutter = ` ${theme.fg("dim", "›")} `;
		let gutterPlaced = false;
		const wrapped = lines.map(line => {
			// ANSI-aware blankness: padding rows carry color codes, so a raw
			// trim() would mistake them for content and misplace the gutter.
			if (!gutterPlaced && stripAnsi(line).trim().length > 0) {
				gutterPlaced = true;
				return gutter + line;
			}
			return line.length > 0 ? `   ${line}` : line;
		});
		wrapped[0] = OSC133_ZONE_START + wrapped[0];
		wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1] + OSC133_ZONE_END;
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return this.#withWorkingGlow(wrapped);
	}

	/**
	 * Paint the follow's sheen over the LAST content row of the prompt while
	 * the agent works on it. Returns the memoized rows untouched when idle, so
	 * the transcript's reference-equality reuse still holds; while working it
	 * returns a fresh copy each frame (the sheen position is wall-clock
	 * driven). The OSC 133 markers are lifted off before painting — they are
	 * invisible bytes, and the glow's width math must see only the visible row.
	 */
	#withWorkingGlow(rows: string[]): string[] {
		if (!this.#working || rows.length === 0) {
			return rows;
		}
		const out = [...rows];
		for (let i = out.length - 1; i >= 0; i--) {
			const row = out[i]!;
			if (stripAnsi(row).trim().length === 0) continue;
			const hasEnd = row.endsWith(OSC133_ZONE_END);
			const core = hasEnd ? row.slice(0, row.length - OSC133_ZONE_END.length) : row;
			const hasStart = core.startsWith(OSC133_ZONE_START);
			const full = hasStart ? core.slice(OSC133_ZONE_START.length) : core;
			// Lift the row's right padding off before painting: padded rows end in
			// spaces WRAPPED in SGR codes, so paintHotTail's bare-space padding
			// strip never fires and the glow lands on invisible trailing cells.
			// eslint-disable-next-line no-control-regex
			const padMatch = /(?:\x1b\[[0-9;]*m| )+$/.exec(full);
			const body = padMatch ? full.slice(0, padMatch.index) : full;
			const pad = padMatch ? full.slice(padMatch.index) : "";
			const painted = paintHotTail(
				body,
				theme,
				TERMINAL.trueColor,
				"userMessageText",
				shimmerPhase(performance.now()),
			);
			out[i] = `${hasStart ? OSC133_ZONE_START : ""}${painted}${pad}${hasEnd ? OSC133_ZONE_END : ""}`;
			break;
		}
		return out;
	}
}
