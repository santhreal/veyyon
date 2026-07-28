import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
	HandoffSummaryMessageComponent,
} from "@veyyon/coding-agent/modes/components/compaction-summary-message";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { CustomMessage } from "@veyyon/coding-agent/session/messages";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

function makeHandoffMessage(content: CustomMessage<unknown>["content"]): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: "handoff",
		content,
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

describe("compaction summary divider", () => {
	/** Stored compaction summaries stay collapsed behind the transcript's Ctrl+O affordance. */
	it("renders a collapsed compaction divider instead of a user or assistant response", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "The parser fix is complete.",
			tokensBefore: 12_345,
			timestamp: Date.now(),
		});
		const collapsed = Bun.stripANSI(component.render(80).join("\n"));

		expect(collapsed).toContain("compacted");
		expect(collapsed).toContain("ctrl+o");
		expect(collapsed).not.toContain("The parser fix is complete.");
	});

	/** Expanding the divider reveals summary prose but never its private provider delimiter. */
	it("expands summary prose without rendering summary tags", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "<summary>\nThe parser fix is complete.\n</summary>",
			tokensBefore: 12_345,
			timestamp: Date.now(),
		});
		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(80).join("\n"));

		expect(expanded).toContain("Compacted from 12,345 tokens");
		expect(expanded).toContain("The parser fix is complete.");
		expect(expanded).not.toContain("<summary>");
		expect(expanded).not.toContain("</summary>");
	});
});

describe("handoff summary divider", () => {
	it("renders handoff custom messages with the compact divider instead of a framed block", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage(
				`<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>\n\nThe above is a handoff document.`,
			),
			false,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const collapsed = Bun.stripANSI(component!.render(80).join("\n"));
		expect(collapsed).toContain("handoff");
		expect(collapsed).toContain("ctrl+o");
		expect(collapsed).not.toContain("[handoff]");
		expect(collapsed).not.toContain("Continue the resize fix");
	});

	it("expands to the handoff document without the provider-only XML wrapper", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage([
				{
					type: "text",
					text: "<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>",
				},
			]),
			true,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const expanded = Bun.stripANSI(component!.render(80).join("\n"));
		expect(expanded).toContain("Handoff context");
		expect(expanded).toContain("Continue the resize fix");
		expect(expanded).not.toContain("<handoff-context>");
		expect(expanded).not.toContain("</handoff-context>");
	});

	it("leaves unrelated custom messages on the generic renderer path", () => {
		const message = makeHandoffMessage("Not a handoff.");
		message.customType = "extension-note";

		expect(createHandoffSummaryMessageComponent(message, false)).toBeUndefined();
	});
});
