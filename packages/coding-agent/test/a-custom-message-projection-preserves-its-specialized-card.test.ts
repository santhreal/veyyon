/**
 * WHY: projection discarded specialized metadata, changed text boundaries, and reversed incoming
 * IRC body precedence. These checks cover custom and hook messages through the production
 * projection and card factory. Advisor severities come from the actual advise input schema;
 * a new severity requires an explicit presentation decision. Terminal transport and extension
 * callbacks are covered separately.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Text } from "@veyyon/tui";
import type { CustomBlockDisplay } from "@veyyon/wire/presentation";
import { AdviseTool } from "../src/advisor/advise-tool";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "../src/collab/protocol";
import {
	CustomMessageComponent,
	createSpecializedCustomComponent,
} from "../src/modes/terminal/components/transcript/custom-message";
import { HookMessageComponent } from "../src/modes/terminal/components/transcript/hook-message";
import { readCustomLevel } from "../src/presentation/custom-display";
import { toTranscriptBlock } from "../src/presentation/transcript-builder";
import {
	type CustomMessage,
	type HookMessage,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
} from "../src/session/messages";
import { initTheme, theme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function project(message: CustomMessage<unknown> | HookMessage<unknown>): CustomBlockDisplay {
	const block = toTranscriptBlock(message, { index: 0 });
	if ((block.kind !== "custom" && block.kind !== "hook") || !block.display) {
		throw new Error(`Specialized ${message.customType} card was replaced by ${block.kind}`);
	}
	return block.display;
}

for (const role of ["custom", "hookMessage"] as const) {
	describe(role, () => {
		test("framed cards restore their default content after an expanded renderer", () => {
			const text = Array.from({ length: 8 }, (_, index) => `Paragraph ${index}`).join("\n\n");
			const block = toTranscriptBlock(
				{
					role,
					customType: "note",
					content: text,
					display: true,
					timestamp: 0,
				},
				{ index: 0 },
			);
			const renderer = ({ expanded }: { expanded: boolean }) =>
				expanded ? new Text("Expanded renderer", 0, 0) : undefined;
			if (block.kind !== "custom" && block.kind !== "hook") throw new Error("Expected a framed block");
			const card =
				block.kind === "custom"
					? new CustomMessageComponent(block, renderer)
					: new HookMessageComponent(block, renderer);
			try {
				const collapsed = card.render(100).join("\n");
				expect(collapsed).toContain("Paragraph 0");
				if (role === "custom") expect(collapsed).toContain("Paragraph 7");
				else expect(collapsed).not.toContain("Paragraph 7");
				card.setExpanded(true);
				const expanded = card.render(100).join("\n");
				expect(expanded).toContain("Expanded renderer");
				expect(expanded).not.toContain("Paragraph 0");
				card.setExpanded(false);
				expect(card.render(100).join("\n")).toBe(collapsed);
			} finally {
				card.dispose();
			}
		});

		test("framed projections preserve empty paragraph chunks", () => {
			const block = toTranscriptBlock(
				{
					role,
					customType: "note",
					content: ["", "first", "", "last"].map(text => ({ type: "text" as const, text })),
					display: true,
					timestamp: 0,
				},
				{ index: 0 },
			);
			expect(block).toMatchObject({
				kind: role === "custom" ? "custom" : "hook",
				text: "\nfirst\n\nlast",
			});
		});

		test.each([
			["error", "error"],
			["warning", "warning"],
			["info", "info"],
			["fatal", "info"],
			[undefined, "info"],
		] as const)("level %p reaches the block as %p", (level, expected) => {
			const message = { role, customType: "note", content: "Body", display: true, timestamp: 0, level };
			expect(readCustomLevel(message)).toBe(expected);
			const block = toTranscriptBlock(message, { index: 0 });
			if (block.kind !== "custom" && block.kind !== "hook") throw new Error(`unexpected ${block.kind}`);
			expect(block.level).toBe(role === "custom" || expected !== "info" ? expected : undefined);
		});

		test.each([
			[COLLAB_PROMPT_MESSAGE_TYPE, "collab-prompt", "firstlast"],
			[SKILL_PROMPT_MESSAGE_TYPE, "skill-prompt", "\nfirst\n\nlast"],
		])("%s preserves its text fragment boundaries", (customType, variant, text) => {
			const content = [
				{ type: "text" as const, text: "" },
				{ type: "text" as const, text: "first" },
				{ type: "text" as const, text: "" },
				{ type: "text" as const, text: "last" },
			];
			const message = { role, content, display: true, timestamp: 0 };
			expect(project({ ...message, customType })).toMatchObject({ variant, text });
		});

		test.each([
			["async-result", { variant: "async-result", jobs: [{}] }],
			[LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, { variant: "late-diagnostics", files: [] }],
			["advisor", { variant: "advisor", notes: [] }],
		] as const)("%s retains specialized presentation without optional details", (customType, expected) => {
			for (const details of [undefined, null, false, "metadata", []]) {
				expect(project({ role, customType, content: "Envelope", details, display: true, timestamp: 0 })).toEqual(
					expected,
				);
			}
		});

		test("every admitted advisor severity preserves its badge and rail tone", async () => {
			const tool = new AdviseTool(() => {});
			const schema = tool.parameters.toJsonSchema() as {
				properties: { severity: { anyOf: { const: string }[] } };
			};
			const severities = schema.properties.severity.anyOf.map(branch => branch.const);
			expect([...severities].sort()).toEqual(["blocker", "concern", "nit"]);
			for (const severity of severities) {
				if (severity !== "nit" && severity !== "concern" && severity !== "blocker") {
					throw new Error(`Missing presentation decision for ${severity}`);
				}
				const result = await tool.execute(`advice-${severity}`, { note: `Review ${severity}`, severity });
				const display = project({
					role,
					customType: "advisor",
					content: "Advice available",
					details: { notes: [result.details] },
					display: true,
					timestamp: 0,
				});
				expect(display).toMatchObject({ variant: "advisor", notes: [{ severity }] });
				const card = createSpecializedCustomComponent(display);
				try {
					const rows = card.render(100).join("\n");
					expect(rows).toContain(`Review ${severity}`);
					expect(rows).toContain(severity);
					const tone = severity === "blocker" ? "error" : severity === "concern" ? "warning" : "muted";
					expect(rows).toContain(theme.fg(tone, theme.symbol("advisor.rail")));
				} finally {
					card.dispose?.();
				}
			}
		});

		for (const kind of ["incoming", "autoreply", "relay"] as const) {
			test(`IRC ${kind} preserves the production body precedence`, () => {
				const display = project({
					role,
					customType: `irc:${kind}`,
					content: "Transport envelope",
					details: { from: "peer", to: "recipient", message: "Incoming primary text", body: "Other body text" },
					display: true,
					timestamp: 0,
				});
				const expected = kind === "incoming" ? "Incoming primary text" : "Other body text";
				expect(display).toMatchObject({ variant: "irc", kind, body: expected });
				const card = createSpecializedCustomComponent(display);
				try {
					const rows = card.render(100).join("\n");
					expect(rows).toContain(expected);
					expect(rows).not.toContain(kind === "incoming" ? "Other body text" : "Incoming primary text");
				} finally {
					card.dispose?.();
				}
			});
		}
	});
}
