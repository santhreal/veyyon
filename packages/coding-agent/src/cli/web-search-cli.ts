/**
 * Web search CLI command handlers.
 *
 * Backs the `veyyon search` subcommand (alias `q`) for testing web search providers.
 */

import { getProjectDir, stripAnsi } from "@veyyon/utils";
import chalk from "chalk";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import { Settings } from "../config/settings";
import { drawToolView } from "../modes/terminal/draw/draw-tool-view";
import { initTheme, theme } from "../theme/theme";
import { runSearchQuery, type SearchQueryParams } from "../tools/web/search/index";
import { SEARCH_PROVIDER_ORDER } from "../tools/web/search/provider";
import type { SearchProviderId } from "../tools/web/search/types";
import { webSearchToolView } from "../tools/web/search/view";

export interface SearchCommandArgs {
	query: string;
	provider?: SearchProviderId | "auto";
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	expanded: boolean;
}

/** Canonical provider list; the `search` command's options validation imports this. */
export const SEARCH_PROVIDERS: Array<SearchProviderId | "auto"> = ["auto", ...SEARCH_PROVIDER_ORDER];

/** Canonical recency list; the `search` command's options validation imports this. */
export const SEARCH_RECENCY_OPTIONS: NonNullable<SearchCommandArgs["recency"]>[] = ["day", "week", "month", "year"];

export async function runSearchCommand(cmd: SearchCommandArgs): Promise<void> {
	if (!cmd.query) {
		process.stderr.write(`${chalk.red("Error: Query is required")}\n`);
		process.stderr.write(`${chalk.dim('Usage: veyyon search <query> — e.g. `veyyon search "bun test filter"`')}\n`);
		process.exit(1);
	}

	if (cmd.provider && !SEARCH_PROVIDERS.includes(cmd.provider)) {
		process.stderr.write(`${chalk.red(`Error: Unknown provider "${cmd.provider}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid providers: ${SEARCH_PROVIDERS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.recency && !SEARCH_RECENCY_OPTIONS.includes(cmd.recency)) {
		process.stderr.write(`${chalk.red(`Error: Invalid recency "${cmd.recency}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid recency values: ${SEARCH_RECENCY_OPTIONS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.limit !== undefined && Number.isNaN(cmd.limit)) {
		process.stderr.write(`${chalk.red("Error: --limit must be a number")}\n`);
		process.exit(1);
	}

	const settings = await Settings.init({ cwd: getProjectDir() });
	applyProviderGlobalsFromSettings(settings);

	await initTheme();

	const params: SearchQueryParams = {
		query: cmd.query,
		provider: cmd.provider,
		recency: cmd.recency,
		limit: cmd.limit,
	};

	const result = await runSearchQuery(params);
	// The card is described once and drawn by the host, which here is this terminal: the compact cap
	// travels as an argument, so a one-shot print states what it left out and offers no gesture for it.
	const component = drawToolView(
		webSearchToolView.renderResult(
			result,
			{ expanded: cmd.expanded },
			{
				query: cmd.query,
				maxAnswerLines: cmd.expanded ? undefined : 6,
			},
		),
		theme,
	);

	const width = Math.max(60, process.stdout.columns ?? 100);
	// The theme renderer emits truecolor escapes unconditionally; follow chalk's
	// stdout color decision (non-TTY pipe, NO_COLOR) so `veyyon q … | less` and
	// redirects get plain text instead of escape soup.
	const lines = component.render(width);
	const rendered = chalk.level === 0 ? lines.map(stripAnsi) : lines;
	process.stdout.write(`${rendered.join("\n")}\n`);

	if (result.details?.error) {
		process.exitCode = 1;
	}
}
