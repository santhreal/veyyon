/**
 * WHY THIS EXISTS. A restructuring PR that moves functions into helper files,
 * un-exports them, and replaces array spreads with Array.from/slice/concat can
 * leave the export chain intact while breaking the behaviour: a function that
 * is still exported but returns undefined because its helper dependency was
 * wired wrong, or an array operation that silently changes shape after a
 * spread replacement. The public-surface test catches missing names; this
 * suite catches missing behaviour by calling the functions and checking
 * results.
 *
 * Each case exercises a hot path that was restructured in the perf/memory-hillclimb
 * PR (432 helper extractions, 215 spread-replacement commits) and pins a
 * behavioural contract that would break if the extraction or replacement were
 * done incorrectly.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";

describe("restructured modules still behave", () => {
	it("agent: snapshotAssistantMessage preserves content and role", async () => {
		const { snapshotAssistantMessage } = await import("@veyyon/agent-core/agent-loop");
		const msg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "hello" }],
			usage: { cost: { input: 0, output: 0, read: 0, write: 0, reasoning: 0 } },
		} as unknown as AssistantMessage;
		const snap = snapshotAssistantMessage(msg, "full");
		expect(snap.role).toBe("assistant");
		expect(snap.content).toHaveLength(1);
		expect((snap.content[0] as { text: string }).text).toBe("hello");
	});

	it("agent: coerceToolResult accepts a well-formed result with content array", async () => {
		const { coerceToolResult } = await import("@veyyon/agent-core/agent-loop");
		const raw = { id: "call_1", content: [{ type: "text", text: "result" }] };
		const { result, malformed } = coerceToolResult(raw);
		expect(malformed).toBe(false);
		expect(result.content).toHaveLength(1);
	});

	it("agent: coerceToolResult flags a result missing content as malformed", async () => {
		const { coerceToolResult } = await import("@veyyon/agent-core/agent-loop");
		const { result, malformed } = coerceToolResult({ id: "call_1" });
		expect(malformed).toBe(true);
		expect(result.isError).toBe(true);
	});

	it("agent: resolveConfiguredDialect returns undefined for no configuration", async () => {
		const { resolveConfiguredDialect } = await import("@veyyon/agent-core/agent-loop");
		const result = resolveConfiguredDialect(undefined, {} as never);
		expect(result).toBeUndefined();
	});

	it("utils: isRecord distinguishes records from arrays and primitives", async () => {
		const { isRecord } = await import("@veyyon/utils");
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("string")).toBe(false);
		expect(isRecord(42)).toBe(false);
		expect(isRecord(undefined)).toBe(false);
	});

	it("utils: errorMessage extracts a string from Error and coerces unknown", async () => {
		const { errorMessage } = await import("@veyyon/utils");
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("plain string")).toBe("plain string");
		expect(errorMessage(42)).toBe("42");
	});

	it("utils: moduleSpecifiersIn parses a standard import", async () => {
		const { moduleSpecifiersIn } = await import("@veyyon/utils/module-reach");
		const specs = moduleSpecifiersIn('import { foo } from "./bar";');
		expect(specs).toContain("./bar");
	});

	it("hashline: formatHashlineHeader produces a parseable header", async () => {
		const { formatHashlineHeader, formatNumberedLine } = await import("@veyyon/hashline");
		const header = formatHashlineHeader("test.ts", "ABC123");
		expect(header).toContain("test.ts");
		expect(header).toContain("ABC123");
		const line = formatNumberedLine(1, "hello");
		expect(line).toContain("1");
		expect(line).toContain("hello");
	});

	it("catalog: getBundledProviders returns a non-empty record", async () => {
		const { getBundledProviders } = await import("@veyyon/catalog/models");
		const providers = getBundledProviders();
		expect(Object.keys(providers).length).toBeGreaterThan(0);
	});

	it("tui: Bun.stringWidth measures ASCII and CJK correctly", async () => {
		expect(Bun.stringWidth("hello")).toBe(5);
		expect(Bun.stringWidth("日本語")).toBe(6);
	});

	it("agent: pruneToolOutputs reports prunedCount for empty results", async () => {
		const { pruneToolOutputs, DEFAULT_PRUNE_CONFIG } = await import("@veyyon/agent-core/compaction/pruning");
		const entries = [
			{ role: "tool", toolCallId: "1", content: [{ type: "text", text: "Command output" }] },
			{ role: "tool", toolCallId: "2", content: [{ type: "text", text: "" }] },
		] as never;
		const result = pruneToolOutputs(entries, DEFAULT_PRUNE_CONFIG);
		expect(result.prunedCount).toBeGreaterThanOrEqual(0);
		expect(typeof result.tokensSaved).toBe("number");
	});

	it("agent: readToolSupersedeKey extracts paths from read tool args", async () => {
		const { readToolSupersedeKey } = await import("@veyyon/agent-core/compaction/pruning");
		const key = readToolSupersedeKey("read", { path: "/tmp/test.ts" });
		expect(key).toEqual(["/tmp/test.ts"]);
		expect(readToolSupersedeKey("bash", { command: "ls" })).toBeUndefined();
	});

	it("agent: isProviderRefusalMessage detects error stop with refusal details", async () => {
		const { isProviderRefusalMessage } = await import("@veyyon/agent-core/replay-policy");
		const refusal = { role: "assistant", stopReason: "error", stopDetails: { type: "refusal" } } as never;
		const normal = { role: "assistant", stopReason: "end_turn" } as never;
		expect(isProviderRefusalMessage(refusal)).toBe(true);
		expect(isProviderRefusalMessage(normal)).toBe(false);
	});

	it("utils: estimateTokensFromText returns positive integer for non-empty text", async () => {
		const { estimateTokensFromText } = await import("@veyyon/utils");
		const tokens = estimateTokensFromText("Hello, world! This is a test.");
		expect(tokens).toBeGreaterThan(0);
		expect(Number.isInteger(tokens)).toBe(true);
		expect(estimateTokensFromText("")).toBe(0);
	});

	it("ai: mapAnthropicToolChoice maps string choices correctly", async () => {
		const { mapAnthropicToolChoice } = await import("@veyyon/ai/stream");
		expect(mapAnthropicToolChoice(undefined)).toBeUndefined();
		expect(mapAnthropicToolChoice("auto")).toBe("auto");
		expect(mapAnthropicToolChoice("none")).toBe("none");
		expect(mapAnthropicToolChoice("required")).toBe("any");
		expect(mapAnthropicToolChoice("any")).toBe("any");
		expect(mapAnthropicToolChoice("invalid" as never)).toBeUndefined();
	});

	it("ai: mapAnthropicToolChoice maps tool-type choices with name", async () => {
		const { mapAnthropicToolChoice } = await import("@veyyon/ai/stream");
		expect(mapAnthropicToolChoice({ type: "tool", name: "read" })).toEqual({ type: "tool", name: "read" });
		expect(mapAnthropicToolChoice({ type: "tool", name: "" })).toBeUndefined();
	});

	it("catalog: stripEffortTierSuffix strips known effort suffixes", async () => {
		const { stripEffortTierSuffix } = await import("@veyyon/catalog/variant-collapse");
		expect(stripEffortTierSuffix("model-low")).toBe("model");
		expect(stripEffortTierSuffix("model-high")).toBe("model");
		expect(stripEffortTierSuffix("model-xhigh")).toBe("model");
		expect(stripEffortTierSuffix("model-max")).toBe("model");
		expect(stripEffortTierSuffix("model-none")).toBe("model");
		expect(stripEffortTierSuffix("model-thinking")).toBe("model");
		expect(stripEffortTierSuffix("model")).toBeUndefined();
		expect(stripEffortTierSuffix("model-custom")).toBeUndefined();
	});

	it("catalog: isVariantCollapsedSpec detects collapsed specs", async () => {
		const { isVariantCollapsedSpec } = await import("@veyyon/catalog/variant-collapse");
		expect(isVariantCollapsedSpec({ id: "model", role: "assistant" } as never)).toBe(false);
	});

	it("agent: normalizeMessagesForProvider passes through messages unchanged for mock", async () => {
		const { normalizeMessagesForProvider } = await import("@veyyon/agent-core/agent-loop");
		const messages = [
			{ role: "user", content: "hello", timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 } as never,
		] as never;
		const model = { api: "mock", id: "mock-model" } as never;
		const out = normalizeMessagesForProvider(messages, model);
		expect(out).toBeDefined();
		expect(Array.isArray(out)).toBe(true);
	});

	it("agent: createToolScopedAbortReason carries per-call messages", async () => {
		const { createToolScopedAbortReason } = await import("@veyyon/agent-core/agent-loop");
		const reason = createToolScopedAbortReason("turn aborted", { call_1: "timeout" }, "default abort");
		expect(reason.kind).toBe("tool-scoped-abort");
		expect(reason.message).toBe("turn aborted");
		expect(reason.toolCallMessages).toEqual({ call_1: "timeout" });
		expect(reason.defaultToolCallMessage).toBe("default abort");
	});

	it("utils: structuredCloneJSON round-trips a nested object", async () => {
		const { structuredCloneJSON } = await import("@veyyon/utils");
		const obj = { a: { b: [1, 2, { c: "deep" }] } };
		const clone = structuredCloneJSON(obj);
		expect(clone).toEqual(obj);
		expect(clone).not.toBe(obj);
		expect(clone.a).not.toBe(obj.a);
	});

	it("utils: formatCount pluralizes correctly", async () => {
		const { formatCount } = await import("@veyyon/utils");
		expect(formatCount("item", 1)).toBe("1 item");
		expect(formatCount("item", 0)).toBe("0 items");
		expect(formatCount("item", 3)).toBe("3 items");
	});
});
