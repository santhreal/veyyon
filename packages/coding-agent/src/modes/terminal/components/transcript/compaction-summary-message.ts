import type {
	BranchSummaryView,
	CompactionKind,
	CompactionSummaryView,
	HandoffSummaryView,
} from "@veyyon/wire/presentation";
import {
	COMPACTION_KIND_LABEL,
	compactionActionLabel,
	extractHandoffDocument,
	getCustomMessageText,
	REMOTE_COMPACTION_KIND_BY_API,
	resolveCompactionKind,
	toBranchSummaryView,
	toCompactionSummaryView,
} from "../../../../presentation/summary-builder";
import type { BranchSummaryMessage, CompactionSummaryMessage, CustomMessage } from "../../../../session/messages";
import { SummaryMessageComponent } from "./summary-message";

export {
	COMPACTION_KIND_LABEL,
	type CompactionKind,
	compactionActionLabel,
	REMOTE_COMPACTION_KIND_BY_API,
	resolveCompactionKind,
};

/**
 * Compaction point in the transcript, rendered as the house divider:
 *
 *   ────────── compacted · ctrl+o
 *
 * The conversation above the divider stays visible (display transcript keeps
 * full history); only the LLM context was reset. Expanding (ctrl+o) reveals
 * the compaction summary below the divider.
 */
export class CompactionSummaryMessageComponent extends SummaryMessageComponent {
	constructor(input: CompactionSummaryMessage | CompactionSummaryView) {
		super("role" in input ? toCompactionSummaryView(input) : input);
	}
}

/**
 * A manual handoff is persisted as a custom message so the replacement session
 * receives its developer context. Render it with the same divider affordance as
 * `/compact` instead of the generic `[handoff]` box.
 */
export class HandoffSummaryMessageComponent extends SummaryMessageComponent {
	constructor(input: CustomMessage<unknown> | HandoffSummaryView) {
		super(
			"role" in input
				? { kind: "handoff-summary", summary: extractHandoffDocument(getCustomMessageText(input)) }
				: input,
		);
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
export class BranchSummaryMessageComponent extends SummaryMessageComponent {
	constructor(input: BranchSummaryMessage | BranchSummaryView) {
		super("role" in input ? toBranchSummaryView(input) : input);
	}
}
