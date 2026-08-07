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
	// Memoized gutter wrapping keyed on the underlying container render
	// (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	// component reference-stable for the transcript's incremental assembly and
	// never mutates the container's cached array.
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	// While the agent works on this prompt, its `›` glyph turns ember so the
	// operator can see at a glance WHICH message is being worked. The event
	// controller flips this on the turn's agent_start and off at agent_end. STATIC
	// by design: an animated per-frame paint here either pins the live-region seam
	// open (unfinalized block near the top of the transcript = a giant blank hole
	// below it — shipped regression) or churns the committed-prefix audit. The
	// bytes change only on arm/disarm, surfaced through the block version.
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

	/**
	 * Post-finalize mutation signal (see FinalizableBlock in
	 * transcript-container.ts): the glyph color changes at arm/disarm while the
	 * block stays finalized, so the version bump is what lets an
	 * already-committed prompt repaint instead of replaying stale bytes.
	 */
	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	constructor(text: string, synthetic = false, imageLinks?: readonly (string | undefined)[]) {
		super();
		// Paint the magic keywords ("ultrathink"/"orchestrate"/"workflowz") inside the rendered
		// bubble too — matching the live editor glow. The Markdown component routes code spans and
		// fenced blocks through its own code styling (never `color`), so those are already excluded;
		// `highlightMagicKeywords` additionally restores the bubble's own foreground after each
		// painted keyword so the gradient never bleeds into the rest of the line.
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
		// The prompt gutter (approved composer mockups, §02 "full screen at rest"): a
		// past prompt reads `› …` — the same glyph you typed behind, with the glyph
		// dim and the TEXT bright. The glyph sits at COMPOSER_INSET_COLS so past
		// prompts share ONE left rail with the composer's `›`. Children render 4
		// columns narrower so the gutter never pushes a wrapped line past the
		// terminal edge.
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
		const wrapped = lines.map(line => {
			// ANSI-aware blankness: padding rows carry color codes, so a raw
			// trim() would mistake them for content and misplace the gutter.
			if (!gutterPlaced && stripAnsi(line).trim().length > 0) {
				gutterPlaced = true;
				return gutter + line;
			}
			return line.length > 0 ? `    ${line}` : line;
		});
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}
