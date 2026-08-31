/**
 * WHY: the harness prints every metric it measured, primary included, and
 * `run_experiment` records that whole map. The state rebuild then treated any
 * name in the map that was not already a declared secondary as a new secondary,
 * so the primary was registered as a secondary of itself and the detail pane
 * printed it twice — `wall time 88.71ms -8.0%` from the primary row, then
 * `wall time 88.71 -8.0%` from the secondary block, the second one missing the
 * unit and the direction.
 *
 * The contract: a metric name occupies exactly one row of the detail pane. The
 * primary is the primary, wherever else it appears.
 *
 * The class is a name reaching a list it is already the head of. Both routes into
 * that list are covered: the map a measured run carries, and the
 * `secondary_metrics` a session declares, which had the same hole. Both are
 * exercised through the real `init_experiment` / `run_experiment` /
 * `log_experiment` path, and the assertion is on the rendered pane rather than on
 * the state field, so a rebuild that stops deduping and a renderer that starts
 * repeating are both red.
 *
 * What it does not catch: two DIFFERENT names for one measurement (`ms` and
 * `wall time` for the same number). Nothing in the session declares them equal,
 * so nothing here can.
 */
import { describe, expect, it } from "bun:test";
import { renderRunDetail } from "@veyyon/coding-agent/autoresearch/screen";
import {
	logRun,
	openExperiment,
	seedMeasuredRun,
	stateOf,
	useAutoresearchRepo,
} from "./helpers/autoresearch-session";
import { useIsolatedAgentDir } from "./helpers/isolated-agent-dir";
import { useTruecolorTheme } from "./helpers/theme-assertions";

useIsolatedAgentDir();
useTruecolorTheme("dark");

const freshRepo = useAutoresearchRepo("veyyon-metric-listed-once-");

/** Every line of the pane that names `metric`, with styling stripped. */
function rowsNaming(pane: string[], metric: string): string[] {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR sequences is the point.
	const plain = pane.map(line => line.replace(/\u001b\[[0-9;]*m/g, ""));
	return plain.filter(line => line.includes(metric));
}

describe("a metric is listed once", () => {
	it("does not repeat the primary the measured run reported among its metrics", async () => {
		const harness = await openExperiment(freshRepo(), {
			name: "parser allocations",
			primaryMetric: "wall time",
			metricUnit: "ms",
			secondaryMetrics: ["peak rss"],
		});
		// The harness reports the primary alongside the secondary, which is what a
		// real `METRIC` line looks like.
		seedMeasuredRun(harness, { metric: 96.4, metrics: { "wall time": 96.4, "peak rss": 130 } });
		await logRun(harness, { status: "keep", description: "baseline", metric: 96.4 });
		seedMeasuredRun(harness, { metric: 88.71, metrics: { "wall time": 88.71, "peak rss": 128 } });
		await logRun(harness, { status: "keep", description: "reuse one token buffer", metric: 88.71 });

		const state = stateOf(harness);
		expect(state.secondaryMetrics.map(metric => metric.name)).toEqual(["peak rss"]);

		const pane = renderRunDetail(state, state.results[1], 80);
		expect(rowsNaming(pane, "wall time")).toHaveLength(1);
		expect(rowsNaming(pane, "peak rss")).toHaveLength(1);
		// The one row that survives is the primary's, with unit and comparison.
		expect(rowsNaming(pane, "wall time")[0]).toContain("88.71ms");
		expect(rowsNaming(pane, "wall time")[0]).toContain("-8.0%");
	});

	it("does not repeat a primary the session declared as its own secondary", async () => {
		const harness = await openExperiment(freshRepo(), {
			name: "declared twice",
			primaryMetric: "wall time",
			metricUnit: "ms",
			secondaryMetrics: ["wall time", "peak rss"],
		});
		seedMeasuredRun(harness, { metric: 96.4, metrics: { "wall time": 96.4 } });
		await logRun(harness, { status: "keep", description: "baseline", metric: 96.4 });

		const state = stateOf(harness);
		expect(state.secondaryMetrics.map(metric => metric.name)).toEqual(["peak rss"]);
		expect(rowsNaming(renderRunDetail(state, state.results[0], 80), "wall time")).toHaveLength(1);
	});

	it("still lists a secondary the session never declared", async () => {
		// The dedupe must not become "only declared metrics count": a metric the
		// harness starts printing mid-session is how a secondary usually arrives.
		const harness = await openExperiment(freshRepo(), {
			name: "undeclared secondary",
			primaryMetric: "wall time",
			metricUnit: "ms",
		});
		seedMeasuredRun(harness, { metric: 96.4, metrics: { "wall time": 96.4, allocations: 4096 } });
		await logRun(harness, { status: "keep", description: "baseline", metric: 96.4 });

		const state = stateOf(harness);
		expect(state.secondaryMetrics.map(metric => metric.name)).toEqual(["allocations"]);
		expect(rowsNaming(renderRunDetail(state, state.results[0], 80), "allocations")).toHaveLength(1);
	});
});
