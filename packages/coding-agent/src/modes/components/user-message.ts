import { Container, Markdown } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { imageReferenceHyperlink, renderPlaceholders } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";

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
		// dimmed because it is history. Children render 3 columns narrower so
		// the gutter never pushes a wrapped line past the terminal edge.
		const lines = super.render(Math.max(1, width - 3));
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
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
		// V3 turn-headers: a micro-label names the speaker, then one row of air.
		wrapped.unshift(` ${theme.fg("dim", "─╴")}${theme.fg("dim", "you")}`, "");
		wrapped[0] = OSC133_ZONE_START + wrapped[0];
		wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1] + OSC133_ZONE_END;
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}
