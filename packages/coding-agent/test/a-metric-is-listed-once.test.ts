/**
 * WHY: a log call carries the metrics the harness printed, primary included, and
 * `mergeMetrics` stripped the primary only from the parsed measurement, not from
 * the map the call declares. That map is the stored `metrics_json`, so the state
 * rebuild registered the primary as a secondary of itself and the detail pane
 * printed it twice: `wall time 88.71ms -8.0%` from the primary row, then
 * `wall time 88.71 -8.0%` from the secondary block, the second missing the unit
 * and taking the comparison a second time. On a crashed run that second row read
 * `wall time 0 -100.0%` about a run that measured nothing.
 *
 * The contract: a metric name occupies exactly one row of the detail pane, and
 * the primary is the primary wherever else it appears.
 *
 * The class is a name reaching a list it is already the head of. All three routes
 * into that list are covered: the metrics a log call declares, the
 * `secondary_metrics` a session declares, and a row already on disk from a build
 * that wrote the primary into it — the last one is why the display filters as
 * well as the writer, since no fix reaches a row already written. Each is driven
 * through the real `init_experiment` / `run_experiment` / `log_experiment` path,
 * and asserted on the rendered pane, so a rebuild that stops deduping and a
 * renderer that starts repeating are both red.
 *
 * What it does not catch: two DIFFERENT names for one measurement (`ms` and
 * `wall time` for the same number). Nothing in the session declares them equal,
 * so nothing here can.
 */
import { describe, expect, it } from "bun:test";
import { renderRunDetail } from "@veyyon/coding-agent/autoresearch/screen";
import { stripAnsi } from "@veyyon/utils";
import { logRun, openExperiment, seedMeasuredRun, stateOf, useAutoresearchRepo } from "./helpers/autoresearch-session";
import { useIsolatedAgentDir } from "./helpers/isolated-agent-dir";
import { useTruecolorTheme } from "./helpers/theme-assertions";

useIsolatedAgentDir();
useTruecolorTheme("dark");

const freshRepo = useAutoresearchRepo("veyyon-metric-listed-once-");

/** Every line of the pane that names `metric`, with styling stripped. */
function rowsNaming(pane: string[], metric: string): string[] {
	return pane.map(line => stripAnsi(line)).filter(line => line.includes(metric));
}

describe("a metric is listed once", () => {
	it("keeps the primary out of the secondary metrics a log call declares", async () => {
		const harness = await openExperiment(freshRepo(), {
			name: "parser allocations",
			primaryMetric: "wall time",
			metricUnit: "ms",
			secondaryMetrics: ["peak rss"],
		});
		seedMeasuredRun(harness, { metric: 96.4, metrics: { "wall time": 96.4, "peak rss": 130 } });
		await logRun(harness, { status: "keep", description: "baseline", metric: 96.4 });
		const runId = seedMeasuredRun(harness, { metric: 88.71, metrics: { "wall time": 88.71, "peak rss": 128 } });
		// A log call that repeats the primary among its metrics, which is what the
		// loop writes when it echoes the harness output it just read.
		await logRun(harness, {
			status: "keep",
			description: "reuse one token buffer",
			metric: 88.71,
			metrics: { "wall time": 88.71, "peak rss": 128 },
		});

		// The stored row is the durable copy, so the primary must not be in it.
		const logged = harness.storage.listLoggedRuns(harness.session.id).at(-1);
		expect(Object.keys(logged?.metrics ?? {})).toEqual(["peak rss"]);
		expect(stateOf(harness).secondaryMetrics.map(metric => metric.name)).toEqual(["peak rss"]);

		const pane = renderRunDetail(harness.runtime, `run:${runId}`, 80);
		expect(rowsNaming(pane, "wall time")).toHaveLength(1);
		expect(rowsNaming(pane, "peak rss")).toHaveLength(1);
		// The row that survives is the primary's, with unit and comparison.
		expect(rowsNaming(pane, "wall time")[0]).toContain("88.71ms");
		expect(rowsNaming(pane, "wall time")[0]).toContain("-8.0%");
	});

	it("lists a row written before the primary was excluded only once", async () => {
		// Every session logged before this fix has the primary in its stored
		// metrics, and those rows are read back on every open. The screen has to
		// render a stale row correctly rather than trusting the writer.
		const harness = await openExperiment(freshRepo(), {
			name: "stale rows",
			primaryMetric: "wall time",
			metricUnit: "ms",
		});
		const runId = seedMeasuredRun(harness, { metric: 96.4 });
		harness.storage.markRunLogged({
			runId,
			status: "keep",
			description: "logged by an older build",
			metric: 96.4,
			metrics: { "wall time": 96.4, "peak rss": 130 },
			asi: null,
			commitHash: "0123456789abcdef",
			confidence: null,
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			loggedAt: Date.now(),
		});

		const state = stateOf(harness);
		expect(state.secondaryMetrics.map(metric => metric.name)).toEqual(["peak rss"]);
		harness.runtime.state = state;
		expect(rowsNaming(renderRunDetail(harness.runtime, `run:${runId}`, 80), "wall time")).toHaveLength(1);
	});

	it("does not repeat a primary the session declared as its own secondary", async () => {
		const harness = await openExperiment(freshRepo(), {
			name: "declared twice",
			primaryMetric: "wall time",
			metricUnit: "ms",
			secondaryMetrics: ["wall time", "peak rss"],
		});
		const runId = seedMeasuredRun(harness, { metric: 96.4, metrics: { "wall time": 96.4 } });
		await logRun(harness, { status: "keep", description: "baseline", metric: 96.4 });

		expect(stateOf(harness).secondaryMetrics.map(metric => metric.name)).toEqual(["peak rss"]);
		expect(rowsNaming(renderRunDetail(harness.runtime, `run:${runId}`, 80), "wall time")).toHaveLength(1);
	});

	it("still lists a secondary the session never declared", async () => {
		// The dedupe must not become "only declared metrics count": a metric the
		// harness starts printing mid-session is how a secondary usually arrives.
		const harness = await openExperiment(freshRepo(), {
			name: "undeclared secondary",
			primaryMetric: "wall time",
			metricUnit: "ms",
		});
		const runId = seedMeasuredRun(harness, { metric: 96.4, metrics: { "wall time": 96.4, allocations: 4096 } });
		await logRun(harness, { status: "keep", description: "baseline", metric: 96.4 });

		expect(stateOf(harness).secondaryMetrics.map(metric => metric.name)).toEqual(["allocations"]);
		expect(rowsNaming(renderRunDetail(harness.runtime, `run:${runId}`, 80), "allocations")).toHaveLength(1);
	});
});
