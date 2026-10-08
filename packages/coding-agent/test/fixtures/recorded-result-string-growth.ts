/**
 * Results of every tool whose codec settles a recorded result, and the string bytes a persisting
 * session that records them leaves live, measured in the process that runs this file. The test
 * imports the builders. Run as a script, it records 24 results of the tool argv[3] names into a new
 * session under argv[2], each repeating a 2000-row text between its content and its details, and
 * prints, as JSON: the bytes of the content texts, the bytes of the details text they repeat, the
 * string bytes the recording left live and the entries the session holds.
 */
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem } from "@veyyon/utils";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";
import { fileRows, readResult, setUpReadSessions } from "./read-string-growth";

/** The text a result repeats, joined anew on each call, so no two results share one string. */
function repeatedText(index: number, rows: number): string {
	return fileRows(index, rows).join("\n");
}

/**
 * A result of each tool whose codec settles, as the tool returns it: its details hold, in a string
 * of their own, a `rows`-row text its content text holds verbatim. Keyed by tool name.
 */
export const SETTLED_RESULTS: Readonly<Record<string, (index: number, rows: number) => ToolResultMessage>> = {
	read: (index, rows) => readResult(index, rows).result,
	eval: (index, rows) => ({
		role: "toolResult",
		toolCallId: `eval-${index}`,
		toolName: "eval",
		content: [{ type: "text", text: repeatedText(index, rows) }],
		details: { cells: [{ index: 0, code: "print(rows)", output: repeatedText(index, rows), status: "complete" }] },
		isError: false,
		timestamp: 2,
	}),
	job: (index, rows) => ({
		role: "toolResult",
		toolCallId: `job-${index}`,
		toolName: "job",
		content: [
			{
				type: "text",
				text: `## Completed (1)\n\n### job-${index} [bash] — completed\nLabel: build\n\`\`\`\n${repeatedText(index, rows)}\n\`\`\``,
			},
		],
		details: {
			jobs: [
				{
					id: `job-${index}`,
					type: "bash",
					status: "completed",
					label: "build",
					durationMs: 1,
					resultText: repeatedText(index, rows),
				},
			],
		},
		isError: false,
		timestamp: 2,
	}),
};

function assistantCalling(results: readonly ToolResultMessage[]): AssistantMessage {
	return {
		role: "assistant",
		content: results.map(result => ({
			type: "toolCall",
			id: result.toolCallId,
			name: result.toolName,
			arguments: {},
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

/** A new session under `dir` of one assistant turn calling every result and the results after it, flushed. */
export async function recordResults(dir: string, results: readonly ToolResultMessage[]): Promise<SessionManager> {
	const manager = SessionManager.create(dir, path.join(dir, "sessions"));
	manager.appendMessage(assistantCalling(results));
	for (const result of results) manager.appendMessage(result);
	await manager.flush();
	return manager;
}

export interface RecordedGrowth {
	results: number;
	/** Bytes the results' content texts occupy. */
	bodyBytes: number;
	/** Bytes the long strings of the results' details occupy as the tool returned them. */
	repeatedBytes: number;
	grown: number;
	entries: number;
}

const RESULTS = 24;
const ROWS = 2000;
/** A details string at least this long is a repeat of the content text, not a label. */
const LONG = 1024;

/**
 * Bytes a string's characters occupy: one each when every one fits in Latin-1, else two. A job
 * result's heading holds an em dash, so its content text takes two bytes a character, and a slice
 * of it as many.
 */
function stringBytes(text: string): number {
	for (let at = 0; at < text.length; at++) {
		if (text.charCodeAt(at) > 0xff) return text.length * 2;
	}
	return text.length;
}

function longStringBytes(value: unknown): number {
	if (typeof value === "string") return value.length >= LONG ? stringBytes(value) : 0;
	if (typeof value !== "object" || value === null) return 0;
	let bytes = 0;
	for (const item of Object.values(value)) bytes += longStringBytes(item);
	return bytes;
}

async function measure(dir: string, tool: string): Promise<RecordedGrowth> {
	await setUpReadSessions();
	const sample = SETTLED_RESULTS[tool]!;
	let bodyBytes = 0;
	let repeatedBytes = 0;
	for (let index = 0; index < RESULTS; index++) {
		const result = sample(index, ROWS);
		for (const block of result.content) bodyBytes += block.type === "text" ? stringBytes(block.text) : 0;
		repeatedBytes += longStringBytes(result.details);
	}
	// A throwaway recording of one small result loads every module and cache the measured one reaches.
	await recordResults(dir, [sample(99, 3)]);

	const before = await liveStringBytes();
	const manager = await recordResults(
		dir,
		Array.from({ length: RESULTS }, (_, index) => sample(index, ROWS)),
	);
	const grown = (await liveStringBytes()) - before;
	return { results: RESULTS, bodyBytes, repeatedBytes, grown, entries: manager.getEntries().length };
}

if (import.meta.main) {
	try {
		const [dir, tool] = process.argv.slice(2);
		if (!dir || tool === undefined || !(tool in SETTLED_RESULTS)) {
			throw new Error(`usage: recorded-result-string-growth.ts <dir> <${Object.keys(SETTLED_RESULTS).join("|")}>`);
		}
		process.stdout.write(`${JSON.stringify(await measure(dir, tool))}\n`);
	} finally {
		await postmortem.cleanup();
	}
}
