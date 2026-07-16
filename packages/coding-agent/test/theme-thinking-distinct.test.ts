import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@veyyon/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@veyyon/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@veyyon/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@veyyon/pi-coding-agent/modes/controllers/event-controller";
import { defaultThemes } from "@veyyon/pi-coding-agent/modes/theme/defaults";
import { getResolvedThemeColors, initTheme } from "@veyyon/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@veyyon/pi-coding-agent/session/agent-session";
import type { TUI } from "@veyyon/pi-tui";

const THINKING_MARKER = "REASONING TRACE MARKER";
const ANSWER_MARKER = "FINAL ANSWER MARKER";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor",
		provider: "cursor",
		model: "cursor-model",
		stopReason: "stop",
		usage: zeroUsage(),
		timestamp: 1,
	};
}

function createFixture() {
	const chatContainer = new TranscriptContainer();
	const ui = {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
		imageBudget: undefined,
	} as unknown as TUI;
	const viewSession = {
		getToolByName: () => undefined,
		extensionRunner: undefined,
		isTtsrAbortPending: false,
		retryAttempt: 0,
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui,
		settings,
		chatContainer,
		pendingTools: new Map(),
		toolOutputExpanded: false,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		noteDisplayableThinkingContent: vi.fn(() => false),
		session: viewSession,
		viewSession,
		sessionManager: { getCwd: () => process.cwd() },
		showWarning: vi.fn(),
		showPinnedError: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		lastAssistantUsage: zeroUsage(),
	} as unknown as InteractiveModeContext;

	return { controller: new EventController(ctx), chatContainer };
}

describe("thinking text visual distinctness", () => {
	beforeAll(async () => {
		// Headless test runs detect no color support and chalk strips the italic
		// escape; force full styling so the render assertions see real output.
		(await import("chalk")).default.level = 3;
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	});

	it("every builtin theme resolves thinkingText distinct from body text", async () => {
		const names = ["dark", "light", ...Object.keys(defaultThemes)];
		const offenders: string[] = [];
		for (const name of names) {
			const colors = await getResolvedThemeColors(name);
			const text = colors.text ?? "";
			const thinking = colors.thinkingText ?? "";
			// `text: ""` means the terminal's default foreground, so thinkingText
			// must be a concrete color; a concrete text color must simply differ.
			if (thinking === "" || thinking === text) {
				offenders.push(`${name} (text=${JSON.stringify(text)} thinkingText=${JSON.stringify(thinking)})`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("renders thinking blocks with styling the answer text does not carry", async () => {
		const { controller, chatContainer } = createFixture();
		const message = assistantMessage([
			{ type: "thinking", thinking: THINKING_MARKER },
			{ type: "text", text: ANSWER_MARKER },
		]);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const rawLines = chatContainer.render(120);
		const thinkingLine = rawLines.find(line => Bun.stripANSI(line).includes(THINKING_MARKER));
		const answerLine = rawLines.find(line => Bun.stripANSI(line).includes(ANSWER_MARKER));
		if (thinkingLine === undefined || answerLine === undefined) {
			throw new Error(`Transcript missing markers:\n${rawLines.map(line => Bun.stripANSI(line)).join("\n")}`);
		}

		// Thinking renders italic (CSI 3m) in the theme's thinkingText color;
		// answer text carries neither.
		expect(thinkingLine).toContain("\x1b[3m");
		expect(answerLine).not.toContain("\x1b[3m");
		const thinkingStyling = thinkingLine.replaceAll(THINKING_MARKER, "MARKER");
		const answerStyling = answerLine.replaceAll(ANSWER_MARKER, "MARKER");
		expect(thinkingStyling).not.toBe(answerStyling);
	});
});
