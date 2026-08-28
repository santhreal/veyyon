import { Container, Markdown } from "@veyyon/tui";
import { SGR_FG_RESET } from "@veyyon/tui/ansi";
import { stripAnsi } from "@veyyon/utils";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import { theme } from "../../modes/theme/theme";
import { imageReferenceHyperlink, renderPlaceholders } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	// Memoized gutter wrapping keyed on the underlying container render (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	// While the agent works on this prompt, its `›` glyph turns ember so the operator can see at a glance WHICH message is being worked. The event
	#working = false;
	#version = 0;

	setWorking(working: boolean): void {
		if (this.#working === working) return;
		this.#working = working;
		this.#version++;
		// The memoized rows bake the glyph color in; rebuild on next render.
		this.#zoneSource = undefined;
		this.#zoneLines = undefined;
	}

	/** Post-finalize mutation signal (see FinalizableBlock in transcript-container.ts): the glyph color changes at arm/disarm while the */
	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	constructor(text: string, synthetic = false, imageLinks?: readonly (string | undefined)[]) {
		super();
		// Paint the magic keywords ("ultrathink"/"orchestratez"/"workflowz") inside the rendered bubble too — matching the live editor glow. The Markdown component routes code spans and
		const keywordReset = theme.getFgAnsi("userMessageText") || SGR_FG_RESET;
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
			color,
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}

	override render(width: number): readonly string[] {
		// The prompt gutter (approved composer mockups, §02 "full screen at rest"): a past prompt reads `› …` — the same glyph you typed behind, with the glyph
		const lines = super.render(Math.max(1, width - 4));
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		// Ember glyph while this prompt is being worked; dim once it is history.
		const gutter = `  ${theme.fg(this.#working ? "borderAccent" : "dim", "›")} `;
		let gutterPlaced = false;
		const wrapped: string[] = new Array(lines.length);
		for (let li = 0; li < lines.length; li++) {
			const line = lines[li]!;
			// ANSI-aware blankness: padding rows carry color codes, so a raw
			// trim() would mistake them for content and misplace the gutter.
			if (!gutterPlaced && stripAnsi(line).trim().length > 0) {
				gutterPlaced = true;
				wrapped[li] = gutter + line;
			} else {
				wrapped[li] = line.length > 0 ? `    ${line}` : line;
			}
		}
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}
