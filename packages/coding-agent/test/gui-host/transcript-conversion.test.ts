/**
 * WHY THIS SUITE EXISTS:
 * Native desktop captures previously rendered opaque bracket labels like
 * `[thinking_level_change]`, `[service_tier_change]`, `[model_change]`,
 * and `[custom_message]` when session entries were converted to fallback blocks.
 *
 * THE CLASS THIS CLOSES:
 * 1. Divergence between SessionEntry union variants and desktop-observable ContentBlocks.
 * 2. Loss of structured/readable model, thinking, tier, and custom entries into fallback labels.
 * 3. Leaking of hidden custom messages marked `display: false`.
 * 4. Corruption of entry IDs, parent hierarchy, timestamps, or raw audit records.
 *
 * WHAT IT DOES NOT CATCH:
 * Rust-side GPUI widget painting or font rendering on the native display.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SESSION_EXIT_CUSTOM_TYPE, TOOL_EXECUTION_START_CUSTOM_TYPE } from "@veyyon/kernel/session/exit-diagnostics";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { agentMessageToTranscriptEntry, sessionEntryToTranscriptEntry } from "../../src/gui-host/transcript-conversion";
import type { TranscriptEntry } from "../../src/gui-host/wire";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/agent/todo";
import { TestSocketClient } from "./test-client";
import { EXHAUSTIVE_FIXTURES, FIXTURE_TIMESTAMP, FIXTURE_TIMESTAMP_MS } from "./transcript-conversion-fixtures";

describe("sessionEntryToTranscriptEntry parameterized exhaustiveness", () => {
	for (const [entryType, fixture] of Object.entries(EXHAUSTIVE_FIXTURES)) {
		test(`maps ${entryType} preserving identifiers, hierarchy, role, and content`, () => {
			const transcript = sessionEntryToTranscriptEntry(fixture.entry, 1);
			expect(transcript.id).toBe(fixture.entry.id);
			expect(transcript.parent).toBe(fixture.entry.parentId ?? null);
			expect(transcript.revision).toBe(1);
			expect(transcript.timestamp_ms).toBe(FIXTURE_TIMESTAMP_MS);
			expect(transcript.raw_discriminator).toBe(fixture.entry.type);
			expect(transcript.raw).toBe(fixture.entry);
			expect(transcript.role).toBe(fixture.expectedRole);
			expect(transcript.content).toEqual(fixture.expectedContent);
		});
	}
});

describe("sessionEntryToTranscriptEntry specific variant contracts", () => {
	test("bare model without provider produces readable Text without fabricating provider", () => {
		const entry: SessionEntry = {
			type: "model_change",
			id: "m-bare",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			model: "gpt-4o",
		};
		const transcript = sessionEntryToTranscriptEntry(entry, 1);
		expect(transcript.content).toEqual([{ Text: { text: "model: gpt-4o" } }]);
	});

	test("model change with non-default routing role produces readable Text retaining role", () => {
		const entry: SessionEntry = {
			type: "model_change",
			id: "m-role",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			model: "anthropic/claude-3-7-sonnet",
			role: "fast",
		};
		const transcript = sessionEntryToTranscriptEntry(entry, 1);
		expect(transcript.content).toEqual([{ Text: { text: "fast model: anthropic/claude-3-7-sonnet" } }]);
	});

	test("thinking level change prefers configured and shows effective value when different", () => {
		const entry: SessionEntry = {
			type: "thinking_level_change",
			id: "t-diff",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			thinkingLevel: "high",
			configured: "auto",
		};
		const transcript = sessionEntryToTranscriptEntry(entry, 1);
		expect(transcript.content).toEqual([{ ThinkingChange: { level: "auto (high)" } }]);
	});

	test("thinking level change when both fields are absent produces 'thinking level not recorded'", () => {
		const entry: SessionEntry = {
			type: "thinking_level_change",
			id: "t-none",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
		};
		const transcript = sessionEntryToTranscriptEntry(entry, 1);
		expect(transcript.content).toEqual([{ Text: { text: "thinking level not recorded" } }]);
	});

	test("service tier change with null produces 'service tier: unset'", () => {
		const entry: SessionEntry = {
			type: "service_tier_change",
			id: "st-null",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			serviceTier: null,
		};
		const transcript = sessionEntryToTranscriptEntry(entry, 1);
		expect(transcript.content).toEqual([{ Text: { text: "service tier: unset" } }]);
	});

	test("custom message with display: false returns empty content preserving links and raw", () => {
		const entry: SessionEntry = {
			type: "custom_message",
			id: "cmsg-hidden",
			parentId: "parent-42",
			timestamp: FIXTURE_TIMESTAMP,
			customType: "telemetry",
			content: "Hidden trace payload",
			display: false,
		};
		const transcript = sessionEntryToTranscriptEntry(entry, 2);
		expect(transcript.id).toBe("cmsg-hidden");
		expect(transcript.parent).toBe("parent-42");
		expect(transcript.raw_discriminator).toBe("custom_message");
		expect(transcript.raw).toBe(entry);
		expect(transcript.content).toEqual([]);
	});

	// A real desktop recording put "Fallback: tool_execution_start" in the
	// transcript between a tool card and the prose after it: the pending-tool
	// warning's own bookkeeping entry, rendered as content. Every writer of a
	// `custom` entry is swept, so a new bookkeeping type cannot arrive visible.
	test.each([
		[TOOL_EXECUTION_START_CUSTOM_TYPE, { toolCallId: "call-1", toolName: "bash" }],
		[SESSION_EXIT_CUSTOM_TYPE, { reason: "dispose", kind: "normal" }],
		[USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] }],
		["goal-completed", { objective: "ship the desktop" }],
		["irc:delivery-telemetry", { delivered: 3 }],
		["ext-state", { flag: true }],
	])("a %s custom entry shows nothing and keeps its record", (customType, data) => {
		const entry: SessionEntry = {
			type: "custom",
			id: `bookkeeping-${customType}`,
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			customType,
			data,
		};
		const transcript = sessionEntryToTranscriptEntry(entry, 3);
		expect(transcript.content).toEqual([]);
		expect(transcript.raw_discriminator).toBe("custom");
		expect(transcript.raw).toBe(entry);
	});

	test("unknown extension entries retain lossless Fallback block", () => {
		const entry = {
			type: "future_plugin_entry",
			id: "future-1",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			payload: { count: 10 },
		} as unknown as SessionEntry;
		const transcript = sessionEntryToTranscriptEntry(entry, 1);
		expect(transcript.raw_discriminator).toBe("future_plugin_entry");
		expect(transcript.content).toEqual([{ Fallback: { producer: "future_plugin_entry", value: entry } }]);
	});
});

describe("LoadTranscript socket integration", () => {
	let tempDir: TempDir;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = TempDir.createSync("gui-host-transcript-test-");
		const testPath = tempDir.path();
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: testPath, agentDir: testPath });
		client = await TestSocketClient.connect(server.endpoint);
		// Consume greeting and capabilities snapshots
		await client.nextFrame();
		await client.nextFrame();
	});
	afterEach(async () => {
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await tempDir.remove();
	});

	test("LoadTranscript delivers converted entries with structured blocks and hidden custom messages", async () => {
		const created = await client.request(1, { CreateSession: { title: "Transcript Integration Session" } });
		expect(created.outcome).toEqual({ RequestSucceeded: { request: 1 } });

		let sessionId: string | undefined;
		let sessionPath: string | undefined;
		for (const frame of created.frames) {
			const active = frame.Snapshot?.ActiveSession;
			if (active && typeof active === "object" && "value" in active) {
				const activeVal = active.value;
				if (activeVal && typeof activeVal === "object" && "id" in activeVal && typeof activeVal.id === "string") {
					sessionId = activeVal.id;
				}
			}
			const sessionsSnap = frame.Snapshot?.Sessions;
			if (
				Array.isArray(sessionsSnap) &&
				sessionsSnap[0] &&
				typeof sessionsSnap[0] === "object" &&
				"value" in sessionsSnap[0] &&
				Array.isArray(sessionsSnap[0].value)
			) {
				const rows = sessionsSnap[0].value as Array<{ id?: string; path?: string }>;
				const matching = rows.find(r => r.id === sessionId);
				if (matching?.path) sessionPath = matching.path;
			}
		}
		if (!sessionId) throw new Error("CreateSession emitted no ActiveSession id");
		if (!sessionPath) throw new Error("CreateSession emitted no session path");

		// Evict session 1 from active in-memory manager
		await client.request(2, { CreateSession: { title: "Secondary Session" } });

		// Populate session 1 on disk
		const sm = await SessionManager.open(sessionPath);
		sm.appendMessage({ role: "user", timestamp: Date.now(), content: "Run workflow" });
		sm.appendModelChange("anthropic/claude-3-7-sonnet", "default");
		sm.appendThinkingLevelChange("high");
		sm.appendServiceTierChange({ openai: "priority", anthropic: "flex" });
		sm.appendCustomMessageEntry("plan-step", "Step 1: Check baseline", true);
		sm.appendCustomMessageEntry("telemetry", "Internal metric snapshot", false);
		sm.appendModeChange("plan");
		await sm.flushSync();

		// Request LoadTranscript for session 1
		const loadResp = await client.request(3, { LoadTranscript: { session: sessionId, before: null } });
		expect(loadResp.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		let entries: TranscriptEntry[] | undefined;
		for (const frame of loadResp.frames) {
			const transcriptSnap = frame.Snapshot?.Transcript;
			if (
				transcriptSnap &&
				typeof transcriptSnap === "object" &&
				"value" in transcriptSnap &&
				Array.isArray(transcriptSnap.value)
			) {
				entries = transcriptSnap.value as TranscriptEntry[];
				break;
			}
		}

		expect(entries).toBeDefined();
		if (!entries) throw new Error("Transcript carried no entries");
		expect(entries.length).toBeGreaterThanOrEqual(6);

		const modelEntry = entries.find(e => e.raw_discriminator === "model_change");
		expect(modelEntry?.content).toEqual([{ ModelChange: { provider: "anthropic", model: "claude-3-7-sonnet" } }]);

		const thinkEntry = entries.find(e => e.raw_discriminator === "thinking_level_change");
		expect(thinkEntry?.content).toEqual([{ ThinkingChange: { level: "high" } }]);

		const tierEntry = entries.find(e => e.raw_discriminator === "service_tier_change");
		expect(tierEntry?.content).toEqual([{ Text: { text: "service tier: openai:priority, anthropic:flex" } }]);

		const visibleMsg = entries.find(e => e.raw_discriminator === "custom_message" && e.content.length > 0);
		expect(visibleMsg?.content).toEqual([{ Text: { text: "Step 1: Check baseline" } }]);

		const hiddenMsg = entries.find(e => {
			if (e.raw_discriminator !== "custom_message") return false;
			const rawRecord = e.raw;
			return Boolean(
				rawRecord &&
					typeof rawRecord === "object" &&
					"customType" in rawRecord &&
					rawRecord.customType === "telemetry",
			);
		});
		expect(hiddenMsg?.content).toEqual([]);
		expect(hiddenMsg?.id).toBeDefined();

		const modeEntry = entries.find(e => e.raw_discriminator === "mode_change");
		expect(modeEntry?.content).toEqual([{ Text: { text: "mode: plan" } }]);
	});
});

describe("tool result identity and presentation", () => {
	for (const isError of [false, true]) {
		test(`retains the call identity and error=${isError} while projecting media separately`, () => {
			const message = {
				role: "toolResult" as const,
				toolCallId: "call-two",
				toolName: "read",
				content: [
					{ type: "text" as const, text: "first line" },
					{ type: "image" as const, mimeType: "image/png", data: "AQID" },
					{ type: "text" as const, text: "second line" },
				],
				isError,
				timestamp: FIXTURE_TIMESTAMP_MS,
			};
			const projected = agentMessageToTranscriptEntry(message, 3, "result-two");
			expect(projected.content).toEqual([
				{
					ToolResult: {
						tool: "call-two",
						content: "first line\nsecond line",
						is_error: isError,
						presentation: {
							expanded: false,
							view: {
								kind: "statusRow",
								status: isError ? "error" : "success",
								title: "read",
								description: "first line",
							},
						},
					},
				},
				{ Image: { media_type: "image/png", data: [1, 2, 3], alt: null } },
			]);
			expect(projected.raw).toBe(message);
		});
	}
});
