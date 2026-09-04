// WHY: the compaction dead-end warning ("Compaction freed too little context…") was rendered
// twice at the top of a resumed turn: the prompt-time compaction check emits it, then the
// continuation it schedules 100ms later re-checks the same dead end and emits it again. Nothing
// sits between the two lines, so the second line is noise. This suite closes the class at the
// presenter: any warning repeated verbatim with nothing appended in between renders once, whatever
// emitted it. It does not catch a repeat separated by other chat content (a new line is correct
// there), a repeat whose text differs by one byte, or the double emission itself in
// `AgentSession`, which is a session-level concern the transcript never sees.
import { beforeAll, describe, expect, test, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { UiHelpers } from "@veyyon/coding-agent/modes/utils/ui-helpers";
import { type Component, Container } from "@veyyon/tui";

const DEAD_END =
	"compaction: Compaction freed too little context to make progress — pausing automatic maintenance to avoid a compaction loop.";

function harness(): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	const ctx = {
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		present: (content: Component | readonly Component[]) => {
			const items = Array.isArray(content) ? content : [content];
			for (const item of items) ctx.chatContainer.addChild(item);
			ctx.ui.requestRender();
		},
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, helpers: new UiHelpers(ctx) };
}

function renderedWarnings(container: Container, needle: string, width = 200): number {
	return container
		.render(width)
		.join("\n")
		.split("\n")
		.filter(line => line.includes(needle)).length;
}

describe("the same warning twice in a row is one warning", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	test("an identical warning with nothing between renders once", () => {
		const { ctx, helpers } = harness();
		helpers.showWarning(DEAD_END);
		helpers.showWarning(DEAD_END);
		// spacer + text, once
		expect(ctx.chatContainer.children).toHaveLength(2);
		expect(renderedWarnings(ctx.chatContainer, "freed too little context")).toBe(1);
	});

	test("a different warning gets its own line", () => {
		const { ctx, helpers } = harness();
		helpers.showWarning(DEAD_END);
		helpers.showWarning("LSP startup failed for ts. It will retry lazily on write.");
		expect(ctx.chatContainer.children).toHaveLength(4);
		expect(renderedWarnings(ctx.chatContainer, "Warning:")).toBe(2);
	});

	test("the same warning after other content gets its own line", () => {
		const { ctx, helpers } = harness();
		helpers.showWarning(DEAD_END);
		ctx.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		helpers.showWarning(DEAD_END);
		expect(ctx.chatContainer.children).toHaveLength(5);
		expect(renderedWarnings(ctx.chatContainer, "freed too little context")).toBe(2);
	});

	test("a status line between two identical warnings is content", () => {
		const { ctx, helpers } = harness();
		helpers.showWarning(DEAD_END);
		helpers.showStatus("Working");
		helpers.showWarning(DEAD_END);
		expect(renderedWarnings(ctx.chatContainer, "freed too little context")).toBe(2);
	});

	test("a warning repeated after an error is not collapsed", () => {
		const { ctx, helpers } = harness();
		helpers.showWarning(DEAD_END);
		helpers.showError("boom");
		helpers.showWarning(DEAD_END);
		expect(renderedWarnings(ctx.chatContainer, "freed too little context")).toBe(2);
	});
});
