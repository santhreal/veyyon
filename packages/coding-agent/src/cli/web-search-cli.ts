/**
 * Web search CLI command handlers.
 *
 * Handles `veyyon q`/`veyyon web-search` subcommands for testing web search providers.
 */

import { getProjectDir } from "@veyyon/pi-utils";
import chalk from "chalk";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import { Settings } from "../config/settings";
import { initTheme, theme } from "../modes/theme/theme";
import { runSearchQuery, type SearchQueryParams } from "../web/search/index";
import { SEARCH_PROVIDER_ORDER } from "../web/search/provider";
import { renderSearchResult } from "../web/search/render";
import type { SearchProviderId } from "../web/search/types";

export interface SearchCommandArgs {
	query: string;
	provider?: SearchProviderId | "auto";
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	expanded: boolean;
}

const PROVIDERS: Array<SearchProviderId | "auto"> = ["auto", ...SEARCH_PROVIDER_ORDER];

const RECENCY_OPTIONS: SearchCommandArgs["recency"][] = ["day", "week", "month", "year"];

export async function runSearchCommand(cmd: SearchCommandArgs): Promise<void> {
	if (!cmd.query) {
		process.stderr.write(`${chalk.red("Error: Query is required")}\n`);
		process.exit(1);
	}

	if (cmd.provider && !PROVIDERS.includes(cmd.provider)) {
		process.stderr.write(`${chalk.red(`Error: Unknown provider "${cmd.provider}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid providers: ${PROVIDERS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.recency && !RECENCY_OPTIONS.includes(cmd.recency)) {
		process.stderr.write(`${chalk.red(`Error: Invalid recency "${cmd.recency}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid recency values: ${RECENCY_OPTIONS.join(", ")}`)}\n`);
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
	const component = renderSearchResult(result, { expanded: cmd.expanded, isPartial: false }, theme, {
		query: cmd.query,
		maxAnswerLines: cmd.expanded ? undefined : 6,
	});

	const width = Math.max(60, process.stdout.columns ?? 100);
	process.stdout.write(`${component.render(width).join("\n")}\n`);

	if (result.details?.error) {
		process.exitCode = 1;
	}
}
