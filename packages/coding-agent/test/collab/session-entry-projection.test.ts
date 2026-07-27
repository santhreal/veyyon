/**
 * What a host transcript entry looks like by the time a guest receives it.
 *
 * WHY THIS SUITE EXISTS. The host used to filter entries by type and broadcast them verbatim. The
 * filter was `isWireSessionEntry`, a type guard, and a type guard narrows the TYPE without touching
 * the VALUE, so every field the host's entry carried beyond what the wire contract declares went out
 * with it. This is the same defect the `welcome` header had one frame over, and the same reason it
 * was invisible: a value carrying more fields satisfies a type declaring fewer, so nothing failed.
 *
 * WHAT WAS ACTUALLY SHIPPING. On an assistant message: `api`, `provider`, `providerPayload`,
 * `request`, `contextSnapshot`, `retryRecovery`, `turnMetrics`, `responseId`, `upstreamProvider`,
 * `stopDetails`, `errorStatus`, `errorId`, `disabledFeatures`, `toolCallAbortMessages`, `duration`
 * and `ttft`. `providerPayload` is the transport-native history used to replay a turn upstream and
 * `request` is the sampling parameters exactly as sent. On a tool result: `prunedAt`, `useless` and
 * `metrics`. On user and developer turns: `steering` and `attribution`.
 *
 * WHY THAT IS A DEFECT AND NOT UNTIDINESS. A guest does not merely read what it receives. It writes
 * the entries into its own replica session file, so these fields land on other people's machines,
 * including read-only viewers who joined through a view link. They are also large, and every one of
 * them crosses a relay somebody else runs.
 *
 * The cases below pin both halves: every declared field survives with its exact value, and every
 * host-only field is gone. The last group is the one that matters over time, because the projection
 * is written out field by field rather than as a destructuring rest, and the whole point of that
 * choice is that a field added to a host entry does not start shipping on its own.
 */

import { describe, expect, it } from "bun:test";
import { fromWireSessionEntry, toWireSessionEntry } from "@veyyon/coding-agent/collab/protocol";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";

/** Keys a projected entry may have, so a leak is named rather than counted. */
function keysOf(value: unknown): string[] {
	return Object.keys(value as Record<string, unknown>).sort();
}

/** A message entry whose assistant message carries every host-only field the type declares. */
function assistantEntry(): SessionEntry {
	return {
		type: "message",
		id: "01JZQ4VN2M7X8P0R5T9K3B6C2D",
		parentId: "01JZQ4VN2M7X8P0R5T9K3B6C2C",
		timestamp: "2026-07-26T11:02:03.004Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "the relay is up" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-6",
			usage: {
				input: 1200,
				output: 340,
				cacheRead: 800,
				cacheWrite: 64,
				totalTokens: 2404,
				orchestration: { input: 12, cacheRead: 4, output: 8 },
				premiumRequests: 1,
				reasoningTokens: 96,
				cost: { total: 0.0412, input: 0.02, output: 0.0212 },
			},
			stopReason: "stop",
			stopDetails: { reason: "end_turn" },
			errorMessage: undefined,
			errorStatus: 429,
			errorId: 7,
			responseId: "msg_01ABCDEF",
			upstreamProvider: "bedrock",
			disabledFeatures: ["thinking"],
			toolCallAbortMessages: { call_1: "aborted by user" },
			contextSnapshot: { tokens: 2404 },
			retryRecovery: { attempts: 2 },
			providerPayload: { raw: { messages: [{ role: "user", content: "secret prompt" }] } },
			request: { temperature: 0.2, maxTokens: 8192 },
			turnMetrics: { toolCalls: 3 },
			duration: 4821,
			ttft: 612,
			timestamp: 1_785_000_123_004,
		},
	} as unknown as SessionEntry;
}

/** A tool-result entry with the three host-only fields populated. */
function toolResultEntry(): SessionEntry {
	return {
		type: "message",
		id: "01JZQ4VN2M7X8P0R5T9K3B6C2E",
		parentId: null,
		timestamp: "2026-07-26T11:02:05.100Z",
		message: {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			details: { path: "/srv/project/main.ts", lines: 42 },
			isError: false,
			attribution: "host",
			prunedAt: 1_785_000_200_000,
			useless: true,
			metrics: { bytes: 4096 },
			timestamp: 1_785_000_125_100,
		},
	} as unknown as SessionEntry;
}

describe("projecting an assistant message entry", () => {
	/**
	 * The seven declared fields survive with their exact values. A projection that dropped one
	 * would leave the guest unable to say what answered or what it cost, and no type error would
	 * report it, because every one of them is either optional or filled from a wide host value.
	 */
	it("carries every field the wire contract declares", () => {
		const wire = toWireSessionEntry(assistantEntry());

		expect(wire).toEqual({
			type: "message",
			id: "01JZQ4VN2M7X8P0R5T9K3B6C2D",
			parentId: "01JZQ4VN2M7X8P0R5T9K3B6C2C",
			timestamp: "2026-07-26T11:02:03.004Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "the relay is up" }],
				model: "claude-opus-4-6",
				provider: "anthropic",
				usage: {
					input: 1200,
					output: 340,
					cacheRead: 800,
					cacheWrite: 64,
					totalTokens: 2404,
					cost: { total: 0.0412 },
				},
				stopReason: "stop",
				errorMessage: undefined,
				timestamp: 1_785_000_123_004,
			},
		});
	});

	/**
	 * The transport-native history and the sampling parameters are the two worth naming on their
	 * own. `providerPayload` can hold the raw upstream request, which is the closest thing in a
	 * transcript to the host's own prompt bytes, and `request` records exactly how the turn was
	 * asked for. Neither is drawn anywhere, and both were being persisted by every guest.
	 */
	it("drops the provider payload and the request parameters", () => {
		const wire = toWireSessionEntry(assistantEntry());
		const message = (wire as unknown as { message: Record<string, unknown> }).message;

		expect(message.providerPayload).toBeUndefined();
		expect(message.request).toBeUndefined();
		expect(JSON.stringify(wire)).not.toContain("secret prompt");
	});

	/**
	 * And the rest of the host-only set, asserted as an exact key list rather than field by field.
	 * A count would pass while shipping a different field than the one it counted; the key list
	 * names what may travel, so a new field fails this case by appearing in it.
	 */
	it("ships exactly the declared keys and nothing else", () => {
		const wire = toWireSessionEntry(assistantEntry());
		const message = (wire as unknown as { message: unknown }).message;

		expect(keysOf(wire)).toEqual(["id", "message", "parentId", "timestamp", "type"]);
		expect(keysOf(message)).toEqual([
			"content",
			"errorMessage",
			"model",
			"provider",
			"role",
			"stopReason",
			"timestamp",
			"usage",
		]);
	});

	/**
	 * Usage is projected too, not passed through. The host's accounting also carries provider-side
	 * orchestration counts, a premium-request counter, a reasoning-token subset and a per-bucket
	 * cost breakdown; a guest draws six numbers and one total.
	 */
	it("narrows usage to the six numbers a guest renders", () => {
		const wire = toWireSessionEntry(assistantEntry());
		const usage = (wire as unknown as { message: { usage: Record<string, unknown> } }).message.usage;

		expect(keysOf(usage)).toEqual(["cacheRead", "cacheWrite", "cost", "input", "output", "totalTokens"]);
		expect(keysOf(usage.cost)).toEqual(["total"]);
		expect(usage.totalTokens).toBe(2404);
	});
});

describe("projecting a tool-result message entry", () => {
	/**
	 * `details` is declared and must survive: it is what tells a guest how to render the result,
	 * and a tool's own detail shape is the whole content of a diff or a search hit.
	 */
	it("keeps the details a guest renders the result from", () => {
		const wire = toWireSessionEntry(toolResultEntry());
		const message = (wire as unknown as { message: { details: unknown } }).message;

		expect(message.details).toEqual({ path: "/srv/project/main.ts", lines: 42 });
	});

	/**
	 * `prunedAt`, `useless` and `metrics` are host bookkeeping about context management. A guest
	 * showing a transcript has no use for whether the host later decided a result was worthless.
	 */
	it("drops the host's context bookkeeping", () => {
		const wire = toWireSessionEntry(toolResultEntry());
		const message = (wire as unknown as { message: unknown }).message;

		expect(keysOf(message)).toEqual(["content", "details", "isError", "role", "timestamp", "toolCallId", "toolName"]);
	});
});

describe("projecting the non-message entry variants", () => {
	/**
	 * A compaction entry carries extension data, hook-preserved data, an extension flag and a
	 * dead-end warning that no guest draws. It ships a summary and the id it kept from.
	 */
	it("narrows a compaction entry to its summary fields", () => {
		const entry = {
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: "2026-07-26T11:03:00.000Z",
			summary: "compacted the first forty turns",
			shortSummary: "compacted",
			firstKeptEntryId: "e40",
			tokensBefore: 128_000,
			details: { artifactIndex: ["a", "b"] },
			preserveData: { hookState: 1 },
			fromExtension: true,
		} as unknown as SessionEntry;

		const wire = toWireSessionEntry(entry);

		expect(wire).toEqual({
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: "2026-07-26T11:03:00.000Z",
			summary: "compacted the first forty turns",
			shortSummary: "compacted",
			firstKeptEntryId: "e40",
			tokensBefore: 128_000,
		});
	});

	/** A branch summary sheds its extension data for the same reason. */
	it("narrows a branch-summary entry", () => {
		const entry = {
			type: "branch_summary",
			id: "b1",
			parentId: "e9",
			timestamp: "2026-07-26T11:04:00.000Z",
			fromId: "e9",
			summary: "explored the retry path",
			details: { tokens: 900 },
			fromExtension: false,
		} as unknown as SessionEntry;

		expect(keysOf(toWireSessionEntry(entry))).toEqual(["fromId", "id", "parentId", "summary", "timestamp", "type"]);
	});

	/**
	 * A thinking-level change also records the user's selector at the time, which is host state:
	 * `configured` is `"auto"` when auto mode was on, and a guest renders the resolved level.
	 */
	it("drops the configured selector from a thinking-level change", () => {
		const entry = {
			type: "thinking_level_change",
			id: "t1",
			parentId: null,
			timestamp: "2026-07-26T11:05:00.000Z",
			thinkingLevel: "high",
			configured: "auto",
		} as unknown as SessionEntry;

		const wire = toWireSessionEntry(entry);

		expect(wire).toEqual({
			type: "thinking_level_change",
			id: "t1",
			parentId: null,
			timestamp: "2026-07-26T11:05:00.000Z",
			thinkingLevel: "high",
		});
	});

	/**
	 * A custom-message entry keeps `details`, because that is where a `collab-prompt` carries the
	 * guest's identity, and losing it makes a guest's own prompt render as the host's. It drops
	 * `attribution`, which is host billing semantics.
	 */
	it("keeps custom-message details and drops the attribution", () => {
		const entry = {
			type: "custom_message",
			id: "cm1",
			parentId: null,
			timestamp: "2026-07-26T11:06:00.000Z",
			customType: "collab-prompt",
			content: "run the tests",
			details: { peerName: "sam" },
			display: true,
			attribution: "guest",
		} as unknown as SessionEntry;

		const wire = toWireSessionEntry(entry);

		expect(wire).toEqual({
			type: "custom_message",
			id: "cm1",
			parentId: null,
			timestamp: "2026-07-26T11:06:00.000Z",
			customType: "collab-prompt",
			content: "run the tests",
			details: { peerName: "sam" },
			display: true,
		});
	});

	/** A model change keeps the role, which is how a guest labels a smol or slow turn. */
	it("carries a model change with its role", () => {
		const entry = {
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp: "2026-07-26T11:07:00.000Z",
			model: "anthropic/claude-opus-4-6",
			role: "smol",
		} as unknown as SessionEntry;

		expect(toWireSessionEntry(entry)).toEqual({
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp: "2026-07-26T11:07:00.000Z",
			model: "anthropic/claude-opus-4-6",
			role: "smol",
		});
	});
});

describe("entries no guest renders", () => {
	/**
	 * An entry type outside the wire union answers `undefined` rather than an entry with missing
	 * fields. Filtering and projecting are one step so an unprojected entry cannot be broadcast,
	 * which is the property the old type-guard-then-send arrangement did not have.
	 */
	it("answers undefined for a host-only entry type", () => {
		for (const type of ["mode_change", "session", "custom", "label", "ttsr_injection"]) {
			const entry = { type, id: "x", parentId: null, timestamp: "2026-07-26T11:08:00.000Z" };

			expect(toWireSessionEntry(entry as unknown as SessionEntry)).toBeUndefined();
		}
	});
});

/**
 * The seven roles the host adds through its `CustomAgentMessages` hook.
 *
 * These used to be passed through with a single deliberate cast, because `@veyyon/wire` declared
 * only the model's four roles and nothing stated what a guest receives for the other seven. They
 * cannot simply be dropped: a guest's replica is drawn by this same package's renderer, so losing a
 * `bashExecution` would make a `!ls` and its output vanish from every guest's transcript. Now that
 * each has a declared shape, each gets the same exact-key-set treatment the four declared roles do.
 */
describe("projecting the seven custom message roles", () => {
	function messageEntry(message: Record<string, unknown>): SessionEntry {
		return {
			type: "message",
			id: "cx1",
			parentId: null,
			timestamp: "2026-07-26T11:09:00.000Z",
			message,
		} as unknown as SessionEntry;
	}

	function projected(message: Record<string, unknown>): Record<string, unknown> {
		const wire = toWireSessionEntry(messageEntry(message));
		return (wire as unknown as { message: Record<string, unknown> }).message;
	}

	/** A `!command` survives with its command, output and exit status intact. */
	it("carries a bash execution with its command, output and exit status", () => {
		expect(
			projected({
				role: "bashExecution",
				command: "ls -la",
				output: "total 8",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1_785_000_400_000,
			}),
		).toEqual({
			role: "bashExecution",
			command: "ls -la",
			output: "total 8",
			exitCode: 0,
			signal: undefined,
			cancelled: false,
			truncated: false,
			meta: undefined,
			excludeFromContext: undefined,
			timestamp: 1_785_000_400_000,
		});
	});

	/**
	 * `signal` and `excludeFromContext` are both drawn, and both are the kind of field a projection
	 * silently loses: one distinguishes an out-of-memory kill from a program calling `exit(137)`, the
	 * other marks a `!!` execution the model never saw.
	 */
	it("keeps the signal and the excluded-from-context marker", () => {
		const wire = projected({
			role: "bashExecution",
			command: "stress",
			output: "",
			exitCode: 137,
			signal: 9,
			cancelled: false,
			truncated: true,
			excludeFromContext: true,
			timestamp: 1_785_000_400_001,
		});

		expect(wire.signal).toBe(9);
		expect(wire.excludeFromContext).toBe(true);
		expect(wire.truncated).toBe(true);
	});

	/** A `$code` execution is the same shape one language over. */
	it("carries a python execution with its code and output", () => {
		expect(
			Object.keys(
				projected({
					role: "pythonExecution",
					code: "print(1)",
					output: "1",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1_785_000_400_002,
				}),
			).sort(),
		).toEqual([
			"cancelled",
			"code",
			"excludeFromContext",
			"exitCode",
			"meta",
			"output",
			"role",
			"timestamp",
			"truncated",
		]);
	});

	/**
	 * `attribution` records who to bill for the turn. It is host bookkeeping and the only field
	 * dropped from an extension-injected message; `details` stays, because an extension's own
	 * renderer draws the message from it.
	 */
	it("drops the billing attribution from an extension message and keeps its details", () => {
		const wire = projected({
			role: "custom",
			customType: "collab-prompt",
			content: "hello",
			display: true,
			details: { guestName: "ada" },
			attribution: { kind: "guest", peerId: 7 },
			timestamp: 1_785_000_400_003,
		});

		expect(wire).toEqual({
			role: "custom",
			customType: "collab-prompt",
			content: "hello",
			display: true,
			details: { guestName: "ada" },
			timestamp: 1_785_000_400_003,
		});
	});

	/** The pre-extensions spelling takes the identical path, so an old session renders the same. */
	it("projects a legacy hook message the same way", () => {
		const wire = projected({
			role: "hookMessage",
			customType: "pre-commit",
			content: "blocked",
			display: true,
			attribution: { kind: "host" },
			timestamp: 1_785_000_400_004,
		});

		expect(wire.role).toBe("hookMessage");
		expect(wire.attribution).toBeUndefined();
		expect(wire.customType).toBe("pre-commit");
	});

	/** A branch summary is four fields and all four are drawn. */
	it("carries a branch summary whole", () => {
		expect(
			projected({
				role: "branchSummary",
				summary: "explored the retry path",
				fromId: "entry-42",
				timestamp: 1_785_000_400_005,
			}),
		).toEqual({
			role: "branchSummary",
			summary: "explored the retry path",
			fromId: "entry-42",
			timestamp: 1_785_000_400_005,
		});
	});

	/**
	 * The widest of the seven. A compaction summary carries `providerPayload`, the transport-native
	 * history used to replay the compacted span upstream, and two legacy block arrays from a removed
	 * image-archive engine. A guest draws the summary and the warning.
	 */
	it("drops the provider payload and the legacy block arrays from a compaction summary", () => {
		const wire = projected({
			role: "compactionSummary",
			summary: "the first forty turns",
			shortSummary: "forty turns",
			tokensBefore: 128_000,
			warning: "no progress since the last compaction",
			providerPayload: { type: "openaiResponsesHistory", items: [{ text: "secret prompt" }] },
			blocks: [{ type: "text", text: "legacy" }],
			images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			timestamp: 1_785_000_400_006,
		});

		expect(wire).toEqual({
			role: "compactionSummary",
			summary: "the first forty turns",
			shortSummary: "forty turns",
			tokensBefore: 128_000,
			warning: "no progress since the last compaction",
			timestamp: 1_785_000_400_006,
		});
		expect(JSON.stringify(wire)).not.toContain("secret prompt");
	});

	/**
	 * A mention keeps the facts the "Read <path>" rows are built from, and NOT the file bodies.
	 *
	 * The renderer draws a path, a line count or a skip reason, and whether an image came with it. It
	 * never draws `content`, so mentioning a 4 MB file used to send 4 MB to every guest on the join
	 * snapshot and again on the entry frame, and land it in their replica session file on disk.
	 */
	it("sends the file facts and never the file bodies", () => {
		const wire = projected({
			role: "fileMention",
			files: [
				{ path: "src/a.ts", content: "export const SECRET_TOKEN = 1;", lineCount: 1, byteSize: 30 },
				{ path: "big.bin", content: "", byteSize: 9_000_000, skippedReason: "binary" },
			],
			timestamp: 1_785_000_400_007,
		});

		expect(wire.files).toEqual([
			{
				path: "src/a.ts",
				hasContent: true,
				lineCount: 1,
				byteSize: 30,
				skippedReason: undefined,
				image: undefined,
			},
			{
				path: "big.bin",
				hasContent: false,
				lineCount: undefined,
				byteSize: 9_000_000,
				skippedReason: "binary",
				image: undefined,
			},
		]);
		expect(JSON.stringify(wire)).not.toContain("SECRET_TOKEN");
	});

	/**
	 * `hasContent` exists so absence stays distinguishable from emptiness. A guest that exports its
	 * replica must be able to say the body was not replicated rather than print a blank `<file>`
	 * block, which is what dropping the field without replacing it would have produced.
	 */
	it("widens a mention back with the body marked missing rather than empty", () => {
		const wire = toWireSessionEntry(
			messageEntry({
				role: "fileMention",
				files: [
					{ path: "src/a.ts", content: "export const a = 1;", lineCount: 1 },
					{ path: "empty.txt", content: "", lineCount: 0 },
				],
				timestamp: 1_785_000_400_009,
			}),
		);
		if (!wire) throw new Error("expected a projected entry");

		const back = fromWireSessionEntry(wire) as unknown as {
			message: { files: { path: string; content: string; contentNotReplicated?: boolean }[] };
		};

		expect(back.message.files[0]).toMatchObject({ path: "src/a.ts", content: "", contentNotReplicated: true });
		// The genuinely empty file is NOT marked: nothing was withheld from it.
		expect(back.message.files[1]).toMatchObject({ path: "empty.txt", content: "", contentNotReplicated: false });
	});

	/**
	 * The round trip the row asked for: a guest's replica must still render a bash execution after
	 * the projection pair, so the command and its output are asserted to survive both directions.
	 */
	it("round-trips a bash execution back into a renderable entry", () => {
		const wire = toWireSessionEntry(
			messageEntry({
				role: "bashExecution",
				command: "git status",
				output: "nothing to commit",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1_785_000_400_008,
			}),
		);
		if (!wire) throw new Error("expected a projected entry");

		const back = fromWireSessionEntry(wire) as unknown as { message: Record<string, unknown> };

		expect(back.message.role).toBe("bashExecution");
		expect(back.message.command).toBe("git status");
		expect(back.message.output).toBe("nothing to commit");
		expect(back.message.exitCode).toBe(0);
	});
});
