/**
 * WHY: the serialized transcript projection dispatches on a message role.
 * The defect class this closes is a message role that reaches the builder and
 * falls
 * through: a new custom role a module of this package adds to
 * `CustomAgentMessages` by declaration merging, or a new member of the core
 * `Message` union, renders as an "Unrenderable message role" error block in
 * production while every hand-written test stays green because nobody added a
 * case for it.
 *
 * So the role set is enumerated from source at run time — the `Message` union in
 * `@veyyon/model` and every `CustomAgentMessages` declaration-merge block under
 * `src/`, since a tool domain declares its own roles beside its own manifest —
 * and the expected mapping is pinned by exact equality.
 * Adding a role turns this file RED until someone records what it renders as.
 *
 * What it does NOT catch: whether a block's *fields* are right beyond the ones
 * asserted here (a truncated body, a wrong timestamp), and it does not see a
 * role that exists only at runtime with no declaration in either file.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@veyyon/session";
import type { TranscriptBlock } from "@veyyon/wire/presentation";
import {
	blockIdFor,
	contentToText,
	defaultToolText,
	isDisplayed,
	toTranscriptBlock,
	toTranscriptBlocks,
} from "../../src/presentation/transcript-builder";

const MODEL_MESSAGE = new URL("../../../../contracts/model/src/message.ts", import.meta.url).pathname;
const CODING_AGENT_SRC = new URL("../../src/", import.meta.url).pathname;

/** Role literals of the core `Message` union, read from its own declaration. */
function coreRoles(): string[] {
	const source = readFileSync(MODEL_MESSAGE, "utf8");
	const union = /export type Message =([^;]+);/.exec(source);
	if (union === null) throw new Error(`no 'export type Message' union in ${MODEL_MESSAGE}`);
	const members = union[1]!
		.split("|")
		.map(part => part.trim())
		.filter(part => part.length > 0);
	return members.map(member => {
		const declaration = new RegExp(`interface ${member}(?:<[^>]*>)?\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
		if (declaration === null) throw new Error(`no interface ${member} in ${MODEL_MESSAGE}`);
		const role = /\brole:\s*"([^"]+)"/.exec(declaration[1]!);
		if (role === null) throw new Error(`interface ${member} declares no role literal`);
		return role[1]!;
	});
}

/** Custom roles this package registers by declaration merging, from every module that does. */
function customRoles(): string[] {
	const roles: string[] = [];
	const files = readdirSync(CODING_AGENT_SRC, { recursive: true, encoding: "utf8" })
		.filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts"))
		.sort();
	for (const file of files) {
		const source = readFileSync(path.join(CODING_AGENT_SRC, file), "utf8");
		if (!source.includes('declare module "@veyyon/session"')) continue;
		const block = /interface CustomAgentMessages\s*\{([\s\S]*?)\n\t\}/.exec(source);
		if (block === null) continue;
		for (const line of block[1]!.split("\n")) {
			const entry = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
			if (entry !== null) roles.push(entry[1]!);
		}
	}
	if (roles.length === 0) throw new Error(`no CustomAgentMessages block under ${CODING_AGENT_SRC}`);
	return roles;
}

/** The decision, one row per role. A role missing from here is an unrecorded decision. */
const EXPECTED_KIND: Record<string, TranscriptBlock["kind"]> = {
	user: "user-message",
	developer: "developer-message",
	assistant: "assistant-message",
	toolResult: "tool-execution",
	bashExecution: "bash-execution",
	pythonExecution: "python-execution",
	custom: "custom",
	hookMessage: "hook",
	branchSummary: "branch-summary",
	compactionSummary: "compaction-summary",
	fileMention: "file-mention",
};

/**
 * A minimally-populated message per role. Every fixture carries the fields the
 * builder reads, so a block that comes back empty is the builder's fault and
 * not the fixture's.
 */
function fixtureFor(role: string): AgentMessage {
	const timestamp = 1_700_000_000_000;
	switch (role) {
		case "user":
			return { role: "user", content: "hello", timestamp } as AgentMessage;
		case "developer":
			return { role: "developer", content: "system note", timestamp } as AgentMessage;
		case "assistant":
			return {
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				model: "test-model",
				stopReason: "stop",
				timestamp,
			} as AgentMessage;
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp,
			} as AgentMessage;
		case "bashExecution":
			return { role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0, timestamp } as AgentMessage;
		case "pythonExecution":
			return { role: "pythonExecution", code: "print(1)", output: "1", exitCode: 0, timestamp } as AgentMessage;
		case "custom":
			return { role: "custom", customType: "reminder", content: "remember", timestamp } as AgentMessage;
		case "hookMessage":
			return { role: "hookMessage", customType: "pre-commit", content: "ran", timestamp } as AgentMessage;
		case "branchSummary":
			return { role: "branchSummary", summary: "branched", timestamp } as AgentMessage;
		case "compactionSummary":
			return {
				role: "compactionSummary",
				summary: "compacted",
				shortSummary: "compacted",
				tokensBefore: 4096,
				timestamp,
			} as AgentMessage;
		case "fileMention":
			return {
				role: "fileMention",
				files: [{ path: "src/app.ts", content: "export {};", lineCount: 1 }],
				timestamp,
			} as AgentMessage;
		default:
			throw new Error(`no fixture for role '${role}'; add one when you add the role`);
	}
}

describe("every message role reaches a transcript block", () => {
	const roles = [...coreRoles(), ...customRoles()];

	test("the enumerated role set is exactly the recorded one", () => {
		// Exact equality, not a count and not a subset: a new role must land here.
		expect([...roles].sort()).toEqual(Object.keys(EXPECTED_KIND).sort());
	});

	test("no role falls through to the error block", () => {
		const unrenderable: string[] = [];
		for (const role of roles) {
			const block = toTranscriptBlock(fixtureFor(role), { index: 0 });
			if (block.kind === "error") unrenderable.push(role);
		}
		expect(unrenderable).toEqual([]);
	});

	test.each(roles)("role '%s' maps to its recorded block kind", role => {
		const block = toTranscriptBlock(fixtureFor(role), { index: 3 });
		expect(block.kind).toBe(EXPECTED_KIND[role]!);
	});

	test("a role the builder does not know renders as a recoverable error", () => {
		// The fall-through must stay reachable: a renderer that receives an unknown
		// role has to draw something the operator can read, not throw mid-frame.
		const block = toTranscriptBlock({ role: "notARole", timestamp: 1 } as unknown as AgentMessage, { index: 0 });
		expect(block.kind).toBe("error");
		if (block.kind !== "error") throw new Error("unreachable");
		expect(block.recoverable).toBe(true);
		expect(block.message).toContain("notARole");
	});
});

describe("block identity survives a rebuild", () => {
	const roles = [...coreRoles(), ...customRoles()];

	test("the same message at the same index yields the same id", () => {
		for (const [index, role] of roles.entries()) {
			const message = fixtureFor(role);
			expect(toTranscriptBlock(message, { index }).id).toBe(toTranscriptBlock(message, { index }).id);
		}
	});

	test("a tool result is keyed by its call id, not its position", () => {
		const message = fixtureFor("toolResult");
		// Position changes on every compaction; the call id does not, which is what
		// lets a streamed tool update land on the block it belongs to.
		expect(blockIdFor(message, 0)).toBe(blockIdFor(message, 41));
		expect(blockIdFor(message, 0)).toBe("tool:call-1");
	});

	test("two messages of the same role at different indices do not collide", () => {
		const message = fixtureFor("user");
		expect(blockIdFor(message, 0)).not.toBe(blockIdFor(message, 1));
	});

	test("rebuilding a persisted transcript reproduces the live ids", () => {
		const messages = roles.map(fixtureFor);
		const live = toTranscriptBlocks(messages).map(block => block.id);
		const rebuilt = toTranscriptBlocks([...messages]).map(block => block.id);
		expect(rebuilt).toEqual(live);
		expect(new Set(live).size).toBe(live.length);
	});
});

describe("hidden messages stay out of the transcript", () => {
	test("a steering user message is not displayed", () => {
		const steering = { role: "user", content: "stop", steering: true, timestamp: 1 } as unknown as AgentMessage;
		expect(isDisplayed(steering)).toBe(false);
		expect(toTranscriptBlocks([steering])).toEqual([]);
	});

	test("a custom message marked display:false is not displayed", () => {
		const hidden = {
			role: "custom",
			customType: "internal",
			content: "x",
			display: false,
			timestamp: 1,
		} as unknown as AgentMessage;
		expect(isDisplayed(hidden)).toBe(false);
		expect(toTranscriptBlocks([hidden])).toEqual([]);
	});

	test("an ordinary user message is displayed", () => {
		expect(isDisplayed(fixtureFor("user"))).toBe(true);
	});

	test("hiding a message does not shift the ids of the ones after it", () => {
		// Indices come from the message's position in the session's own array, so a
		// hidden message must not renumber its neighbours; otherwise every id after
		// a steering interjection changes and pending updates miss.
		const first = fixtureFor("user");
		const hidden = { role: "user", content: "stop", steering: true, timestamp: 1 } as unknown as AgentMessage;
		const last = { role: "developer", content: "after", timestamp: 2 } as AgentMessage;
		const withHidden = toTranscriptBlocks([first, hidden, last]);
		expect(withHidden.map(block => block.id)).toEqual([blockIdFor(first, 0), blockIdFor(last, 2)]);
	});
});

describe("prompt projections preserve text and synthetic provenance", () => {
	test.each(["user", "developer"] as const)("%s text chunks retain their original adjacency", role => {
		const message: Extract<AgentMessage, { role: "user" | "developer" }> = {
			role,
			content: [
				{ type: "text", text: "first" },
				{ type: "text", text: "" },
				{ type: "text", text: " second" },
			],
			timestamp: 1,
		};
		const block = toTranscriptBlock(message, { index: 0 });
		expect(block.kind).toBe(role === "user" ? "user-message" : "developer-message");
		if (block.kind !== "user-message" && block.kind !== "developer-message") throw new Error(block.kind);
		expect(block.text).toBe("first second");
		expect(block.synthetic).toBe(role === "developer");
	});

	test("a synthetic user prompt retains its provenance", () => {
		const block = toTranscriptBlock(
			{ role: "user", content: "generated prompt", synthetic: true, timestamp: 1 },
			{ index: 0 },
		);
		if (block.kind !== "user-message") throw new Error(block.kind);
		expect(block.synthetic).toBe(true);
		expect(block.text).toBe("generated prompt");
	});
});

describe("contentToText extracts wire-visible text across content structures", () => {
	test("preserves string content verbatim", () => {
		expect(contentToText("hello world")).toBe("hello world");
		expect(contentToText("")).toBe("");
	});

	test("returns empty string for empty block array and empty text blocks", () => {
		expect(contentToText([])).toBe("");
		expect(contentToText([{ type: "text", text: "" }])).toBe("");
	});

	test("skips leading empty text blocks without prepending newline to following text", () => {
		expect(
			contentToText([
				{ type: "text", text: "" },
				{ type: "text", text: "hello" },
			]),
		).toBe("hello");
	});

	test("preserves empty text blocks after the first nonempty block", () => {
		expect(
			contentToText([
				{ type: "text", text: "first" },
				{ type: "text", text: "" },
				{ type: "text", text: "last" },
			]),
		).toBe("first\n\nlast");
	});

	test("returns empty string for image-only content", () => {
		expect(contentToText([{ type: "image", mimeType: "image/png" }])).toBe("");
	});

	test("joins multipart text blocks with newline separator", () => {
		expect(
			contentToText([
				{ type: "text", text: "line 1" },
				{ type: "text", text: "line 2" },
			]),
		).toBe("line 1\nline 2");
	});

	test("skips image and non-text blocks in mixed multipart content", () => {
		expect(
			contentToText([
				{ type: "text", text: "before" },
				{ type: "image", mimeType: "image/jpeg" },
				null,
				{ type: "other", text: "ignored" },
				{ type: "text", text: "after" },
			]),
		).toBe("before\nafter");
	});

	test("returns empty string for non-string non-array inputs", () => {
		expect(contentToText(undefined)).toBe("");
		expect(contentToText(null)).toBe("");
		expect(contentToText(123)).toBe("");
		expect(contentToText({ text: "not in an array" })).toBe("");
	});
});

describe("defaultToolText formats tool arguments safely", () => {
	test("returns string arguments verbatim", () => {
		expect(defaultToolText("raw string args")).toBe("raw string args");
	});

	test("returns empty string for undefined", () => {
		expect(defaultToolText(undefined)).toBe("");
	});

	test("formats objects and arrays as 2-space indented JSON", () => {
		expect(defaultToolText({ key: "val" })).toBe('{\n  "key": "val"\n}');
		expect(defaultToolText([1, 2])).toBe("[\n  1,\n  2\n]");
	});

	test("formats primitives to JSON string", () => {
		expect(defaultToolText(null)).toBe("null");
		expect(defaultToolText(42)).toBe("42");
		expect(defaultToolText(true)).toBe("true");
	});

	test("returns [unserializable] for circular references without throwing", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(defaultToolText(circular)).toBe("[unserializable]");
	});

	test("returns [unserializable] for BigInt without throwing", () => {
		expect(defaultToolText({ num: BigInt(42) })).toBe("[unserializable]");
	});
});

describe("toTranscriptBlock projects content and tool text faithfully", () => {
	test("compaction preserves full context and reports pre-compaction tokens without inventing savings", () => {
		const block = toTranscriptBlock(
			{
				role: "compactionSummary",
				summary: "Full context.",
				shortSummary: "Index-only abbreviation.",
				tokensBefore: 8192,
				compactedBy: "provider/model",
				warning: "Repeated operation.",
				timestamp: 1,
			},
			{ index: 0 },
		);
		if (block.kind !== "compaction-summary") throw new Error(block.kind);
		expect(block.summary).toBe("Full context.");
		expect(block.tokensBefore).toBe(8192);
		expect(block.compactedBy).toBe("provider/model");
		expect(block.warning).toBe("Repeated operation.");
		expect(block).not.toHaveProperty("reclaimedTokens");
		expect(block).not.toHaveProperty("replacedCount");
	});

	test("user message extracts multipart text and images", () => {
		const message = {
			role: "user",
			content: [
				{ type: "text", text: "explain this:" },
				{ type: "image", mimeType: "image/png" },
				{ type: "text", text: "and this too" },
			],
			timestamp: 100,
		} as AgentMessage;
		const block = toTranscriptBlock(message, { index: 0 });
		if (block.kind !== "user-message") throw new Error("expected user-message block");
		expect(block.text).toBe("explain this:and this too");
		expect(block.attachments).toEqual([{ kind: "image", name: "image/png" }]);
	});

	test("toolResult message extracts multipart text for both success and failure", () => {
		const success = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [
				{ type: "text", text: "row 1" },
				{ type: "text", text: "row 2" },
			],
			isError: false,
			timestamp: 100,
		} as AgentMessage;
		const successBlock = toTranscriptBlock(success, { index: 0 });
		if (successBlock.kind !== "tool-execution") throw new Error("expected tool-execution");
		expect(successBlock.output).toBe("row 1\nrow 2");

		const failed = {
			role: "toolResult",
			toolCallId: "c2",
			toolName: "bash",
			content: [
				{ type: "text", text: "err 1" },
				{ type: "text", text: "err 2" },
			],
			isError: true,
			timestamp: 101,
		} as AgentMessage;
		const failedBlock = toTranscriptBlock(failed, { index: 1 });
		if (failedBlock.kind !== "tool-execution") throw new Error("expected tool-execution");
		expect(failedBlock.error).toBe("err 1\nerr 2");
	});

	test("assistant message formats tool-call input with defaultToolText fallback", () => {
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "src/main.ts" },
				},
			],
			model: "test-model",
			stopReason: "toolUse",
			timestamp: 100,
		} as unknown as AgentMessage;
		const block = toTranscriptBlock(message, { index: 0 });
		if (block.kind !== "assistant-message") throw new Error("expected assistant-message");
		expect(block.segments).toEqual([
			{
				kind: "tool-call",
				toolCallId: "call-1",
				toolName: "read",
				input: '{\n  "path": "src/main.ts"\n}',
			},
		]);
	});
});
