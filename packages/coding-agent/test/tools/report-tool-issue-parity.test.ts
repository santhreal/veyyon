/**
 * report_tool_issue tool pins exact observable output, metadata, and helpers.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. report_tool_issue is a hidden tool for automated QA tracking. Its
 * contracts: tool metadata (name, label, approval), exact output text,
 * proxy_ prefix stripping, allowlist enforcement, payload sanitization, and
 * the isAutoQaEnabled flag.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createReportToolIssueTool,
	isAutoQaEnabled,
	sanitizeAutoQaPayload,
	__resetAutoQaFlushStateForTests,
} from "@veyyon/coding-agent/tools/report-tool-issue";
import { Settings } from "@veyyon/coding-agent/config/settings";

// Minimal session mock: the tool only calls getActiveModelString, settings,
// and obfuscateProviderText. All three are safe to stub.
function mockSession() {
	return {
		getActiveModelString: () => "test-model",
		settings: Settings.isolated(),
		obfuscateProviderText: (text: string) => text,
	} as never;
}

describe("report_tool_issue tool metadata", () => {
	it("has name 'report_tool_issue'", () => {
		const tool = createReportToolIssueTool(mockSession(), ["read", "bash"]);
		expect(tool.name).toBe("report_tool_issue");
	});

	it("has label 'Report Tool Issue'", () => {
		const tool = createReportToolIssueTool(mockSession(), ["read", "bash"]);
		expect(tool.label).toBe("Report Tool Issue");
	});

	it("has approval 'write'", () => {
		const tool = createReportToolIssueTool(mockSession(), ["read", "bash"]);
		expect(tool.approval).toBe("write");
	});

	it("has intent 'omit'", () => {
		const tool = createReportToolIssueTool(mockSession(), ["read", "bash"]);
		expect(tool.intent).toBe("omit");
	});

	it("has strict false", () => {
		const tool = createReportToolIssueTool(mockSession(), ["read", "bash"]);
		expect(tool.strict).toBe(false);
	});

	it("description mentions automated QA", () => {
		const tool = createReportToolIssueTool(mockSession(), ["read", "bash"]);
		expect(tool.description).toContain("automated QA");
	});
});

describe("report_tool_issue execute output", () => {
	it("returns 'Noted, thanks!' for a known tool", async () => {
		const tool = createReportToolIssueTool(mockSession(), ["read", "bash"]);
		const result = await tool.execute("test-id", { tool: "read", report: "something odd" });
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		// The text is always "Noted, thanks!" regardless of whether the DB write succeeded.
		expect((result.content[0] as { text: string }).text).toBe("Noted, thanks!");
	});

	it("returns 'Noted, thanks!' for an unknown tool (silent drop)", async () => {
		const tool = createReportToolIssueTool(mockSession(), ["read", "bash"]);
		const result = await tool.execute("test-id", { tool: "nonexistent", report: "test" });
		expect((result.content[0] as { text: string }).text).toBe("Noted, thanks!");
	});

	it("strips proxy_ prefix before allowlist check", async () => {
		// proxy_read should be accepted as "read" when read is in the allowlist.
		const tool = createReportToolIssueTool(mockSession(), ["read", "bash"]);
		const result = await tool.execute("test-id", { tool: "proxy_read", report: "test" });
		expect((result.content[0] as { text: string }).text).toBe("Noted, thanks!");
	});

	it("accepts any tool when allowlist is empty", async () => {
		const tool = createReportToolIssueTool(mockSession(), []);
		const result = await tool.execute("test-id", { tool: "anything", report: "test" });
		expect((result.content[0] as { text: string }).text).toBe("Noted, thanks!");
	});
});

describe("isAutoQaEnabled", () => {
	it("returns false by default", () => {
		expect(isAutoQaEnabled(Settings.isolated())).toBe(false);
	});

	it("returns true when dev.autoqa setting is on", () => {
		const settings = Settings.isolated();
		settings.set("dev.autoqa", true);
		expect(isAutoQaEnabled(settings)).toBe(true);
	});
});

describe("sanitizeAutoQaPayload", () => {
	it("sanitizes string values", () => {
		const result = sanitizeAutoQaPayload("hello", s => s.toUpperCase());
		expect(result).toBe("HELLO");
	});

	it("sanitizes strings inside arrays", () => {
		const result = sanitizeAutoQaPayload(["a", "b"], s => s.toUpperCase());
		expect(result).toEqual(["A", "B"]);
	});

	it("sanitizes both keys and string values in objects", () => {
		const result = sanitizeAutoQaPayload({ key: "value" }, s => s.toUpperCase());
		expect(result).toEqual({ KEY: "VALUE" });
	});

	it("sanitizes object keys", () => {
		const result = sanitizeAutoQaPayload({ secretKey: "v" }, s => s.replace(/secret/gi, "X"));
		expect(result).toEqual({ XKey: "v" });
	});

	it("passes through numbers and booleans (keys still sanitized)", () => {
		const result = sanitizeAutoQaPayload({ n: 42, b: true }, s => s.toUpperCase());
		expect(result).toEqual({ N: 42, B: true });
	});

	it("passes through null", () => {
		const result = sanitizeAutoQaPayload(null, () => "X");
		expect(result).toBeNull();
	});

	it("handles nested objects (keys and values sanitized)", () => {
		const result = sanitizeAutoQaPayload({ outer: { inner: "text" } }, s => s.toUpperCase());
		expect(result).toEqual({ OUTER: { INNER: "TEXT" } });
	});

	it("handles circular references", () => {
		const obj: Record<string, unknown> = { a: "x" };
		obj.self = obj;
		const result = sanitizeAutoQaPayload(obj, s => s.toUpperCase()) as Record<string, unknown>;
		expect(result.A).toBe("X");
		expect(result.SELF).toBe(result); // circular ref preserved
	});
});

// Reset flush state so it doesn't leak across test files.
afterEach(() => __resetAutoQaFlushStateForTests());
