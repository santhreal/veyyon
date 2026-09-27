/**
 * WHY: session construction and every MCP refresh read the persisted MCP tool selection through
 * `SessionManager.getMCPToolSelection()`, which scans the branch for one entry instead of rebuilding
 * the branch's messages. `buildSessionContext()` is the single definition of which selection a branch
 * holds, so the defect class this closes is a scan that answers a different branch than the context
 * does: the oldest selection instead of the newest, a selection from an abandoned branch, a selection
 * read at the "before the first entry" position, and an explicit empty selection read as no
 * selection, which re-applies the configured MCP defaults the session had turned off.
 *
 * Every entry of a two-branch tree is made the leaf in turn, and the null leaf after it, and the
 * scan is compared against the built context at each one.
 *
 * What it does not catch: a leaf id that names no entry. No public `SessionManager` call produces
 * one; both reads resolve it through `resolveContextLeaf`.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, UserMessage } from "@veyyon/ai";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

let clock = 0;

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: ++clock };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: ++clock,
	};
}

/** The selection the built context reports, in the accessor's shape. */
function contextSelection(session: SessionManager): readonly string[] | undefined {
	const context = session.buildSessionContext();
	return context.hasPersistedMCPToolSelection ? context.selectedMCPToolNames : undefined;
}

/**
 * root ─ selection [a] ─ fork ─┬─ selection [b, c] ─ reply ─ selection [] ─ reply
 *                              └─ reply (no selection of its own)
 */
function twoBranchSession(): SessionManager {
	const session = SessionManager.inMemory("/repo");
	session.appendMessage(user("start"));
	session.appendMCPToolSelection(["mcp_a"]);
	const fork = session.appendMessage(assistant("fork"));
	session.appendMCPToolSelection(["mcp_b", "mcp_c"]);
	session.appendMessage(user("on the first branch"));
	session.appendMCPToolSelection([]);
	session.appendMessage(assistant("after clearing"));
	session.branch(fork);
	session.appendMessage(user("on the second branch"));
	return session;
}

describe("SessionManager.getMCPToolSelection", () => {
	it("reports the selection the built context reports at every leaf of a branched session", () => {
		const session = twoBranchSession();
		const answers = new Map<string, readonly string[] | undefined>();
		for (const entry of session.getEntries()) {
			session.branch(entry.id);
			expect(session.getMCPToolSelection()).toEqual(contextSelection(session));
			answers.set(entry.id, session.getMCPToolSelection());
		}
		session.resetLeaf();
		expect(session.getMCPToolSelection()).toEqual(contextSelection(session));
		expect(session.getMCPToolSelection()).toBeUndefined();

		// The sweep reaches every distinct answer: none yet, the first selection, the newer one on
		// the first branch, its explicit clear, and the fork's selection carried onto the second branch.
		const entries = session.getEntries();
		expect(entries.map(entry => answers.get(entry.id))).toEqual([
			undefined,
			["mcp_a"],
			["mcp_a"],
			["mcp_b", "mcp_c"],
			["mcp_b", "mcp_c"],
			[],
			[],
			["mcp_a"],
		]);
	});
});
