import type { RunRow, RunStore, TraceRow } from "./store";

export interface ArmProjection {
	etaMs: number | null;
	passPct: number;
	costPerTask: number;
	totalCostUsd: number;
	meanTrialMs: number;
}

export interface ArmSummary {
	run: RunRow;
	arm: string;
	config: string;
	passPct: number | null;
	costPerTask: number | null;
	meanTrialMs: number | null;
	projected: ArmProjection | null;
}

export interface ExperimentSummary {
	id: string;
	goal: string;
	arms: number;
	runningArms: number;
	datasets: string[];
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	costUsd: number;
	createdAt: number;
	updatedAt: number;
}

export interface ExperimentDetail {
	id: string;
	goal: string;
	arms: ArmSummary[];
	tasks: string[];
	matrix: Record<string, Record<string, { status: string; reward: number | null }>>;
}

export function experimentOf(jobName: string): string {
	const dash = jobName.indexOf("-");
	return dash > 0 ? jobName.slice(0, dash) : jobName;
}

export function armOf(jobName: string): string {
	const exp = experimentOf(jobName);
	return jobName.length > exp.length ? jobName.slice(exp.length + 1) : jobName;
}

function prewalkLabel(prewalkJson: string | null): string {
	if (!prewalkJson) return "";
	try {
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
		return "";
	}
}

export function summarizeArm(run: RunRow, traces: TraceRow[]): ArmSummary {
	const decided = traces.filter(t => t.status === "pass" || t.status === "fail" || t.status === "error");
	const durations = decided.filter(t => t.durationMs > 0).map(t => t.durationMs);
	const meanTrialMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
	const decidedPass = decided.filter(t => t.status === "pass").length;
	const decidedCost = decided.reduce((sum, t) => sum + (t.costUsd || 0), 0);
	const passPct = decided.length > 0 ? (100 * decidedPass) / decided.length : null;
	const costPerTask = decided.length > 0 ? decidedCost / decided.length : null;

	let projected: ArmProjection | null = null;
	if (run.status === "running" && decided.length > 0 && run.nTotal > decided.length) {
		const elapsed = Date.now() - run.createdAt;
		const rate = decided.length / Math.max(elapsed, 1);
		const remaining = run.nTotal - decided.length;
		projected = {
			etaMs: rate > 0 ? Date.now() + remaining / rate : null,
			passPct: passPct ?? 0,
			costPerTask: costPerTask ?? 0,
			totalCostUsd: run.costUsd + (decidedCost / decided.length) * remaining,
			meanTrialMs: meanTrialMs ?? 0,
		};
	}
	return {
		run,
		arm: armOf(run.jobName),
		config: `${run.benchmark} · ${run.models}${prewalkLabel(run.prewalk)}`,
		passPct,
		costPerTask,
		meanTrialMs,
		projected,
	};
}

export function calibratedFinalPassPct(options: {
	decided: Array<{ task: string; passed: boolean }>;
	siblings: Map<string, { passes: number; decided: number }>;
	remaining: string[];
	nTotal: number;
}): number | null {
	const { decided, siblings, remaining, nTotal } = options;
	if (decided.length === 0 || nTotal <= 0) return null;
	const sigma = (x: number): number => 1 / (1 + Math.exp(-x));
	const smoothed = (s: { passes: number; decided: number } | undefined): number | null =>
		s && s.decided > 0 ? (s.passes + 1) / (s.decided + 2) : null;
	const known = [...siblings.values()].map(s => smoothed(s)).filter((p): p is number => p !== null);
	const meanP = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 0.5;
	const logit = (p: number): number => Math.max(-4, Math.min(4, Math.log(p / (1 - p))));
	const decidedLogits = decided.map(d => logit(smoothed(siblings.get(d.task)) ?? meanP));
	const passes = decided.filter(d => d.passed).length;

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
	const groups = new Map<string, RunRow[]>();
	for (const run of store.listRuns()) {
		const id = experimentOf(run.jobName);
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
			costUsd: runs.reduce((a, r) => a + r.costUsd, 0),
			createdAt: Math.min(...runs.map(r => r.createdAt)),
			updatedAt: Math.max(...runs.map(r => r.finishedAt ?? Date.now())),
		});
	}
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
			costUsd: 0,
			createdAt: meta.updatedAt,
			updatedAt: meta.updatedAt,
		});
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

const RERUN_SUFFIX = /-(fix|backfill|refill|retry|rerun|bf)\d*$/i;

export function canonicalArmOf(jobName: string): string {
	let arm = armOf(jobName);
	for (;;) {
		const next = arm.replace(RERUN_SUFFIX, "");
		if (next === arm || next.length === 0) return arm;
		arm = next;
	}
}

export function pickMergedTrials(traces: TraceRow[]): TraceRow[] {
	const byTask = new Map<string, TraceRow>();
	const decided = (t: TraceRow): boolean => t.status === "pass" || t.status === "fail";
	for (const t of traces) {
		const cur = byTask.get(t.task);
		if (!cur) {
			byTask.set(t.task, t);
			continue;
		}
		const wins = decided(t) === decided(cur) ? t.updatedAt >= cur.updatedAt : decided(t);
		if (wins) byTask.set(t.task, t);
	}
	return [...byTask.values()];
}

export function experimentDetail(store: RunStore, id: string): ExperimentDetail | null {
	const runs = store.listRuns().filter(r => experimentOf(r.jobName) === id);
	if (runs.length === 0) {
		const meta = store.getExperimentMeta(id);
		return meta ? { id, goal: meta.goal, arms: [], tasks: [], matrix: {} } : null;
	}
	const groups = new Map<string, RunRow[]>();
	for (const run of runs) {
		const key = canonicalArmOf(run.jobName);
		const bucket = groups.get(key);
		if (bucket) bucket.push(run);
		else groups.set(key, [run]);
	}
	const arms: ArmSummary[] = [];
	const matrix: ExperimentDetail["matrix"] = {};
	const tasks = new Set<string>();
	for (const [canonical, members] of groups) {
		members.sort((a, b) => a.createdAt - b.createdAt);
		const base = members.find(m => armOf(m.jobName) === canonical) ?? members[0];
		const armLabel = base.label || canonical;
		const merged = pickMergedTrials(members.flatMap(m => store.listTraces(m.jobName)));
		const running = members.some(m => m.status === "running");
		const decidedCount = merged.filter(
			t => t.status === "pass" || t.status === "fail" || t.status === "error",
		).length;
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
			costUsd: members.reduce((a, m) => a + m.costUsd, 0),
			tokIn: members.reduce((a, m) => a + m.tokIn, 0),
			tokOut: members.reduce((a, m) => a + m.tokOut, 0),
			tokCache: members.reduce((a, m) => a + m.tokCache, 0),
			createdAt: Math.min(...members.map(m => m.createdAt)),
			finishedAt: running
				? null
				: members.reduce<number | null>((a, m) => Math.max(a ?? 0, m.finishedAt ?? 0) || null, null),
		};
		const summary = summarizeArm(mergedRun, merged);
		summary.arm = armLabel;
		if (members.length > 1) summary.config += ` · merged ${members.length} runs`;
		arms.push(summary);
		const cells: Record<string, { status: string; reward: number | null }> = {};
		for (const t of merged) {
			tasks.add(t.task);
			cells[t.task] = { status: t.status, reward: t.reward };
		}
		matrix[armLabel] = cells;
	}
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
				if (cell.status !== "pass" && cell.status !== "fail") continue;
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
			if (cell.status !== "pass" && cell.status !== "fail") continue;
			decided.push({ task, passed: cell.status === "pass" });
			decidedTasks.add(task);
		}
		const remaining = taskList.filter(task => !decidedTasks.has(task));
		const calibrated = calibratedFinalPassPct({ decided, siblings, remaining, nTotal: arm.run.nTotal });
		if (calibrated !== null) arm.projected.passPct = calibrated;
	}
	const roleRank = (role: string) => (role === "baseline" ? 0 : role === "variant" ? 1 : 2);
	arms.sort((a, b) => roleRank(a.run.role) - roleRank(b.run.role) || a.arm.localeCompare(b.arm));
	return { id, goal: store.getExperimentMeta(id)?.goal ?? "", arms, tasks: [...tasks].sort(), matrix };
}
