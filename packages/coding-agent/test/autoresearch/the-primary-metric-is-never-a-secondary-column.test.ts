/**
 * WHY: the autoresearch table printed the primary metric twice — once as the
 * column the loop optimizes and once as a secondary reading beside it — and the
 * overlay summary reported the same number under both headings with two
 * different percentages, because the median that feeds the secondary column is
 * computed over a different run set than the primary one.
 *
 * The class this closes is a metric reaching `state.secondaryMetrics` when it is
 * already the primary. There are two doors into that set and the defect only
 * needed one: `session.secondaryMetrics`, which a caller of `init_experiment`
 * writes, and the key set of every logged run's `metrics`, into which
 * `log_experiment` writes the primary reading alongside the secondary ones. A
 * fix at either door alone leaves the other open, so both are exercised here,
 * separately and together.
 *
 * What it does not catch: how the columns are laid out or labelled. This asserts
 * the metric set the renderer is handed, not the frame it draws from it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildExperimentState } from "@veyyon/coding-agent/autoresearch/state";
import { AutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import type { NumericMetricMap } from "@veyyon/coding-agent/autoresearch/types";
import { TempDir } from "@veyyon/utils";

const PRIMARY = "runtime_ms";

describe("the primary metric is never a secondary column", () => {
	let dbDir: TempDir;
	let storage: AutoresearchStorage;

	beforeEach(() => {
		dbDir = TempDir.createSync("@veyyon-autoresearch-secondary-");
		storage = new AutoresearchStorage(dbDir.join("test.db"), dbDir.path());
	});

	afterEach(async () => {
		storage.close();
		await dbDir.remove().catch(() => {});
	});

	/** Open a session, then log one run reporting `metrics`, the way the tools do. */
	function sessionWith(declaredSecondaries: string[], metrics: NumericMetricMap) {
		const session = storage.openSession({
			name: "speed",
			goal: null,
			primaryMetric: PRIMARY,
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: null,
			branch: null,
			baselineCommit: null,
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: declaredSecondaries,
		});
		const run = storage.insertRun({
			sessionId: session.id,
			segment: session.currentSegment,
			command: "bun run bench",
			logPath: "run.log",
			preRunDirtyPaths: [],
			startedAt: 1_000,
		});
		storage.markRunLogged({
			runId: run.id,
			status: "keep",
			description: "baseline",
			metric: metrics[PRIMARY] ?? 0,
			metrics,
			asi: null,
			commitHash: "abc1234",
			confidence: null,
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			loggedAt: 2_000,
		});
		return buildExperimentState(session, storage.listLoggedRuns(session.id));
	}

	it("drops the primary from the columns a run reports, and keeps the rest", () => {
		// `log_experiment` writes the primary into `metrics` beside the secondary
		// ones, so every run offers the duplicate.
		const state = sessionWith([], { [PRIMARY]: 412.6, cold_ms: 508.1, memory_mb: 91 });
		expect(state.secondaryMetrics.map(metric => metric.name)).toEqual(["cold_ms", "memory_mb"]);
	});

	it("drops the primary when the session declared it as a secondary too", () => {
		// The other door: a declaration, before any run exists.
		const state = sessionWith([PRIMARY, "cold_ms"], {});
		expect(state.secondaryMetrics.map(metric => metric.name)).toEqual(["cold_ms"]);
	});

	it("drops it when both doors offer it, and leaves no duplicate of a real secondary", () => {
		const state = sessionWith([PRIMARY, "cold_ms"], { [PRIMARY]: 412.6, cold_ms: 508.1 });
		expect(state.secondaryMetrics.map(metric => metric.name)).toEqual(["cold_ms"]);
	});

	it("keeps a secondary whose name merely contains the primary's", () => {
		// The exclusion is exact equality. A prefix or substring test would eat
		// `runtime_ms_p99`, which is a different reading.
		const state = sessionWith([], { [PRIMARY]: 412.6, runtime_ms_p99: 980.2, p99_runtime_ms: 981.0 });
		expect(state.secondaryMetrics.map(metric => metric.name)).toEqual(["runtime_ms_p99", "p99_runtime_ms"]);
	});
});
