/**
 * Contract: a turn-level tool-batch ledger never dumps its model-facing body
 * into the transcript.
 *
 * WHAT THIS CLOSES. When a tool batch is cut short and no placeholder result
 * exists to hang the ledger on, the loop sends the whole ledger as a synthetic
 * user message. That text is a standing instruction to the MODEL — call ids,
 * retry orders, "arguments never finished" — and it used to render verbatim as
 * a dimmed user bubble, several dense rows of internal jargon per interrupted
 * batch. Both transcript surfaces (the live UiHelpers path and the rebuild
 * ChatTranscriptBuilder path) now collapse it to a one-line marker that keeps
 * the operator-facing fact: the batch was cut short, and the counts.
 *
 * WHAT IT DOES NOT CATCH. The placeholder tool-result form of the ledger is
 * rendered by ToolExecutionComponent's never-ran notice and is pinned by
 * tool-execution-interrupt-honesty.test.ts. Ledger expiry in the LLM context
 * is pinned by test/session/tool-batch-ledger-expiry.test.ts.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/components/chat-transcript-builder";
import { COMPOSER_INSET_COLS } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { UiHelpers } from "@veyyon/coding-agent/modes/utils/ui-helpers";
import type { SessionMessageEntry } from "@veyyon/coding-agent/session/session-entries";
import { Container, type TUI } from "@veyyon/tui";

const LEDGER_TEXT = [
	"Partial completion ledger for this tool batch (1 call): 0 ran, 1 never ran.",
	"Cause: the turn was aborted before the remaining calls were dispatched.",
	"- never ran, arguments never finished: tool_lqkR2mNN5n7yrjUqtWSj4yaj (bash)",
	'Only the calls marked "never ran" need retrying; they had no side effects.',
].join("\n");

function ledgerMessage(): AgentMessage {
	return { role: "user", content: LEDGER_TEXT, synthetic: true, timestamp: 1 };
}

function plainRows(container: Container): string[] {
	return container
		.render(80)
		.map(line => stripVTControlCharacters(line).replace(/\s+$/, ""))
		.filter(line => line.length > 0);
}

function makeUiHelpers(): { helpers: UiHelpers; chatContainer: Container } {
	const chatContainer = new Container();
	const ctx = {
		chatContainer,
		getUserMessageText: (message: AgentMessage) =>
			message.role === "user" && typeof message.content === "string" ? message.content : "",
		viewSession: { sessionManager: { putBlobSync: () => "blob://unused" } },
		editor: { addToHistory: () => {} },
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;
	return { helpers: new UiHelpers(ctx), chatContainer };
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

describe("a turn-level batch ledger in the transcript", () => {
	it("collapses to a one-line marker on the live path", () => {
		const { helpers, chatContainer } = makeUiHelpers();
		helpers.addMessageToChat(ledgerMessage());
		const rows = plainRows(chatContainer);
		const body = rows.join("\n");

		const marker = rows.filter(row => row.includes("batch cut short"));
		expect(marker).toHaveLength(1);
		// The marker is a transcript block like any other: it opens on the rail.
		expect(marker[0]?.slice(0, COMPOSER_INSET_COLS)).toBe(" ".repeat(COMPOSER_INSET_COLS));
		expect(marker[0]?.[COMPOSER_INSET_COLS]).not.toBe(" ");
		expect(rows.some(row => row.includes("(1 call): 0 ran, 1 never ran"))).toBe(true);
		expect(body).not.toContain("Partial completion ledger");
		expect(body).not.toContain("tool_lqkR2mNN5n7yrjUqtWSj4yaj");
		expect(body).not.toContain("never ran, arguments never finished");
	});

	it("collapses to a one-line marker on the rebuild path", () => {
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender: () => {} } as unknown as TUI,
			cwd: process.cwd(),
			requestRender: () => {},
		});
		try {
			const entry: SessionMessageEntry = {
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-08-15T00:00:00.000Z",
				message: ledgerMessage(),
			};
			builder.rebuild([entry]);
			const rows = plainRows(builder.container);
			const body = rows.join("\n");

			const marker = rows.filter(row => row.includes("batch cut short"));
			expect(marker).toHaveLength(1);
			expect(marker[0]?.slice(0, COMPOSER_INSET_COLS)).toBe(" ".repeat(COMPOSER_INSET_COLS));
			expect(body).not.toContain("Partial completion ledger");
			expect(body).not.toContain("tool_lqkR2mNN5n7yrjUqtWSj4yaj");
		} finally {
			builder.reset();
		}
	});

	it("leaves an ordinary synthetic user message rendered in full", () => {
		const { helpers, chatContainer } = makeUiHelpers();
		helpers.addMessageToChat({
			role: "user",
			content: "continue from where you stopped",
			synthetic: true,
			timestamp: 1,
		});
		expect(plainRows(chatContainer).join("\n")).toContain("continue from where you stopped");
	});
});
