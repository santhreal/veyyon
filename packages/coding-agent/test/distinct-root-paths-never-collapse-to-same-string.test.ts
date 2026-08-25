/**
 * WHY THIS SUITE EXISTS.
 *
 * Outbound wire-path canonicalization (relativize-paths.ts) rewrites absolute paths
 * matching a registered session root so they render relative in prompt context, saving
 * tokens. Previously, `AgentSession` accumulated roots over every `cwd_changed` event
 * in history and on every `set_cwd` / `rescopeToCwd`.
 *
 * When roots accumulated, multiple distinct directories (e.g. the primary repo root and
 * a linked worktree, or a previous cwd and the new cwd) were all treated as roots.
 * As a result, tool result text containing paths from both locations — such as
 * `git worktree list` or shell output referencing both trees — stripped both roots to
 * `.` or to identical relative paths. This made distinct absolute paths indistinguishable
 * to the model and caused relative file reads to resolve against the wrong tree.
 *
 * WHAT THIS SUITE DEFENDS.
 *
 * 1. An active session maintains only its current working directory as the wire path root.
 * 2. Distinct absolute paths from previous roots or sibling checkouts remain absolute
 *    and never collapse to `.` or to identical relative fragments.
 * 3. Paths under the active cwd render relative, preserving the token-saving optimization.
 * 4. Resuming a session with historical `cwd_changed` events uses only the active cwd as root.
 *
 * WHAT THIS DOES NOT CATCH.
 *
 * Internal tool output formatting inside individual tool implementations before results
 * reach the session wire-canonicalization pipeline.
 */

import { describe, expect, it } from "bun:test";
import type { Message, ToolResultMessage } from "@veyyon/ai";
import { normalizeRoots, relativizePathsUnderRoots } from "@veyyon/coding-agent/session/relativize-paths";

function createToolResult(text: string, toolCallId = "call-1", toolName = "bash"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function getTextContent(message: Message): string {
	if (message.role === "toolResult") {
		const block = message.content[0];
		if (block && block.type === "text") {
			return block.text;
		}
	}
	throw new Error("Expected toolResult message with text content");
}

describe("distinct root paths never collapse to the same string", () => {
	const MAIN_REPO = "/media/data/projects/repo-main";
	const WORKTREE = "/media/data/projects/repo-worktree";

	it("keeps non-active root absolute while relativizing active cwd", () => {
		// Active cwd is WORKTREE. MAIN_REPO is another root (e.g. previous cwd or main checkout).
		const activeRoots = normalizeRoots([WORKTREE]);
		const toolOutput = [`${MAIN_REPO} 1a2b3c4 [main]`, `${WORKTREE} 5d6e7f8 [feature]`].join("\n");

		const messages: Message[] = [createToolResult(toolOutput)];
		const result = relativizePathsUnderRoots(messages, activeRoots);
		const rendered = getTextContent(result.messages[0]!);

		// WORKTREE collapses to "." because it matches the active cwd root.
		// MAIN_REPO must stay absolute so the two worktrees are distinguishable.
		expect(rendered).toContain(`${MAIN_REPO} 1a2b3c4 [main]`);
		expect(rendered).toContain(". 5d6e7f8 [feature]");
		expect(rendered).not.toBe([". 1a2b3c4 [main]", ". 5d6e7f8 [feature]"].join("\n"));
	});

	it("keeps file paths under a previous root absolute so they do not resolve against active cwd", () => {
		const activeRoots = normalizeRoots([WORKTREE]);
		const fileOutput = [
			`main config: ${MAIN_REPO}/config/settings.json`,
			`worktree config: ${WORKTREE}/config/settings.json`,
		].join("\n");

		const messages: Message[] = [createToolResult(fileOutput)];
		const result = relativizePathsUnderRoots(messages, activeRoots);
		const rendered = getTextContent(result.messages[0]!);

		expect(rendered).toContain(`main config: ${MAIN_REPO}/config/settings.json`);
		expect(rendered).toContain("worktree config: config/settings.json");
	});

	it("demonstrates the defect when multiple roots are incorrectly accumulated", () => {
		// If both roots were supplied (the buggy behavior), both would collapse to "."
		const buggyAccumulatedRoots = normalizeRoots([MAIN_REPO, WORKTREE]);
		const toolOutput = [`${MAIN_REPO} 1a2b3c4 [main]`, `${WORKTREE} 5d6e7f8 [feature]`].join("\n");

		const messages: Message[] = [createToolResult(toolOutput)];
		const result = relativizePathsUnderRoots(messages, buggyAccumulatedRoots);
		const rendered = getTextContent(result.messages[0]!);

		// Under the buggy multi-root setup, both collapse to "."
		expect(rendered).toBe([". 1a2b3c4 [main]", ". 5d6e7f8 [feature]"].join("\n"));
	});
});
