/**
 * The heap cells a rebuilt and drawn transcript leaves live per turn, by cell type, measured in the
 * process that runs this file. Run as a script, it rebuilds and draws a transcript of `TURNS` and
 * then `2 * TURNS` turns of each shape and prints, as JSON, the growth in live cells of each type
 * between the two divided by `TURNS`.
 *
 * Shapes cover the turns a transcript draws: every subject `transcript-collection-growth.ts` sweeps
 * (a conversation turn with thinking, a read showing an image, and one call of each shipped tool), a
 * plain answer, a failed turn and a narrated tool call (text before the call). The process claims the
 * Kitty image protocol, so an image is drawn as an image rather than as its text placeholder.
 */

import { heapStats } from "bun:jsc";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { ImageProtocol, setTerminalImageProtocol, type TUI } from "@veyyon/tui";
import { postmortem } from "@veyyon/utils";
import { PIXEL_PNG, SUBJECTS, turn } from "./transcript-collection-growth";

export const TURNS = 20;

/** The cell types a component allocates per instance: objects, arrays, closures and their scopes. */
export const CELL_TYPES = ["Object", "Array", "Function", "JSLexicalEnvironment"] as const;
export type CellType = (typeof CELL_TYPES)[number];
export type TurnCells = Record<CellType, number>;

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(index: number, content: AssistantMessage["content"], failure?: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: index + 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason:
			failure !== undefined ? "error" : content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		...(failure !== undefined ? { errorMessage: failure } : {}),
		usage,
	};
}

function prompt(index: number): AgentMessage {
	return { role: "user", content: `Question ${index}: what does module ${index} export?`, timestamp: index + 1 };
}

function readTurn(index: number, narration: string | undefined): AgentMessage[] {
	const id = `call-read-${index}`;
	const call = { type: "toolCall" as const, id, name: "read", arguments: { path: `src/file-${index}.ts` } };
	return [
		assistant(index, narration === undefined ? [call] : [{ type: "text", text: narration }, call]),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: `result ${index} of read\nline two of ${index}` }],
			isError: false,
			timestamp: index + 2,
		},
	];
}

/** A tool card showing an image: a `browser` result carrying a screenshot, which its own card draws. */
export const TOOL_IMAGE = "browser with a screenshot";

function screenshotTurn(index: number): AgentMessage[] {
	return turn("browser", index).map(message =>
		message.role === "toolResult"
			? {
					...message,
					content: [...message.content, { type: "image" as const, data: PIXEL_PNG, mimeType: "image/png" }],
				}
			: message,
	);
}

/** One turn of each shape: distinct text per turn, so no module cache serves one turn's rows to another. */
export const SHAPES: Readonly<Record<string, (index: number) => AgentMessage[]>> = {
	...Object.fromEntries(SUBJECTS.map(subject => [subject, (index: number) => turn(subject, index)])),
	answer: index => [
		prompt(index),
		assistant(index, [{ type: "text", text: `Module ${index} exports one function.` }]),
	],
	"failed turn": index => [
		prompt(index),
		assistant(index, [{ type: "text", text: `Reading module ${index} first.` }], `upstream 502 on turn ${index}`),
	],
	"narrated call": index => readTurn(index, `I will read module ${index} before answering.`),
	[TOOL_IMAGE]: screenshotTurn,
};

function liveCells(): TurnCells {
	Bun.gc(true);
	Bun.gc(true);
	const counts = heapStats().objectTypeCounts;
	const cells = {} as TurnCells;
	for (const type of CELL_TYPES) cells[type] = counts[type] ?? 0;
	return cells;
}

function drawn(builder: ChatTranscriptBuilder, messages: readonly AgentMessage[]): TurnCells {
	builder.rebuild(messages);
	builder.container.render(120);
	return liveCells();
}

function turns(shape: (index: number) => AgentMessage[], count: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < count; index++) messages.push(...shape(index));
	return messages;
}

/** Cells of each type left live per turn of each shape. */
export async function measure(): Promise<Record<string, TurnCells>> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	// A detected protocol is per process; this one exists only to measure, so it claims one outright.
	setTerminalImageProtocol(ImageProtocol.Kitty);
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
	const builder = new ChatTranscriptBuilder({ ui, cwd: process.cwd(), requestRender: () => {} });
	const perTurn: Record<string, TurnCells> = {};
	for (const [name, shape] of Object.entries(SHAPES)) {
		// Both transcripts exist before either is measured, so their messages count in both readings.
		const once = turns(shape, TURNS);
		const twice = turns(shape, 2 * TURNS);
		// A throwaway pass loads every module and fills every per-builder table the shape reaches.
		drawn(builder, once);
		const base = drawn(builder, once);
		const grown = drawn(builder, twice);
		const cells = {} as TurnCells;
		for (const type of CELL_TYPES) cells[type] = (grown[type] - base[type]) / TURNS;
		perTurn[name] = cells;
	}
	builder.reset();
	return perTurn;
}

if (import.meta.main) {
	try {
		process.stdout.write(`${JSON.stringify(await measure())}\n`);
	} finally {
		await postmortem.cleanup();
	}
}
