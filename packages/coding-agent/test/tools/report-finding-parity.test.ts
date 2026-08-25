/**
 * report_finding tool pins exact observable output and metadata.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. report_finding is a hidden tool used by review agents to report
 * code review findings. Its contracts: tool metadata (name, label,
 * approval), exact output text format, details shape, priority validation,
 * and the parseReportFindingDetails round-trip.
 */
import { describe, expect, it } from "bun:test";
import {
	reportFindingTool,
	isFindingPriority,
	getPriorityInfo,
	PRIORITY_LABELS,
	parseReportFindingDetails,
} from "@veyyon/coding-agent/tools/review";

describe("report_finding tool metadata", () => {
	it("has name 'report_finding'", () => {
		expect(reportFindingTool.name).toBe("report_finding");
	});

	it("has label 'Report Finding'", () => {
		expect(reportFindingTool.label).toBe("Report Finding");
	});

	it("has approval 'read'", () => {
		expect(reportFindingTool.approval).toBe("read");
	});

	it("has a non-empty description", () => {
		expect(reportFindingTool.description.length).toBeGreaterThan(0);
	});

	it("has intent 'omit'", () => {
		expect(reportFindingTool.intent).toBe("omit");
	});
});

describe("report_finding execute", () => {
	it("produces exact output text for a P0 finding", async () => {
		const result = await reportFindingTool.execute("call-1", {
			title: "Null dereference in handler",
			body: "The handler accesses x.y without checking x for null.",
			priority: "P0",
			confidence: 0.95,
			file_path: "src/handler.ts",
			line_start: 42,
			line_end: 42,
		});

		expect(result.content).toHaveLength(1);
		const block = result.content[0];
		expect(block.type).toBe("text");
		expect(block.type === "text" ? block.text : "").toBe(
			"Finding recorded: P0 Null dereference in handler\nLocation: src/handler.ts:42\nConfidence: 95%",
		);
	});

	it("produces exact output text for a line range", async () => {
		const result = await reportFindingTool.execute("call-2", {
			title: "Unused import",
			body: "The import is never used.",
			priority: "P3",
			confidence: 1,
			file_path: "src/utils.ts",
			line_start: 10,
			line_end: 15,
		});

		const block = result.content[0];
		expect(block.type === "text" ? block.text : "").toBe(
			"Finding recorded: P3 Unused import\nLocation: src/utils.ts:10-15\nConfidence: 100%",
		);
	});

	it("details match input", async () => {
		const result = await reportFindingTool.execute("call-3", {
			title: "Test finding",
			body: "Test body",
			priority: "P1",
			confidence: 0.5,
			file_path: "test.ts",
			line_start: 1,
			line_end: 5,
		});

		expect(result.details).toEqual({
			title: "Test finding",
			body: "Test body",
			priority: "P1",
			confidence: 0.5,
			file_path: "test.ts",
			line_start: 1,
			line_end: 5,
		});
	});
});

describe("isFindingPriority", () => {
	it("accepts P0 through P3", () => {
		expect(isFindingPriority("P0")).toBe(true);
		expect(isFindingPriority("P1")).toBe(true);
		expect(isFindingPriority("P2")).toBe(true);
		expect(isFindingPriority("P3")).toBe(true);
	});

	it("rejects invalid values", () => {
		expect(isFindingPriority("P4")).toBe(false);
		expect(isFindingPriority("p0")).toBe(false);
		expect(isFindingPriority(0)).toBe(false);
		expect(isFindingPriority("")).toBe(false);
		expect(isFindingPriority(null)).toBe(false);
	});
});

describe("getPriorityInfo", () => {
	it("returns correct info for each priority", () => {
		expect(getPriorityInfo("P0")).toEqual({ ord: 0, symbol: "status.error", color: "error" });
		expect(getPriorityInfo("P1")).toEqual({ ord: 1, symbol: "status.warning", color: "warning" });
		expect(getPriorityInfo("P2")).toEqual({ ord: 2, symbol: "status.warning", color: "muted" });
		expect(getPriorityInfo("P3")).toEqual({ ord: 3, symbol: "status.info", color: "accent" });
	});
});

describe("PRIORITY_LABELS", () => {
	it("is the ordered list P0 through P3", () => {
		expect(PRIORITY_LABELS).toEqual(["P0", "P1", "P2", "P3"]);
	});
});

describe("parseReportFindingDetails", () => {
	it("parses a valid record", () => {
		const result = parseReportFindingDetails({
			title: "Bug",
			body: "Description",
			priority: "P1",
			confidence: 0.8,
			file_path: "src/foo.ts",
			line_start: 1,
			line_end: 10,
		});
		expect(result).toEqual({
			title: "Bug",
			body: "Description",
			priority: "P1",
			confidence: 0.8,
			file_path: "src/foo.ts",
			line_start: 1,
			line_end: 10,
		});
	});

	it("returns undefined for non-record input", () => {
		expect(parseReportFindingDetails(null)).toBeUndefined();
		expect(parseReportFindingDetails("string")).toBeUndefined();
		expect(parseReportFindingDetails(42)).toBeUndefined();
	});

	it("returns undefined when required fields are missing", () => {
		expect(parseReportFindingDetails({ title: "Bug" })).toBeUndefined();
	});
});
