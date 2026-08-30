import { resolveServerCompactionTransport } from "@veyyon/agent-core/compaction";
import type { Api, Model } from "@veyyon/ai";
import { Box, type Component, Markdown } from "@veyyon/tui";
import type { BranchSummaryMessage, CompactionSummaryMessage, CustomMessage } from "../../../../session/messages";
import { withIcon } from "../../../../theme/icon-label";
import { getMarkdownTheme } from "../../../../theme/markdown-theme";
import { theme } from "../../../../theme/theme";
import { actionKeyHint } from "../../utils/key-hint";
import { renderTranscriptDivider } from "./transcript-divider";

/**
 * Which engine will run the next compaction pass.
 *
 * `local` is the in-process summarizer: a real model call against the
 * configured summarizer, billed and timed like any other turn. The rest are
 * the provider's own compaction endpoint, one round trip with no summarizer
 * behind it, and they differ by host: the official OpenAI route, the Azure
 * deployment route, and the ChatGPT Codex route.
 */
export type CompactionKind = "local" | "openai-remote" | "azure-remote" | "codex-remote";

/**
 * Wire api → the remote compaction host that serves it. Exported so a test
 * sweeps the set rather than restating it: a new server-compaction api that
 * lands in `SERVER_COMPACTION_WIRE_APIS` and not here would resolve as
 * `local` and mislabel every pass on that host.
 */
export const REMOTE_COMPACTION_KIND_BY_API: Record<string, CompactionKind> = {
	"openai-responses": "openai-remote",
	"azure-openai-responses": "azure-remote",
	"openai-codex-responses": "codex-remote",
};

/**
 * What each kind is called on screen. Exported so a test sweeps every member
 * and goes red when a new kind arrives without a name of its own.
 */
export const COMPACTION_KIND_LABEL: Record<CompactionKind, string> = {
	local: "local compaction",
	"openai-remote": "openai remote compaction",
	"azure-remote": "azure remote compaction",
	"codex-remote": "codex remote compaction",
};

/**
 * Which compaction engine the next pass will use. This mirrors the admission
 * half of the engine's gate (`AgentSession.#tryServerSideCompaction`):
 * `compaction.remote` on, plus a session model whose capability data resolves a
 * server-compaction transport. It is restated here rather than imported because
 * the gate's method is private and the two primitives it reads are public; the
 * engine's async remainder (an api key must resolve) means a remote answer can
 * still fall back to local, and the engine announces that fallback (missing key
 * or failed pass) with a one-time warning notice.
 *
 * A model that resolves a transport but whose api is not in the wire table
 * cannot happen — `resolveServerCompactionTransport` gates on the same set —
 * so an unknown api reads as local rather than inventing a host name.
 */
export function resolveCompactionKind(session: {
	settings: { get(key: "compaction.remote"): unknown };
	model: Model<Api> | undefined;
}): CompactionKind {
	if (session.settings.get("compaction.remote") !== true) return "local";
	const model = session.model;
	if (!model || resolveServerCompactionTransport(model) === undefined) return "local";
	return REMOTE_COMPACTION_KIND_BY_API[model.api] ?? "local";
}

/**
 * The action part of the compaction loader label. Every pass names its engine,
 * because the on-screen difference between a provider round trip and a local
 * summarizer grinding through the history used to be nothing at all, and a
 * silent minute reads as the wrong one either way. The caller passes the kind
 * from {@link resolveCompactionKind} and adds its own reason prefix and cancel
 * hint around this.
 */
export function compactionActionLabel(isAuto: boolean, kind: CompactionKind): string {
	const base = isAuto ? "Auto-compacting context" : "Compacting context...";
	return `${base} (${COMPACTION_KIND_LABEL[kind]})`;
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
		// Theme may have changed — rebuild the detail box lazily on next render.
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

/**
 * Compaction point in the transcript, rendered as the house divider:
 *
 *   ────────── 📷 compacted · ctrl+o
 *
 * The conversation above the divider stays visible (display transcript keeps
 * full history); only the LLM context was reset. Expanding (ctrl+o) reveals
 * the compaction summary below the divider.
 */
export class CompactionSummaryMessageComponent implements Component {
	#divider: SummaryDividerComponent;

	constructor(private readonly message: CompactionSummaryMessage) {
		this.#divider = new SummaryDividerComponent({
			// A dead-end warning stamped by the progress guard badges the bar;
			// the full text lives in the ctrl+o detail block below.
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
		// A server-side compaction names the provider model that did it; a
		// configured local compaction model did not apply to that compaction.
		const attribution = this.message.compactedBy ? ` · server-side by ${this.message.compactedBy}` : "";
		const warningNote = this.message.warning
			? `\n\n${withIcon(theme.icon.warning, `**Warning:** ${this.message.warning}`)}`
			: "";
		return `**Compacted from ${tokenStr} tokens**${attribution}${warningNote}\n\n${this.message.summary}`;
	}
}

/**
 * A manual handoff is persisted as a custom message so the replacement session
 * receives its developer context. Render it with the same divider affordance as
 * `/compact` instead of the generic `[handoff]` box.
 */
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

/**
 * A branch summary collapses a side branch back into the main line. Render it
 * with the same slim divider as `/compact` and handoff rather than a `[branch]`
 * box, so every history-collapse point reads as one consistent banner.
 */
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
	for (const content of message.content) {
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
