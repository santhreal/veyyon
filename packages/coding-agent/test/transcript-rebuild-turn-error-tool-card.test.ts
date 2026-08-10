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
 * WHERE THE REASON IS SAID. Once, as the turn's own error, above the cards it cut short.
 * The cards say only that the call never ran. Splitting an assistant turn into display
 * segments used to scrub the stop reason off the head segment as well as the after-tool
 * ones, so a rebuilt dead turn stated its reason NOWHERE once the cards stopped carrying
 * it: the head keeps it now, the segments still do not, and live the pinned banner
 * suppresses the head's copy until it is dismissed.
 *
 * WHY THE REBUILDER AND NOT A COMPONENT. The component's rendering of a never-ran
 * placeholder is pinned in `tool-execution-interrupt-honesty.test.ts`. What was broken here
 * is which result the rebuilder hands it, so the test drives `rebuild()` with a real turn
 * and reads the rows.
 *
 * WHAT IT DOES NOT CATCH. The `read` group is a separate renderer with its own row state,
 * asserted below by its status glyph rather than a notice line, because a read row has no
 * notice. The live event path is covered by the honesty suite, `event-controller-error-banner`
 * (which pins the banner and restores the inline copy), and the session simulation.
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
// The turn error is width-truncated like any transcript row, so the assertions match its
// head rather than the whole sentence: what is under test is how many rows state it and
// which row that is, not the truncation.
const STREAM_ERROR_HEAD = "OpenAI completions stream closed";

function turnErrorRows(rows: readonly string[]): string[] {
	return rows.filter(row => row.includes(STREAM_ERROR_HEAD));
}

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

function deadTurn(calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>): SessionMessageEntry[] {
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
			content: calls.map((call, index) => ({
				type: "toolCall",
				id: `call-${index}`,
				name: call.name,
				arguments: call.args,
			})),
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
		const rows = rebuiltRows(deadTurn([{ name: "bash", args: { command: "npm run migrate:up" } }]));
		const body = rows.join("\n");

		expect(body).toContain("npm run migrate:up");
		expect(body).toContain("not executed: the provider stream failed before this call ran");
		// The transport error is the TURN's fact, stated once as the turn's error above the
		// cards. It must not also be presented as this command's own output under failure
		// chrome, which is what the fabricated `isError` result made the card say.
		expect(rows.some(row => row.includes("failed") && row.includes("bash"))).toBe(false);
		expect(body).not.toContain("Tool call was not executed because the provider stream ended");
		expect(turnErrorRows(rows)).toHaveLength(1);
		expect(turnErrorRows(rows)[0]?.startsWith(" Error: ")).toBe(true);
	});

	it("marks a read row as not run rather than as a failed read", () => {
		const rows = rebuiltRows(deadTurn([{ name: "read", args: { path: "packages/coding-agent/src/cli.ts" } }]));

		// The glyph is the whole row's claim: `!` says the read never happened, `✗` would say
		// the file could not be read, which is what the fabricated failure result made it say.
		expect(rows).toContain(" ! Read packages/coding-agent/src/cli.ts");
		expect(rows.some(row => row.includes("✗"))).toBe(false);
		expect(turnErrorRows(rows)).toHaveLength(1);
		expect(turnErrorRows(rows)[0]?.startsWith(" Error: ")).toBe(true);
	});

	it("states the provider's reason once for a whole dead batch, not once per dropped call", () => {
		// The wall of yellow text: a wide batch printed the same transport sentence on every
		// dropped call, under a turn error that had already said it. One statement per turn,
		// and one line per call saying only that it never ran.
		const rows = rebuiltRows(
			deadTurn([
				{ name: "bash", args: { command: "npm run migrate:up" } },
				{ name: "bash", args: { command: "npm run seed" } },
			]),
		);

		expect(turnErrorRows(rows)).toHaveLength(1);
		expect(turnErrorRows(rows)[0]?.startsWith(" Error: ")).toBe(true);
		expect(rows.filter(row => row.includes("not executed: the provider stream failed"))).toHaveLength(2);
		expect(rows.filter(row => row.includes("$ npm run"))).toHaveLength(2);
	});
});
