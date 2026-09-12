import { Box, type Component, Markdown } from "@veyyon/tui";
import type { SummaryMessageView } from "@veyyon/wire/presentation";
import { withIcon } from "../../../../theme/icon-label";
import { getMarkdownTheme } from "../../../../theme/markdown-theme";
import { theme } from "../../../../theme/theme";
import { actionKeyHint } from "../../utils/key-hint";
import { renderTranscriptDivider } from "./transcript-divider";

/** Expandable history-collapse divider with lazily rendered summary Markdown. */
export class SummaryMessageComponent implements Component {
	#expanded = false;
	#cache?: { width: number; hint: string; lines: string[] };
	#detail?: Box;

	constructor(private readonly view: SummaryMessageView) {}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#detail = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const hint = actionKeyHint("app.tools.expand");
		if (this.#cache?.width === width && this.#cache.hint === hint) return this.#cache.lines;
		const row = renderTranscriptDivider(width, this.#label(), hint || undefined);
		const lines = this.#expanded ? ["", row, "", ...this.#detailBox().render(width)] : ["", row, ""];
		this.#cache = { width, hint, lines };
		return lines;
	}

	#label(): string {
		switch (this.view.kind) {
			case "compaction-summary":
				return this.view.warning
					? withIcon(theme.icon.camera, `compacted ${theme.fg("warning", theme.icon.warning)}`)
					: withIcon(theme.icon.camera, "compacted");
			case "branch-summary":
				return withIcon(theme.icon.branch, "branch");
			case "handoff-summary":
				return withIcon(theme.icon.context, "handoff");
		}
	}

	#detailMarkdown(): string {
		switch (this.view.kind) {
			case "compaction-summary": {
				const tokens = this.view.tokensBefore.toLocaleString();
				const attribution = this.view.compactedBy ? ` · server-side by ${this.view.compactedBy}` : "";
				const warning = this.view.warning
					? `\n\n${withIcon(theme.icon.warning, `**Warning:** ${this.view.warning}`)}`
					: "";
				return `**Compacted from ${tokens} tokens**${attribution}${warning}\n\n${this.view.summary}`;
			}
			case "branch-summary":
				return `**Branch summary**\n\n${this.view.summary}`;
			case "handoff-summary":
				return `**Handoff context**\n\n${this.view.summary || "_No handoff content._"}`;
		}
	}

	#detailBox(): Box {
		if (this.#detail) return this.#detail;
		const box = new Box(1, 1);
		box.setIgnoreTight(true);
		box.addChild(
			new Markdown(this.#detailMarkdown(), 0, 0, getMarkdownTheme(), {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
		this.#detail = box;
		return box;
	}
}
