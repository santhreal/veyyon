/**
 * Harbor trial result parsing from result.json files, directory scanning for
 * trials, job-level result summaries, and score/spend aggregation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tryParseJson } from "@veyyon/utils";
import { harborAgentLogPath } from "../backend";
import { dropCostProbe, probeTrialCost } from "./cost-probe";

export type TrialStatus = "pass" | "fail" | "error" | "running";

export interface Trial {
	name: string;
	status: TrialStatus;
	reward: number | null;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	durationMs: number;
	/** Detail string: exception type, or empty on success. */
	detail: string;
}

interface AgentCtxLike {
	cost_usd?: number;
	n_input_tokens?: number;
	n_output_tokens?: number;
	n_cache_tokens?: number;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function resolveReward(rewards: Record<string, number> | null): number | null {
	if (!rewards) return null;
	const vals = Object.values(rewards).filter(v => typeof v === "number");
	if (vals.length === 0) return null;
	if (typeof rewards.reward === "number") return rewards.reward;
	return Math.max(...vals);
}

function readJson(file: string): unknown {
	try {
		return tryParseJson(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** Parse one trial directory into a Trial, or null if it isn't a trial dir yet. */
export function parseTrial(dir: string, name: string, agentName = "veyyon"): Trial | null {
	const resultPath = path.join(dir, "result.json");
	if (!fs.existsSync(resultPath)) {
		// running: dir exists, no result yet. Use dir mtime as start proxy.
		let started = Date.now();
		try {
			started = fs.statSync(dir).mtimeMs;
		} catch {
			/* ignore */
		}

		// Realtime cost from the live agent log, parsed incrementally.
		const relAgentLog = harborAgentLogPath(agentName);
		const probe = probeTrialCost(path.join(dir, relAgentLog));
		const costUsd = probe?.costUsd ?? 0;
		const tokIn = probe?.tokIn ?? 0;
		const tokOut = probe?.tokOut ?? 0;
		const tokCache = probe?.tokCache ?? 0;

		return {
			name,
			status: "running",
			reward: null,
			costUsd,
			tokIn,
			tokOut,
			tokCache,
			durationMs: Date.now() - started,
			detail: "",
		};
	}
	// Trial finished: usage now comes from result.json; drop the live-parse state.
	dropCostProbe(path.join(dir, harborAgentLogPath(agentName)));
	const raw = readJson(resultPath);
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;

	// token/cost: prefer top-level agent_result, fall back to step_results[].agent_result
	const ctxs: AgentCtxLike[] = [];
	if (r.agent_result && typeof r.agent_result === "object") ctxs.push(r.agent_result as AgentCtxLike);
	if (Array.isArray(r.step_results)) {
		for (const st of r.step_results) {
			if (st && typeof st === "object") {
				const ar = (st as Record<string, unknown>).agent_result;
				if (ar && typeof ar === "object") ctxs.push(ar as AgentCtxLike);
			}
		}
	}
	let costUsd = 0;
	let tokIn = 0;
	let tokOut = 0;
	let tokCache = 0;
	for (const ctx of ctxs) {
		costUsd += num(ctx.cost_usd);
		tokIn += num(ctx.n_input_tokens);
		tokOut += num(ctx.n_output_tokens);
		tokCache += num(ctx.n_cache_tokens);
	}

	// rewards: top-level verifier_result, else step_results last verifier
	let rewards: Record<string, number> | null = null;
	const collectRewards = (vr: unknown): void => {
		if (vr && typeof vr === "object") {
			const rw = (vr as Record<string, unknown>).rewards;
			if (rw && typeof rw === "object") rewards = rw as Record<string, number>;
		}
	};
	collectRewards(r.verifier_result);
	if (!rewards && Array.isArray(r.step_results)) {
		for (const st of r.step_results) {
			if (st && typeof st === "object") collectRewards((st as Record<string, unknown>).verifier_result);
		}
	}
	const reward = resolveReward(rewards);

	// exception
	const exc =
		r.exception_info && typeof r.exception_info === "object" ? (r.exception_info as Record<string, unknown>) : null;

	// duration
	let durationMs = 0;
	const start = typeof r.started_at === "string" ? Date.parse(r.started_at) : NaN;
	const end = typeof r.finished_at === "string" ? Date.parse(r.finished_at) : NaN;
	if (Number.isFinite(start) && Number.isFinite(end)) durationMs = end - start;

	let status: TrialStatus;
	let detail = "";
	if (exc) {
		status = "error";
		detail = typeof exc.exception_type === "string" ? exc.exception_type : "error";
	} else if (reward === null) {
		status = "error";
		detail = "missing or unparsable reward";
	} else if (reward >= 1 - 1e-9) {
		status = "pass";
	} else {
		status = "fail";
	}
	return { name, status, reward, costUsd, tokIn, tokOut, tokCache, durationMs, detail };
}

export function readTrials(jobDir: string, agentName = "veyyon"): Trial[] {
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(jobDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const trials: Trial[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		if (e.name.startsWith("_")) continue;
		const t = parseTrial(path.join(jobDir, e.name), e.name, agentName);
		if (t) trials.push(t);
	}
	return trials;
}

/** Authoritative job-level totals from <jobDir>/result.json (written incrementally). */
export interface JobInfo {
	nTotal: number;
	running: number | null;
	pending: number | null;
	finishedAt: number | null;
}

export function readJobResult(jobDir: string): JobInfo | null {
	const raw = readJson(path.join(jobDir, "result.json"));
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const nTotal = typeof r.n_total_trials === "number" ? r.n_total_trials : 0;
	let running: number | null = null;
	let pending: number | null = null;
	if (r.stats && typeof r.stats === "object") {
		const s = r.stats as Record<string, unknown>;
		if (typeof s.n_running_trials === "number") running = s.n_running_trials;
		if (typeof s.n_pending_trials === "number") pending = s.n_pending_trials;
	}
	const finishedRaw = typeof r.finished_at === "string" ? Date.parse(r.finished_at) : NaN;
	const finishedAt = Number.isFinite(finishedRaw) ? finishedRaw : null;
	return nTotal > 0 ? { nTotal, running, pending, finishedAt } : null;
}

export interface Totals {
	total: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	pending: number;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
}

export function aggregate(trials: Trial[], job: JobInfo | null, fallbackExpected: number): Totals {
	const t: Totals = {
		total: fallbackExpected,
		done: 0,
		pass: 0,
		fail: 0,
		error: 0,
		running: 0,
		pending: fallbackExpected,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
	};
	for (const tr of trials) {
		t.costUsd += tr.costUsd;
		t.tokIn += tr.tokIn;
		t.tokOut += tr.tokOut;
		t.tokCache += tr.tokCache;
		switch (tr.status) {
			case "pass":
				t.pass++;
				t.done++;
				break;
			case "fail":
				t.fail++;
				t.done++;
				break;
			case "error":
				t.error++;
				t.done++;
				break;
			case "running":
				t.running++;
				break;
		}
	}
	if (job) {
		if (job.nTotal > 0) t.total = job.nTotal;
		if (job.running !== null) t.running = job.running;
		if (job.pending !== null) t.pending = job.pending;
		else t.pending = Math.max(0, t.total - t.done - t.running);
	} else {
		t.pending = Math.max(0, t.total - t.done - t.running);
	}
	return t;
}
