import { describe, expect, it } from "bun:test";
import { renderTrialRow, type Trial } from "./runner";

/**
 * Locks FINDING-METAHARNESS-REPORT-TABLE-UNESCAPED-DETAIL. The benchmark report
 * table used to interpolate a trial's task name and its free-text `detail` (an
 * exception type, or a JSON.stringify error blob from benchmarks.ts) straight
 * into a `| … |` row. A `|` or a newline in either — both routine in error text
 * and JSON — ended the cell or the whole row early and shifted every following
 * column against the six-column header. renderTrialRow now routes both through
 * the canonical escapeMarkdownTableCell. These assert the exact cell bytes and
 * that the row keeps exactly six columns, so a revert to raw interpolation fails
 * loudly.
 */
describe("renderTrialRow table-cell escaping", () => {
	const trial = (over: Partial<Trial>): Trial => ({
		name: "task-a",
		status: "pass",
		reward: 1,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		durationMs: 0,
		detail: "",
		...over,
	});

	/** Count the columns of a rendered row by splitting on unescaped pipes. */
	const columns = (row: string): number => row.split(/(?<!\\)\|/).length;

	it("escapes a pipe in the detail so the row keeps six columns", () => {
		const row = renderTrialRow(trial({ status: "error", detail: "ValueError: a | b mismatch" }));
		// 6 columns → 8 segments when split on unescaped pipes (leading + trailing empty).
		expect(columns(row)).toBe(8);
		expect(row).toContain("ValueError: a \\| b mismatch");
	});

	it("collapses a newline in a JSON detail blob so it cannot end the row early", () => {
		const detail = JSON.stringify({ error: "line one\nline two" });
		const row = renderTrialRow(trial({ status: "error", detail }));
		expect(row).not.toContain("\n");
		expect(columns(row)).toBe(8);
	});

	it("escapes a pipe in the task name as well", () => {
		const row = renderTrialRow(trial({ name: "suite | case" }));
		expect(row).toContain("| suite \\| case |");
		expect(columns(row)).toBe(8);
	});

	it("renders a null reward as an em dash and tags status with an emoji", () => {
		const row = renderTrialRow(trial({ name: "t", status: "fail", reward: null }));
		expect(row.startsWith("| t | ❌ fail | — |")).toBe(true);
	});

	it("keeps a plain trial row at six columns", () => {
		expect(columns(renderTrialRow(trial({ name: "plain", detail: "ok" })))).toBe(8);
	});
});
