/**
 * Experiment layer: groups runs that share a job-name prefix (`sb2-n8`,
 * `sb2-gemini` → experiment `sb2`) so comparable arms can be charted together,
 * with linear projections for arms still in flight.
 */
import { isRecord } from "@veyyon/utils";
import { sumOfMeasured } from "../core/scoring";
import {
	type ArmProjection,
	type ArmSummary,
	type ExperimentDetail,
	type ExperimentSummary,
	isDecidedTrialStatus,
	isGradedTrialStatus,
} from "../wire";
import type { RunRow, RunStore, TraceRow } from "./store";

export type { ArmProjection, ArmSummary, ExperimentDetail, ExperimentSummary };

export interface RunCoordinates {
	experiment: string;
	arm: string;
}

/** What a run carries that can identify its experiment and arm. `RunRow` satisfies it. */
export interface RunCoordinateSource {
	readonly jobName?: string;
	readonly experiment?: string;
	readonly arm?: string;
	readonly config?: Record<string, unknown>;
}

/** A trimmed string, or "" when the value is not a string. */
function trimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Split `<id>-<arm>` when `id` is an experiment somebody registered.
 *
 * The longest matching id wins, so registering both `sb` and `sb-v2` reads `sb-v2-base` as arm
 * `base` of `sb-v2` rather than arm `v2-base` of `sb`.
 */
function splitOnRegisteredId(jobName: string, registeredIds: ReadonlySet<string>): RunCoordinates | null {
	let best: RunCoordinates | null = null;
	for (const id of registeredIds) {
		if (!id || !jobName.startsWith(`${id}-`)) continue;
		const arm = jobName.slice(id.length + 1);
		if (arm.length === 0) continue;
		if (best === null || id.length > best.experiment.length) best = { experiment: id, arm };
	}
	return best;
}

/**
 * Read the coordinates a run carries.
 *
 * A run launched through the manager records its experiment and arm, and those win. A run from
 * before coordinates were recorded carries only a job name, and the only unambiguous reading of
 * a name is `<registered id>-<arm>` for an id that was actually registered: pass those ids in
 * to recover the grouping. Nothing is sliced off a name matching no registered experiment, so a
 * standalone run stays its own single-arm experiment instead of colliding with every other run
 * that happens to share its first token.
 */
export function inferRunCoordinates(
	runOrJobName: string | RunCoordinateSource,
	registeredIds: ReadonlySet<string> = new Set(),
): RunCoordinates {
	if (typeof runOrJobName === "string") {
		return splitOnRegisteredId(runOrJobName, registeredIds) ?? { experiment: runOrJobName, arm: runOrJobName };
	}
	const jobName = trimmedString(runOrJobName.jobName);
	const cfg = isRecord(runOrJobName.config) ? runOrJobName.config : undefined;

	const recordedExp =
		trimmedString(runOrJobName.experiment) ||
		trimmedString(cfg?.experiment) ||
		trimmedString(cfg?.experimentId) ||
		trimmedString(cfg?.experiment_id);

	const recordedArm =
		trimmedString(runOrJobName.arm) ||
		trimmedString(cfg?.arm) ||
		trimmedString(cfg?.armId) ||
		trimmedString(cfg?.arm_id);

	if (recordedExp && recordedArm) {
		return { experiment: recordedExp, arm: recordedArm };
	}
	if (recordedExp) {
		return { experiment: recordedExp, arm: jobName || recordedExp };
	}
	if (recordedArm) {
		return { experiment: jobName || recordedArm, arm: recordedArm };
	}
	return splitOnRegisteredId(jobName, registeredIds) ?? { experiment: jobName, arm: jobName };
}

/**
 * Every experiment id the store knows: registered rows, plus ids recorded on runs.
 *
 * This is the set an uncoordinated job name is read against.
 */
export function knownExperimentIds(store: RunStore): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const meta of store.listExperimentMeta()) {
		if (meta.id) ids.add(meta.id);
	}
	for (const run of store.listRuns()) {
		const cfg = isRecord(run.config) ? run.config : undefined;
		const recorded =
			trimmedString(run.experiment) ||
			trimmedString(cfg?.experiment) ||
			trimmedString(cfg?.experimentId) ||
			trimmedString(cfg?.experiment_id);
		if (recorded) ids.add(recorded);
	}
	return ids;
}

/**
 * The known ids plus one the caller named.
 *
 * A lookup for a specific experiment already asserts that experiment exists, so its own id is
 * a legitimate reading of an uncoordinated `<id>-<arm>` job name. The aggregate index, which
 * names no id, gets no such licence: it groups only what runs actually recorded.
 */
export function knownExperimentIdsWith(store: RunStore, id: string): ReadonlySet<string> {
	const ids = new Set(knownExperimentIds(store));
	if (id) ids.add(id);
	return ids;
}

/** Experiment id from recorded coordinates, else from a registered `<id>-<arm>` job name. */
export function experimentOf(runOrJobName: string | RunCoordinateSource, registeredIds?: ReadonlySet<string>): string {
	return inferRunCoordinates(runOrJobName, registeredIds).experiment;
}

/** Arm label from recorded coordinates, else from a registered `<id>-<arm>` job name. */
export function armOf(runOrJobName: string | RunCoordinateSource, registeredIds?: ReadonlySet<string>): string {
	return inferRunCoordinates(runOrJobName, registeredIds).arm;
}

function prewalkLabel(prewalkJson: string | null): string {
	if (!prewalkJson) return "";
	try {
		// Historical rows may hold legacy reasoning-slide JSON ({model, turns, onAction, plan}).
		const parsed = JSON.parse(prewalkJson) as {
			into?: string;
			model?: string;
			turns?: number;
			onAction?: boolean;
			plan?: boolean;
		};
		if (parsed.model) {
			const trigger = parsed.onAction ? "on first edit/write" : `after ${parsed.turns} turns`;
			return ` → ${parsed.model} ${trigger}${parsed.plan ? " +plan" : ""}`;
		}
		return ` → ${parsed.into ?? "smol"} at first action`;
	} catch {
		// This builds a human-readable SUFFIX for an experiment label. An unparseable spec has no suffix to
		// show, and the empty string means the label is printed without one; the spec itself is validated
		// where the experiment is run.
		return "";
	}
}

export function summarizeArm(run: RunRow, traces: TraceRow[], registeredIds?: ReadonlySet<string>): ArmSummary {
	// Every observed stat is computed over DECIDED trials only — numerator and
	// denominator from the same population. `run.costUsd` includes in-flight
	// trials' accumulating spend, so dividing it by the decided count wildly
	// overstates $/task early in a run; per-trial trace costs don't.
	const decided = traces.filter(t => isDecidedTrialStatus(t.status));
	const durations = decided.filter(t => t.durationMs > 0).map(t => t.durationMs);
	const meanTrialMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
	const decidedPass = decided.filter(t => t.status === "pass").length;
	const measuredCosts = decided
		.map(t => t.costUsd)
		.filter((c): c is number => typeof c === "number" && Number.isFinite(c));
	const decidedCost = sumOfMeasured(decided.map(t => t.costUsd));
	const passPct = decided.length > 0 ? (100 * decidedPass) / decided.length : null;
	const costPerTask = measuredCosts.length > 0 && decidedCost !== null ? decidedCost / measuredCosts.length : null;

	let projected: ArmProjection | null = null;
	if (run.status === "running" && decided.length > 0 && run.nTotal > decided.length) {
		const elapsed = Date.now() - run.createdAt;
		const rate = decided.length / Math.max(elapsed, 1);
		const remaining = run.nTotal - decided.length;
		const totalCostUsd =
			run.costUsd !== null && costPerTask !== null
				? run.costUsd + costPerTask * remaining
				: run.costUsd !== null
					? run.costUsd
					: costPerTask !== null
						? costPerTask * run.nTotal
						: null;
		projected = {
			etaMs: rate > 0 ? Date.now() + remaining / rate : null,
			passPct: passPct ?? 0,
			costPerTask,
			totalCostUsd,
			meanTrialMs: meanTrialMs ?? 0,
		};
	}
	const recordedArm = armOf(run, registeredIds);
	return {
		run,
		arm: run.label || recordedArm,
		recordedArm,
		config: `${run.benchmark} · ${run.models}${prewalkLabel(run.prewalk)}`,
		passPct,
		costPerTask,
		meanTrialMs,
		projected,
	};
}

/**
 * Difficulty-calibrated final pass-rate projection for a running arm.
 *
 * Naive extrapolation (observed pass% → whole run) is wrong whenever the
 * decided subset isn't difficulty-representative: an arm that has so far only
 * decided tasks every sibling also passes should NOT project its 100%. This
 * uses every sibling result as a per-task difficulty signal (a one-parameter
 * Rasch-style fit):
 *
 *   1. Task difficulty: smoothed sibling pass rate p_t = (passes+1)/(n+2).
 *   2. Arm skill: a single log-odds shift `b`, moment-matched on the DECIDED
 *      tasks so that Σ σ(logit(p_t)+b) equals the arm's actual pass count.
 *   3. Projection: score the REMAINING tasks through σ(logit(p_t)+b); tasks
 *      beyond the sibling union (no signal) score at the mean difficulty.
 *
 * Returns the projected final pass percentage over `nTotal`, or null when the
 * arm has no reward-decided trials to calibrate on.
 */
export function calibratedFinalPassPct(options: {
	/** This arm's reward-decided outcomes. */
	decided: Array<{ task: string; passed: boolean }>;
	/** Per-task decided outcomes across sibling arms. */
	siblings: Map<string, { passes: number; decided: number }>;
	/** Tasks this arm has not decided yet. */
	remaining: string[];
	/** Full sample size to project over. */
	nTotal: number;
}): number | null {
	const { decided, siblings, remaining, nTotal } = options;
	if (decided.length === 0 || nTotal <= 0) return null;
	const sigma = (x: number): number => 1 / (1 + Math.exp(-x));
	const smoothed = (s: { passes: number; decided: number } | undefined): number | null =>
		s && s.decided > 0 ? (s.passes + 1) / (s.decided + 2) : null;
	const known = [...siblings.values()].map(s => smoothed(s)).filter((p): p is number => p !== null);
	const meanP = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 0.5;
	// Clamped logit keeps unanimous tasks from saturating the fit.
	// Uses the raw min/max form deliberately: a unanimous arm's logit is +/-Infinity
	// (p=1 -> +Inf, p=0 -> -Inf), and min/max map those to +4/-4 respectively. A
	// clamp helper that fails non-finite to the low bound would flip +Inf to -4.
	const logit = (p: number): number => Math.max(-4, Math.min(4, Math.log(p / (1 - p))));
	const decidedLogits = decided.map(d => logit(smoothed(siblings.get(d.task)) ?? meanP));
	const passes = decided.filter(d => d.passed).length;

	// Moment-match the skill shift on the decided set (monotone → bisection).
	// One pseudo-task of mean difficulty, "passed" at the sibling base rate,
	// shrinks the fit toward sibling-average skill — a perfect (or zero)
	// decided record would otherwise drive the shift to ±∞ (separation) and
	// project near-certainty everywhere.
	const fitLogits = [...decidedLogits, logit(meanP)];
	const target = passes + meanP;
	let lo = -6;
	let hi = 6;
	for (let i = 0; i < 50; i++) {
		const mid = (lo + hi) / 2;
		const expected = fitLogits.reduce((sum, l) => sum + sigma(l + mid), 0);
		if (expected < target) lo = mid;
		else hi = mid;
	}
	const b = (lo + hi) / 2;

	const remainingKnown = remaining.map(task => sigma(logit(smoothed(siblings.get(task)) ?? meanP) + b));
	const padCount = Math.max(0, nTotal - decided.length - remaining.length);
	const expectedRemaining = remainingKnown.reduce((a, x) => a + x, 0) + padCount * sigma(logit(meanP) + b);
	return (100 * (passes + expectedRemaining)) / nTotal;
}

export function buildExperiments(store: RunStore): ExperimentSummary[] {
	const registeredIds = knownExperimentIds(store);
	const groups = new Map<string, RunRow[]>();
	for (const run of store.listRuns()) {
		const id = experimentOf(run, registeredIds);
		let bucket = groups.get(id);
		if (!bucket) {
			bucket = [];
			groups.set(id, bucket);
		}
		bucket.push(run);
	}
	const out: ExperimentSummary[] = [];
	for (const [id, runs] of groups) {
		out.push({
			id,
			goal: store.getExperimentMeta(id)?.goal ?? "",
			arms: runs.length,
			runningArms: runs.filter(r => r.status === "running").length,
			datasets: [...new Set(runs.map(r => r.dataset).filter(Boolean))],
			nTotal: runs.reduce((a, r) => a + r.nTotal, 0),
			done: runs.reduce((a, r) => a + r.done, 0),
			pass: runs.reduce((a, r) => a + r.pass, 0),
			fail: runs.reduce((a, r) => a + r.fail, 0),
			error: runs.reduce((a, r) => a + r.error, 0),
			costUsd: sumOfMeasured(runs.map(r => r.costUsd)),
			createdAt: Math.min(...runs.map(r => r.createdAt)),
			updatedAt: Math.max(...runs.map(r => r.finishedAt ?? Date.now())),
		});
	}
	// Registered-but-empty experiments (created via POST /api/experiments, no
	// arms yet) are still browsable: zeroed rollups, goal from the meta row.
	for (const meta of store.listExperimentMeta()) {
		if (groups.has(meta.id)) continue;
		out.push({
			id: meta.id,
			goal: meta.goal,
			arms: 0,
			runningArms: 0,
			datasets: [],
			nTotal: 0,
			done: 0,
			pass: 0,
			fail: 0,
			error: 0,
			costUsd: null,
			createdAt: meta.updatedAt,
			updatedAt: meta.updatedAt,
		});
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

/** `-fix`/`-backfill`/`-retry` (optionally numbered) re-run suffixes that fold into the base arm. */
const RERUN_SUFFIX = /-(fix|backfill|refill|retry|rerun|bf)\d*$/i;

/** Arm label with re-run suffixes stripped: `n4p2-fix2` and `n4p2-backfill` both merge into `n4p2`. */
export function canonicalArmOf(
	runOrJobName: string | RunCoordinateSource,
	registeredIds?: ReadonlySet<string>,
): string {
	let arm = armOf(runOrJobName, registeredIds);
	for (;;) {
		const next = arm.replace(RERUN_SUFFIX, "");
		if (next === arm || next.length === 0) return arm;
		arm = next;
	}
}

/**
 * Collapse re-run trials onto one row per task: a reward-decided trial always
 * beats an undecided one (error/running), and within the same class the
 * latest update wins — so a `-fix` re-run of an errored task replaces the
 * error, but never a genuine earlier pass/fail... unless it is itself decided
 * and newer.
 */
export function pickMergedTrials(traces: TraceRow[]): TraceRow[] {
	const byTask = new Map<string, TraceRow>();
	const graded = (t: TraceRow): boolean => isGradedTrialStatus(t.status);
	for (const t of traces) {
		const cur = byTask.get(t.task);
		if (!cur) {
			byTask.set(t.task, t);
			continue;
		}
		const wins = graded(t) === graded(cur) ? t.updatedAt >= cur.updatedAt : graded(t);
		if (wins) byTask.set(t.task, t);
	}
	return [...byTask.values()];
}

export function experimentDetail(store: RunStore, id: string): ExperimentDetail | null {
	const registeredIds = knownExperimentIdsWith(store, id);
	const runs = store.listRuns().filter(r => experimentOf(r, registeredIds) === id);
	if (runs.length === 0) {
		// Registered but armless (POST /api/experiments): still readable.
		const meta = store.getExperimentMeta(id);
		return meta ? { id, goal: meta.goal, arms: [], tasks: [], matrix: {} } : null;
	}
	// One row per CANONICAL arm: `-fix`/`-backfill` re-runs merge into their
	// base arm — per-task best trial, summed spend.
	const groups = new Map<string, RunRow[]>();
	for (const run of runs) {
		const key = canonicalArmOf(run, registeredIds);
		const bucket = groups.get(key);
		if (bucket) bucket.push(run);
		else groups.set(key, [run]);
	}
	const arms: ArmSummary[] = [];
	const matrix: ExperimentDetail["matrix"] = {};
	const tasks = new Set<string>();
	for (const [canonical, members] of groups) {
		members.sort((a, b) => a.createdAt - b.createdAt);
		const base = members.find(m => armOf(m, registeredIds) === canonical) ?? members[0];
		const armLabel = base.label || canonical;
		const merged = pickMergedTrials(members.flatMap(m => store.listTraces(m.jobName)));
		const running = members.some(m => m.status === "running");
		const decidedCount = merged.filter(t => isDecidedTrialStatus(t.status)).length;
		const nTotal = Math.max(merged.length, ...members.map(m => m.nTotal));
		const mergedRun: RunRow = {
			...base,
			status: running ? "running" : nTotal > 0 && decidedCount >= nTotal ? "complete" : base.status,
			nTotal,
			done: decidedCount,
			pass: merged.filter(t => t.status === "pass").length,
			fail: merged.filter(t => t.status === "fail").length,
			error: merged.filter(t => t.status === "error").length,
			running: members.reduce((a, m) => a + m.running, 0),
			costUsd: sumOfMeasured(members.map(m => m.costUsd)),
			tokIn: members.reduce((a, m) => a + m.tokIn, 0),
			tokOut: members.reduce((a, m) => a + m.tokOut, 0),
			tokCache: sumOfMeasured(members.map(m => m.tokCache)),
			createdAt: Math.min(...members.map(m => m.createdAt)),
			finishedAt: running
				? null
				: members.reduce<number | null>((a, m) => Math.max(a ?? 0, m.finishedAt ?? 0) || null, null),
		};
		const summary = summarizeArm(mergedRun, merged, registeredIds);
		summary.arm = armLabel;
		summary.recordedArm = canonical;
		if (members.length > 1) summary.config += ` · merged ${members.length} runs`;
		arms.push(summary);
		const cells: ExperimentDetail["matrix"][string] = {};
		for (const t of merged) {
			tasks.add(t.task);
			cells[t.task] = { status: t.status, reward: t.reward };
		}
		matrix[armLabel] = cells;
	}
	// Replace naive running-arm pass projections with the sibling-calibrated
	// estimate: per-task difficulty from every other arm's outcome on the
	// shared sample.
	const taskList = [...tasks];
	for (const arm of arms) {
		if (!arm.projected) continue;
		const own = matrix[arm.arm] ?? {};
		const siblings = new Map<string, { passes: number; decided: number }>();
		for (const otherArm in matrix) {
			if (otherArm === arm.arm) continue;
			const cells = matrix[otherArm];
			for (const task in cells) {
				const cell = cells[task];
				// Task difficulty comes from graded outcomes only: an errored trial says nothing
				// about whether the task is passable.
				if (!isGradedTrialStatus(cell.status)) continue;
				const s = siblings.get(task) ?? { passes: 0, decided: 0 };
				s.decided++;
				if (cell.status === "pass") s.passes++;
				siblings.set(task, s);
			}
		}
		const decided: Array<{ task: string; passed: boolean }> = [];
		const decidedTasks = new Set<string>();
		for (const task in own) {
			const cell = own[task];
			if (!isGradedTrialStatus(cell.status)) continue;
			decided.push({ task, passed: cell.status === "pass" });
			decidedTasks.add(task);
		}
		const remaining = taskList.filter(task => !decidedTasks.has(task));
		const calibrated = calibratedFinalPassPct({ decided, siblings, remaining, nTotal: arm.run.nTotal });
		if (calibrated !== null) arm.projected.passPct = calibrated;
	}
	// Baselines first, then variants, then untagged — the table reads as
	// "reference rows, then treatments".
	const roleRank = (role: string) => (role === "baseline" ? 0 : role === "variant" ? 1 : 2);
	arms.sort((a, b) => roleRank(a.run.role) - roleRank(b.run.role) || a.arm.localeCompare(b.arm));
	return { id, goal: store.getExperimentMeta(id)?.goal ?? "", arms, tasks: [...tasks].sort(), matrix };
}
