/**
 * WHY THIS SUITE EXISTS:
 *
 * An eval result held its output twice: once in `content` as the text the model reads, and again in
 * `details.cells[i].output` for the card. In a typical session, eval outputs are by far the largest
 * producer of session bytes. The eval result codec drops `output` from the written line when the
 * content text rebuilds it exactly (as a span of content text), and restores it on load. It also
 * drops top-level `details.statusEvents` when it deep-equals `cells[0].statusEvents`.
 *
 * CLASS: for every eval result shape (exact match, exit-code prefix, multi-cell, status events),
 * the session writes the cell output at most once and loads the details byte-for-byte as the tool
 * returned them, and the card drawn from the written form matches the card drawn from the tool's
 * original result. A result whose content no longer rebuilds the output (a prune notice, folded
 * bookkeeping, replaced content) keeps its output on disk, and so does an output shorter than the
 * span tag threshold. A line written before the codec existed loads unchanged.
 *
 * DOES NOT CATCH: output text modified by transformations outside folding and exit-code notices
 * that is not an exact substring of the content text, which the codec safely leaves unslimmed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { EvalCellResult, EvalStatusEvent, EvalToolDetails } from "@veyyon/coding-agent/eval/types";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { getThemeByName, initTheme, type Theme } from "@veyyon/coding-agent/theme/theme";
import { MIN_CODED_TEXT } from "@veyyon/coding-agent/tools/core/output-notice";
import { evalResultCodec, FROM_CELL0 } from "@veyyon/coding-agent/tools/shell/eval-result-codec";
import { evalToolView } from "@veyyon/coding-agent/tools/shell/eval-view";
// Register all domain codecs through the composition root
import "@veyyon/coding-agent/tools/index";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

function assistantCalling(ids: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall", id, name: "eval", arguments: { code: "print(1)" } })),
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

/** Eval details as a session file line holds them: a span stands in for each dropped output. */
type WrittenEvalDetails = Omit<EvalToolDetails, "cells"> & {
	cells?: (EvalCellResult & { outputSpan?: [number, number] })[];
	statusEventsFrom?: string;
};

function writtenDetails(file: string): Map<string, WrittenEvalDetails> {
	const out = new Map<string, WrittenEvalDetails>();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"toolResult"') || !line.includes('"toolName":"eval"')) continue;
		const entry = JSON.parse(line) as { message: ToolResultMessage<WrittenEvalDetails> };
		if (entry.message.details) out.set(entry.message.toolCallId, entry.message.details);
	}
	return out;
}

function loadedResults(manager: SessionManager): Map<string, ToolResultMessage<EvalToolDetails>> {
	const out = new Map<string, ToolResultMessage<EvalToolDetails>>();
	for (const entry of manager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			out.set(entry.message.toolCallId, entry.message as ToolResultMessage<EvalToolDetails>);
		}
	}
	return out;
}

const LONG_OUTPUT = "Line 1: computed value 42\nLine 2: status is ok\nLine 3: finished without error.";
const SHORT_OUTPUT = "short output";

describe("a session file stores an eval cell output once", () => {
	let theme: Theme;
	let dirOverrides: DirOverridesSnapshot | undefined;
	let root: TempDir;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme missing");
		theme = dark;
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		root = TempDir.createSync("@pi-eval-output-once-");
		setAgentDir(root.join("agent"));
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await root.remove();
	});

	async function record(results: readonly ToolResultMessage<EvalToolDetails>[]): Promise<SessionManager> {
		const returned = results.map(result => JSON.stringify(result.details));
		const manager = SessionManager.create(root.path(), root.join("sessions"));
		manager.appendMessage(assistantCalling(results.map(r => r.toolCallId)));
		for (const result of results) manager.appendMessage(result);
		// Recording settles each result in place: the details the session holds read as the tool returned them.
		expect(results.map(result => JSON.stringify(result.details))).toEqual(returned);
		await manager.flush();
		return manager;
	}

	function draw(result: ToolResultMessage<EvalToolDetails>, details: EvalToolDetails): string {
		const view = evalToolView.renderResult({ content: result.content, details }, { expanded: true, partial: false });
		return Bun.stripANSI(drawToolView(view, theme).render(160).join("\n"));
	}

	it("drops cell output on disk when content matches exactly, and restores it on load", async () => {
		const result: ToolResultMessage<EvalToolDetails> = {
			role: "toolResult",
			toolCallId: "call-exact",
			toolName: "eval",
			content: [{ type: "text", text: LONG_OUTPUT }],
			details: {
				cells: [
					{
						index: 0,
						code: "print('hello')",
						output: LONG_OUTPUT,
						status: "complete",
					},
				],
			},
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written.get("call-exact");
		expect(diskDetails?.cells?.[0]?.output).toBeUndefined();
		expect(diskDetails?.cells?.[0]?.outputSpan).toEqual([0, LONG_OUTPUT.length]);

		const reopened = loadedResults(await SessionManager.open(file));
		const loaded = reopened.get("call-exact");
		expect(loaded?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
		expect(loaded?.details?.cells?.[0]?.output).toBe(LONG_OUTPUT);

		// View drawn from written form matches original
		expect(draw(result, diskDetails!)).toEqual(draw(result, result.details!));
	});

	it("drops cell output when content has an exit-code notice appended", async () => {
		const contentText = `${LONG_OUTPUT}\n\nExit code: 1`;
		const result: ToolResultMessage<EvalToolDetails> = {
			role: "toolResult",
			toolCallId: "call-exit-code",
			toolName: "eval",
			content: [{ type: "text", text: contentText }],
			details: {
				cells: [
					{
						index: 0,
						code: "throw new Error()",
						output: LONG_OUTPUT,
						status: "error",
						exitCode: 1,
					},
				],
				isError: true,
			},
			isError: true,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written.get("call-exit-code");
		expect(diskDetails?.cells?.[0]?.output).toBeUndefined();
		expect(diskDetails?.cells?.[0]?.outputSpan).toEqual([0, LONG_OUTPUT.length]);

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened.get("call-exit-code")?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
		expect(draw(result, diskDetails!)).toEqual(draw(result, result.details!));
	});

	it("drops top-level statusEvents when it deep-equals cells[0].statusEvents", async () => {
		const events: EvalStatusEvent[] = [
			{ op: "log", message: "starting task" },
			{ op: "phase", title: "compiling" },
		];
		const result: ToolResultMessage<EvalToolDetails> = {
			role: "toolResult",
			toolCallId: "call-status-events",
			toolName: "eval",
			content: [{ type: "text", text: LONG_OUTPUT }],
			details: {
				cells: [
					{
						index: 0,
						code: "log('starting task')",
						output: LONG_OUTPUT,
						status: "complete",
						statusEvents: events.map(e => ({ ...e })),
					},
				],
				statusEvents: events.map(e => ({ ...e })),
			},
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written.get("call-status-events");
		expect(diskDetails?.statusEvents).toBeUndefined();
		expect(diskDetails?.statusEventsFrom).toBe(FROM_CELL0);

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened.get("call-status-events")?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
		expect(reopened.get("call-status-events")?.details?.statusEvents).toEqual(events);
	});

	it("keeps statusEvents whole when it differs from cells[0].statusEvents", async () => {
		const topEvents: EvalStatusEvent[] = [{ op: "log", message: "top level" }];
		const cellEvents: EvalStatusEvent[] = [{ op: "log", message: "cell level" }];
		const result: ToolResultMessage<EvalToolDetails> = {
			role: "toolResult",
			toolCallId: "call-diff-status",
			toolName: "eval",
			content: [{ type: "text", text: LONG_OUTPUT }],
			details: {
				cells: [
					{
						index: 0,
						code: "log('cell level')",
						output: LONG_OUTPUT,
						status: "complete",
						statusEvents: cellEvents,
					},
				],
				statusEvents: topEvents,
			},
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written.get("call-diff-status");
		expect(diskDetails?.statusEvents).toEqual(topEvents);
		expect(diskDetails?.statusEventsFrom).toBeUndefined();
	});

	it("keeps output whole when content text does not rebuild it (pruned or modified)", async () => {
		const result: ToolResultMessage<EvalToolDetails> = {
			role: "toolResult",
			toolCallId: "call-pruned",
			toolName: "eval",
			content: [{ type: "text", text: "[Output pruned ~500 tokens; recover: artifact://123]" }],
			details: {
				cells: [
					{
						index: 0,
						code: "print(large_data)",
						output: LONG_OUTPUT,
						status: "complete",
					},
				],
			},
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written.get("call-pruned");
		expect(diskDetails?.cells?.[0]?.output).toBe(LONG_OUTPUT);
		expect(diskDetails?.cells?.[0]?.outputSpan).toBeUndefined();

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened.get("call-pruned")?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
	});

	it("keeps output whole when shorter than MIN_DROPPED_TEXT", async () => {
		expect(SHORT_OUTPUT.length).toBeLessThan(MIN_CODED_TEXT);
		const result: ToolResultMessage<EvalToolDetails> = {
			role: "toolResult",
			toolCallId: "call-short",
			toolName: "eval",
			content: [{ type: "text", text: SHORT_OUTPUT }],
			details: {
				cells: [
					{
						index: 0,
						code: "print('short')",
						output: SHORT_OUTPUT,
						status: "complete",
					},
				],
			},
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written.get("call-short");
		expect(diskDetails?.cells?.[0]?.output).toBe(SHORT_OUTPUT);
		expect(diskDetails?.cells?.[0]?.outputSpan).toBeUndefined();

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened.get("call-short")?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
	});

	it("handles multi-cell outputs across spans in content text", async () => {
		const out1 = "Cell 1 output: first batch of processed rows.";
		const out2 = "Cell 2 output: second batch of processed rows.";
		const combined = `${out1}\n\n${out2}`;

		const result: ToolResultMessage<EvalToolDetails> = {
			role: "toolResult",
			toolCallId: "call-multi-cell",
			toolName: "eval",
			content: [{ type: "text", text: combined }],
			details: {
				cells: [
					{ index: 0, code: "step1()", output: out1, status: "complete" },
					{ index: 1, code: "step2()", output: out2, status: "complete" },
				],
			},
			isError: false,
			timestamp: 2,
		};

		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const diskDetails = written.get("call-multi-cell");
		expect(diskDetails?.cells?.[0]?.output).toBeUndefined();
		expect(diskDetails?.cells?.[1]?.output).toBeUndefined();
		expect(diskDetails?.cells?.[0]?.outputSpan).toEqual([0, out1.length]);
		expect(diskDetails?.cells?.[1]?.outputSpan).toEqual([
			combined.indexOf(out2),
			combined.indexOf(out2) + out2.length,
		]);

		const reopened = loadedResults(await SessionManager.open(file));
		expect(reopened.get("call-multi-cell")?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
	});

	it("leaves the in-memory details whole and never mutates input during slim", async () => {
		const originalDetails: EvalToolDetails = {
			cells: [
				{
					index: 0,
					code: "print('immutability')",
					output: LONG_OUTPUT,
					status: "complete",
				},
			],
		};
		const detailsClone = JSON.parse(JSON.stringify(originalDetails));

		const result: ToolResultMessage<EvalToolDetails> = {
			role: "toolResult",
			toolCallId: "call-mem",
			toolName: "eval",
			content: [{ type: "text", text: LONG_OUTPUT }],
			details: originalDetails,
			isError: false,
			timestamp: 2,
		};

		await record([result]);
		// original object was not mutated
		expect(originalDetails).toEqual(detailsClone);
		expect(originalDetails.cells?.[0]?.output).toBe(LONG_OUTPUT);
	});

	it("slim returns the exact same reference when nothing drops", () => {
		const details: EvalToolDetails = {
			cells: [{ index: 0, code: "x = 1", output: SHORT_OUTPUT, status: "complete" }],
		};
		const slimmed = evalResultCodec.slim(details, [{ type: "text", text: SHORT_OUTPUT }]);
		expect(slimmed).toBe(details);
	});

	it("restore of details written whole is a no-op", () => {
		const wholeDetails: EvalToolDetails = {
			cells: [{ index: 0, code: "x = 1", output: LONG_OUTPUT, status: "complete" }],
		};
		const clone = JSON.parse(JSON.stringify(wholeDetails));
		evalResultCodec.restore(wholeDetails, [{ type: "text", text: LONG_OUTPUT }]);
		expect(wholeDetails).toEqual(clone);
	});
});
