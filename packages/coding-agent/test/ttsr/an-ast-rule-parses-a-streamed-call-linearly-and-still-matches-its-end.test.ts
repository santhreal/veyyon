/**
 * An ast-grep rule parses a streamed edit or write a bounded number of times, one parse at a time,
 * and still matches what the completed call contains.
 *
 * THE DEFECT. Every `toolcall_delta` of an edit or write ran `astMatch` on the call's whole
 * reconstructed source. Parsing is linear in the source and the source grows one delta at a time,
 * so a streamed file was parsed once per delta: a 1 500-line write parsed 233 MB across 3 814
 * native calls. The session dispatches stream events without awaiting them, so those parses ran
 * at once, and the native pool spent two minutes of CPU on one write while the model streamed it.
 *
 * THE CLASS. Any streamed tool call whose source is AST-matched: the write tool and the edit tool
 * in every mode it streams in. The modes are read from `EDIT_MODES` at run time and pinned by
 * exact equality against the payload table below, so a new edit mode turns this suite red until
 * someone states how its payload streams. Each variant is held to four contracts:
 *
 *   - each parse of a partial call follows growth of a quarter of the last one parsed and of at
 *     least `AST_PARTIAL_MIN_GROWTH` characters, so the characters parsed over the stream stay
 *     within six times its final source;
 *   - no two parses of one call are in flight at once;
 *   - a violation that only the completed call contains is delivered by `afterToolCall`, even when
 *     the tool returns the moment the call completes;
 *   - a violation at the start of a long stream interrupts it before the call completes.
 *
 * Two contracts of the scheduler do not depend on the tool and are asserted once, on the write
 * tool: a pass still parsing when the next turn starts delivers nothing, and a delta handled
 * after its call's `toolcall_end` does not displace the completed call's match.
 *
 * WHAT IT DOES NOT CATCH. A new tool outside the edit and write tools that exposes
 * `matcherDigest` or `matcherEntries` joins the scheduler without joining this table. The bound
 * is on characters handed to the native matcher, not on the matcher's own cost per character.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AnyAgentTool } from "@veyyon/agent-core";
import type { Rule } from "@veyyon/coding-agent/discovery/capability/rule";
import { EditTool } from "@veyyon/coding-agent/edit";
import { AST_PARTIAL_MIN_GROWTH } from "@veyyon/coding-agent/export/ttsr";
import { WriteTool } from "@veyyon/coding-agent/tools/fs/write";
import { EDIT_MODES, type EditMode } from "@veyyon/coding-agent/utils/edit-mode";
import * as natives from "@veyyon/natives";
import { makeToolSession } from "../helpers/tool-session";
import { type TtsrHarness, ttsrHarness } from "../helpers/ttsr-runtime";

const PATH = "src/streamed.ts";
const CHUNK = 64;
const VIOLATION = 'console.log("streamed");';

/** How one tool streams the source it introduces. */
interface StreamedCall {
	readonly toolName: string;
	tool(): AnyAgentTool;
	/** The streamed string argument wrapped around `source`. */
	text(source: string): string;
	/** The call's arguments with the streamed argument cut at `text`. */
	args(text: string): Record<string, unknown>;
}

const plusLines = (source: string): string =>
	source
		.split("\n")
		.map(line => `+${line}`)
		.join("\n");

function editTool(mode: EditMode): AnyAgentTool {
	const tool = new EditTool(
		makeToolSession({
			settings: { get: key => (key === "edit.mode" ? mode : undefined), getEditVariantForModel: () => mode },
		}),
	);
	expect(tool.mode).toBe(mode);
	return tool;
}

/** One payload per edit mode, keyed by the mode and pinned below against `EDIT_MODES`. */
const EDIT_PAYLOADS: Record<EditMode, Pick<StreamedCall, "text" | "args">> = {
	replace: {
		text: source => source,
		args: text => ({ path: PATH, edits: [{ old_text: "anchor", new_text: text }] }),
	},
	patch: {
		text: source => `@@\n${plusLines(source)}`,
		args: text => ({ path: PATH, edits: [{ op: "update", diff: text }] }),
	},
	hashline: {
		text: source => `[${PATH}#ABCD]\nINS.HEAD:\n${plusLines(source)}`,
		args: text => ({ input: text }),
	},
	apply_patch: {
		text: source => `*** Begin Patch\n*** Add File: ${PATH}\n${plusLines(source)}\n*** End Patch`,
		args: text => ({ input: text }),
	},
};

const CALLS: Record<string, StreamedCall> = {
	write: {
		toolName: "write",
		tool: () => new WriteTool(makeToolSession({ settings: { get: () => undefined }, enableLsp: false })),
		text: source => source,
		args: text => ({ path: PATH, content: text }),
	},
	...Object.fromEntries(
		EDIT_MODES.map(mode => [
			`edit:${mode}`,
			{ toolName: "edit", tool: () => editTool(mode), ...EDIT_PAYLOADS[mode] } satisfies StreamedCall,
		]),
	),
};

function astRule(interruptMode: "never" | "tool-only"): Rule {
	return {
		name: "no-console-in-streamed-source",
		path: "/rules/no-console.md",
		content: "Do not log to the console.",
		astCondition: ["console.log($$$ARGS)"],
		scope: ["tool:write(*.ts)", "tool:edit(*.ts)"],
		interruptMode,
		_source: { provider: "test", providerName: "test", path: "/rules/no-console.md", level: "project" },
	};
}

/** A source of about 30 KB with no violation in it. */
function cleanSource(): string {
	return Array.from({ length: 1000 }, (_, i) => `const value${i} = compute(${i});`).join("\n");
}

/** What `astMatch` was handed: characters per parse and the most parses in flight at once. */
interface ParseLog {
	readonly sources: number[];
	maxInFlight: number;
}

function recordParses(): ParseLog {
	const original = natives.astMatch;
	const log: ParseLog = { sources: [], maxInFlight: 0 };
	let inFlight = 0;
	vi.spyOn(natives, "astMatch").mockImplementation(async options => {
		log.sources.push(options.source.length);
		inFlight++;
		log.maxInFlight = Math.max(log.maxInFlight, inFlight);
		try {
			return await original(options);
		} finally {
			inFlight--;
		}
	});
	return log;
}

/** Total length of the snapshots the tool reconstructs from `args`. */
function digestLength(tool: AnyAgentTool, args: Record<string, unknown>): number {
	const entries = tool.matcherEntries?.(args);
	if (entries && entries.length > 0) return entries.reduce((sum, entry) => sum + entry.digest.length, 0);
	return tool.matcherDigest?.(args)?.length ?? 0;
}

/** Stream `text` from `from` to `to` in deltas, without awaiting any, as the session dispatches them. */
function streamDeltas(
	harness: TtsrHarness,
	call: StreamedCall,
	text: string,
	from: number,
	to: number,
	toolCallId: string,
): Promise<boolean>[] {
	const pending: Promise<boolean>[] = [];
	for (let end = Math.min(from + CHUNK, to); from < to; end = Math.min(end + CHUNK, to)) {
		pending.push(harness.toolDelta(text.slice(from, end), toolCallId, call.toolName, call.args(text.slice(0, end))));
		from = end;
	}
	return pending;
}

/** Stream `text` in deltas, each settling before the next arrives, as a model streaming slower than a parse does. */
async function streamSettled(
	harness: TtsrHarness,
	call: StreamedCall,
	text: string,
	toolCallId: string,
): Promise<void> {
	for (let from = 0; from < text.length; from += CHUNK) {
		const end = Math.min(from + CHUNK, text.length);
		await harness.toolDelta(text.slice(from, end), toolCallId, call.toolName, call.args(text.slice(0, end)));
	}
	await harness.toolEnd(toolCallId, call.toolName, call.args(text));
}

function afterToolCall(harness: TtsrHarness, call: StreamedCall, toolCallId: string): Promise<undefined> | undefined {
	return harness.runtime.afterToolCall({
		toolCall: { id: toolCallId, name: call.toolName, type: "toolCall", arguments: {} },
		isError: false,
	} as never);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("an ast-grep rule on a streamed call", () => {
	it("covers the write tool and every edit mode", () => {
		expect(Object.keys(EDIT_PAYLOADS).sort()).toEqual([...EDIT_MODES].sort());
		expect(Object.keys(CALLS).sort()).toEqual(["write", ...EDIT_MODES.map(mode => `edit:${mode}`)].sort());
	});

	describe.each(Object.entries(CALLS))("%s", (_name, call) => {
		it("parses a partial call only after it has grown", async () => {
			const tool = call.tool();
			const harness = ttsrHarness([astRule("never")], { tools: [tool] });
			const log = recordParses();
			const text = call.text(cleanSource());

			await streamSettled(harness, call, text, "call-bound");

			const finalLength = digestLength(tool, call.args(text));
			expect(log.sources.at(-1)).toBe(finalLength);
			let last = 0;
			for (const length of log.sources.slice(0, -1)) {
				expect(length - last).toBeGreaterThanOrEqual(Math.max(AST_PARTIAL_MIN_GROWTH, last / 4));
				last = length;
			}
			expect(log.sources.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(6 * finalLength);
		});

		it("parses one snapshot at a time while its deltas arrive unawaited", async () => {
			const tool = call.tool();
			const harness = ttsrHarness([astRule("never")], { tools: [tool] });
			const log = recordParses();
			const text = call.text(cleanSource());

			const pending = streamDeltas(harness, call, text, 0, text.length, "call-flood");
			pending.push(harness.toolEnd("call-flood", call.toolName, call.args(text)));
			await afterToolCall(harness, call, "call-flood");
			await Promise.all(pending);

			expect(log.sources.at(-1)).toBe(digestLength(tool, call.args(text)));
			expect(log.maxInFlight).toBe(1);
		});

		it("delivers a violation only the completed call contains through afterToolCall", async () => {
			const tool = call.tool();
			const harness = ttsrHarness([astRule("never")], { tools: [tool] });
			const text = call.text(`${cleanSource()}\n${VIOLATION}`);
			const cut = text.lastIndexOf(VIOLATION);

			// Everything before the violation streams and settles, so the last partial match has
			// already run when the violation arrives in a delta too short to be due for another.
			await Promise.all(streamDeltas(harness, call, text, 0, cut, "call-final"));
			expect(text.length - cut).toBeLessThan(AST_PARTIAL_MIN_GROWTH);
			const pending = streamDeltas(harness, call, text, cut, text.length, "call-final");
			pending.push(harness.toolEnd("call-final", call.toolName, call.args(text)));
			await afterToolCall(harness, call, "call-final");

			expect(harness.runtime.takePendingToolReminders()).toMatchObject({
				details: { rules: ["no-console-in-streamed-source"] },
			});
			await Promise.all(pending);
		});

		it("interrupts on a violation at the start before the call completes", async () => {
			const tool = call.tool();
			const harness = ttsrHarness([astRule("tool-only")], { tools: [tool] });
			const text = call.text(`${VIOLATION}\n${cleanSource()}`);
			let end = 0;
			while (digestLength(tool, call.args(text.slice(0, end))) < 2 * AST_PARTIAL_MIN_GROWTH) end += CHUNK;

			await Promise.all(streamDeltas(harness, call, text, 0, end, "call-early"));

			expect(end).toBeLessThan(text.length);
			expect(harness.recorded.aborts).toHaveLength(1);
		});
	});

	it("drops what a pass finds once the next turn has started", async () => {
		const call = CALLS.write;
		const harness = ttsrHarness([astRule("tool-only")], { tools: [call.tool()] });
		const text = call.text(`${cleanSource()}\n${VIOLATION}`);

		const pending = streamDeltas(harness, call, text, 0, text.length, "call-stale");
		pending.push(harness.toolEnd("call-stale", call.toolName, call.args(text)));
		harness.runtime.onTurnStart();
		await Promise.all(pending);

		expect(harness.recorded.aborts).toEqual([]);
	});

	it("matches the completed call when a delta is handled after its toolcall_end", async () => {
		const call = CALLS.write;
		const harness = ttsrHarness([astRule("never")], { tools: [call.tool()] });
		const text = call.text(`${cleanSource()}\n${VIOLATION}`);
		const cut = text.lastIndexOf(VIOLATION);

		await Promise.all(streamDeltas(harness, call, text, 0, cut, "call-late"));
		const pending = streamDeltas(harness, call, text, cut, text.length, "call-late");
		pending.push(harness.toolEnd("call-late", call.toolName, call.args(text)));
		pending.push(harness.toolDelta("", "call-late", call.toolName, call.args(text.slice(0, cut))));
		await afterToolCall(harness, call, "call-late");

		expect(harness.runtime.takePendingToolReminders()).toMatchObject({
			details: { rules: ["no-console-in-streamed-source"] },
		});
		await Promise.all(pending);
	});
});
