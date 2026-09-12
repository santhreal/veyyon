import type { Component } from "@veyyon/tui";
import type { CustomBlock, CustomBlockDisplay } from "@veyyon/wire/presentation";
import { theme } from "../../../../theme/theme";
import { buildAsyncResultBlock, buildIrcMessageCard } from "../../utils/transcript-render-helpers";
import { createAdvisorMessageCard } from "./advisor-message";
import { createBackgroundTanDispatchBlock } from "./background-tan-message";
import { CollabPromptMessageComponent } from "./collab-prompt-message";
import { HandoffSummaryMessageComponent } from "./compaction-summary-message";
import { LateDiagnosticsMessageComponent } from "./late-diagnostics-message";
import { FramedMessageComponent } from "./message-frame";
import { SkillMessageComponent } from "./skill-message";

/**
 * Shared production factory for specialized custom message cards.
 */
export function createSpecializedCustomComponent(display: CustomBlockDisplay, getExpanded?: () => boolean): Component {
	switch (display.variant) {
		case "async-result":
			return buildAsyncResultBlock(display);
		case "late-diagnostics":
			return new LateDiagnosticsMessageComponent(display.files);
		case "collab-prompt":
			return new CollabPromptMessageComponent(display);
		case "skill-prompt":
			return new SkillMessageComponent(display);
		case "irc":
			return buildIrcMessageCard(display, getExpanded ?? (() => false));
		case "advisor":
			return createAdvisorMessageCard(display, getExpanded ?? (() => false), theme);
		case "background-tan":
			return createBackgroundTanDispatchBlock(display);
		case "handoff":
			return new HandoffSummaryMessageComponent({
				kind: "handoff-summary",
				summary: display.summary,
			});
	}
}

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends FramedMessageComponent<CustomBlock> {}
