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

describe("restructured modules still behave", () => {
	it("agent: snapshotAssistantMessage preserves content and role", async () => {
		const { snapshotAssistantMessage } = await import("@veyyon/agent-core/agent-loop");
		const msg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "hello" }],
			usage: { cost: { input: 0, output: 0, read: 0, write: 0, reasoning: 0 } },
		};
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
});
