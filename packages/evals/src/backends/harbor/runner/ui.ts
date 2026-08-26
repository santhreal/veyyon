/**
 * ANSI terminal dashboard rendering, live trial progress display, and markdown
 * benchmark report generation for Harbor runs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { escapeMarkdownTableCell } from "@veyyon/coding-agent/utils/markdown-table";
import { clampLow } from "@veyyon/utils";
import { formatUsd } from "../../../wire";
import type { Config } from "./config";
import { aggregate, readJobResult, readTrials, type Trial, type TrialStatus } from "./results";

const isTTY = Boolean(process.stdout.isTTY);
const useColor = isTTY && !process.env.NO_COLOR;

export const CSI = "\x1b[";
export function c(code: string, s: string): string {
	return useColor ? `${CSI}${code}m${s}${CSI}0m` : s;
}
export const dim = (s: string): string => c("2", s);
export const bold = (s: string): string => c("1", s);
export const green = (s: string): string => c("32", s);
export const red = (s: string): string => c("31", s);
export const yellow = (s: string): string => c("33", s);

/** The shared formatter, with harbor's own absent marker for a run nothing priced. */
export function fmtUsd(n: number | null): string {
	return formatUsd(n, "—");
}

export function fmtNum(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return `${n}`;
}

export function fmtDur(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rem = s % 60;
	if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
	if (m > 0) return `${m}m${rem.toString().padStart(2, "0")}s`;
	return `${rem}s`;
}

export function bar(frac: number, width: number): string {
	const f = clampLow(frac, 0, 1);
	const filled = Math.round(f * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function pad(s: string, w: number): string {
	return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

export function agentArgsLabel(cfg: Config): string | null {
	return cfg.agentArgs.length > 0 ? cfg.agentArgs.join(" ") : null;
}

export interface RenderState {
	cfg: Config;
	jobDir: string;
	logPath: string;
	startMs: number;
	expected: number;
	tick: number;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function statusIcon(s: TrialStatus, tick: number): string {
	switch (s) {
		case "pass":
			return green("✓");
		case "fail":
			return red("✗");
		case "error":
			return yellow("!");
		case "running":
			return yellow(SPINNER[tick % SPINNER.length] ?? "•");
	}
}

function tailFile(file: string, maxLines: number): string[] {
	try {
		const buf = fs.readFileSync(file, "utf8");
		const lines = buf.split("\n").filter(l => l.trim().length > 0);
		return lines.slice(-maxLines);
	} catch {
		return [];
	}
}

export function render(st: RenderState): void {
	const trials = readTrials(st.jobDir, st.cfg.agent);
	const tot = aggregate(trials, readJobResult(st.jobDir), st.expected);
	const elapsed = Date.now() - st.startMs;
	const frac = tot.total > 0 ? tot.done / tot.total : 0;
	const successPct = tot.done > 0 ? (tot.pass / tot.done) * 100 : 0;
	const eta = tot.done > 0 && tot.total > tot.done ? fmtDur((elapsed / tot.done) * (tot.total - tot.done)) : "—";

	const out: string[] = [];
	if (isTTY) out.push(`${CSI}H${CSI}2J`); // home + clear
	const spin = SPINNER[st.tick % SPINNER.length];
	const agentLabel =
		st.cfg.agent === "veyyon"
			? `veyyon (${st.cfg.install})${agentArgsLabel(st.cfg) ? ` [${agentArgsLabel(st.cfg)}]` : ""}`
			: st.cfg.agent;
	const modelsLabel = st.cfg.models.length > 0 ? st.cfg.models.join(", ") : "no model (oracle/nop)";
	out.push(
		`${bold(`${st.cfg.dataset}`)}  ${dim("•")}  ${modelsLabel}  ${dim("•")}  ${agentLabel}  ${dim("•")}  ${st.cfg.envType}  ${yellow(spin)}\n`,
	);
	out.push(
		`  ${bar(frac, 30)}  ${(frac * 100).toFixed(0)}%  ${tot.done}/${tot.total} done  ${dim("•")}  ${green(`${tot.pass} pass`)} (${successPct.toFixed(1)}%)  ${red(`${tot.fail} fail`)}  ${yellow(`${tot.error} err`)}  ${dim(`${tot.running} run`)}\n`,
	);
	out.push(
		`  spend ${bold(fmtUsd(tot.costUsd))}  ${dim("•")}  tok in ${fmtNum(tot.tokIn)}  out ${fmtNum(tot.tokOut)}  cache ${fmtNum(tot.tokCache)}  ${dim("•")}  elapsed ${fmtDur(elapsed)}  eta ${eta}\n\n`,
	);

	// Running + recent completed trials (max 10 rows)
	const recent = [...trials].sort((a, _b) => (a.status === "running" ? -1 : 1)).slice(0, 10);
	if (recent.length > 0) {
		out.push(`  ${dim("trials:")}\n`);
		for (const t of recent) {
			const reward = t.reward !== null ? t.reward.toFixed(2) : "—";
			const cost = fmtUsd(t.costUsd);
			const detail = t.detail ? `  ${dim(`(${t.detail})`)}` : "";
			out.push(
				`    ${statusIcon(t.status, st.tick)} ${pad(t.name, 40)} ${pad(reward, 6)} ${pad(cost, 8)} ${pad(fmtDur(t.durationMs), 7)}${detail}\n`,
			);
		}
		out.push("\n");
	}

	// Harbor log tail
	const logLines = tailFile(st.logPath, 6);
	if (logLines.length > 0) {
		out.push(`  ${dim("harbor.log:")}\n`);
		for (const l of logLines) out.push(`    ${dim(pad(l, 90))}\n`);
	}

	process.stdout.write(out.join(""));
}

/** Emoji-tagged status label for a trial's result column. */
export function trialStatusLabel(status: TrialStatus): string {
	switch (status) {
		case "pass":
			return "✅ pass";
		case "fail":
			return "❌ fail";
		case "error":
			return "⚠️ error";
		case "running":
			return "⏳ running";
	}
}

/**
 * Render a single markdown table row for a trial.
 * Detail strings and task names are escaped so embedded pipes or HTML
 * do not break the markdown table structure.
 */
export function renderTrialRow(t: Trial): string {
	const reward = t.reward !== null ? t.reward.toFixed(2) : "—";
	return `| ${escapeMarkdownTableCell(t.name)} | ${trialStatusLabel(t.status)} | ${reward} | ${fmtUsd(t.costUsd)} | ${fmtDur(t.durationMs)} | ${escapeMarkdownTableCell(t.detail)} |`;
}

export function writeReport(st: RenderState, benchDir: string, exitCode: number): string {
	const trials = readTrials(st.jobDir, st.cfg.agent).sort((a, b) => a.name.localeCompare(b.name));
	const tot = aggregate(trials, readJobResult(st.jobDir), st.expected);
	const successPct = tot.done > 0 ? (tot.pass / tot.done) * 100 : 0;
	const elapsedMs = Date.now() - st.startMs;

	const lines: string[] = [
		`# Benchmark Report: ${st.cfg.dataset}`,
		"",
		`- **Models:** ${st.cfg.models.join(", ")}`,
		`- **Agent:** ${st.cfg.agent} (${st.cfg.install})`,
		st.cfg.agentArgs.length > 0 ? `- **Agent Args:** \`${st.cfg.agentArgs.join(" ")}\`` : null,
		`- **Dataset:** ${st.cfg.dataset}`,
		`- **Exit Code:** ${exitCode}`,
		`- **Elapsed:** ${fmtDur(elapsedMs)}`,
		`- **Pass Rate:** ${tot.pass}/${tot.done} (${successPct.toFixed(1)}%)`,
		`- **Totals:** ${tot.pass} pass, ${tot.fail} fail, ${tot.error} error`,
		`- **Spend:** ${fmtUsd(tot.costUsd)}`,
		`- **Tokens:** in ${fmtNum(tot.tokIn)}, out ${fmtNum(tot.tokOut)}, cache ${fmtNum(tot.tokCache)}`,
		"",
		"## Trials",
		"",
		"| Task | Status | Reward | Cost | Duration | Detail |",
		"| --- | --- | ---: | ---: | ---: | --- |",
		...trials.map(renderTrialRow),
		"",
	].filter((l): l is string => l !== null);

	const reportPath = path.join(benchDir, "report.md");
	fs.writeFileSync(reportPath, lines.join("\n"));
	return reportPath;
}

export async function runDashboardLoop(
	st: RenderState,
	isFinished: () => boolean,
	options?: { isTTY?: boolean; intervalMs?: number; maxTicks?: number },
): Promise<void> {
	const tty = options?.isTTY ?? isTTY;
	const interval = options?.intervalMs ?? (tty ? 700 : 10000);
	const maxTicks = options?.maxTicks ?? Number.POSITIVE_INFINITY;
	while (!isFinished() && st.tick < maxTicks) {
		render(st);
		st.tick++;
		if (isFinished() || st.tick >= maxTicks) break;
		await Bun.sleep(interval);
	}
	render(st); // final frame
}
