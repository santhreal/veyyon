/**
 * A session of read results, and the string bytes it leaves live, measured in the process that runs
 * this file. The test imports the builders. Run as a script, it brings 24 reads of 2000 rows into a
 * session under argv[2] the way argv[3] names, rebuilds its transcript with read previews off, runs the
 * step argv[4] names, and prints, as JSON: the bytes of the read bodies, the string bytes the arrival
 * and the step left live, the entries the session holds, and how many card tags its file holds after.
 *
 * Arrivals: `load` opens a session file the reads were recorded to; `record` records reads as the
 * tool returns them into a new session, as a running session does.
 * Steps: `open` runs nothing after the rebuild; `rewrite` rewrites every entry after the first.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { BUILTIN_RESULT_CODECS } from "@veyyon/coding-agent/tools/index";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { registerToolResultCodecs } from "@veyyon/kernel/session/tool-result-codecs";
import type { TUI } from "@veyyon/tui";
import { postmortem } from "@veyyon/utils";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";

/** What a card tag looks like in a written line. */
export const ROWS_TAG = /"from":"rows"/g;

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

/** Settings, theme and result codecs as a host sets them up before it opens a session. */
export async function setUpReadSessions(): Promise<void> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	registerToolResultCodecs(BUILTIN_RESULT_CODECS);
}

/** The rows a read returned: distinct per read, so the loader's string pool shares none of them. */
export function fileRows(read: number, rows: number): string[] {
	return Array.from(
		{ length: rows },
		(_, row) => `\tconst value${read}_${row} = compute(${row}, "${"x".repeat(32)}");`,
	);
}

/** A read result as the read tool returns it: numbered rows under a snapshot header, and its card text. */
export function readResult(read: number, rows: number): { result: ToolResultMessage<ReadToolDetails>; body: string } {
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

/** A new session under `dir` of one assistant turn calling every read and the results after it, flushed. */
async function recordSession(
	dir: string,
	results: readonly ToolResultMessage<ReadToolDetails>[],
): Promise<SessionManager> {
	const manager = SessionManager.create(dir, path.join(dir, "sessions"));
	manager.appendMessage(assistantCalling(results.map(result => result.toolCallId)));
	for (const result of results) manager.appendMessage(result);
	await manager.flush();
	return manager;
}

/** The file of a session {@link recordSession} records. */
export async function recordReads(
	dir: string,
	results: readonly ToolResultMessage<ReadToolDetails>[],
): Promise<string> {
	return (await recordSession(dir, results)).getSessionFile() as string;
}

export function rebuiltBuilder(manager: SessionManager, preview: boolean): ChatTranscriptBuilder {
	const builder = new ChatTranscriptBuilder({
		ui,
		cwd: manager.getCwd(),
		requestRender: () => {},
		getSettings: () => Settings.isolated({ "read.toolResultPreview": preview }),
	});
	builder.rebuild(manager.buildSessionContext({ transcript: true }));
	return builder;
}

export type Arrival = "load" | "record";

/**
 * How reads reach a session under `dir`. The outer call runs before a measurement and returns the call
 * that brings the reads `results` builds into the session, which runs inside it: `load` records them to
 * a file first and opens that file, `record` builds them and records them into a new session.
 */
export const ARRIVALS: Readonly<
	Record<
		Arrival,
		(dir: string, results: () => ToolResultMessage<ReadToolDetails>[]) => Promise<() => Promise<SessionManager>>
	>
> = {
	load: async (dir, results) => {
		const file = await recordReads(dir, results());
		return () => SessionManager.open(file);
	},
	record: async (dir, results) => () => recordSession(dir, results()),
};

export type Step = "open" | "rewrite";

/** What a session does after its transcript rebuilds. */
export const STEPS: Readonly<Record<Step, (manager: SessionManager) => Promise<void>>> = {
	open: async () => {},
	rewrite: manager => manager.rewriteEntries([manager.getEntries()[0]!]),
};

export interface Growth {
	reads: number;
	bodyBytes: number;
	grown: number;
	entries: number;
	/** Card tags the session file holds after the step. */
	tags: number;
}

export function rowsTags(file: string): number {
	return fs.readFileSync(file, "utf8").match(ROWS_TAG)?.length ?? 0;
}

const READS = 24;
const ROWS = 2000;

function measuredReads(): ToolResultMessage<ReadToolDetails>[] {
	return Array.from({ length: READS }, (_, read) => readResult(read, ROWS).result);
}

async function measure(dir: string, arrival: Arrival, step: Step): Promise<Growth> {
	await setUpReadSessions();
	const arrive = ARRIVALS[arrival];
	const run = STEPS[step];
	let bodyBytes = 0;
	for (let read = 0; read < READS; read++) bodyBytes += readResult(read, ROWS).body.length;
	const measured = await arrive(dir, measuredReads);
	// A throwaway pass over a one-read session loads every module and cache the measured pass reaches,
	// without leaving the measured session's own text behind.
	const warmed = await (await arrive(dir, () => [readResult(99, 3).result]))();
	rebuiltBuilder(warmed, false).reset();
	await run(warmed);

	const before = await liveStringBytes();
	const manager = await measured();
	const builder = rebuiltBuilder(manager, false);
	await run(manager);
	const grown = (await liveStringBytes()) - before;
	const entries = manager.getEntries().length;
	builder.reset();
	return { reads: READS, bodyBytes, grown, entries, tags: rowsTags(manager.getSessionFile() as string) };
}

if (import.meta.main) {
	try {
		const [dir, arrival, step] = process.argv.slice(2);
		if (!dir || !(arrival !== undefined && arrival in ARRIVALS) || !(step !== undefined && step in STEPS)) {
			throw new Error(
				`usage: read-string-growth.ts <dir> <${Object.keys(ARRIVALS).join("|")}> <${Object.keys(STEPS).join("|")}>`,
			);
		}
		process.stdout.write(`${JSON.stringify(await measure(dir, arrival as Arrival, step as Step))}\n`);
	} finally {
		await postmortem.cleanup();
	}
}
