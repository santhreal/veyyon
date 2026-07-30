/**
 * Text rendering for `veyyon session stats`. Separated from the pure analysis
 * ({@link computeSessionStats}) so the aggregate math is tested on values while
 * the layout is tested on strings.
 */

import { formatBytes, formatDuration, formatNumber } from "@veyyon/utils";
import type { SessionStatsReport, TurnStat } from "./session-stats";

const COLUMN_GAP = "  ";

// The text view caps long tables so a huge session stays readable; `--json`
// always carries every row. Caps are surfaced with an explicit note (never a
// silent truncation) so the reader knows rows were withheld and how to see them.
const TURN_CAP = 40;
const REPEAT_CAP = 25;

function padRight(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
	return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** Render a simple table: a header row then body rows, columns aligned to the widest cell. */
function table(
	header: readonly string[],
	rows: readonly (readonly string[])[],
	rightAlign: ReadonlySet<number>,
): string[] {
	const widths = header.map((cell, col) => Math.max(cell.length, ...rows.map(row => (row[col] ?? "").length)));
	const format = (cells: readonly string[]) =>
		cells
			.map((cell, col) => (rightAlign.has(col) ? padLeft(cell, widths[col]) : padRight(cell, widths[col])))
			.join(COLUMN_GAP)
			.trimEnd();
	return [format(header), ...rows.map(format)];
}

/**
 * Choose which turns to print. Short sessions show every turn in order; long
 * ones show the {@link TURN_CAP} slowest turns (by request time) kept in their
 * original order, with a note that says so — the slow turns are where a study
 * looks first, and `--json` still carries the full sequence.
 */
function selectTurns(turns: readonly TurnStat[]): { shown: TurnStat[]; note?: string } {
	if (turns.length <= TURN_CAP) return { shown: [...turns] };
	const slowest = [...turns]
		.sort((a, b) => (b.requestMs ?? 0) - (a.requestMs ?? 0))
		.slice(0, TURN_CAP)
		.sort((a, b) => a.index - b.index);
	return { shown: slowest, note: `${TURN_CAP} slowest of ${turns.length}; --json for all` };
}

export function formatSessionStats(report: SessionStatsReport): string {
	const { totals } = report;
	const lines: string[] = [];

	lines.push(`Session ${report.sessionId || "(unknown)"}`);
	if (report.cwd) lines.push(`  cwd            ${report.cwd}`);
	lines.push(`  instrumentation ${report.instrumentationLevel}`);
	lines.push("");

	lines.push("Totals");
	lines.push(`  wall clock     ${formatDuration(totals.wallClockMs)}`);
	lines.push(`  turns          ${totals.assistantTurns} assistant, ${totals.userMessages} user`);
	lines.push(
		`  tool calls     ${totals.toolCalls}` +
			(totals.toolErrors > 0 ? ` (${totals.toolErrors} error${totals.toolErrors === 1 ? "" : "s"})` : "") +
			(totals.instrumentedToolCalls < totals.toolCalls ? ` · ${totals.instrumentedToolCalls} instrumented` : ""),
	);
	lines.push(
		`  tokens         ${formatNumber(totals.totalTokens)} total ` +
			`(in ${formatNumber(totals.input)}, out ${formatNumber(totals.output)}, ` +
			`cacheR ${formatNumber(totals.cacheRead)}, cacheW ${formatNumber(totals.cacheWrite)})`,
	);
	lines.push(`  request time   ${formatDuration(totals.requestMs)}`);
	lines.push(`  tool time      ${formatDuration(totals.toolDurationMs)}`);
	lines.push(`  queue wait     ${formatDuration(totals.queueWaitMs)}`);
	lines.push(`  result weight  ${formatNumber(totals.resultTokens)} tokens, ${formatBytes(totals.resultBytes)}`);
	lines.push("");
	if (report.lifecycle) {
		const lifecycle = report.lifecycle;
		lines.push("Lifecycle");
		lines.push(`  journal        ${lifecycle.transitions} transitions, ${lifecycle.checkpoints} checkpoints`);
		if (lifecycle.sequence) {
			lines.push(
				`  sequence       ${lifecycle.sequence.entries} entries · ` +
					`${lifecycle.sequence.first} → ${lifecycle.sequence.last} · high ${lifecycle.sequence.highest}`,
			);
		}
		if (lifecycle.latestState) {
			lines.push(`  latest state   ${lifecycle.latestState.state} (${lifecycle.latestState.reason})`);
		}
		if (lifecycle.latestCheckpoint) {
			lines.push(
				`  checkpoint     ${lifecycle.latestCheckpoint.id} · prefix ${lifecycle.latestCheckpoint.prefixSequence}`,
			);
		}
		lines.push("");
	}

	if (report.context) {
		const context = report.context;
		lines.push("Context attribution");
		lines.push(
			`  prompt         ${formatNumber(context.promptTokens.total)} total · ` +
				`${formatNumber(context.promptTokens.max)} max`,
		);
		lines.push(
			`  non-message    ${formatNumber(context.nonMessageTokens.total)} total · ` +
				`${formatNumber(context.nonMessageTokens.max)} max`,
		);
		if (context.storedMessagesTokens) {
			lines.push(
				`  stored         ${formatNumber(context.storedMessagesTokens.total)} total · ` +
					`${formatNumber(context.storedMessagesTokens.max)} max`,
			);
		}
		if (context.tailTokens) {
			lines.push(
				`  request tail   ${formatNumber(context.tailTokens.total)} total · ` +
					`${formatNumber(context.tailTokens.max)} max`,
			);
		}
		if (context.compactionEntries) {
			const latest = context.compactionEntryIds?.at(-1);
			lines.push(
				`  compactions    ${context.compactionEntries.toLocaleString("en-US")} unique${latest === undefined ? "" : ` · latest ${latest}`}`,
			);
		}
		lines.push("");
	}

	if (report.toolSpans) {
		const spans = report.toolSpans;
		const statuses = Object.entries(spans.statuses)
			.filter(([, count]) => count > 0)
			.map(([status, count]) => `${status} ${count}`)
			.join(", ");
		lines.push("Tool spans");
		lines.push(`  outcomes       ${statuses}`);
		if (spans.rich) {
			lines.push(
				`  scheduling     ${formatDuration(spans.rich.queuedMs)} queued · ` +
					`${spans.rich.shared} shared · ${spans.rich.exclusive} exclusive · ${spans.rich.batches} batches`,
			);
			lines.push(`  result blocks  ${spans.rich.resultBlocks} total · ${spans.rich.resultImages} images`);
		}
		if (spans.ultra) {
			lines.push(`  arguments      ${formatBytes(spans.ultra.argsBytes)} · ${spans.ultra.uniqueArgs} unique hashes`);
		}
		lines.push("");
	}

	if (report.ircDelivery) {
		lines.push("IRC delivery");
		for (const direction of ["sent", "received"] as const) {
			const delivery = report.ircDelivery[direction];
			const outcomes = Object.entries(delivery.outcomes)
				.filter(([, count]) => count > 0)
				.map(([outcome, count]) => `${outcome} ${count}`)
				.join(", ");
			lines.push(
				`  ${direction.padEnd(14)}${delivery.count} · ${formatBytes(delivery.payloadBytes)}` +
					(outcomes ? ` · ${outcomes}` : ""),
			);
			if (delivery.routes) {
				const routes = Object.entries(delivery.routes)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([route, count]) => `${route} ${count}`)
					.join(", ");
				lines.push(`  ${`${direction} routes`.padEnd(14)}${routes}`);
			}
		}
		lines.push("");
	}

	if (report.taskState) {
		const tasks = report.taskState;
		const operations = Object.entries(tasks.byOperation)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([operation, count]) => `${operation} ${count}`)
			.join(", ");
		lines.push("Task state");
		if (tasks.latest) {
			lines.push(
				`  latest         ${tasks.latest.total} total · ${tasks.latest.open} open · ` +
					`${tasks.latest.inProgress} in progress · ${tasks.latest.completed} completed · ` +
					`${tasks.latest.dropped} dropped`,
			);
		} else {
			lines.push("  latest         no task state on active branch");
		}
		lines.push(`  operations     ${tasks.operations} (${operations})`);
		lines.push(
			`  transitions    ${tasks.transitions.total} total · ${tasks.transitions.added} added · ` +
				`${tasks.transitions.removed} removed · ${tasks.transitions.toCompleted} completed · ` +
				`${tasks.transitions.toDropped} dropped`,
		);
		lines.push("");
	}

	if (report.toolLatency.length > 0) {
		lines.push("Tool latency (slowest first)");
		const rows = report.toolLatency.map(t => [
			t.tool,
			String(t.calls),
			formatDuration(t.totalDurationMs),
			formatDuration(t.p50DurationMs),
			formatDuration(t.p95DurationMs),
			formatDuration(t.maxDurationMs),
			formatDuration(t.queueWaitMs),
			String(t.errors),
		]);
		const right = new Set([1, 2, 3, 4, 5, 6, 7]);
		for (const row of table(["tool", "calls", "total", "p50", "p95", "max", "queued", "err"], rows, right)) {
			lines.push(`  ${row}`);
		}
		lines.push("");
	}

	const costed = report.toolCost.filter(t => t.resultTokens > 0);
	if (costed.length > 0) {
		lines.push("Tool cost (most tokens into context first)");
		const rows = costed.map(t => [t.tool, String(t.calls), formatNumber(t.resultTokens), formatBytes(t.resultBytes)]);
		const right = new Set([1, 2, 3]);
		for (const row of table(["tool", "calls", "tokens", "bytes"], rows, right)) {
			lines.push(`  ${row}`);
		}
		lines.push("");
	}

	if (report.repeatedCalls.length > 0) {
		const shown = report.repeatedCalls.slice(0, REPEAT_CAP);
		lines.push("Repeated identical calls (same tool, same arguments)");
		const rows = shown.map(r => [
			r.tool,
			r.argsHash,
			String(r.count),
			formatDuration(r.totalDurationMs),
			formatNumber(r.totalResultTokens),
		]);
		const right = new Set([2, 3, 4]);
		for (const row of table(["tool", "args", "count", "time", "tokens"], rows, right)) {
			lines.push(`  ${row}`);
		}
		if (report.repeatedCalls.length > shown.length) {
			lines.push(`  … ${report.repeatedCalls.length - shown.length} more (use --json for all)`);
		}
		lines.push("");
	}

	if (report.turns.length > 0) {
		const { shown, note } = selectTurns(report.turns);
		lines.push(note ? `Per-turn (${note})` : "Per-turn");
		const rows = shown.map(t => [
			`#${t.index}`,
			t.model,
			t.requestMs !== undefined ? formatDuration(t.requestMs) : "-",
			String(t.toolCalls),
			formatNumber(t.totalTokens),
			formatNumber(t.output),
		]);
		const right = new Set([2, 3, 4, 5]);
		for (const row of table(["turn", "model", "req", "tools", "tokens", "out"], rows, right)) {
			lines.push(`  ${row}`);
		}
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}
