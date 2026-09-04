/**
 * WHY: the transcript builder is the only path from a session message to
 * something an operator sees, and its switch is on a role string. The defect
 * class this closes is a message role that reaches the builder and falls
 * through: a new custom role registered in `session/messages.ts`, or a new
 * member of the core `Message` union, renders as an "Unrenderable message role"
 * error block in production while every hand-written test stays green because
 * nobody added a case for it.
 *
 * So the role set is enumerated from source at run time — the `Message` union in
 * `@veyyon/ai` and the `CustomAgentMessages` declaration-merge block in
 * `session/messages.ts` — and the expected mapping is pinned by exact equality.
 * Adding a role turns this file RED until someone records what it renders as.
 *
 * What it does NOT catch: whether a block's *fields* are right beyond the ones
 * asserted here (a truncated body, a wrong timestamp), and it does not see a
 * role that exists only at runtime with no declaration in either file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AgentMessage } from "@veyyon/agent-core";
import type { TranscriptBlock } from "@veyyon/wire/presentation";
import {
	blockIdFor,
	isDisplayed,
	toTranscriptBlock,
	toTranscriptBlocks,
} from "../../src/presentation/transcript-builder";

const AI_TYPES = new URL("../../../ai/src/types.ts", import.meta.url).pathname;
const CODING_AGENT_MESSAGES = new URL("../../src/session/messages.ts", import.meta.url).pathname;

/** Role literals of the core `Message` union, read from its own declaration. */
function coreRoles(): string[] {
	const source = readFileSync(AI_TYPES, "utf8");
	const union = /export type Message =([^;]+);/.exec(source);
	if (union === null) throw new Error(`no 'export type Message' union in ${AI_TYPES}`);
	const members = union[1]!
		.split("|")
		.map(part => part.trim())
		.filter(part => part.length > 0);
	return members.map(member => {
		const declaration = new RegExp(`interface ${member}(?:<[^>]*>)?\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
		if (declaration === null) throw new Error(`no interface ${member} in ${AI_TYPES}`);
		const role = /\brole:\s*"([^"]+)"/.exec(declaration[1]!);
		if (role === null) throw new Error(`interface ${member} declares no role literal`);
		return role[1]!;
	});
}

/** Custom roles this package registers by declaration merging. */
function customRoles(): string[] {
	const source = readFileSync(CODING_AGENT_MESSAGES, "utf8");
	const block = /interface CustomAgentMessages\s*\{([\s\S]*?)\n\t\}/.exec(source);
	if (block === null) throw new Error(`no CustomAgentMessages block in ${CODING_AGENT_MESSAGES}`);
	const roles: string[] = [];
	for (const line of block[1]!.split("\n")) {
		const entry = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
		if (entry !== null) roles.push(entry[1]!);
	}
	if (roles.length === 0) throw new Error("CustomAgentMessages parsed to no roles");
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
