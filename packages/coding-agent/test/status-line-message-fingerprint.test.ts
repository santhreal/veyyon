/**
 * Message fingerprinting for the status line's context-usage memo.
 *
 * Why this suite exists: the status line redraws on every agent event, and
 * `messageFingerprint` runs on the LAST message each redraw to detect
 * in-place growth of the streaming tail. The toolCall branch used to
 * `JSON.stringify` the full arguments object per redraw — a streaming Write
 * with a 100KB body re-serialized 100KB on every render tick (Law 7). It now
 * uses an allocation-free structural size sum. These tests lock the property
 * that matters: every in-place mutation the memo must catch still changes the
 * fingerprint, and an unchanged message yields a byte-identical fingerprint
 * (otherwise the memo would either go stale or thrash).
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { messageFingerprint } from "@veyyon/coding-agent/modes/components/status-line/component";

function assistantWithToolCall(args: unknown): AgentMessage {
	return {
		role: "assistant",
		timestamp: 1000,
		content: [{ type: "toolCall", id: "t1", name: "write", arguments: args }],
		usage: { totalTokens: 0 },
	} as unknown as AgentMessage;
}

describe("messageFingerprint toolCall arguments", () => {
	/** The core memo contract: identical content → identical fingerprint. A
	 * nondeterministic fingerprint would recompute context usage every frame. */
	it("is stable for an unchanged toolCall message", () => {
		const msg = assistantWithToolCall({ file_path: "/a/b.ts", content: "hello world" });
		expect(messageFingerprint(msg)).toBe(messageFingerprint(msg));
		expect(messageFingerprint(msg)).toBe(
			messageFingerprint(assistantWithToolCall({ file_path: "/a/b.ts", content: "hello world" })),
		);
	});

	/** The streaming-tail case the fingerprint exists for: a tool call whose
	 * argument string grows in place between redraws MUST change the
	 * fingerprint, or the context gauge freezes mid-stream. */
	it("changes when a nested argument string grows in place", () => {
		const args = { file_path: "/a/b.ts", content: "hello" };
		const msg = assistantWithToolCall(args);
		const before = messageFingerprint(msg);
		args.content = "hello world, now longer";
		expect(messageFingerprint(msg)).not.toBe(before);
	});

	/** Deeply nested growth (arrays of objects, as MultiEdit-style args are)
	 * must be seen too — the size walk is recursive, not top-level-only. */
	it("changes when a deeply nested string grows", () => {
		const args = { edits: [{ old_string: "a", new_string: "b" }] };
		const msg = assistantWithToolCall(args);
		const before = messageFingerprint(msg);
		args.edits[0]!.new_string = "b".repeat(50);
		expect(messageFingerprint(msg)).not.toBe(before);
	});

	/** Adding a key or an array element is an in-place mutation the memo must
	 * catch even when no existing string changed length. */
	it("changes when keys or array elements are added", () => {
		const args: Record<string, unknown> = { files: ["a.ts"] };
		const msg = assistantWithToolCall(args);
		const before = messageFingerprint(msg);
		(args.files as string[]).push("b.ts");
		const afterPush = messageFingerprint(msg);
		expect(afterPush).not.toBe(before);
		args.status = "normal";
		expect(messageFingerprint(msg)).not.toBe(afterPush);
	});

	/** BigInt arguments crashed the old JSON.stringify path without its
	 * replacer; the structural walk must handle them without throwing. */
	it("handles bigint arguments without throwing", () => {
		const msg = assistantWithToolCall({ offset: 9007199254740993n });
		expect(() => messageFingerprint(msg)).not.toThrow();
		expect(messageFingerprint(msg)).toBe(messageFingerprint(msg));
	});

	/** Streaming partial args arrive as a raw string before JSON parse
	 * completes; its growth is the earliest in-flight signal. */
	it("changes as a string-typed (partial JSON) argument grows", () => {
		const msg = assistantWithToolCall('{"file_path": "/a');
		const before = messageFingerprint(msg);
		const grown = assistantWithToolCall('{"file_path": "/a/b.ts", "content": "x"}');
		expect(messageFingerprint(grown)).not.toBe(before);
	});

	/** null/boolean/number leaves are legal JSON argument values; they carry
	 * fixed weight and must not throw or be skipped silently. */
	it("fingerprints primitive argument leaves deterministically", () => {
		const a = messageFingerprint(assistantWithToolCall({ recursive: true, depth: 3, filter: null }));
		const b = messageFingerprint(assistantWithToolCall({ recursive: true, depth: 3, filter: null }));
		expect(a).toBe(b);
	});
});
