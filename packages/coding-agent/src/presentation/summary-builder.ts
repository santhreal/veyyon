import type { Api, Model } from "@veyyon/ai";
import { resolveServerCompactionTransport } from "@veyyon/ai/providers/openai-compaction";
import type {
	BranchSummaryView,
	CompactionKind,
	CompactionSummaryView,
	HandoffSummaryView,
} from "@veyyon/wire/presentation";
import type { BranchSummaryMessage, CompactionSummaryMessage, CustomMessage } from "../session/messages";

export const REMOTE_COMPACTION_KIND_BY_API: Record<string, CompactionKind> = {
	"openai-responses": "openai-remote",
	"azure-openai-responses": "azure-remote",
	"openai-codex-responses": "codex-remote",
};

export const COMPACTION_KIND_LABEL: Record<CompactionKind, string> = {
	local: "local compaction",
	"openai-remote": "openai remote compaction",
	"azure-remote": "azure remote compaction",
	"codex-remote": "codex remote compaction",
};

/** The admitted transport; missing credentials can still force a local pass. */
export function resolveCompactionKind(session: {
	settings: { get(key: "compaction.remote"): unknown };
	model: Model<Api> | undefined;
}): CompactionKind {
	if (session.settings.get("compaction.remote") !== true) return "local";
	const model = session.model;
	if (!model || resolveServerCompactionTransport(model) === undefined) return "local";
	return REMOTE_COMPACTION_KIND_BY_API[model.api] ?? "local";
}

export function compactionActionLabel(isAuto: boolean, kind: CompactionKind): string {
	const base = isAuto ? "Auto-compacting context" : "Compacting context...";
	return `${base} (${COMPACTION_KIND_LABEL[kind]})`;
}

export function toCompactionSummaryView(message: CompactionSummaryMessage): CompactionSummaryView {
	const view: CompactionSummaryView = {
		kind: "compaction-summary",
		summary: message.summary,
		tokensBefore: message.tokensBefore,
	};
	if (message.compactedBy !== undefined) view.compactedBy = message.compactedBy;
	if (message.warning !== undefined) view.warning = message.warning;
	return view;
}

export function toBranchSummaryView(message: BranchSummaryMessage): BranchSummaryView {
	return { kind: "branch-summary", summary: message.summary };
}

export function toHandoffSummaryView(message: CustomMessage<unknown>): HandoffSummaryView | undefined {
	if (message.customType !== "handoff" || !message.display) return undefined;
	return { kind: "handoff-summary", summary: extractHandoffDocument(getCustomMessageText(message)) };
}

export function getCustomMessageText(message: CustomMessage<unknown>): string {
	if (typeof message.content === "string") return message.content;
	let firstText: string | undefined;
	let parts: string[] | undefined;
	for (const content of message.content) {
		if (content.type !== "text") continue;
		if (firstText === undefined) {
			firstText = content.text;
			continue;
		}
		if (parts === undefined) parts = [firstText];
		parts.push(content.text);
	}
	return parts === undefined ? (firstText ?? "") : parts.join("\n");
}

export function extractHandoffDocument(text: string): string {
	const openTag = "<handoff-context>";
	const closeTag = "</handoff-context>";
	const openIndex = text.indexOf(openTag);
	if (openIndex === -1) return text.trim();
	const contentStart = openIndex + openTag.length;
	const closeIndex = text.indexOf(closeTag, contentStart);
	return (closeIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, closeIndex)).trim();
}
