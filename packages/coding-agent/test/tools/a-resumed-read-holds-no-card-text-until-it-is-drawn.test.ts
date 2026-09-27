/**
 * WHY THIS SUITE EXISTS:
 *
 * A session file stores a read card's text only as a tag naming how the result's numbered rows
 * rebuild it (`a-session-file-stores-a-read-card-once`). Loading the session rebuilt every tagged card
 * text at once, as a rope over one sliced string per row, and the transcript copied each into its read
 * row. With read previews off, which is the default, no card ever draws that text, so a resumed
 * session held a second copy of every file it had read, in several string cells per row, for as long
 * as it stayed open: 50 MiB and 1.67 million cells on a 2627-read session.
 *
 * CLASS: a loaded `rows` card text is built on first read and never before it. Opening the session and
 * rebuilding its transcript with previews off keeps no copy of the rows, whatever form the copy takes
 * (a rope, a flat join, a copy the read row takes), and neither does a rewrite that writes every read
 * again, which writes an unchanged result's card as the tag it was loaded from; rebuilding with
 * previews on draws the rows; and a result whose content is replaced after the load (a prune, a shake,
 * a compaction elision) still writes the card text it was loaded with, since the rebuild reads the
 * rows the line was written with.
 *
 * DOES NOT CATCH: a consumer outside the transcript rebuild and the session writer that reads
 * `displayContent.text` of every loaded result, which builds every card text again; the bound here
 * covers only the open, the rebuild and a rewrite. A `prefix` card text is a slice of the result's text
 * and is built eagerly, as it costs one string cell.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { BUILTIN_RESULT_CODECS } from "@veyyon/coding-agent/tools/index";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { registerToolResultCodecs } from "@veyyon/kernel/session/tool-result-codecs";
import type { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { liveStringBytes } from "../helpers/live-string-bytes";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

/** A heap snapshot walks the whole process heap; in a shared suite process each takes seconds. */
const SNAPSHOT_ROW_TIMEOUT_MS = 60_000;

/** The rows a read returned: distinct per read, so the loader's string pool shares none of them. */
function fileRows(read: number, rows: number): string[] {
	return Array.from(
		{ length: rows },
		(_, row) => `\tconst value${read}_${row} = compute(${row}, "${"x".repeat(32)}");`,
	);
}

/** A read result as the read tool returns it: numbered rows under a snapshot header, and its card text. */
function readResult(read: number, rows: number): { result: ToolResultMessage<ReadToolDetails>; body: string } {
	const lines = fileRows(read, rows);
	const body = `[src/file-${read}.ts#1A2B]\n${lines.map((line, i) => `${i + 1}:${line}`).join("\n")}`;
	return {
		body,
		result: {
			role: "toolResult",
			toolCallId: `read-${read}`,
			toolName: "read",
			content: [{ type: "text", text: body }],
			details: { displayContent: { text: lines.join("\n"), startLine: 1 } },
			isError: false,
			timestamp: 2,
		},
	};
}

function assistantCalling(ids: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id, read) => ({
			type: "toolCall",
			id,
			name: "read",
			arguments: { path: `src/file-${read}.ts` },
		})),
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function rebuiltBuilder(manager: SessionManager, preview: boolean): ChatTranscriptBuilder {
	const builder = new ChatTranscriptBuilder({
		ui,
		cwd: manager.getCwd(),
		requestRender: () => {},
		getSettings: () => Settings.isolated({ "read.toolResultPreview": preview }),
	});
	builder.rebuild(manager.buildSessionContext({ transcript: true }));
	return builder;
}

describe("a resumed read holds no card text until it is drawn", () => {
	let root: TempDir;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		registerToolResultCodecs(BUILTIN_RESULT_CODECS);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(() => {
		root = TempDir.createSync("@pi-resumed-read-card-");
	});

	afterEach(async () => {
		await root.remove();
	});

	async function recordReads(results: readonly ToolResultMessage<ReadToolDetails>[]): Promise<string> {
		const manager = SessionManager.create(root.path(), root.join("sessions"));
		manager.appendMessage(assistantCalling(results.map(result => result.toolCallId)));
		for (const result of results) manager.appendMessage(result);
		await manager.flush();
		const file = manager.getSessionFile() as string;
		// The written line holds the tag and no text, so the load is the path under test.
		expect(fs.readFileSync(file, "utf8")).toContain('"from":"rows"');
		return file;
	}

	/** What a resumed session does after its transcript rebuilds, each leaving the rows unbuilt. */
	const AFTER_OPEN: Array<{ step: string; run: (manager: SessionManager) => Promise<void> }> = [
		{ step: "the session opens and its transcript rebuilds with previews off", run: async () => {} },
		{
			step: "the session rewrites every entry after its first",
			run: manager => manager.rewriteEntries([manager.getEntries()[0]!]),
		},
	];

	for (const { step, run } of AFTER_OPEN) {
		it(
			`keeps no copy of the rows after ${step}`,
			async () => {
				const reads = Array.from({ length: 24 }, (_, read) => readResult(read, 2000));
				const bodyBytes = reads.reduce((sum, read) => sum + read.body.length, 0);
				const file = await recordReads(reads.map(read => read.result));
				// A throwaway pass over a one-read session loads every module and cache the measured pass
				// reaches, without leaving the measured session's own text behind.
				const warmed = await SessionManager.open(await recordReads([readResult(99, 3).result]));
				rebuiltBuilder(warmed, false).reset();
				await run(warmed);

				const before = liveStringBytes();
				const manager = await SessionManager.open(file);
				const builder = rebuiltBuilder(manager, false);
				await run(manager);
				const grown = liveStringBytes() - before;

				expect(manager.getEntries().length).toBe(reads.length + 1);
				// The measurement sees the loaded results, so a bound it passes is not a count that missed them.
				// Half, since strings an earlier file in the same process left behind can die in the window.
				expect(grown).toBeGreaterThan(bodyBytes / 2);
				// The session holds each result's text once. A second copy of the rows, in any form, is
				// another body's worth of bytes on top.
				expect(grown).toBeLessThan(bodyBytes * 1.5);
				builder.reset();
				// Every card is still written as its tag.
				expect(fs.readFileSync(file, "utf8").match(/"from":"rows"/g)?.length).toBe(reads.length);
			},
			SNAPSHOT_ROW_TIMEOUT_MS,
		);
	}

	it("draws the loaded rows when read previews are on", async () => {
		const file = await recordReads([readResult(0, 3).result]);
		const builder = rebuiltBuilder(await SessionManager.open(file), true);
		const drawn = builder.container.render(160).map(line => stripVTControlCharacters(line));
		builder.reset();
		for (const row of fileRows(0, 3)) {
			expect(drawn.some(line => line.includes(row.trim()))).toBe(true);
		}
		// The rows drawn are the card's, not the numbered rows the model read.
		expect(drawn.some(line => /\d:\s*const value0_/.test(line))).toBe(false);
	});

	it("writes the card text it was loaded with once the result's content is replaced", async () => {
		const { result } = readResult(0, 40);
		const loadedText = result.details?.displayContent?.text;
		const file = await recordReads([result]);
		const manager = await SessionManager.open(file);
		const loaded = manager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "toolResult");
		if (loaded?.type !== "message" || loaded.message.role !== "toolResult") throw new Error("read result missing");
		// What a prune leaves in place of the rows.
		loaded.message.content = [{ type: "text", text: "[Output truncated - 900 tokens]" }];
		await manager.rewriteEntries();

		const written = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(line => line.includes('"toolResult"'))
			.map(line => JSON.parse(line) as { message: ToolResultMessage<ReadToolDetails> });
		expect(written.map(entry => entry.message.details?.displayContent)).toEqual([{ text: loadedText, startLine: 1 }]);
	});
});
