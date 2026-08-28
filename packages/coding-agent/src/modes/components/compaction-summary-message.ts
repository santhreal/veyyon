import { resolveServerCompactionTransport } from "@veyyon/agent-core/compaction";
import type { Api, Model } from "@veyyon/ai";
import { Box, type Component, Markdown } from "@veyyon/tui";
import { withIcon } from "../../modes/theme/icon-label";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import { theme } from "../../modes/theme/theme";
import { actionKeyHint } from "../../modes/utils/key-hint";
import type { BranchSummaryMessage, CompactionSummaryMessage, CustomMessage } from "../../session/messages";
import { renderTranscriptDivider } from "./transcript-divider";

export function willCompactRemotely(session: {
	settings: { get(key: "compaction.remote"): unknown };
	model: Model<Api> | undefined;
}): boolean {
	if (session.settings.get("compaction.remote") !== true) return false;
	return !!session.model && resolveServerCompactionTransport(session.model) !== undefined;
}

export function compactionActionLabel(isAuto: boolean, remote: boolean): string {
	const base = isAuto ? "Auto-compacting context" : "Compacting context...";
	return remote ? `${base} (openai remote compaction)` : base;
}

interface SummaryDividerOptions {
	label: () => string;
	detailMarkdown: () => string;
	hint: () => string;
}

class SummaryDividerComponent implements Component {
	#expanded = false;
	#cache?: { width: number; hint: string; lines: string[] };
	#detail?: Box;

	constructor(private readonly options: SummaryDividerOptions) {}

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
		const hint = this.options.hint();
		if (this.#cache?.width === width && this.#cache.hint === hint) {
			return this.#cache.lines;
		}
		const row = renderTranscriptDivider(width, this.options.label(), hint || undefined);
		const lines = this.#expanded ? ["", row, "", ...this.#detailBox().render(width)] : ["", row, ""];
		this.#cache = { width, hint, lines };
		return lines;
	}

	#detailBox(): Box {
		if (this.#detail) return this.#detail;
		const box = new Box(1, 1);
		box.setIgnoreTight(true);
		box.addChild(
			new Markdown(this.options.detailMarkdown(), 0, 0, getMarkdownTheme(), {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
		this.#detail = box;
		return box;
	}
}

export class CompactionSummaryMessageComponent implements Component {
	#divider: SummaryDividerComponent;

	constructor(private readonly message: CompactionSummaryMessage) {
		this.#divider = new SummaryDividerComponent({
			label: () =>
				this.message.warning
					? withIcon(theme.icon.camera, `compacted ${theme.fg("warning", theme.icon.warning)}`)
					: withIcon(theme.icon.camera, "compacted"),
			detailMarkdown: () => this.#detailMarkdown(),
			hint: () => actionKeyHint("app.tools.expand"),
		});
	}

	setExpanded(expanded: boolean): void {
		this.#divider.setExpanded(expanded);
	}

	invalidate(): void {
		this.#divider.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#divider.render(width);
	}

	#detailMarkdown(): string {
		const tokenStr = this.message.tokensBefore.toLocaleString();
		const attribution = this.message.compactedBy ? ` · server-side by ${this.message.compactedBy}` : "";
		const warningNote = this.message.warning
			? `\n\n${withIcon(theme.icon.warning, `**Warning:** ${this.message.warning}`)}`
			: "";
		return `**Compacted from ${tokenStr} tokens**${attribution}${warningNote}\n\n${this.message.summary}`;
	}
}

export class HandoffSummaryMessageComponent implements Component {
	#divider: SummaryDividerComponent;

	constructor(private readonly message: CustomMessage<unknown>) {
		this.#divider = new SummaryDividerComponent({
			label: () => withIcon(theme.icon.context, "handoff"),
			detailMarkdown: () => this.#detailMarkdown(),
			hint: () => actionKeyHint("app.tools.expand"),
		});
	}

	setExpanded(expanded: boolean): void {
		this.#divider.setExpanded(expanded);
	}

	invalidate(): void {
		this.#divider.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#divider.render(width);
	}

	#detailMarkdown(): string {
		const document = extractHandoffDocument(getCustomMessageText(this.message));
		return `**Handoff context**\n\n${document || "_No handoff content._"}`;
	}
}

export function createHandoffSummaryMessageComponent(
	message: CustomMessage<unknown>,
	expanded: boolean,
): HandoffSummaryMessageComponent | undefined {
	if (message.customType !== "handoff" || !message.display) return undefined;
	const component = new HandoffSummaryMessageComponent(message);
	component.setExpanded(expanded);
	return component;
}

export class BranchSummaryMessageComponent implements Component {
	#divider: SummaryDividerComponent;

	constructor(private readonly message: BranchSummaryMessage) {
		this.#divider = new SummaryDividerComponent({
			label: () => withIcon(theme.icon.branch, "branch"),
			detailMarkdown: () => `**Branch summary**\n\n${this.message.summary}`,
			hint: () => actionKeyHint("app.tools.expand"),
		});
	}

	setExpanded(expanded: boolean): void {
		this.#divider.setExpanded(expanded);
	}

	invalidate(): void {
		this.#divider.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#divider.render(width);
	}
}

function getCustomMessageText(message: CustomMessage<unknown>): string {
	if (typeof message.content === "string") return message.content;
	let firstText: string | undefined;
	let parts: string[] | undefined;
	for (let ci = 0; ci < message.content.length; ci++) {
		const content = message.content[ci]!;
		if (content.type !== "text") continue;
		if (firstText === undefined) {
			firstText = content.text;
			continue;
		}
		if (parts === undefined) {
			parts = [firstText];
		}
		parts.push(content.text);
	}
	return parts === undefined ? (firstText ?? "") : parts.join("\n");
}

function extractHandoffDocument(text: string): string {
	const openTag = "<handoff-context>";
	const closeTag = "</handoff-context>";
	const openIndex = text.indexOf(openTag);
	if (openIndex === -1) return text.trim();

	const contentStart = openIndex + openTag.length;
	const closeIndex = text.indexOf(closeTag, contentStart);
	const document = closeIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, closeIndex);
	return document.trim();
}
