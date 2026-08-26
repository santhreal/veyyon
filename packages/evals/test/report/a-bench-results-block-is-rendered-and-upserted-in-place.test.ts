/**
 * bench-report block rendering and doc upsert. Exists because the feature-doc
 * emit path must be idempotent: re-running after a re-bench REPLACES the keyed
 * block in place, never appends a second copy (the exact scattering the tool
 * was built to stop), and a doc with a broken marker pair fails loudly
 * instead of silently duplicating or truncating prose.
 *
 * Two ways of losing that idempotence are pinned below. A key is interpolated
 * into an HTML comment, so a key holding `-->`, `<` or a newline closed the
 * comment early: the markers rendered as prose, the pair could no longer be
 * found, and the next emit appended a second block. And a doc whose
 * "## Benchmark results" heading is followed by another section took the block
 * at the end of the file, filing it under whichever heading came last.
 */
import { describe, expect, it } from "bun:test";
import type { BenchmarkSnapshot } from "../../src/manager/benchmarks";
import type { RunRow } from "../../src/manager/store";
import { renderBenchResultsBlock, requireBlockKey, upsertBenchResultsBlock } from "../../src/report/bench-report";

function fakeRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		benchmark: "deepswe",
		jobName: "ds-argot-1",
		dataset: "deep-swe",
		agent: "vey",
		models: "gemini-3.6-flash",
		prewalk: null,
		config: {},
		role: "variant",
		note: "argot decode arm vs none",
		label: "",
		status: "complete",
		pid: null,
		exitCode: 0,
		createdAt: 1750000000000,
		finishedAt: 1753142400000,
		nTotal: 10,
		done: 10,
		pass: 6,
		fail: 3,
		error: 1,
		...overrides,
	} as RunRow;
}

function fakeSnapshot(): BenchmarkSnapshot {
	return {
		traces: [],
		total: 10,
		done: 10,
		pass: 6,
		fail: 3,
		error: 1,
		running: 0,
		costUsd: 12.345,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		score: 0.6,
		metrics: { reward_rate: 0.6, mean_partial: 0.725 },
	};
}

describe("renderBenchResultsBlock", () => {
	it("renders the keyed markers, metric rows, counts, and cost with exact bytes", () => {
		const block = renderBenchResultsBlock(fakeRun(), fakeSnapshot(), "argot");
		expect(block.startsWith("<!-- bench-results:argot -->\n")).toBe(true);
		expect(block.endsWith("\n<!-- /bench-results:argot -->")).toBe(true);
		expect(block).toContain("**DeepSWE arms**: run `ds-argot-1` (gemini-3.6-flash, 2025-07-22)");
		expect(block).toContain("| Full reward | 60.0% |");
		expect(block).toContain("| Mean partial | 72.5% |");
		expect(block).toContain("| Tasks pass / fail / error | 6 / 3 / 1 (of 10) |");
		expect(block).toContain("| Cost | $12.35 |");
		expect(block).toContain("argot decode arm vs none");
	});

	it("renders a null metric as n/a and an unfinished run without a date", () => {
		const snapshot = fakeSnapshot();
		snapshot.metrics = { reward_rate: null, mean_partial: null };
		const block = renderBenchResultsBlock(fakeRun({ finishedAt: null }), snapshot, "k");
		expect(block).toContain("| Full reward | n/a |");
		expect(block).toContain("unfinished)");
	});
});

describe("upsertBenchResultsBlock", () => {
	const block = "<!-- bench-results:k -->\nNEW\n<!-- /bench-results:k -->";

	it("replaces an existing keyed block in place, byte-exact around it", () => {
		const doc = "# Feature\n\nprose\n\n<!-- bench-results:k -->\nOLD\n<!-- /bench-results:k -->\n\ntail\n";
		expect(upsertBenchResultsBlock(doc, "k", block)).toBe(`# Feature\n\nprose\n\n${block}\n\ntail\n`);
	});

	it("is idempotent: applying the same block twice yields the same document", () => {
		const doc = "# Feature\n";
		const once = upsertBenchResultsBlock(doc, "k", block);
		expect(upsertBenchResultsBlock(once, "k", block)).toBe(once);
	});

	it("leaves a differently-keyed block untouched", () => {
		const other = "<!-- bench-results:other -->\nKEEP\n<!-- /bench-results:other -->";
		const doc = `# F\n\n${other}\n`;
		const out = upsertBenchResultsBlock(doc, "k", block);
		expect(out).toContain("KEEP");
		expect(out).toContain("NEW");
	});

	it("appends under an existing Benchmark results heading without duplicating it", () => {
		const doc = "# F\n\n## Benchmark results\n\nintro\n";
		const out = upsertBenchResultsBlock(doc, "k", block);
		expect(out.match(/## Benchmark results/g)).toHaveLength(1);
		expect(out).toContain("NEW");
	});

	it("creates the heading when absent", () => {
		const out = upsertBenchResultsBlock("# F\n", "k", block);
		expect(out).toContain("## Benchmark results\n\n<!-- bench-results:k -->");
	});

	it("fails loudly on an unclosed marker pair instead of corrupting the doc", () => {
		expect(() => upsertBenchResultsBlock("x\n<!-- bench-results:k -->\ny\n", "k", block)).toThrow(
			/no closing marker/,
		);
	});

	it("files the block at the end of the results section, not at the end of the page", () => {
		const doc = "# F\n\n## Benchmark results\n\nintro\n\n## Notes\n\ntail\n";

		const out = upsertBenchResultsBlock(doc, "k", block);

		expect(out).toBe(`# F\n\n## Benchmark results\n\nintro\n\n${block}\n\n## Notes\n\ntail\n`);
		expect(out.indexOf("NEW")).toBeLessThan(out.indexOf("## Notes"));
	});

	it("keeps a deeper subsection inside the results section", () => {
		const doc = "# F\n\n## Benchmark results\n\n### Parity\n\nnumbers\n\n## Notes\n\ntail\n";

		const out = upsertBenchResultsBlock(doc, "k", block);

		expect(out).toBe(`# F\n\n## Benchmark results\n\n### Parity\n\nnumbers\n\n${block}\n\n## Notes\n\ntail\n`);
	});

	it("stops at a following h1 as well as an h2", () => {
		const doc = "## Benchmark results\n\nintro\n\n# Appendix\n\ntail\n";

		const out = upsertBenchResultsBlock(doc, "k", block);

		expect(out).toBe(`## Benchmark results\n\nintro\n\n${block}\n\n# Appendix\n\ntail\n`);
	});

	it("stays idempotent on a page whose results section is not the last one", () => {
		const doc = "# F\n\n## Benchmark results\n\nintro\n\n## Notes\n\ntail\n";
		const once = upsertBenchResultsBlock(doc, "k", block);

		expect(upsertBenchResultsBlock(once, "k", block)).toBe(once);
	});

	it("refuses a key that would not survive its own marker", () => {
		for (const key of ["", "a -->b", "a\nb", "a<b", "a b", "k/../x", "café"]) {
			expect(() => upsertBenchResultsBlock("# F\n", key, block)).toThrow(/Invalid bench block key/);
			expect(() => renderBenchResultsBlock(fakeRun(), fakeSnapshot(), key)).toThrow(/Invalid bench block key/);
		}
	});

	it("accepts the keys a doc actually uses", () => {
		for (const key of ["argot", "deepswe", "edit_v2", "harbor.2", "a-b"]) {
			expect(requireBlockKey(key)).toBe(key);
		}
	});
});
