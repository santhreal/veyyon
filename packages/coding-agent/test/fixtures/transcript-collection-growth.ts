/**
 * The keyed collections (Map, Set, WeakMap, WeakSet) a rebuilt and drawn transcript leaves live per
 * turn, measured in the process that runs this file. The test imports the turn builders. Run as a
 * script, it rebuilds and draws a transcript of `TURNS` and then `2 * TURNS` turns of each subject and
 * prints, as JSON, the growth in live collections between the two divided by `TURNS`.
 *
 * Subjects: `conversation` is a user prompt and an assistant turn with thinking and text; `IMAGE_READ`
 * is a read whose result carries a PNG, which the calling assistant turn keeps in its image table;
 * every other subject is a tool name, and its turn is an assistant turn calling that tool once and the
 * call's text result.
 */

import { heapStats } from "bun:jsc";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "@veyyon/coding-agent/tools/core/builtin-names";
import type { TUI } from "@veyyon/tui";
import { postmortem } from "@veyyon/utils";

export const TURNS = 20;
export const CONVERSATION = "conversation";
export const IMAGE_READ = "read with an image";
/** Every subject the fixture measures: the conversation, a read showing an image, and each shipped tool. */
export const SUBJECTS: readonly string[] = [CONVERSATION, IMAGE_READ, ...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES];
const COLLECTIONS = ["Map", "Set", "WeakMap", "WeakSet"] as const;
/** A 1x1 PNG: a format every image protocol draws as it stands, so no conversion starts. */
export const PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(turn: number, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: turn + 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		usage,
	};
}

/** One turn of `subject`: distinct text per turn, so no module cache serves one turn's rows to another. */
export function turn(subject: string, index: number): AgentMessage[] {
	if (subject === CONVERSATION) {
		return [
			{ role: "user", content: `Question ${index}: what does module ${index} export?`, timestamp: index + 1 },
			assistant(index, [
				{ type: "thinking", thinking: `Module ${index} is small; read its exports before answering.` },
				{ type: "text", text: `Module ${index} exports \`load${index}\` and \`save${index}\`.\n\n- one\n- two` },
			]),
		];
	}
	const tool = subject === IMAGE_READ ? "read" : subject;
	const id = `call-${tool}-${index}`;
	const text = { type: "text" as const, text: `result ${index} of ${tool}\nline two of ${index}` };
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: id,
		toolName: tool,
		content: subject === IMAGE_READ ? [text, { type: "image", data: PIXEL_PNG, mimeType: "image/png" }] : [text],
		isError: false,
		timestamp: index + 2,
	};
	return [
		assistant(index, [{ type: "toolCall", id, name: tool, arguments: { path: `src/file-${index}.ts` } }]),
		result,
	];
}

function liveCollections(): number {
	Bun.gc(true);
	Bun.gc(true);
	const counts = heapStats().objectTypeCounts;
	let total = 0;
	for (const kind of COLLECTIONS) total += counts[kind] ?? 0;
	return total;
}

function drawn(builder: ChatTranscriptBuilder, subject: string, turns: number): number {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < turns; index++) messages.push(...turn(subject, index));
	builder.rebuild(messages);
	builder.container.render(120);
	return liveCollections();
}

/** Collections left live per turn of each subject. */
export async function measure(): Promise<Record<string, number>> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
	const builder = new ChatTranscriptBuilder({ ui, cwd: process.cwd(), requestRender: () => {} });
	const perTurn: Record<string, number> = {};
	for (const subject of SUBJECTS) {
		// A throwaway pass loads every module and fills every per-builder table the subject reaches.
		drawn(builder, subject, TURNS);
		const once = drawn(builder, subject, TURNS);
		const twice = drawn(builder, subject, 2 * TURNS);
		perTurn[subject] = (twice - once) / TURNS;
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
