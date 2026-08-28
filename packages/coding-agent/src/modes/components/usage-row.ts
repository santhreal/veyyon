import type { Usage } from "@veyyon/ai";
import { Container, Spacer, Text } from "@veyyon/tui";
import { formatDuration, formatNumber } from "@veyyon/utils";
import { withIcon } from "../../modes/theme/icon-label";
import { theme } from "../../modes/theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";
import { tokensPerSecond } from "./status-line/token-rate";

/** The per-turn receipt shown under a completed assistant message when `display.showTokenUsage` is on: what the turn spent and how long it took. */
export function createUsageRowBlock(usage: Usage, durationMs?: number, ttftMs?: number): Container {
	const totalInput = usage.input + usage.cacheWrite;
	const parts: string[] = [];
	parts.push(withIcon(theme.icon.input, formatNumber(totalInput)));
	parts.push(withIcon(theme.icon.output, formatNumber(usage.output)));
	if (usage.cacheRead > 0) {
		parts.push(withIcon(theme.icon.cache, formatNumber(usage.cacheRead)));
	}
	if (durationMs !== undefined && durationMs > 0) {
		parts.push(withIcon(theme.icon.time, formatDuration(durationMs)));
	}
	if (ttftMs && ttftMs > 0) {
		parts.push(`ttft ${(ttftMs / 1000).toFixed(1)}s`);
	}
	// TPS over the total request duration — the post-TTFT window undercounts generation time when reasoning tokens are hidden before the first visible
	const tokPerSec = tokensPerSecond(usage.output, durationMs);
	if (tokPerSec !== null) {
		parts.push(withIcon(theme.icon.throughput, `${tokPerSec.toFixed(1)}/s`));
	}
	const block = new Container();
	block.addChild(new Spacer(1));
	// COMPOSER_INSET_COLS, the column every other row in the transcript starts at: the prose above this row is mounted there and so is the rail of the
	block.addChild(new Text(theme.fg("dim", parts.join("  ")), COMPOSER_INSET_COLS, 0));
	return block;
}
