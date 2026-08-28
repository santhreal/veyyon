import { Container, Markdown } from "@veyyon/tui";
import { SGR_FG_RESET } from "@veyyon/tui/ansi";
import { stripAnsi } from "@veyyon/utils";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import { theme } from "../../modes/theme/theme";
import { imageReferenceHyperlink, renderPlaceholders } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";

export class UserMessageComponent extends Container {
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	#working = false;
	#version = 0;

	setWorking(working: boolean): void {
		if (this.#working === working) return;
		this.#working = working;
		this.#version++;
		this.#zoneSource = undefined;
		this.#zoneLines = undefined;
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	constructor(text: string, synthetic = false, imageLinks?: readonly (string | undefined)[]) {
		super();
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
		const md = new Markdown(text, 0, 1, getMarkdownTheme(), {
			color,
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}

	override render(width: number): readonly string[] {
		const lines = super.render(Math.max(1, width - 4));
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		const gutter = `  ${theme.fg(this.#working ? "borderAccent" : "dim", "›")} `;
		let gutterPlaced = false;
		const wrapped: string[] = new Array(lines.length);
		for (let li = 0; li < lines.length; li++) {
			const line = lines[li]!;
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
