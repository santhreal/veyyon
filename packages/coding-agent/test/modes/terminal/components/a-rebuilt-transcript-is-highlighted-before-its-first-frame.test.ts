/**
 * A rebuilt transcript highlights every source its tool cards draw in one native batch, spread across
 * threads, before the first frame, and that frame draws exactly what it drew without the batch.
 *
 * WHAT THIS CLOSES. The first frame of a rebuilt transcript draws every card, and each card
 * highlighted its sources one after another on the render thread: a 24,169-source transcript spent
 * 7.1 s of a 14.7 s first frame there. The rebuild now collects each card's sources before the frame
 * (`ToolExecutionComponent.highlightRequests`) and hands them to `prefetchHighlights`.
 *
 * THE CLASS. The collection choosing differently from the draw: a phase it skips (a result view, the
 * per-file views of an edit across several files), a section kind it misses (code, or the context
 * runs of a change), or a source or language it spells differently from the draw (a source it does
 * not sanitize, a language with no grammar it keys by name), so the draw misses the batch and
 * highlights again, or the batch highlights what no frame draws. The sweep drives one transcript
 * holding each of those, and fails when any source the frame highlights is not served from the
 * batch, or the batch holds a source the frame never highlights. The frame drawn with the batch is
 * compared byte for byte with the frame drawn without it.
 *
 * WHAT IT DOES NOT CATCH. Sources a tool's own `renderCall`/`renderResult` highlights, Markdown
 * code fences, and the read group: none of them is collected, and each still highlights at the draw.
 * A collection that also takes the call view of a card whose result replaces it stays green: the
 * presentation builds no call view for such a card, so there is nothing extra to collect.
 */
import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import * as highlightModule from "@veyyon/coding-agent/theme/highlight";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import * as natives from "@veyyon/natives";
import type { TUI } from "@veyyon/tui";

const WIDTH = 120;
const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;

/** An SGR the highlighter never writes, prefixed to every row the batch returns. */
const FROM_BATCH = "\x1b[53m";

const usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let entryCounter = 0;
function entry(message: AgentMessage): SessionMessageEntry {
	entryCounter += 1;
	return {
		type: "message",
		id: `entry-${entryCounter}`,
		parentId: null,
		timestamp: "2026-09-26T00:00:00.000Z",
		message,
	};
}

/** One settled tool call and its result, as a session records them. */
function toolTurn(
	id: string,
	name: string,
	args: Record<string, unknown>,
	result: { text: string; details?: unknown },
): SessionMessageEntry[] {
	return [
		entry({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			content: [{ type: "toolCall", id, name, arguments: args }],
			stopReason: "toolUse",
			timestamp: 2,
		}),
		entry({
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: result.text }],
			details: result.details,
			isError: false,
			timestamp: 3,
		}),
	];
}

/**
 * A transcript whose cards draw each kind of highlighted source: a result's code (`write`, whose
 * merged call would draw the whole file where the result draws a preview of it), code in a language
 * the highlighter has no grammar for, a result's change (`edit`), the per-file changes of an edit
 * across two files, and a command (`bash`). Every identifier carries `word`, so two transcripts
 * built with different words share no source and neither can be served from what the other
 * highlighted.
 */
function transcript(word: string): SessionMessageEntry[] {
	const change = (file: number) =>
		[
			` 10|const ${word}${file}a = 1;`,
			` 11|function ${word}${file}() { return "${word}"; }`,
			`-12|const ${word}${file}b = 2;`,
			`+12|const ${word}${file}b = 3;`,
			` 13|const ${word}${file}c = [${word}${file}a, ${word}${file}b];`,
		].join("\n");
	const file = Array.from({ length: 60 }, (_, index) => `export const ${word}${index + 1} = ${index + 1};`);
	return [
		entry({ role: "user", content: `rebuild the ${word} module`, timestamp: 1 }),
		...toolTurn(
			`${word}-write`,
			"write",
			{ path: `src/${word}.ts`, content: `${file.join("\n")}\n` },
			{ text: `wrote src/${word}.ts` },
		),
		...toolTurn(
			`${word}-write-zig`,
			"write",
			{ path: `src/${word}.zig`, content: `const ${word} = @import("std");\npub fn main() void {}\n` },
			{ text: `wrote src/${word}.zig` },
		),
		...toolTurn(
			`${word}-edit`,
			"edit",
			{ path: `src/${word}1.ts`, edits: [{ path: `src/${word}1.ts` }] },
			{ text: "Edited 1 file", details: { diff: change(1) } },
		),
		...toolTurn(
			`${word}-edit-many`,
			"edit",
			{ edits: [{ path: `src/${word}2.ts` }, { path: `src/${word}3.ts` }] },
			{
				text: "Edited 2 files",
				details: {
					diff: "",
					perFileResults: [
						{ path: `src/${word}2.ts`, diff: change(2) },
						{ path: `src/${word}3.ts`, diff: change(3) },
					],
				},
			},
		),
		...toolTurn(
			`${word}-bash`,
			"bash",
			{ command: `grep -rn "${word}" src | while read -r line; do echo "$line"; done` },
			{ text: `src/${word}.ts:1:export const ${word} = 1;` },
		),
	];
}

function highlightKey(code: string, lang: string | undefined): string {
	return `${lang && natives.supportsLanguage(lang) ? lang : ""}\x00${code}`;
}

/** Rebuild `entries` and draw the first frame, the way a resumed session does. */
function firstFrame(entries: readonly SessionMessageEntry[]): string {
	const builder = new ChatTranscriptBuilder({ ui, cwd: process.cwd(), requestRender: () => {} });
	try {
		builder.rebuild(entries);
		return builder.container.render(WIDTH).join("\n");
	} finally {
		builder.reset();
	}
}

describe("a rebuilt transcript is highlighted before its first frame", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("serves every source the first frame highlights from one batch, and batches nothing it does not draw", () => {
		const batched: string[] = [];
		let batches = 0;
		const batch = natives.highlightCodeBatch;
		spyOn(natives, "highlightCodeBatch").mockImplementation((sources, colors) => {
			batches++;
			for (const source of sources) batched.push(highlightKey(source.code, source.lang ?? undefined));
			return batch(sources, colors).map(rows =>
				rows
					.split("\n")
					.map(row => `${FROM_BATCH}${row}`)
					.join("\n"),
			);
		});
		const drawn: { key: string; lang: string | undefined; rows: string[] }[] = [];
		const highlight = highlightModule.highlightCode;
		spyOn(highlightModule, "highlightCode").mockImplementation((code, lang, highlightTheme) => {
			const rows = highlight(code, lang, highlightTheme);
			drawn.push({ key: highlightKey(code, lang), lang, rows });
			return rows;
		});

		firstFrame(transcript("alpha"));

		expect(batches).toBe(1);
		// Every kind of source is in the frame: a result's code in a language with a grammar and in one
		// without, the command, and the context runs of both the one-file change and the per-file
		// changes, which are highlighted as TypeScript.
		const languages = new Set(drawn.map(call => call.lang));
		expect(languages.has("bash")).toBe(true);
		expect(languages.has("zig")).toBe(true);
		expect(natives.supportsLanguage("zig")).toBe(false);
		const typescript = drawn.filter(call => call.lang === "typescript" || call.lang === "ts");
		for (const file of [1, 2, 3]) {
			expect(typescript.some(call => call.key.includes(`alpha${file}a = 1;`))).toBe(true);
		}
		expect(typescript.some(call => call.key.includes("export const alpha1 = 1;"))).toBe(true);
		for (const call of drawn) {
			expect({ key: call.key, rows: call.rows.filter(row => !row.startsWith(FROM_BATCH)) }).toEqual({
				key: call.key,
				rows: [],
			});
		}
		expect([...new Set(batched)].sort()).toEqual([...new Set(drawn.map(call => call.key))].sort());
	});

	it("draws the frame it draws when every source is highlighted at the draw", () => {
		// Words neither this file nor another test drew, so no row is served from an earlier cache.
		const ahead = firstFrame(transcript("gamma"));
		spyOn(highlightModule, "prefetchHighlights").mockImplementation(() => {});
		const atDraw = firstFrame(transcript("delta"));
		expect(atDraw).not.toBe(ahead);
		expect(atDraw.replaceAll("delta", "gamma")).toBe(ahead);
	});
});
