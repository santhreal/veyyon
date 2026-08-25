/**
 * WHY THIS SUITE EXISTS.
 *
 * Outbound wire-path canonicalization renders absolute paths under the session's
 * root as root-relative, and `ProviderContextCanonicalizer` memoizes that work per
 * source message so an append-mostly history is only rendered once. The provider
 * prompt cache depends on the same property from the other side: a request reuses
 * the cached prefix only while the bytes of the earlier messages are identical to
 * the bytes already sent.
 *
 * Two changes collided here. Roots used to accumulate, so a `cd` produced a
 * superset and re-rendering old messages happened to reproduce the same bytes.
 * That accumulation also made two distinct directories both render as `.`, which
 * is the defect fixed by relativizing against the active cwd only — and with a
 * single root, re-rendering an old message under a NEW cwd does not reproduce its
 * bytes. `transform` discarded its whole memo whenever the roots array changed, so
 * one `set_cwd` rewrote every earlier message and dropped the cached prefix.
 *
 * WHAT THIS SUITE DEFENDS.
 *
 * 1. A message already canonicalized keeps the exact bytes it was canonicalized
 *    with after the roots change — for every message role the relativizer rewrites.
 * 2. The memo prefix is reused rather than rebuilt: the earlier entries of the
 *    output are the same objects, which is what a re-render would break first.
 * 3. Messages appended after the change render against the NEW cwd.
 * 4. Only one directory is ever relative in a single rendering, so the defect the
 *    single-root change fixed stays fixed across a cwd change.
 *
 * WHAT THIS DOES NOT CATCH.
 *
 * Whether a provider actually honors the prefix — that is the provider's cache
 * behavior, observable only in billing. It also does not catch a caller that hands
 * the canonicalizer a fresh array of the SAME roots on every request; that costs a
 * relativizer rebuild but changes no bytes, so nothing here can see it.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@veyyon/ai";
import type { ToolCallIdMap } from "@veyyon/coding-agent/session/canonicalize-tool-call-ids";
import { ProviderContextCanonicalizer } from "@veyyon/coding-agent/session/provider-context-canonicalizer";
import { normalizeRoots } from "@veyyon/coding-agent/session/relativize-paths";

const OLD_CWD = "/media/data/projects/repo-main";
const NEW_CWD = "/media/data/projects/repo-worktree";

function createCanonicalizer(): ProviderContextCanonicalizer {
	const map: ToolCallIdMap = new Map();
	let counter = 0;
	return new ProviderContextCanonicalizer(map, () => {
		counter += 1;
		return `tc_${counter}`;
	});
}

const TIMESTAMP = 1_756_080_000;

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: TIMESTAMP };
}

function userBlocks(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: TIMESTAMP };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: TIMESTAMP,
	};
}

function toolResult(text: string, toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: TIMESTAMP,
	};
}

/** Every message role the relativizer rewrites, each carrying a path under OLD_CWD. */
const HISTORY_BY_ROLE: ReadonlyArray<{ role: string; message: Message }> = [
	{ role: "user (string content)", message: user(`read ${OLD_CWD}/src/main.ts please`) },
	{ role: "user (block content)", message: userBlocks(`also ${OLD_CWD}/src/other.ts`) },
	{ role: "assistant", message: assistant(`I opened ${OLD_CWD}/src/main.ts`) },
	{ role: "toolResult", message: toolResult(`wrote ${OLD_CWD}/src/main.ts`, "provider-call-1") },
];

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	const blocks = message.content as ReadonlyArray<{ type: string; text?: string }>;
	return blocks
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("a cwd change does not rewrite history already sent", () => {
	it("keeps the bytes of every already-rendered role after the roots change", () => {
		const canonicalizer = createCanonicalizer();
		const history = HISTORY_BY_ROLE.map(entry => entry.message);

		const before = canonicalizer.transform(history, normalizeRoots([OLD_CWD]));
		const renderedBefore = before.messages.map(textOf);
		// The optimization has to have done something, or the freeze below is vacuous.
		expect(renderedBefore[0]).toBe("read src/main.ts please");

		const after = canonicalizer.transform([...history, user("now what")], normalizeRoots([NEW_CWD]));
		for (let i = 0; i < HISTORY_BY_ROLE.length; i++) {
			expect(textOf(after.messages[i]!)).toBe(renderedBefore[i]!);
		}
	});

	it("reuses the memoized prefix instead of re-rendering it", () => {
		const canonicalizer = createCanonicalizer();
		const history = HISTORY_BY_ROLE.map(entry => entry.message);

		const before = canonicalizer.transform(history, normalizeRoots([OLD_CWD]));
		const after = canonicalizer.transform([...history, user("now what")], normalizeRoots([NEW_CWD]));

		for (let i = 0; i < HISTORY_BY_ROLE.length; i++) {
			expect(after.messages[i]).toBe(before.messages[i]);
		}
	});

	it("renders a message appended after the change against the new cwd", () => {
		const canonicalizer = createCanonicalizer();
		const history = [user(`read ${OLD_CWD}/src/main.ts`)];

		canonicalizer.transform(history, normalizeRoots([OLD_CWD]));
		const after = canonicalizer.transform(
			[...history, user(`now read ${NEW_CWD}/src/main.ts and ${OLD_CWD}/src/main.ts`)],
			normalizeRoots([NEW_CWD]),
		);

		// The new cwd is relative; the previous one is a different directory and stays
		// absolute, which is the whole point of a single root.
		expect(textOf(after.messages[1]!)).toBe(`now read src/main.ts and ${OLD_CWD}/src/main.ts`);
	});

	it("never renders two directories as the same string in one message", () => {
		const canonicalizer = createCanonicalizer();
		const listing = toolResult(`${OLD_CWD}\n${NEW_CWD}\n`, "provider-call-1");

		const rendered = textOf(canonicalizer.transform([listing], normalizeRoots([NEW_CWD])).messages[0]!);

		const lines = rendered.split("\n").filter(line => line.length > 0);
		expect(lines).toEqual([OLD_CWD, "."]);
		expect(new Set(lines).size).toBe(lines.length);
	});

	it("accumulates bytes saved across the roots change instead of restarting the count", () => {
		const canonicalizer = createCanonicalizer();
		const history = [user(`read ${OLD_CWD}/src/main.ts`)];

		const before = canonicalizer.transform(history, normalizeRoots([OLD_CWD]));
		const after = canonicalizer.transform(
			[...history, user(`read ${NEW_CWD}/src/other.ts`)],
			normalizeRoots([NEW_CWD]),
		);

		expect(before.bytesSaved).toBe(OLD_CWD.length + 1);
		expect(after.bytesSaved).toBe(before.bytesSaved + NEW_CWD.length + 1);
	});
});
