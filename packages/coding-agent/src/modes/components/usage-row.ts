import type { Usage } from "@veyyon/ai";
import { Container, Spacer, Text } from "@veyyon/tui";
import { formatDuration, formatNumber } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import { tokensPerSecond } from "./status-line/token-rate";


/**
 * The per-turn receipt shown under a completed assistant message when
 * `display.showTokenUsage` is on: what the turn spent and how long it took.
 *
 * The wall clock is the number you want when comparing two models or two edit
 * formats on the same prompt, and it was the one number missing: the total
 * duration was read only to divide the output tokens by it, so the row published a
 * rate and never the time behind it. Time to first token wore the clock icon on its
 * own, which made the single time value on the row ambiguous — a reader could not
 * tell whether they were looking at the turn's length or its latency. The clock now
 * means the turn's length, matching the status line's `time_spent` segment, and TTFT
 * carries its own label.
 *
 * Every value is derived from the usage and timings the turn already reported. No
 * second estimator: a receipt that disagreed with the status line would be worse
 * than no receipt.
 */
export function createUsageRowBlock(usage: Usage, durationMs?: number, ttftMs?: number): Container {
	const totalInput = usage.input + usage.cacheWrite;
	const parts: string[] = [];
	parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
	parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
	if (usage.cacheRead > 0) {
		parts.push(`${theme.icon.cache} ${formatNumber(usage.cacheRead)}`);
	}
	if (durationMs !== undefined && durationMs > 0) {
		parts.push(`${theme.icon.time} ${formatDuration(durationMs)}`);
	}
	if (ttftMs && ttftMs > 0) {
		parts.push(`ttft ${(ttftMs / 1000).toFixed(1)}s`);
	}
	// TPS over the total request duration — the post-TTFT window undercounts
	// generation time when reasoning tokens are hidden before the first visible
	// byte, inflating the rate. `tokensPerSecond` is the one owner of the
	// arithmetic and of the too-short-to-be-meaningful floor, shared with the
	// status line so both surfaces publish the same number under the same rule.
	const tokPerSec = tokensPerSecond(usage.output, durationMs);
	if (tokPerSec !== null) {
		parts.push(`${theme.icon.throughput} ${tokPerSec.toFixed(1)}/s`);
	}
	const block = new Container();
	block.addChild(new Spacer(1));
	block.addChild(new Text(theme.fg("dim", parts.join("  ")), 1, 0));
	return block;
}
