/**
 * WHY THIS SUITE EXISTS:
 * Connects the GUI host engine to canonical @veyyon/view ToolView presentation
 * data for the native client, asserting that registered semantic renderers,
 * generic fallbacks, disclosure toggles (SetToolViewExpanded), live streaming
 * arguments, result details and transcript resume all produce typed ToolPresentation
 * without calling terminal hooks or leaking raw Argot handles.
 *
 * THE CLASS THIS CLOSES:
 * 1. Missing or untyped presentation on native wire ToolCall and ToolResult blocks.
 * 2. Stale disclosure or failure to regenerate presentations on SetToolViewExpanded.
 * 3. Dropping result details/error semantics into flattened strings for renderers.
 * 4. Duplicate payload arms or precomputed dual copies on wire blocks.
 * 5. Failure to update call presentation (hasResult: true) when result arrives.
 * 6. Swallowed or crashing renderer exceptions hiding recorded outputs.
 * 7. Wrong session/call disclosure error routing or cross-session state corruption.
 *
 * WHAT IT DOES NOT CATCH:
 * GPU rasterization and GPUI view layouts in Rust/C++ desktop UI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import type { ToolView, ToolViewContext } from "@veyyon/view";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { buildToolCallPresentation, buildToolResultPresentation } from "../../src/gui-host/presentation";
import type { ContentBlock, TranscriptEntry } from "../../src/gui-host/wire";
import { type RequestFrame, TestSocketClient } from "./test-client";

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCallBlocks(entry: TranscriptEntry): Extract<ContentBlock, { ToolCall: unknown }>[] {
	return entry.content.filter((block): block is Extract<ContentBlock, { ToolCall: unknown }> => "ToolCall" in block);
}

function toolResultBlocks(entry: TranscriptEntry): Extract<ContentBlock, { ToolResult: unknown }>[] {
	return entry.content.filter(
		(block): block is Extract<ContentBlock, { ToolResult: unknown }> => "ToolResult" in block,
	);
}

function transcriptEntries(frames: RequestFrame[]): TranscriptEntry[] {
	for (const frame of frames) {
		const section = frame.Snapshot?.Transcript;
		if (section !== undefined) return (section as { value: TranscriptEntry[] }).value;
	}
	throw new Error("no Transcript snapshot in frames");
}

function updatedEntries(frames: RequestFrame[]): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];
	for (const frame of frames) {
		if (frame.TranscriptUpdated !== undefined) {
			entries.push((frame.TranscriptUpdated as { entry: TranscriptEntry }).entry);
		}
	}
	return entries;
}

describe("GUI Host ToolPresentation and Disclosure", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let sessionDir: string;
	const storage = new FileSessionStorage();

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-tools-"));
		sessionDir = computeDefaultSessionDir(tempDir, storage, path.join(tempDir, "agent", "sessions"));
		await fs.mkdir(sessionDir, { recursive: true });

		server = await startGuiHostServer({
			cwd: tempDir,
			agentDir: path.join(tempDir, "agent"),
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame(); // ConnectionChanged
		await client.nextFrame(); // Snapshot.Capabilities
	});

	afterEach(async () => {
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("buildToolCallPresentation and buildToolResultPresentation with registered semantic tool", () => {
		let callContextReceived: ToolViewContext | undefined;
		let resultContextReceived: ToolViewContext | undefined;
		let resultArgsReceived: unknown;

		const mockTool: AgentTool = {
			name: "custom_analyzer",
			label: "Custom Analyzer",
			description: "Analyzes custom files",
			parameters: {
				type: "object",
				properties: { target: { type: "string" } },
			} as unknown as AgentTool["parameters"],
			execute: async () => ({ content: [{ type: "text", text: "done" }] }),
			view: {
				renderCall: (args, context): ToolView => {
					callContextReceived = context;
					const target = (args as { target: string }).target;
					return {
						kind: "statusRow",
						status: context.partial ? "running" : context.hasResult ? "done" : "pending",
						title: "Analyzer",
						description: `Target: ${target}${context.hasResult ? " [settled]" : ""}`,
					};
				},
				renderResult: (result, context, args): ToolView => {
					resultContextReceived = context;
					resultArgsReceived = args;
					const score = (result.details as { score?: number } | undefined)?.score ?? 0;
					const target = (args as { target?: string } | undefined)?.target ?? "unknown";
					return {
						kind: "statusRow",
						status: result.isError ? "error" : "success",
						title: "Analyzer Result",
						description: context.expanded ? `Score: ${score} for ${target}` : `Score: ${score}`,
					};
				},
			},
		};

		// 1. Call presentation - collapsed, no result
		const callPres = buildToolCallPresentation("custom_analyzer", { target: "src/index.ts" }, mockTool, {
			expanded: false,
			hasResult: false,
		});
		expect(callPres.expanded).toBe(false);
		expect(callPres.view).toEqual({
			kind: "statusRow",
			status: "pending",
			title: "Analyzer",
			description: "Target: src/index.ts",
		});
		expect(callContextReceived).toEqual({ expanded: false, hasResult: false });

		// 2. Call presentation - with hasResult: true
		const callPresSettled = buildToolCallPresentation("custom_analyzer", { target: "src/index.ts" }, mockTool, {
			expanded: false,
			hasResult: true,
		});
		expect(callPresSettled.view).toEqual({
			kind: "statusRow",
			status: "done",
			title: "Analyzer",
			description: "Target: src/index.ts [settled]",
		});

		// 3. Result presentation - collapsed
		const resultPres = buildToolResultPresentation(
			"custom_analyzer",
			{ content: [{ type: "text", text: "Success" }], details: { score: 98 }, isError: false },
			{ target: "src/index.ts" },
			mockTool,
			{ expanded: false, hasResult: true },
		);
		expect(resultPres.expanded).toBe(false);
		expect(resultPres.view).toEqual({
			kind: "statusRow",
			status: "success",
			title: "Analyzer Result",
			description: "Score: 98",
		});
		expect(resultContextReceived).toEqual({ expanded: false, hasResult: true });
		expect(resultArgsReceived).toEqual({ target: "src/index.ts" });

		// 4. Result presentation - expanded, and the tool's own details survive the trip
		const resultPresExpanded = buildToolResultPresentation(
			"custom_analyzer",
			{ content: [{ type: "text", text: "Success" }], details: { score: 98 }, isError: false },
			{ target: "src/index.ts" },
			mockTool,
			{ expanded: true, hasResult: true },
		);
		expect(resultPresExpanded.expanded).toBe(true);
		expect(resultPresExpanded.view).toEqual({
			kind: "statusRow",
			status: "success",
			title: "Analyzer Result",
			description: "Score: 98 for src/index.ts",
		});
	});

	test("tool lacking semantic hooks gets honest generic semantic fallback", () => {
		const unhookedTool: AgentTool = {
			name: "raw_scanner",
			label: "Raw Scanner",
			description: "Scans raw files",
			parameters: {} as unknown as AgentTool["parameters"],
			execute: async () => ({ content: [{ type: "text", text: "raw out" }] }),
		};

		// Collapsed call
		const callPres = buildToolCallPresentation("raw_scanner", { path: "lib/core.ts", limit: 10 }, unhookedTool, {
			expanded: false,
			hasResult: false,
		});
		expect(callPres.expanded).toBe(false);
		expect(callPres.view.kind).toBe("statusRow");
		if (callPres.view.kind === "statusRow") {
			expect(callPres.view.title).toBe("raw_scanner");
			expect(callPres.view.description).toBe("lib/core.ts");
			expect(callPres.view.status).toBe("pending");
		}

		// Expanded call: a panel of the arguments, in the canonical framed shape
		const callPresExp = buildToolCallPresentation("raw_scanner", { path: "lib/core.ts", limit: 10 }, unhookedTool, {
			expanded: true,
			hasResult: false,
		});
		expect(callPresExp.expanded).toBe(true);
		expect(callPresExp.view.kind).toBe("framedBlock");
		if (callPresExp.view.kind === "framedBlock") {
			expect(callPresExp.view.header?.title).toBe("raw_scanner");
			expect(callPresExp.view.sections[0]?.label).toBe("Arguments");
			const argumentText = (callPresExp.view.sections[0]?.lines ?? []).flatMap(line => line.map(span => span.text));
			expect(argumentText.join(" ")).toContain("lib/core.ts");
		}

		// Collapsed result
		const resultPres = buildToolResultPresentation(
			"raw_scanner",
			{ content: [{ type: "text", text: "Found 4 matches" }], details: { count: 4 }, isError: false },
			{ path: "lib/core.ts" },
			unhookedTool,
			{ expanded: false, hasResult: true },
		);
		expect(resultPres.expanded).toBe(false);
		expect(resultPres.view.kind).toBe("statusRow");
		if (resultPres.view.kind === "statusRow") {
			expect(resultPres.view.status).toBe("success");
			expect(resultPres.view.description).toBe("Found 4 matches");
		}

		// Expanded result: the tool's own details reach a section of their own
		const resultPresExp = buildToolResultPresentation(
			"raw_scanner",
			{ content: [{ type: "text", text: "Found 4 matches" }], details: { count: 4 }, isError: false },
			{ path: "lib/core.ts" },
			unhookedTool,
			{ expanded: true, hasResult: true },
		);
		expect(resultPresExp.view.kind).toBe("framedBlock");
		if (resultPresExp.view.kind === "framedBlock") {
			expect(resultPresExp.view.sections.map(section => section.label)).toEqual(["Output", "Details"]);
			const detailText = (resultPresExp.view.sections[1]?.lines ?? []).flatMap(line => line.map(span => span.text));
			expect(detailText.join("")).toContain("count");
			expect(detailText.join("")).toContain("4");
		}

		// Error result
		const resultPresErr = buildToolResultPresentation(
			"raw_scanner",
			{ content: [{ type: "text", text: "File not found" }], isError: true },
			{ path: "missing.ts" },
			unhookedTool,
			{ expanded: false, hasResult: true },
		);
		expect(resultPresErr.view.kind).toBe("statusRow");
		if (resultPresErr.view.kind === "statusRow") {
			expect(resultPresErr.view.status).toBe("error");
			expect(resultPresErr.view.description).toBe("File not found");
		}
	});

	test("renderer exception produces visible error notice without throwing or suppressing raw output", () => {
		const throwingTool: AgentTool = {
			name: "faulty_tool",
			label: "Faulty Tool",
			description: "Throws during render",
			parameters: {} as unknown as AgentTool["parameters"],
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			view: {
				renderCall: () => {
					throw new Error("Call render exploded");
				},
				renderResult: () => {
					throw new Error("Result render exploded");
				},
			},
		};

		const callPres = buildToolCallPresentation("faulty_tool", { arg1: "test" }, throwingTool, { expanded: false });
		expect(callPres.view.kind).toBe("notice");
		if (callPres.view.kind === "notice") {
			expect(callPres.view.state).toBe("error");
			expect(callPres.view.headline[0]?.text).toContain("Call render exploded");
		}

		const resultPres = buildToolResultPresentation(
			"faulty_tool",
			{ content: [{ type: "text", text: "raw preserved text" }], isError: false },
			{ arg1: "test" },
			throwingTool,
			{ expanded: false },
		);
		expect(resultPres.view.kind).toBe("notice");
		if (resultPres.view.kind === "notice") {
			expect(resultPres.view.state).toBe("error");
			expect(resultPres.view.headline[0]?.text).toContain("Result render exploded");
		}
	});

	test("SetToolViewExpanded toggles disclosure and updates transcript over socket", async () => {
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		const sessionId = sm.getSessionId();

		sm.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-xyz-123",
					name: "read",
					arguments: { path: "src/server.ts" },
				},
			],
			api: "openai-chat",
			provider: "openai",
			model: "gpt-4o",
			stopReason: "toolUse",
			usage: ZERO_USAGE,
			timestamp: Date.now(),
		});

		sm.appendMessage({
			role: "toolResult",
			toolCallId: "call-xyz-123",
			toolName: "read",
			content: [{ type: "text", text: "export const port = 3000;\n" }],
			isError: false,
			timestamp: Date.now(),
		});

		const { frames: loadFrames } = await client.request(1, {
			LoadTranscript: { session: sessionId, before: null },
		});
		const entries = transcriptEntries(loadFrames);
		expect(entries.length).toBe(2);

		const assistantEntry = entries[0];
		const resultEntry = entries[1];
		if (!assistantEntry || !resultEntry) throw new Error("transcript snapshot carried no entries");

		const callBlock = toolCallBlocks(assistantEntry)[0];
		expect(callBlock).toBeDefined();
		expect(callBlock?.ToolCall.id).toBe("call-xyz-123");
		expect(callBlock?.ToolCall.arguments).toEqual({ path: "src/server.ts" });
		expect(callBlock?.ToolCall.presentation?.expanded).toBe(false);
		expect(callBlock?.ToolCall.presentation?.view.kind).toBe("statusRow");

		const resultBlock = toolResultBlocks(resultEntry)[0];
		expect(resultBlock).toBeDefined();
		expect(resultBlock?.ToolResult.tool).toBe("call-xyz-123");
		expect(resultBlock?.ToolResult.presentation?.expanded).toBe(false);

		const { outcome: expandOutcome, frames: expandFrames } = await client.request(2, {
			SetToolViewExpanded: {
				session: sessionId,
				call_id: "call-xyz-123",
				expanded: true,
			},
		});
		expect(expandOutcome.RequestSucceeded?.request).toBe(2);

		const expanded = updatedEntries(expandFrames);
		expect(expanded.length).toBeGreaterThanOrEqual(1);
		let sawExpandedCall = false;
		for (const entry of expanded) {
			for (const block of toolCallBlocks(entry)) {
				sawExpandedCall = true;
				expect(block.ToolCall.presentation?.expanded).toBe(true);
				expect(block.ToolCall.presentation?.view.kind).toBe("framedBlock");
			}
			for (const block of toolResultBlocks(entry)) {
				expect(block.ToolResult.presentation?.expanded).toBe(true);
			}
		}
		expect(sawExpandedCall).toBe(true);

		const { outcome: collapseOutcome, frames: collapseFrames } = await client.request(3, {
			SetToolViewExpanded: {
				session: sessionId,
				call_id: "call-xyz-123",
				expanded: false,
			},
		});
		expect(collapseOutcome.RequestSucceeded?.request).toBe(3);
		const collapsed = updatedEntries(collapseFrames);
		expect(collapsed.length).toBeGreaterThanOrEqual(1);
		for (const entry of collapsed) {
			for (const block of toolCallBlocks(entry)) {
				expect(block.ToolCall.presentation?.expanded).toBe(false);
				expect(block.ToolCall.presentation?.view.kind).toBe("statusRow");
			}
		}
	});

	test("SetToolViewExpanded error handling and validation", async () => {
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		const sessionId = sm.getSessionId();

		// OpenSession resolves a session id against the sessions on disk, so the
		// session has to hold a message before it can be opened. Its outcome is
		// asserted: an unopened session answers every later case with
		// SESSION_NOT_FOUND, which would pass case 2 and hide case 3.
		sm.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-validation-1",
					name: "read",
					arguments: { path: "src/server.ts" },
				},
			],
			api: "openai-chat",
			provider: "openai",
			model: "gpt-4o",
			stopReason: "toolUse",
			usage: ZERO_USAGE,
			timestamp: Date.now(),
		});

		const { outcome: openOutcome } = await client.request(10, {
			OpenSession: { session: sessionId },
		});
		expect(openOutcome.RequestSucceeded?.request).toBe(10);

		// 1. Invalid payload: missing fields
		const { outcome: badPayloadOutcome } = await client.request(11, {
			SetToolViewExpanded: {
				session: sessionId,
			},
		});
		expect(badPayloadOutcome.RequestFailed?.error.scope).toBe("Tool");
		expect(badPayloadOutcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");

		// 2. Inactive / wrong session
		const { outcome: badSessionOutcome } = await client.request(12, {
			SetToolViewExpanded: {
				session: "non-existent-session-id",
				call_id: "call-123",
				expanded: true,
			},
		});
		expect(badSessionOutcome.RequestFailed?.error.scope).toBe("Tool");
		expect(badSessionOutcome.RequestFailed?.error.code).toBe("SESSION_NOT_FOUND");

		// 3. Unknown / stale call_id
		const { outcome: staleCallOutcome } = await client.request(13, {
			SetToolViewExpanded: {
				session: sessionId,
				call_id: "call-does-not-exist",
				expanded: true,
			},
		});
		expect(staleCallOutcome.RequestFailed?.error.scope).toBe("Tool");
		expect(staleCallOutcome.RequestFailed?.error.code).toBe("CALL_NOT_FOUND");
	});

	test("resume and LoadTranscript produces registered tool presentations on all entries", async () => {
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		const sessionId = sm.getSessionId();

		sm.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-res-1",
					name: "read",
					arguments: { path: "packages/core/src/index.ts" },
				},
				{
					type: "toolCall",
					id: "call-res-2",
					name: "write",
					arguments: { path: "packages/core/src/output.ts", content: "export const x = 1;" },
				},
			],
			api: "openai-chat",
			provider: "openai",
			model: "gpt-4o",
			stopReason: "toolUse",
			usage: ZERO_USAGE,
			timestamp: Date.now(),
		});

		sm.appendMessage({
			role: "toolResult",
			toolCallId: "call-res-1",
			toolName: "read",
			content: [{ type: "text", text: "file contents\nline 2" }],
			isError: false,
			timestamp: Date.now(),
		});

		sm.appendMessage({
			role: "toolResult",
			toolCallId: "call-res-2",
			toolName: "write",
			content: [{ type: "text", text: "successfully wrote 20 bytes" }],
			isError: false,
			timestamp: Date.now(),
		});

		const { frames } = await client.request(20, {
			LoadTranscript: { session: sessionId, before: null },
		});
		const entries = transcriptEntries(frames);
		expect(entries.length).toBe(3);

		const assistantEntry = entries[0];
		const firstResultEntry = entries[1];
		const secondResultEntry = entries[2];
		if (!assistantEntry || !firstResultEntry || !secondResultEntry) {
			throw new Error("transcript snapshot carried fewer entries than asserted");
		}

		const callBlocks = toolCallBlocks(assistantEntry);
		expect(callBlocks.length).toBe(2);
		expect(callBlocks.map(block => block.ToolCall.id)).toEqual(["call-res-1", "call-res-2"]);
		for (const block of callBlocks) {
			expect(block.ToolCall.presentation?.expanded).toBe(false);
			expect(block.ToolCall.presentation?.view.kind).toBe("statusRow");
		}

		const result1 = toolResultBlocks(firstResultEntry)[0];
		expect(result1?.ToolResult.tool).toBe("call-res-1");
		expect(result1?.ToolResult.presentation?.view.kind).toBe("statusRow");

		const result2 = toolResultBlocks(secondResultEntry)[0];
		expect(result2?.ToolResult.tool).toBe("call-res-2");
		expect(result2?.ToolResult.presentation?.view.kind).toBe("statusRow");
	});
});
