/**
 * Stats CLI command handlers.
 *
 * Handles `veyyon stats` subcommand for viewing AI usage statistics.
 */

import { formatCostTiered as formatCost, normalizePremiumRequests } from "@veyyon/stats/format";
import { truncateToWidth } from "@veyyon/tui/utils";
import { formatDuration, formatNumber, formatPercent } from "@veyyon/utils";
import chalk from "chalk";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	json: boolean;
	summary: boolean;
}

// =============================================================================
// Argument Parser
// =============================================================================

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const { getDashboardStats, syncAllSessions, getTotalMessageCount, startServer, closeDb } = await import(
		"@veyyon/stats"
	);

	// Sync session files first
	const progress = createSyncProgressReporter();
	process.stderr.write("Syncing session files...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	// stderr, like "Syncing…": in --json mode stdout must carry only the JSON
	// document or `veyyon stats -j | jq` fails to parse.
	process.stderr.write(`Synced ${processed} new entries from ${files} files (${total} total)\n\n`);

	if (cmd.json) {
		const stats = await getDashboardStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (cmd.summary) {
		await printStatsSummary();
		return;
	}

	// Start the dashboard server
	const { port } = await startServer(cmd.port);
	console.log(chalk.green(`Dashboard available at: http://localhost:${port}`));

	// Open browser
	const url = `http://localhost:${port}`;
	openPath(url);

	console.log("Press Ctrl+C to stop\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(): Promise<void> {
	const { getDashboardStats } = await import("@veyyon/stats");
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	console.log(chalk.bold("\n=== AI Usage Statistics ===\n"));

	console.log(chalk.bold("Overall:"));
	console.log(`  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`);
	console.log(`  Error Rate: ${formatPercent(overall.errorRate)}`);
	console.log(`  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`);
	console.log(`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  Cache Rate: ${formatPercent(overall.cacheRate)}`);
	console.log(`  Total Cost: ${formatCost(overall.totalCost)}`);
	console.log(`  Premium Requests: ${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`);
	console.log(`  Avg Duration: ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`);
	console.log(`  Avg TTFT: ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  Avg Tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold("\nBy Model:"));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost)}, ${formatPercent(m.cacheRate)} cache`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold("\nBy Folder:"));
		for (const f of byFolder.slice(0, 10)) {
			console.log(`  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost)}`);
		}
	}

	console.log("");
}

// =============================================================================
// Help
// =============================================================================
