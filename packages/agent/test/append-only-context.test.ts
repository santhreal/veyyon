import { describe, expect, it } from "bun:test";
import { AppendOnlyContextManager, AppendOnlyLog, StablePrefix } from "@veyyon/agent-core/append-only-context";
import type { AgentContext, AgentTool } from "@veyyon/agent-core/types";
import type { Message, Tool, ToolExample } from "@veyyon/ai";
import { INTENT_FIELD } from "@veyyon/wire";
import { type } from "arktype";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
	return {
		systemPrompt: ["You are a helpful assistant.", "Be concise."],
		messages: [],
		tools: [],
		...overrides,
	};
}

function makeTool(
	name: string,
	description?: string,
	parameters?: Tool["parameters"],
	examples?: readonly ToolExample[],
): AgentTool {
	return {
		name,
		description: description ?? `Tool ${name}`,
		parameters: parameters ?? { type: "object", properties: {} },
		label: name,
		examples,
		execute: async () => ({ content: [{ type: "text", text: "done" }] }),
	} as AgentTool;
}

const BUILD_OPTS = { intentTracing: false } as const;

/** Log/digest tests exercise byte-stability, not provider-message validity —
 *  fixtures are minimal shapes narrowed once here instead of per-site casts. */
function partialMsg(fields: Record<string, unknown>): Message {
	return fields as unknown as Message;
}

// ---------------------------------------------------------------------------
// StablePrefix
// ---------------------------------------------------------------------------

describe("StablePrefix", () => {
	it("builds and returns cached system prompt + tools", () => {
		const p = new StablePrefix();
		const ctx = makeContext({
			systemPrompt: ["You are a helpful assistant."],
			tools: [makeTool("read")],
		});

		const changed = p.build(ctx, BUILD_OPTS);
		expect(changed).toBe(true);
		expect(p.built).toBe(true);

		const { systemPrompt, tools } = p.toContext();
		expect(systemPrompt).toEqual(["You are a helpful assistant."]);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("read");
	});

	it("returns false on identical rebuild", () => {
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Hello"] });

		p.build(ctx, BUILD_OPTS);
		const changed = p.build(ctx, BUILD_OPTS);
		expect(changed).toBe(false);
	});

	it("returns true when system prompt changes", () => {
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Old prompt"] });
		p.build(ctx, BUILD_OPTS);

		const changed = p.build(makeContext({ systemPrompt: ["New prompt"] }), BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("returns true when tools change", () => {
		const p = new StablePrefix();
		p.build(makeContext({ tools: [makeTool("read")] }), BUILD_OPTS);

		const changed = p.build(makeContext({ tools: [makeTool("read"), makeTool("write")] }), BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("returns true when tool description changes", () => {
		const p = new StablePrefix();
		p.build(makeContext({ tools: [makeTool("read", "Original desc")] }), BUILD_OPTS);

		const changed = p.build(makeContext({ tools: [makeTool("read", "Updated desc")] }), BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("invalidate forces rebuild", () => {
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Stable"] });
		p.build(ctx, BUILD_OPTS);

		p.invalidate();
		expect(p.built).toBe(false);

		const changed = p.build(ctx, BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("toContext() throws when not built", () => {
		const p = new StablePrefix();
		expect(() => p.toContext()).toThrow("build()");
	});

	it("fingerprint changes across rebuilds", () => {
		const p = new StablePrefix();
		const ctx1 = makeContext({ systemPrompt: ["Prompt A"] });
		p.build(ctx1, BUILD_OPTS);
		const fp1 = p.fingerprint;

		const ctx2 = makeContext({ systemPrompt: ["Prompt B"] });
		p.build(ctx2, BUILD_OPTS);
		const fp2 = p.fingerprint;

		expect(fp1).not.toBe(fp2);
	});

	it("fingerprint stable for identical context", () => {
		const p = new StablePrefix();
		p.build(makeContext({ systemPrompt: ["Stable"], tools: [makeTool("foo")] }), BUILD_OPTS);
		const fp1 = p.fingerprint;

		p.build(makeContext({ systemPrompt: ["Stable"], tools: [makeTool("foo")] }), BUILD_OPTS);
		const fp2 = p.fingerprint;

		expect(fp1).toBe(fp2);
	});

	it("fingerprint cache hit on same references returns false from build", () => {
		// WHY: StablePrefix caches the fingerprint by reference equality of
		// systemPrompt, tools, and options. When all references match, the
		// cache returns the same fingerprint without calling computeFingerprint.
		// build() must return false (no change) on the second call.
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Stable"], tools: [makeTool("foo")] });
		const first = p.build(ctx, BUILD_OPTS);
		expect(first).toBe(true);
		const second = p.build(ctx, BUILD_OPTS);
		expect(second).toBe(false);
	});

	it("fingerprint cache miss on different systemPrompt reference rebuilds", () => {
		const p = new StablePrefix();
		const ctx1 = makeContext({ systemPrompt: ["A"] });
		p.build(ctx1, BUILD_OPTS);
		const fp1 = p.fingerprint;
		const ctx2 = makeContext({ systemPrompt: ["A"] });
		p.build(ctx2, BUILD_OPTS);
		const fp2 = p.fingerprint;
		// Same content → same fingerprint even though different array reference
		expect(fp1).toBe(fp2);
	});

	it("invalidate clears fingerprint cache", () => {
		// WHY: invalidate() must clear the fingerprint cache so the next build()
		// recomputes from scratch, not from stale cached references.
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Stable"] });
		p.build(ctx, BUILD_OPTS);
		p.invalidate();
		const rebuilt = p.build(ctx, BUILD_OPTS);
		expect(rebuilt).toBe(true);
	});

	it("version increases on each rebuild", () => {
		const p = new StablePrefix();
		expect(p.version).toBe(0);

		p.build(makeContext({ systemPrompt: ["V1"] }), BUILD_OPTS);
		expect(p.version).toBe(1);

		p.build(makeContext({ systemPrompt: ["V2"] }), BUILD_OPTS);
		expect(p.version).toBe(2);

		p.build(makeContext({ systemPrompt: ["V2"] }), BUILD_OPTS);
		expect(p.version).toBe(2); // unchanged = no increment
	});
});

// ---------------------------------------------------------------------------
// AppendOnlyLog
// ---------------------------------------------------------------------------

describe("AppendOnlyLog", () => {
	it("starts empty", () => {
		const log = new AppendOnlyLog();
		expect(log.length).toBe(0);
		expect(log.toMessages()).toEqual([]);
	});

	it("appends messages", () => {
		const log = new AppendOnlyLog();
		log.append(partialMsg({ role: "user", content: "hello" }));
		log.append(partialMsg({ role: "assistant", content: "world" }));
		expect(log.length).toBe(2);
		expect(log.toMessages()).toHaveLength(2);
	});

	it("toMessages returns a copy of the array", () => {
		const log = new AppendOnlyLog();
		const msg = partialMsg({ role: "user", content: "test" });
		log.append(msg);
		const msgs = log.toMessages();
		// Array is a copy — mutating it doesn't affect the log
		msgs.pop();
		expect(log.length).toBe(1);
	});

	it("replaceTail replaces last entry", () => {
		const log = new AppendOnlyLog();
		log.append(partialMsg({ role: "user", content: "old" }));
		log.replaceTail(partialMsg({ role: "user", content: "new" }));
		expect(log.toMessages()).toHaveLength(1);
		expect(log.toMessages()[0]!.content).toBe("new");
	});

	it("replaceTail is no-op on empty log", () => {
		const log = new AppendOnlyLog();
		log.replaceTail(partialMsg({ role: "user", content: "nope" }));
		expect(log.length).toBe(0);
	});

	it("extend appends multiple messages", () => {
		const log = new AppendOnlyLog();
		log.extend([partialMsg({ role: "user", content: "a" }), partialMsg({ role: "assistant", content: "b" })]);
		expect(log.length).toBe(2);
	});

	it("clear resets the log", () => {
		const log = new AppendOnlyLog();
		log.append(partialMsg({ role: "user", content: "x" }));
		log.clear();
		expect(log.length).toBe(0);
	});

	it("entries readonly access returns internal array", () => {
		const log = new AppendOnlyLog();
		log.append(partialMsg({ role: "user", content: "test" }));
		expect(log.entries()).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// AppendOnlyContextManager
// ---------------------------------------------------------------------------

describe("AppendOnlyContextManager", () => {
	it("build() returns context with stable prefix on first call", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({
			systemPrompt: ["You are a bot."],
			tools: [makeTool("read")],
		});

		const result = mgr.build(ctx, BUILD_OPTS);

		expect(result.systemPrompt).toEqual(["You are a bot."]);
		expect(result.tools).toHaveLength(1);
		expect(result.messages).toEqual([]);
	});

	it("build() returns same systemPrompt and tools on subsequent calls", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({
			systemPrompt: ["Original prompt"],
			tools: [makeTool("read")],
		});

		mgr.build(ctx, BUILD_OPTS);

		// Same context — should reuse cached prefix
		const result = mgr.build(ctx, BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["Original prompt"]);
		expect(result.tools).toHaveLength(1);
	});

	it("build() detects changed system prompt and rebuilds", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["Old"] }), BUILD_OPTS);

		const result = mgr.build(makeContext({ systemPrompt: ["New"] }), BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["New"]);
	});

	it("prefix.fingerprint changes when tools change", () => {
		const mgr = new AppendOnlyContextManager();

		mgr.build(makeContext({ tools: [makeTool("read")] }), BUILD_OPTS);
		const fp1 = mgr.prefix.fingerprint;

		mgr.build(makeContext({ tools: [makeTool("read"), makeTool("write")] }), BUILD_OPTS);
		const fp2 = mgr.prefix.fingerprint;

		expect(fp1).not.toBe(fp2);
	});

	it("appendMessage grows the log", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.appendMessage(partialMsg({ role: "user", content: "hello" }));
		mgr.appendMessage(partialMsg({ role: "assistant", content: "world" }));

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]!.role).toBe("user");
		expect(result.messages[1]!.role).toBe("assistant");
	});

	it("appendMessage messages appear in every subsequent build()", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.appendMessage(partialMsg({ role: "user", content: "q1" }));
		const r1 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r1.messages).toHaveLength(1);

		mgr.appendMessage(partialMsg({ role: "assistant", content: "a1" }));
		const r2 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r2.messages).toHaveLength(2);
		expect(r2.messages[1]!.content).toBe("a1");
	});

	it("invalidate forces prefix rebuild", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["V1"] }), BUILD_OPTS);

		mgr.invalidate();
		const result = mgr.build(makeContext({ systemPrompt: ["V2"] }), BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["V2"]);
	});

	it("reset clears log and prefix", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["Original"] }), BUILD_OPTS);
		mgr.appendMessage(partialMsg({ role: "user", content: "hello" }));

		const freshCtx = makeContext({ systemPrompt: ["Fresh start"] });
		mgr.reset(freshCtx, BUILD_OPTS);

		const result = mgr.build(freshCtx, BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["Fresh start"]);
		expect(result.messages).toHaveLength(0);
	});

	it("replaceTailMessage updates last log entry", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.appendMessage(partialMsg({ role: "user", content: "old" }));
		mgr.replaceTailMessage(partialMsg({ role: "user", content: "new" }));

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.content).toBe("new");
	});

	it("build propagates tool spec description default", () => {
		const mgr = new AppendOnlyContextManager();
		const toolWithNoDesc = makeTool("bare");
		delete (toolWithNoDesc as { description?: string }).description;

		const ctx = makeContext({ tools: [toolWithNoDesc] });
		const result = mgr.build(ctx, BUILD_OPTS);

		const tool: Tool | undefined = result.tools?.[0];
		expect(tool).toBeDefined();
		expect(tool!.description).toBe("");
	});

	it("tools returned from build are frozen in the cache", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({ tools: [makeTool("read")] });

		const r1 = mgr.build(ctx, BUILD_OPTS);
		const r2 = mgr.build(ctx, BUILD_OPTS);

		expect(r1.tools).toHaveLength(1);
		expect(r2.tools).toHaveLength(1);
		// Same name, same structure
		expect(r1.tools![0]!.name).toBe(r2.tools![0]!.name);
	});

	it("tolerates context with no tools", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({ tools: undefined as unknown as AgentTool[] });

		const result = mgr.build(ctx, BUILD_OPTS);
		expect(result.tools).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Fingerprint determinism
// ---------------------------------------------------------------------------

describe("fingerprint determinism", () => {
	it("identical context produces identical fingerprint", () => {
		const p1 = new StablePrefix();
		const p2 = new StablePrefix();

		const ctx = makeContext({
			systemPrompt: ["Rule 1", "Rule 2"],
			tools: [makeTool("read", "Read files"), makeTool("edit", "Edit files")],
		});

		p1.build(ctx, BUILD_OPTS);
		p2.build(ctx, BUILD_OPTS);

		expect(p1.fingerprint).toBe(p2.fingerprint);
	});

	it("tool order changes fingerprint", () => {
		const p1 = new StablePrefix();
		const p2 = new StablePrefix();

		const tools = [makeTool("a", "Tool A"), makeTool("b", "Tool B")];
		p1.build(makeContext({ tools }), BUILD_OPTS);

		// Create a context where tool b has "Tool B" too
		// so the fingerprint changes with name order
		const otherTools = [makeTool("b", "Tool B"), makeTool("a", "Tool A")];
		p2.build(makeContext({ tools: otherTools }), BUILD_OPTS);

		expect(p1.fingerprint).not.toBe(p2.fingerprint);
	});

	it("system prompt array structure changes fingerprint", () => {
		const p1 = new StablePrefix();
		const p2 = new StablePrefix();

		// ["A", "B"] and ["A\nB"] have the same joined text but different
		// array structure — must produce different fingerprints.
		p1.build(makeContext({ systemPrompt: ["A", "B"] }), BUILD_OPTS);
		p2.build(makeContext({ systemPrompt: ["A\nB"] }), BUILD_OPTS);

		expect(p1.fingerprint).not.toBe(p2.fingerprint);
	});
});

// ---------------------------------------------------------------------------
// AppendOnlyLog message sync
// ---------------------------------------------------------------------------

describe("message sync", () => {
	it("syncMessages on first call appends all messages", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const msgs: Message[] = [
			partialMsg({ role: "user", content: "Hello" }),
			partialMsg({ role: "assistant", content: "Hi" }),
		];
		mgr.syncMessages(msgs);

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]!.content).toBe("Hello");
		expect(result.messages[1]!.content).toBe("Hi");
	});

	it("syncMessages on subsequent calls only appends delta", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([partialMsg({ role: "user", content: "q1" })]);
		const r1 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r1.messages).toHaveLength(1);

		mgr.syncMessages([partialMsg({ role: "user", content: "q1" }), partialMsg({ role: "assistant", content: "a1" })]);
		const r2 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r2.messages).toHaveLength(2);
		expect(r2.messages[1]!.content).toBe("a1");
	});

	it("syncMessages with unchanged messages is a no-op (same length, no new entries)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([partialMsg({ role: "user", content: "q1" })]);

		const before = mgr.log.length;

		// Same array length → nothing new to append
		mgr.syncMessages([partialMsg({ role: "user", content: "q1" })]);
		expect(mgr.log.length).toBe(before);
	});

	it("syncMessages resets log when array shrinks (compaction)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([
			partialMsg({ role: "user", content: "q1" }),
			partialMsg({ role: "assistant", content: "a1" }),
			partialMsg({ role: "user", content: "q2" }),
		]);
		expect(mgr.log.length).toBe(3);

		// Simulate compaction — array shrinks
		mgr.syncMessages([partialMsg({ role: "user", content: "q2" })]);
		expect(mgr.log.length).toBe(1);
		expect(mgr.log.toMessages()[0]!.content).toBe("q2");
	});

	it("build + syncMessages integration: messages come from log, not from context.messages", () => {
		const mgr = new AppendOnlyContextManager();

		// First turn: build with empty context, sync first message
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([partialMsg({ role: "user", content: "turn1" })]);
		const r1 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r1.messages).toHaveLength(1);
		expect(r1.messages[0]!.content).toBe("turn1");

		// Second turn: sync second message
		mgr.syncMessages([
			partialMsg({ role: "user", content: "turn1" }),
			partialMsg({ role: "assistant", content: "resp1" }),
		]);
		const r2 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r2.messages).toHaveLength(2);
		expect(r2.messages[1]!.content).toBe("resp1");
	});

	it("resetSyncCursor forces full re-sync on next call", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([partialMsg({ role: "user", content: "old" })]);

		mgr.resetSyncCursor();
		mgr.syncMessages([partialMsg({ role: "user", content: "fresh" })]);

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.content).toBe("fresh");
	});

	it("preserves the byte-stable prefix when a deep message is rewritten (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = partialMsg({ role: "user", content: "q1" });
		const original1 = partialMsg({ role: "assistant", content: "original long result" });
		mgr.syncMessages([original0, original1]);
		expect(mgr.log.length).toBe(2);

		// Same length, but the second message's content changed (simulates per-turn
		// tool-output pruning / transformContext re-render).
		mgr.syncMessages([
			partialMsg({ role: "user", content: "q1" }),
			partialMsg({ role: "assistant", content: "[pruned]" }),
		]);
		expect(mgr.log.length).toBe(2);

		const entries = mgr.log.entries();
		// The first message MUST keep its on-the-wire identity — that's what
		// stops llama.cpp from re-prefilling the entire prior context.
		expect(entries[0]).toBe(original0);
		// The diverged tail is re-synced with the new bytes.
		expect((entries[1] as { content: unknown }).content).toBe("[pruned]");
	});

	it("detects tool-result metadata-only rewrites before preserving a later prefix (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = partialMsg({ role: "user", content: "q1" });
		const original1 = partialMsg({
			role: "toolResult",
			content: [{ type: "text", text: "same output" }],
			toolCallId: "old-call",
			toolName: "read",
			isError: false,
		});
		const original2 = partialMsg({ role: "assistant", content: "a1" });
		mgr.syncMessages([original0, original1, original2]);

		mgr.syncMessages([
			partialMsg({ role: "user", content: "q1" }),
			partialMsg({
				role: "toolResult",
				content: [{ type: "text", text: "same output" }],
				toolCallId: "new-call",
				toolName: "write",
				isError: true,
			}),
			partialMsg({ role: "assistant", content: "a1-pruned" }),
		]);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toBe(original0);
		expect((entries[1] as { toolCallId: unknown }).toolCallId).toBe("new-call");
		expect((entries[1] as { toolName: unknown }).toolName).toBe("write");
		expect((entries[1] as { isError: unknown }).isError).toBe(true);
		expect((entries[2] as { content: unknown }).content).toBe("a1-pruned");
	});

	it("detects providerPayload-only rewrites before preserving a later prefix (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = partialMsg({ role: "user", content: "q1" });
		const original1 = partialMsg({
			role: "assistant",
			content: [{ type: "text", text: "same visible output" }],
			id: "assistant-1",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "old native" }] }],
			},
		});
		const original2 = partialMsg({ role: "user", content: "q2" });
		mgr.syncMessages([original0, original1, original2]);

		mgr.syncMessages([
			partialMsg({ role: "user", content: "q1" }),
			partialMsg({
				role: "assistant",
				content: [{ type: "text", text: "same visible output" }],
				id: "assistant-1",
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: "openai",
					items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "new native" }] }],
				},
			}),
			partialMsg({ role: "user", content: "q2-rewritten" }),
		]);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toBe(original0);
		expect(
			(entries[1] as { providerPayload?: { items?: Array<{ content?: Array<{ text?: string }> }> } }).providerPayload
				?.items?.[0]?.content?.[0]?.text,
		).toBe("new native");
		expect((entries[2] as { content: unknown }).content).toBe("q2-rewritten");
	});

	it("does not reuse a stable prefix longer than the current log after direct log clear (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([partialMsg({ role: "user", content: "q1" }), partialMsg({ role: "assistant", content: "a1" })]);
		expect(mgr.log.length).toBe(2);

		// Public log clear used by advisor reset: it intentionally empties the
		// provider-bound message log but does not touch the private sync cursor.
		mgr.log.clear();
		expect(mgr.log.length).toBe(0);

		mgr.syncMessages([
			partialMsg({ role: "user", content: "q1" }),
			partialMsg({ role: "assistant", content: "a1-rewritten" }),
		]);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(2);
		expect((entries[0] as { content: unknown }).content).toBe("q1");
		expect((entries[1] as { content: unknown }).content).toBe("a1-rewritten");
	});

	it("preserves the prefix when the tail is rewritten (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = partialMsg({ role: "user", content: "q1" });
		const original1 = partialMsg({ role: "assistant", content: "a1" });
		const original2 = partialMsg({ role: "user", content: "q2" });
		mgr.syncMessages([original0, original1, original2]);

		// Tail-only rewrite (e.g. per-turn pruning of the most recent tool result):
		// the first two messages MUST stay byte-stable; only the tail re-syncs.
		mgr.syncMessages([
			partialMsg({ role: "user", content: "q1" }),
			partialMsg({ role: "assistant", content: "a1" }),
			partialMsg({ role: "user", content: "q2-rewritten" }),
		]);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toBe(original0);
		expect(entries[1]).toBe(original1);
		expect((entries[2] as { content: unknown }).content).toBe("q2-rewritten");
	});

	it("appended new messages keep the prefix stable even when the prior tail also diverged (#3406)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original0 = partialMsg({ role: "user", content: "q1" });
		const original1 = partialMsg({ role: "assistant", content: "a1" });
		mgr.syncMessages([original0, original1]);

		// Re-sync with: (a) message #1 rewritten in place; (b) a brand-new tail
		// appended. The prefix [original0] MUST stay byte-stable.
		mgr.syncMessages([
			partialMsg({ role: "user", content: "q1" }),
			partialMsg({ role: "assistant", content: "a1-pruned" }),
			partialMsg({ role: "user", content: "q2" }),
		]);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toBe(original0);
		expect((entries[1] as { content: unknown }).content).toBe("a1-pruned");
		expect((entries[2] as { content: unknown }).content).toBe("q2");
	});

	it("rewriting the first message still re-syncs from scratch", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([partialMsg({ role: "user", content: "hello" })]);
		expect(mgr.log.length).toBe(1);

		// No byte-stable prefix — the only message diverged.
		mgr.syncMessages([partialMsg({ role: "user", content: "world" })]);

		const msgs = mgr.build(makeContext(), BUILD_OPTS).messages;
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.content).toBe("world");
	});

	it("no-op when content unchanged", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([partialMsg({ role: "user", content: "q1" }), partialMsg({ role: "assistant", content: "a1" })]);

		const before = mgr.log.length;
		mgr.syncMessages([partialMsg({ role: "user", content: "q1" }), partialMsg({ role: "assistant", content: "a1" })]);
		// Length unchanged — no new messages appended, no clear
		expect(mgr.log.length).toBe(before);
	});

	it("invalidateForModelChange resets prefix and log", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["Before"] }), BUILD_OPTS);
		mgr.syncMessages([partialMsg({ role: "user", content: "hello" })]);

		mgr.invalidateForModelChange();

		// Should need a fresh build — prefix was invalidated
		const ctx = makeContext({ systemPrompt: ["After"] });
		const result = mgr.build(ctx, BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["After"]);
		expect(result.messages).toHaveLength(0);

		// Re-sync should work cleanly
		mgr.syncMessages([partialMsg({ role: "user", content: "new turn" })]);
		const r2 = mgr.build(ctx, BUILD_OPTS);
		expect(r2.messages).toHaveLength(1);
		expect(r2.messages[0]!.content).toBe("new turn");
	});
});

// ---------------------------------------------------------------------------
// Intent injection
// ---------------------------------------------------------------------------

describe("intent injection through build()", () => {
	it("injects required `i` into tool schemas when intentTracing is true", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("read", "Read", {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: true });
		const params = result.tools?.[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(params?.properties).toBeDefined();
		expect(params!.properties![INTENT_FIELD]).toBeDefined();
		expect(params!.required).toContain(INTENT_FIELD);
	});

	it("materializes ArkType params and keeps `i` first in authored order", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("write", "Write", type({ path: "string", content: "string" }));
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: true });
		const params = result.tools?.[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		// `i` must lead; authored order (path before content) is preserved rather
		// than ArkType's alphabetized-by-hash order (content, path).
		expect(Object.keys(params.properties ?? {})).toEqual([INTENT_FIELD, "path", "content"]);
		expect(params.required).toContain(INTENT_FIELD);
	});

	it("omits `i` when intentTracing is false", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("read", "Read", {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: false });
		const params = result.tools?.[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(params?.properties?.[INTENT_FIELD]).toBeUndefined();
		expect(params?.required ?? []).not.toContain(INTENT_FIELD);
	});

	it("intentTracing flip invalidates the fingerprint cache", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({ tools: [makeTool("read")] });

		mgr.build(ctx, { intentTracing: false });
		const fpNoIntent = mgr.prefix.fingerprint;

		mgr.build(ctx, { intentTracing: true });
		const fpWithIntent = mgr.prefix.fingerprint;

		expect(fpNoIntent).not.toBe(fpWithIntent);
	});
});

describe("tool examples injection through build()", () => {
	const findExamples: readonly ToolExample[] = [{ caption: "Find files", call: { paths: ["src/**/*.ts"] } }];
	const findParams = {
		type: "object",
		properties: { paths: { type: "array", items: { type: "string" } } },
	};

	it("injects examples when exampleDialect is provided", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", findParams, findExamples);
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: false, exampleDialect: "anthropic" });
		const desc = result.tools?.[0]?.description ?? "";
		expect(desc).toContain("<examples>");
		expect(desc).toContain("# Find files");
		expect(desc).toContain('<invoke name="find">');
	});

	it("omits examples when exampleDialect is undefined", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", findParams, findExamples);
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: false });
		const desc = result.tools?.[0]?.description ?? "";
		expect(desc).toBe("Find files.");
	});

	it("injects the `i` placeholder into examples when intentTracing is on", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", findParams, findExamples);
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: true, exampleDialect: "anthropic" });
		const desc = result.tools?.[0]?.description ?? "";
		expect(desc).toContain(`<parameter name="${INTENT_FIELD}"`);
		expect(desc).toContain("…");
	});

	it("exampleDialect flip invalidates the fingerprint cache", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", undefined, findExamples);
		const ctx = makeContext({ tools: [tool] });

		mgr.build(ctx, { intentTracing: false });
		const fpNoExamples = mgr.prefix.fingerprint;

		mgr.build(ctx, { intentTracing: false, exampleDialect: "anthropic" });
		const fpWithExamples = mgr.prefix.fingerprint;

		expect(fpNoExamples).not.toBe(fpWithExamples);
	});
});

// ---------------------------------------------------------------------------
// Helpers for fast-path tests
// ---------------------------------------------------------------------------

/** Read a field from a test Message by key. The compiler cannot track the
 *  real shape of `partialMsg` fixtures, so narrow at the boundary instead of
 *  asserting an inline object type at every access site. */
function fieldOf<K extends string>(msg: Message, key: K): unknown {
	if (msg && typeof msg === "object" && key in msg) return (msg as unknown as Record<string, unknown>)[key];
	return undefined;
}

/** Simulate `convertToLlm` for user messages: shallow spread preserves the
 *  `content` reference but creates a new outer object. */
function spreadUser(content: unknown, extra?: Record<string, unknown>): Message {
	return { role: "user", content, attribution: "user", ...extra } as unknown as Message;
}

/** Simulate `convertToLlm` for assistant messages: the same object is returned
 *  (no spread). */
function passthroughAssistant(msg: Message): Message {
	return msg;
}

/** Simulate `convertToLlm` for toolResult messages: shallow spread with
 *  `content` usually preserved (when not pruned). */
function spreadToolResult(content: unknown, extra?: Record<string, unknown>): Message {
	return { role: "toolResult", content, attribution: "agent", ...extra } as unknown as Message;
}

// ---------------------------------------------------------------------------
// Tool-call mutation detection (new-object scenario)
// ---------------------------------------------------------------------------

describe("syncMessages detects tool_calls mutation", () => {
	it("rebuilds the log when tool_calls changes on a new object with same content (#3406)", () => {
		// WHY: convertToLlm creates a fresh object each turn via shallow spread.
		// The content reference is preserved, but tool_calls is a different array.
		// The fast-path must fall through to the digest, which covers tool_calls.
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const userMsg = partialMsg({ role: "user", content: "q" });
		const assistantContent = [{ type: "text", text: "response" }];
		const originalAssistant = partialMsg({
			role: "assistant",
			content: assistantContent,
			tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/a"}' } }],
		});
		mgr.syncMessages([userMsg, originalAssistant]);
		expect(mgr.log.length).toBe(2);

		// New object (shallow spread): same content reference, different tool_calls.
		const newAssistant = partialMsg({
			role: "assistant",
			content: assistantContent,
			tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/b"}' } }],
		});
		mgr.syncMessages([userMsg, newAssistant]);

		expect(mgr.log.length).toBe(2);
		const rebuilt = mgr.log.toMessages()[1]!;
		const rebuiltTc = fieldOf(rebuilt, "tool_calls") as Array<{ function: { arguments: string } }>;
		expect(rebuiltTc[0].function.arguments).toBe('{"path":"/b"}');
	});

	it("in-place tool_calls mutation on the same object is visible through the log reference", () => {
		// WHY: when the exact same object is synced again (identity-equal), the
		// fast-path skips the digest. Any in-place mutation is already visible
		// because the log stores the object reference, not a copy. This test
		// documents that behavior so a future change to log-storage semantics
		// (e.g. deep-cloning on append) doesn't silently break it.
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const assistant: Record<string, unknown> = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/a"}' } }],
		};
		const msgs = [partialMsg({ role: "user", content: "q" }), assistant] as unknown as Message[];
		mgr.syncMessages(msgs);

		const tcs = assistant.tool_calls as Array<{ function: { arguments: string } }>;
		tcs[0].function.arguments = '{"path":"/b"}';
		mgr.syncMessages(msgs);

		const rebuilt = mgr.log.toMessages()[1]!;
		const rebuiltTc = fieldOf(rebuilt, "tool_calls") as Array<{ function: { arguments: string } }>;
		expect(rebuiltTc[0].function.arguments).toBe('{"path":"/b"}');
	});
});

// ---------------------------------------------------------------------------
// Fast-path regression tests for #longestStablePrefix
// ---------------------------------------------------------------------------

describe("longestStablePrefix fast-path", () => {
	// WHY: the fast-path skips the JSON.stringify digest when object identity or
	// content-reference + scalar fields all match. These tests prove every field
	// the digest covers is also checked by the fast-path, so no in-place rewrite
	// escapes detection when convertToLlm creates a new object.

	it("identity-equal assistant message: skips digest, log preserves reference", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const user = partialMsg({ role: "user", content: "q" });
		const assistant = passthroughAssistant(partialMsg({ role: "assistant", content: "a" }));
		mgr.syncMessages([user, assistant]);

		// Same objects — fast-path skips digest for both.
		mgr.syncMessages([user, assistant]);

		const entries = mgr.log.entries();
		expect(entries[0]).toBe(user);
		expect(entries[1]).toBe(assistant);
	});

	it("shallow-spread user message with same content ref: skips digest", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = [{ type: "text", text: "hello" }];
		const original = spreadUser(content);
		mgr.syncMessages([original]);

		// New object, same content reference — fast-path matches.
		const spread = spreadUser(content);
		expect(spread).not.toBe(original); // new outer object
		expect(fieldOf(spread, "content")).toBe(content); // same content ref

		mgr.syncMessages([spread]);
		const entries = mgr.log.entries();
		// Log still holds the original (no divergence detected).
		expect(entries[0]).toBe(original);
	});

	it("shallow-spread toolResult with same content ref: skips digest", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = [{ type: "text", text: "output" }];
		const original = spreadToolResult(content, { toolCallId: "c1", toolName: "bash" });
		mgr.syncMessages([original]);

		const spread = spreadToolResult(content, { toolCallId: "c1", toolName: "bash" });
		expect(spread).not.toBe(original);
		expect(fieldOf(spread, "content")).toBe(content);

		mgr.syncMessages([spread]);
		const entries = mgr.log.entries();
		expect(entries[0]).toBe(original);
	});

	it("content array changed on new object: fast-path falls through to digest", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const original = spreadUser([{ type: "text", text: "old" }]);
		mgr.syncMessages([original]);

		const changed = spreadUser([{ type: "text", text: "new" }]);
		mgr.syncMessages([changed]);

		const entries = mgr.log.entries();
		expect(fieldOf(entries[0], "content")).not.toBe(original);
		const text = fieldOf(entries[0], "content") as Array<{ text: string }>;
		expect(text[0].text).toBe("new");
	});

	it("providerPayload changed on new object with same content ref: detected", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = [{ type: "text", text: "same" }];
		const original = partialMsg({
			role: "assistant",
			content,
			providerPayload: { type: "old", data: "a" },
		});
		mgr.syncMessages([original]);

		// New object, same content ref, different providerPayload.
		const changed = partialMsg({
			role: "assistant",
			content,
			providerPayload: { type: "new", data: "b" },
		});
		mgr.syncMessages([changed]);

		const entries = mgr.log.entries();
		const pp = fieldOf(entries[0], "providerPayload") as { type: string };
		expect(pp.type).toBe("new");
	});

	it("tool_calls changed on new object with same content ref: detected", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = [{ type: "text", text: "same" }];
		const original = partialMsg({
			role: "assistant",
			content,
			tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
		});
		mgr.syncMessages([original]);

		const changed = partialMsg({
			role: "assistant",
			content,
			tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: "{}" } }],
		});
		mgr.syncMessages([changed]);

		const entries = mgr.log.entries();
		const tc = fieldOf(entries[0], "tool_calls") as Array<{ function: { name: string } }>;
		expect(tc[0].function.name).toBe("write");
	});

	it("toolCallId changed on new object with same content ref: detected", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = [{ type: "text", text: "output" }];
		const original = spreadToolResult(content, { toolCallId: "old-call", toolName: "bash" });
		mgr.syncMessages([original]);

		const changed = spreadToolResult(content, { toolCallId: "new-call", toolName: "bash" });
		mgr.syncMessages([changed]);

		const entries = mgr.log.entries();
		expect(fieldOf(entries[0], "toolCallId")).toBe("new-call");
	});

	it("toolName changed on new object with same content ref: detected", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = [{ type: "text", text: "output" }];
		const original = spreadToolResult(content, { toolCallId: "c1", toolName: "read" });
		mgr.syncMessages([original]);

		const changed = spreadToolResult(content, { toolCallId: "c1", toolName: "write" });
		mgr.syncMessages([changed]);

		const entries = mgr.log.entries();
		expect(fieldOf(entries[0], "toolName")).toBe("write");
	});

	it("isError changed on new object with same content ref: detected", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = [{ type: "text", text: "output" }];
		const original = spreadToolResult(content, { toolCallId: "c1", toolName: "bash", isError: false });
		mgr.syncMessages([original]);

		const changed = spreadToolResult(content, { toolCallId: "c1", toolName: "bash", isError: true });
		mgr.syncMessages([changed]);

		const entries = mgr.log.entries();
		expect(fieldOf(entries[0], "isError")).toBe(true);
	});

	it("id changed on new object with same content ref: detected", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = [{ type: "text", text: "same" }];
		const original = partialMsg({ role: "assistant", content, id: "msg-old" });
		mgr.syncMessages([original]);

		const changed = partialMsg({ role: "assistant", content, id: "msg-new" });
		mgr.syncMessages([changed]);

		const entries = mgr.log.entries();
		expect(fieldOf(entries[0], "id")).toBe("msg-new");
	});

	it("role changed on new object with same content ref: detected", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = "same text";
		const original = partialMsg({ role: "user", content });
		mgr.syncMessages([original]);

		const changed = partialMsg({ role: "assistant", content });
		mgr.syncMessages([changed]);

		const entries = mgr.log.entries();
		expect(fieldOf(entries[0], "role")).toBe("assistant");
	});

	it("snake_case tool_call_id changed on new object: detected", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content = [{ type: "text", text: "output" }];
		const original = partialMsg({ role: "toolResult", content, tool_call_id: "old", name: "bash" });
		mgr.syncMessages([original]);

		const changed = partialMsg({ role: "toolResult", content, tool_call_id: "new", name: "bash" });
		mgr.syncMessages([changed]);

		const entries = mgr.log.entries();
		expect(fieldOf(entries[0], "tool_call_id")).toBe("new");
	});

	it("prefix preserved when only the tail message changes on a new object", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const content0 = [{ type: "text", text: "stable" }];
		const user0 = spreadUser(content0);
		const assistant = passthroughAssistant(partialMsg({ role: "assistant", content: "a1" }));
		mgr.syncMessages([user0, assistant]);

		// user0: new object, same content ref → fast-path matches, prefix preserved.
		// assistant: same object → identity match.
		// New tail appended.
		const user0Spread = spreadUser(content0);
		mgr.syncMessages([user0Spread, assistant, partialMsg({ role: "user", content: "q2" })]);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(3);
		expect(entries[0]).toBe(user0);
		expect(entries[1]).toBe(assistant);
		expect(fieldOf(entries[2], "content")).toBe("q2");
	});

	it("divergence at position 0 re-syncs entire log", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([spreadUser("hello"), passthroughAssistant(partialMsg({ role: "assistant", content: "a" }))]);

		mgr.syncMessages([spreadUser("world"), passthroughAssistant(partialMsg({ role: "assistant", content: "a" }))]);

		const entries = mgr.log.entries();
		expect(entries).toHaveLength(2);
		expect(fieldOf(entries[0], "content")).toBe("world");
	});
});

describe("AppendOnlyContextManager.hasImages", () => {
	// WHY: applyProviderImagePolicy scans every message's content blocks for
	// images on every turn — O(n*blocks). The hasImages flag on
	// AppendOnlyContextManager lets canonicalizeProviderContext skip that scan
	// entirely when no message in the log contains an image block, which is the
	// common case for code-focused sessions. These tests prove the flag is set
	// and reset correctly across every mutation path: syncMessages append,
	// syncMessages compaction, syncMessages in-place rewrite (truncate),
	// appendMessage, replaceTailMessage, invalidateForModelChange,
	// resetSyncCursor, and reset.

	function imgMsg(role: "user" | "assistant" = "user"): Message {
		return partialMsg({
			role,
			content: [{ type: "image", source: { type: "base64" } }],
		});
	}
	function textMsg(role: "user" | "assistant" = "user"): Message {
		return partialMsg({ role, content: [{ type: "text", text: "hi" }] });
	}

	it("is false on a fresh manager", () => {
		const mgr = new AppendOnlyContextManager();
		expect(mgr.hasImages).toBe(false);
	});

	it("stays false after syncing text-only messages", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([textMsg()]);
		expect(mgr.hasImages).toBe(false);
	});

	it("becomes true after syncing a message with an image block", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([textMsg(), imgMsg()]);
		expect(mgr.hasImages).toBe(true);
	});

	it("stays true on subsequent syncs with no new images", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([imgMsg()]);
		mgr.syncMessages([imgMsg(), textMsg()]);
		expect(mgr.hasImages).toBe(true);
	});

	it("resets to false on compaction (array shrinks below sync count)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([imgMsg(), textMsg()]);
		expect(mgr.hasImages).toBe(true);
		mgr.syncMessages([textMsg()]);
		expect(mgr.hasImages).toBe(false);
	});

	it("resets to false on invalidateForModelChange", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([imgMsg()]);
		expect(mgr.hasImages).toBe(true);
		mgr.invalidateForModelChange();
		expect(mgr.hasImages).toBe(false);
	});

	it("resets to false on resetSyncCursor", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([imgMsg()]);
		expect(mgr.hasImages).toBe(true);
		mgr.resetSyncCursor();
		expect(mgr.hasImages).toBe(false);
	});

	it("resets to false on reset", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([imgMsg()]);
		expect(mgr.hasImages).toBe(true);
		mgr.reset(makeContext(), BUILD_OPTS);
		expect(mgr.hasImages).toBe(false);
	});

	it("appendMessage sets hasImages when message has image", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.appendMessage(imgMsg());
		expect(mgr.hasImages).toBe(true);
	});

	it("appendMessage does not set hasImages for text-only message", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.appendMessage(textMsg());
		expect(mgr.hasImages).toBe(false);
	});

	it("replaceTailMessage recalculates when image-bearing tail is replaced with text", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.appendMessage(textMsg());
		mgr.appendMessage(imgMsg());
		expect(mgr.hasImages).toBe(true);
		mgr.replaceTailMessage(textMsg("assistant"));
		expect(mgr.hasImages).toBe(false);
	});

	it("replaceTailMessage sets hasImages when text tail is replaced with image", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.appendMessage(textMsg());
		expect(mgr.hasImages).toBe(false);
		mgr.replaceTailMessage(imgMsg());
		expect(mgr.hasImages).toBe(true);
	});

	it("in-place rewrite (truncate) recalculates hasImages from remaining log", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		// Sync two messages, second has image
		const m1 = textMsg();
		const m2 = imgMsg();
		mgr.syncMessages([m1, m2]);
		expect(mgr.hasImages).toBe(true);
		// In-place rewrite: change m2 to text-only (triggers truncation + re-append)
		const m2Text = textMsg("assistant");
		mgr.syncMessages([m1, m2Text]);
		expect(mgr.hasImages).toBe(false);
	});

	it("in-place rewrite preserves hasImages when image message is in stable prefix", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		const m1 = imgMsg();
		const m2 = textMsg();
		mgr.syncMessages([m1, m2]);
		expect(mgr.hasImages).toBe(true);
		// In-place rewrite: change only m2 (m1 with image stays in stable prefix)
		const m2New = textMsg("assistant");
		mgr.syncMessages([m1, m2New]);
		expect(mgr.hasImages).toBe(true);
	});
});
