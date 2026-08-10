/**
 * What a rebuilt transcript says about a tool call whose TURN died.
 *
 * WHAT THIS CLOSES. A turn that ends with a provider error carries its tool calls with no
 * result of their own, and every rebuild site fabricated one: `{ content: [the provider's
 * error], isError: true }` with no details at all. That shape says the TOOL failed. It did
 * not: the turn did, and the call never reached a tool. So the operator got a red `failed`
 * frame, the transport error presented as that command's own output, and no statement that
 * nothing had run, which is the only fact that mattered. The live path had been fixed for
 * exactly this and the rebuild had not, so the card changed its story when the transcript
 * was rebuilt from state.
 *
 * The rebuild now hands those calls the loop's own `assistant_stop_error` placeholder
 * (`turnFailedToolResult`), so both surfaces render one shape.
 *
 * WHY THE REBUILDER AND NOT A COMPONENT. The component's rendering of a never-ran
 * placeholder is pinned in `tool-execution-interrupt-honesty.test.ts`. What was broken here
 * is which result the rebuilder hands it, so the test drives `rebuild()` with a real turn
 * and reads the rows.
 *
 * WHAT IT DOES NOT CATCH. The `read` group is a separate renderer with its own row state,
 * asserted below by its status glyph rather than a notice line, because a read row has no
 * notice. The live event path is covered by the honesty suite plus the session simulation.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/components/chat-transcript-builder";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { SessionMessageEntry } from "@veyyon/coding-agent/session/session-entries";
import type { TUI } from "@veyyon/tui";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
const STREAM_ERROR = "OpenAI completions stream closed before a terminal finish reason was received";

let entryCounter = 0;

function entry(message: AgentMessage): SessionMessageEntry {
	entryCounter += 1;
	return {
		type: "message",
		id: `entry-${entryCounter}`,
		parentId: null,
		timestamp: "2026-08-07T00:00:00.000Z",
		message,
	};
}

function deadTurn(toolName: string, args: Record<string, unknown>): SessionMessageEntry[] {
	return [
		entry({ role: "user", content: "do the thing", timestamp: 1 }),
		entry({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{ type: "toolCall", id: "call-a", name: toolName, arguments: args }],
			stopReason: "error",
			errorMessage: STREAM_ERROR,
			timestamp: 2,
		}),
	];
}

function rebuiltRows(entries: SessionMessageEntry[]): string[] {
	const builder = new ChatTranscriptBuilder({ ui, cwd: process.cwd(), requestRender: () => {} });
	try {
		builder.rebuild(entries);
		return builder.container
			.render(80)
			.map(line => stripVTControlCharacters(line).replace(/\s+$/, ""))
			.filter(line => line.length > 0);
	} finally {
		builder.reset();
	}
}

describe("a rebuilt turn that died before its tools ran", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("renders the call and one not-executed line, not a failed tool", () => {
		const rows = rebuiltRows(deadTurn("bash", { command: "npm run migrate:up" }));
		const body = rows.join("\n");

		expect(body).toContain("npm run migrate:up");
		expect(body).toContain("not executed: the provider stream failed before this call ran");
		// The transport error is the TURN's fact and is stated as the turn's error. It must not
		// also be presented as this command's own output under failure chrome.
		expect(rows.some(row => row.includes("failed") && row.includes("bash"))).toBe(false);
		expect(body).not.toContain("Tool call was not executed because the provider stream ended");
	});

	it("marks a read row as not run rather than as a failed read", () => {
		const rows = rebuiltRows(deadTurn("read", { path: "packages/coding-agent/src/cli.ts" }));

		// The glyph is the whole row's claim: `!` says the read never happened, `✗` would say
		// the file could not be read, which is what the fabricated failure result made it say.
		expect(rows).toContain(" ! Read packages/coding-agent/src/cli.ts");
		expect(rows.some(row => row.includes("✗"))).toBe(false);
		expect(rows.join("\n")).not.toContain(STREAM_ERROR);
	});
});
